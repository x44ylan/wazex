import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test(
  "server finishes QR approval and archives drives without a dashboard polling; reconnect syncs once",
  { timeout: 30000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "wazex-background-"));
    const base = "http://127.0.0.1:4312";
    const child = spawn(
      process.execPath,
      ["--import", "./tests/fixtures/waze-http.mjs", "server/index.js"],
      {
        cwd: resolve("."),
        windowsHide: true,
        env: { ...process.env, PORT: "4312", WAZEX_DATA_DIR: directory },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    try {
      await new Promise((ok, fail) => {
        const timeout = setTimeout(
          () => fail(new Error("Fixture server did not start")),
          10000,
        );
        child.stdout.on("data", (chunk) => {
          if (chunk.toString().includes("listening")) {
            clearTimeout(timeout);
            ok();
          }
        });
        child.once("error", (error) => {
          clearTimeout(timeout);
          fail(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          fail(new Error(`Fixture server exited ${code}`));
        });
      });
      const status = async () => (await fetch(`${base}/api/status`)).json();
      const token = (await status()).token;
      const post = async (path, body = {}) => {
        const response = await fetch(`${base}/api${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Wazex-Token": token,
          },
          body: JSON.stringify(body),
        });
        assert.equal(response.ok, true);
        return response.json();
      };
      async function waitForRuns(count) {
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
          // GET status never polls Waze or finalizes approval.
          const s = await status();
          if (
            !s.running &&
            s.runs.length === count &&
            s.runs.every((run) => run.status === "complete")
          )
            return s;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("Background approval/sync did not finish");
      }
      assert.equal(
        (await post("/login", { region: "row" })).state,
        "token_created",
      );
      const s = await waitForRuns(1);
      assert.equal(s.connected.id, "row:fixture-account");
      assert.ok(existsSync(join(directory, "waze-session.enc")));
      const rows = await (await fetch(`${base}/api/drives`)).json();
      assert.equal(rows.length, 1);
      const drive = await (
        await fetch(`${base}/api/drives/fixture-drive`)
      ).json();
      assert.deepEqual(drive.detail.coordinates, [
        [1, 2],
        [2, 3],
      ]);
      // A second approval of the same account must still trigger a sync.
      await post("/login", { region: "row" });
      await waitForRuns(2);
      await Promise.all([post("/login/status"), post("/login/status")]);
      assert.equal(
        (await status()).runs.length,
        2,
        "Repeated UI polling must not start duplicate syncs",
      );
      assert.equal(
        (await (await fetch(`${base}/api/drives`)).json()).length,
        1,
      );
    } finally {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill();
        await exited;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
