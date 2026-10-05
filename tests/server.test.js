import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test(
  "HTTP backup restore is atomic, idempotent, and survives server restart",
  { timeout: 30000 },
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wazex-test-"));
    const base = "http://127.0.0.1:4311";
    let child;
    async function start() {
      child = spawn(
        process.execPath,
        ["server/index.js", "--public-origin=https://wazex.example.test:8443"],
        {
          cwd: resolve("."),
          env: {
            ...process.env,
            PORT: "4311",
            WAZEX_DATA_DIR: dataDir,
            WAZEX_PUBLIC_ORIGIN: "https://wazex.example.test:8443",
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      await new Promise((ok, fail) => {
        const timeout = setTimeout(
          () => fail(new Error("Test server failed to start")),
          10000,
        );
        child.stdout.on("data", (chunk) => {
          if (chunk.toString().includes("listening")) {
            clearTimeout(timeout);
            ok();
          }
        });
        child.once("error", (e) => {
          clearTimeout(timeout);
          fail(e);
        });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          if (code) fail(new Error(`Test server exited ${code}`));
        });
      });
      return (await (await fetch(`${base}/api/status`)).json()).token;
    }
    async function stop() {
      if (child && child.exitCode === null) {
        const exited = new Promise((r) => child.once("exit", r));
        child.kill();
        await exited;
      }
    }
    const backup = {
      format: "wazex",
      version: 1,
      account: { id: "row:test", name: "Test account", region: "row" },
      drives: [
        {
          id: "test-drive",
          startTime: 1000,
          endTime: 61000,
          totalRoadMeters: 1200,
          hasFullSession: true,
          detail: {
            coordinates: [
              [1, 2],
              [2, 3],
            ],
          },
        },
      ],
    };
    try {
      let token = await start();
      async function post(path, body, t = token) {
        return fetch(`${base}/api${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Wazex-Token": t },
          body: JSON.stringify(body),
        });
      }
      assert.equal(
        (await post("/settings", { autoSync: false }, "wrong")).status,
        403,
      );
      assert.equal((await post("/settings", { autoSync: false })).status, 200);
      assert.equal(
        (
          await fetch(`${base}/api/settings`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Wazex-Token": token,
              Origin: "https://wazex.example.test:8443",
              Host: "wazex.example.test:8443",
            },
            body: JSON.stringify({ autoSync: false }),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${base}/api/status`, {
            headers: { Origin: "https://example.com" },
          })
        ).status,
        403,
      );
      assert.equal((await (await post("/import", backup)).json()).added, 1);
      assert.equal((await (await post("/import", backup)).json()).added, 0);
      const malformed = {
        ...backup,
        drives: [
          ...backup.drives,
          { ...backup.drives[0], id: "would-rollback" },
          { id: "invalid" },
        ],
      };
      assert.equal((await post("/import", malformed)).status, 400);
      const rows = await (await fetch(`${base}/api/drives`)).json();
      assert.equal(rows.length, 1);
      const routes = await (await fetch(`${base}/api/routes`)).json();
      assert.deepEqual(routes, [
        {
          id: "test-drive",
          start: 1000,
          points: backup.drives[0].detail.coordinates,
        },
      ]);
      assert.equal(
        (await fetch(`${base}/api/routes?account=unknown`)).status,
        400,
      );
      const exported = await (await fetch(`${base}/api/export`)).json();
      assert.deepEqual(exported.drives[0].detail, backup.drives[0].detail);
      await stop();
      token = await start();
      assert.equal(
        (await (await fetch(`${base}/api/drives`)).json()).length,
        1,
      );
      const restored = await (
        await fetch(`${base}/api/drives/test-drive`)
      ).json();
      assert.equal(restored.meters, 1200);
    } finally {
      await stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);
