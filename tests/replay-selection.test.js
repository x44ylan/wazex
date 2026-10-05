import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { chromium, expect } from "playwright/test";

// Failure coverage: selection is ignored, accounts mix, IDs alter SQL,
// empty/invalid/oversized selections fail, restart loses routes, or export
// silently becomes partial, or serial batches time out under normal latency.
// This launches the real server with synthetic data.
test(
  "HTTP replay selects archive routes before loading details",
  { timeout: 60000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "wazex-replay-"));
    const reservation = createServer();
    await new Promise((ready) => reservation.listen(0, "127.0.0.1", ready));
    const port = reservation.address().port;
    await new Promise((done) => reservation.close(done));
    const base = `http://127.0.0.1:${port}`;
    const checks = [];
    let child, token;
    async function start() {
      child = spawn(process.execPath, ["server/index.js"], {
        cwd: resolve("."),
        env: { ...process.env, PORT: String(port), WAZEX_DATA_DIR: directory },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let logs = "";
      child.stderr.on("data", (data) => {
        logs += data;
      });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
        try {
          const response = await fetch(`${base}/api/status`);
          if (response.ok) {
            token = (await response.json()).token;
            return;
          }
        } catch {}
        await new Promise((done) => setTimeout(done, 50));
      }
      throw new Error("Isolated server did not start");
    }
    async function stop() {
      if (child && child.exitCode === null) {
        const exited = new Promise((done) => child.once("exit", done));
        child.kill();
        await exited;
      }
    }
    const post = (path, body) =>
      fetch(`${base}/api${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Wazex-Token": token },
        body: JSON.stringify(body),
      });
    const drives = Array.from({ length: 3000 }, (_, index) => ({
      id:
        index === 4
          ? "route'quoted"
          : index === 2999
            ? "route|2999"
            : `route-${index}`,
      startTime:
        index >= 2990 ? Date.now() - 120000 + index : 1000 + index * 1000,
      endTime:
        index >= 2990 ? Date.now() - 60000 + index : 61000 + index * 1000,
      totalRoadMeters: 1200,
      hasFullSession: true,
      detail: {
        coordinates: [
          [103, 1],
          [103.01 + index / 100000, 1.01],
        ],
        metadata: "synthetic".repeat(40),
      },
    }));
    const backup = {
      format: "wazex",
      version: 1,
      account: { id: "row:fixture", name: "Synthetic archive", region: "row" },
      drives,
    };
    try {
      await start();
      assert.equal((await post("/import", backup)).status, 200);
      assert.equal(
        (
          await post("/import", {
            ...backup,
            account: { ...backup.account, id: "row:other" },
            drives: [drives[0]],
          })
        ).status,
        200,
      );
      const request = {
        account: "row:fixture",
        ids: ["route|2999", "route'quoted", "missing", "route|2999"],
      };
      const started = performance.now();
      let response = await post("/routes", request);
      assert.equal(response.status, 200);
      const selected = await response.json();
      assert.deepEqual(
        selected.map((route) => route.id),
        ["route'quoted", "route|2999"],
      );
      assert.deepEqual(selected[0].points, drives[4].detail.coordinates);
      checks.push({
        check: "selected routes, deduplication and parameterized IDs",
        selected: selected.length,
        archive: drives.length,
        milliseconds: performance.now() - started,
      });
      assert.deepEqual(
        await (
          await post("/routes", { account: "row:fixture", ids: [] })
        ).json(),
        [],
      );
      assert.deepEqual(
        await (
          await post("/routes", { account: "row:other", ids: ["route|2999"] })
        ).json(),
        [],
      );
      for (const ids of ["route-0", [null], [""], Array(201).fill("route-0")]) {
        assert.equal(
          (await post("/routes", { account: "row:fixture", ids })).status,
          400,
        );
      }
      assert.equal(
        (await post("/routes", { account: "unknown", ids: [] })).status,
        400,
      );
      checks.push({
        check: "empty selections, account isolation and bounded validation",
      });
      const exported = await (
        await fetch(`${base}/api/export?account=row%3Afixture`)
      ).json();
      assert.equal(exported.drives.length, drives.length);
      await stop();
      await start();
      response = await post("/routes", request);
      assert.deepEqual(await response.json(), selected);
      checks.push({ check: "restart persistence and complete export" });
      assert.equal((await post("/import", backup)).status, 200);
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({
          viewport: { width: 390, height: 844 },
        });
        const requests = [],
          errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
          if (
            request.url().endsWith("/api/routes") &&
            request.method() === "POST"
          )
            requests.push(request.postDataJSON());
        });
        await page.route("**/api/routes", async (route) => {
          await new Promise((done) => setTimeout(done, 800));
          await route.continue();
        });
        await page.goto(base);
        const paths = page
          .getByRole("region", { name: "Your roads" })
          .locator(".replay-network path");
        await expect(paths).toHaveCount(drives.length, { timeout: 30000 });
        assert.ok(requests.length >= 15);
        assert.ok(
          requests.every(
            (body) => body.ids.length <= 200 && body.account === "row:fixture",
          ),
        );
        const prior = requests.length;
        await page.getByLabel("Time range").selectOption("7");
        await expect(paths).toHaveCount(10);
        assert.equal(requests.length, prior + 1);
        assert.deepEqual(
          requests.at(-1).ids,
          drives
            .slice(2990)
            .map((drive) => drive.id)
            .sort(),
        );
        assert.deepEqual(errors, []);
        mkdirSync("test-results", { recursive: true });
        await page.screenshot({
          path: "test-results/replay-selection.png",
          fullPage: true,
        });
        checks.push({
          check:
            "production browser replay tolerates delayed batches and refreshes after time filter",
          route_requests: requests.length,
        });
      } finally {
        await browser.close();
      }
      const output =
        process.env.WAZEX_E2E_OUTPUT || "test-results/replay-selection.json";
      mkdirSync(resolve(output, ".."), { recursive: true });
      writeFileSync(
        output,
        JSON.stringify({ ok: true, checks }, null, 2) + "\n",
      );
    } finally {
      await stop();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
