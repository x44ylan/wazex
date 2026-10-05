import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CookieJar } from "tough-cookie";
import { SessionVault } from "../server/session-vault.js";

test(
  "saved login is verified after restarts; temporary failures differ from expired authentication",
  { timeout: 30000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "wazex-restore-"));
    const jar = new CookieJar();
    await jar.setCookie(
      "_web_session=fixture-approved; Path=/; Secure; HttpOnly",
      "https://www.waze.com",
    );
    new SessionVault(directory).save(await jar.serialize());
    let child;
    async function stop() {
      if (child?.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill();
        await exited;
      }
    }
    async function start(code = "") {
      child = spawn(
        process.execPath,
        ["--import", "./tests/fixtures/waze-http.mjs", "server/index.js"],
        {
          cwd: resolve("."),
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            PORT: "4313",
            WAZEX_DATA_DIR: directory,
            WAZEX_FIXTURE_SESSION_STATUS: code,
          },
        },
      );
      await new Promise((ok, fail) => {
        const timeout = setTimeout(
          () => fail(new Error("Restore test did not start")),
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
          fail(new Error(`Restore server exited ${code}`));
        });
      });
      for (let i = 0; i < 50; i++) {
        const state = await (
          await fetch("http://127.0.0.1:4313/api/status")
        ).json();
        if (state.connectionState !== "checking") return state;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("Saved session was never checked");
    }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const s = await start();
        assert.equal(s.connectionState, "connected");
        assert.equal(s.connected.id, "row:fixture-account");
        await stop();
      }
      const blocked = await start("403");
      assert.equal(blocked.connectionState, "unknown");
      await stop();
      const expired = await start("401");
      assert.equal(expired.connectionState, "expired");
      assert.equal(expired.connected, null);
    } finally {
      await stop();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
