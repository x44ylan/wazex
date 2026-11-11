// Verify both trusted public origins and rejection of untrusted hosts/origins.
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "wazex-origin-"));
const port = 14310;
const processChild = spawn(process.execPath, ["server/index.js"], {
  env: {
    ...process.env,
    PORT: String(port),
    WAZEX_DATA_DIR: directory,
    WAZEX_PUBLIC_ORIGIN: "https://tail.example:4310",
    WAZEX_ADDITIONAL_ORIGINS: "https://wazex.example",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("startup timed out")),
      10000,
    );
    processChild.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    processChild.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}`));
    });
  });
  const call = (host, origin, method = "GET", token = "") =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/status",
          method,
          headers: {
            host,
            ...(origin ? { origin } : {}),
            ...(token ? { "x-wazex-token": token } : {}),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              json: async () => JSON.parse(data),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  for (const [host, origin] of [
    ["tail.example:4310", "https://tail.example:4310"],
    ["wazex.example", "https://wazex.example"],
  ]) {
    const status = await call(host, origin);
    assert.equal(status.status, 200);
    const token = (await status.json()).token;
    // POST reaches routing (404), proving host, origin and CSRF guards accepted it.
    assert.equal((await call(host, origin, "POST", token)).status, 404);
    assert.equal((await call(host, origin, "POST")).status, 403);
  }
  assert.equal(
    (await call("evil.example", "https://wazex.example")).status,
    403,
  );
  assert.equal(
    (await call("wazex.example", "https://evil.example")).status,
    403,
  );
  assert.equal(
    (await call("wazex.example", "http://wazex.example")).status,
    403,
  );
  console.log(
    "Both public origins accepted; untrusted hosts, origins and missing CSRF token rejected.",
  );
} finally {
  processChild.kill();
  await new Promise((resolve) => processChild.once("exit", resolve));
  await rm(directory, { recursive: true, force: true });
}
