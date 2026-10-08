import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { CookieJar } from "tough-cookie";
import { SessionVault } from "../server/session-vault.js";
import { createStore } from "../server/store.js";

// Failure cases: session verification loses 403, a partial sync hides the route
// error, reload/restart drops warnings, successful recovery leaves stale errors,
// replay discards HTTP errors, HTML 403 causes a JSON parser error, failed actions
// hide another active warning, mobile overflow, real Waze requests, browser errors.
const directory = await mkdtemp(join(tmpdir(), "wazex-errors-"));
const faultsFile = join(directory, "faults.json");
const base = "http://127.0.0.1:4316";
const output = resolve(
  process.env.WAZEX_VERIFY_OUTPUT || "test-results/error-visibility",
);
await mkdir(output, { recursive: true });
const jar = new CookieJar();
await jar.setCookie(
  "_web_session=fixture-approved; Path=/; Secure; HttpOnly",
  "https://www.waze.com",
);
new SessionVault(directory).save(await jar.serialize());
const store = createStore(join(directory, "wazex.sqlite"));
store.account({ id: "fixture-account", userName: "Fixture driver" }, "row");
store.set("activeAccount", "row:fixture-account");
store.set("autoSync", false);
store.close();
let child, browser;
const errors = [],
  checks = {};
const faults = (value) => writeFile(faultsFile, JSON.stringify(value));
async function stop() {
  if (child?.exitCode === null) {
    const exited = new Promise((ok) => child.once("exit", ok));
    child.kill();
    await exited;
  }
}
async function start() {
  const image = process.env.WAZEX_VERIFY_IMAGE;
  const args = image
    ? [
        "run",
        "--rm",
        "--network=host",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--tmpfs=/tmp",
        "-v",
        `${directory}:/fixture-data`,
        "-v",
        `${resolve("tests/fixtures")}:/fixtures:ro`,
        "-e",
        "PORT=4316",
        "-e",
        "WAZEX_DATA_DIR=/fixture-data",
        "-e",
        "WAZEX_FIXTURE_FAULTS=/fixture-data/faults.json",
        "--entrypoint=node",
        image,
        "--import",
        "/fixtures/error-http.mjs",
        "/app/server/index.js",
      ]
    : ["--import", "./tests/fixtures/error-http.mjs", "server/index.js"];
  child = spawn(image ? "docker" : process.execPath, args, {
    cwd: resolve("."),
    env: {
      ...process.env,
      PORT: "4316",
      WAZEX_DATA_DIR: directory,
      WAZEX_FIXTURE_FAULTS: faultsFile,
      WAZEX_PUBLIC_ORIGIN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((ok, fail) => {
    const timer = setTimeout(
      () => fail(new Error("Fixture server startup timeout")),
      10000,
    );
    child.stdout.on("data", (data) => {
      if (data.toString().includes("listening")) {
        clearTimeout(timer);
        ok();
      }
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      fail(e);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`Fixture server exited ${code}`));
    });
  });
  for (let i = 0; i < 100; i++) {
    const s = await status();
    if (s.connectionState !== "checking") return s;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error("Fixture connection check timeout");
}
async function status() {
  return (await fetch(`${base}/api/status`)).json();
}
async function waitSync() {
  for (let i = 0; i < 100; i++) {
    const s = await status();
    if (!s.running && s.runs.length) return s;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error("Fixture sync timeout");
}
try {
  await faults({ session: 403 });
  const blocked = await start();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  assert.equal(blocked.connectionState, "unknown");
  assert.match(blocked.connectionError || "", /HTTP 403/);
  await page
    .getByRole("alert")
    .filter({ hasText: /Waze connection:.*HTTP 403/ })
    .waitFor();
  checks.connection_403_visible = true;
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(
      await page
        .getByRole("alert")
        .filter({ hasText: /HTTP 403/ })
        .isVisible(),
    );
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
  }
  checks.desktop_and_phone = true;
  await faults({ detail: 403, slowDetails: true });
  await page.getByRole("button", { name: "Connections & settings" }).click();
  await page.getByRole("button", { name: "Check saved session" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /Waze connection:/ })
    .waitFor({ state: "hidden" });
  checks.connection_recovery = true;
  await page
    .getByRole("button", { name: "Sync drives", exact: true })
    .first()
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: /Waze routes:.*HTTP 403/ })
    .waitFor();
  assert.equal((await status()).running, true);
  checks.route_error_visible_during_sync = true;
  const partial = await waitSync();
  assert.equal(partial.runs[0].status, "partial");
  assert.match(partial.lastError || "", /HTTP 403/);
  assert.match(partial.runs[0].error, /HTTP 403/);
  await page
    .getByRole("alert")
    .filter({ hasText: /HTTP 403/ })
    .waitFor();
  assert.equal(
    await page
      .locator(".alert.success")
      .filter({ hasText: /Archive updated|routes unavailable/ })
      .count(),
    0,
  );
  checks.partial_sync_403_visible = true;
  await page.reload();
  await page
    .getByRole("alert")
    .filter({ hasText: /HTTP 403/ })
    .waitFor();
  await page.screenshot({
    path: join(output, "route-warning.png"),
    fullPage: true,
  });
  checks.reload_warning = true;
  await stop();
  await start();
  assert.match((await status()).lastError || "", /HTTP 403/);
  await page.reload();
  await page
    .getByRole("alert")
    .filter({ hasText: /HTTP 403/ })
    .waitFor();
  checks.restart_warning = true;
  await faults({ list: 403 });
  await page
    .getByRole("button", { name: "Sync drives", exact: true })
    .first()
    .click();
  assert.equal((await waitSync()).runs[0].status, "failed");
  await page
    .getByRole("alert")
    .filter({ hasText: /HTTP 403/ })
    .waitFor();
  checks.failed_sync_visible = true;
  await stop();
  const retryStore = createStore(join(directory, "wazex.sqlite"));
  retryStore.db.prepare("UPDATE route_retries SET next_at = 0").run();
  retryStore.close();
  await faults({});
  await start();
  await page.reload();
  await page
    .getByRole("button", { name: "Sync drives", exact: true })
    .first()
    .click();
  const complete = await waitSync();
  assert.equal(complete.runs[0].status, "complete");
  assert.equal(complete.lastError, null);
  await page
    .getByRole("alert")
    .filter({ hasText: /HTTP 403/ })
    .waitFor({ state: "hidden" });
  checks.success_clears_warning = true;
  await page.route("**/api/routes**", (route) =>
    route.fulfill({
      status: 403,
      json: { error: "Refresh the page and try again." },
    }),
  );
  await page.reload();
  await page
    .getByRole("alert")
    .filter({ hasText: /Refresh the page and try again/ })
    .waitFor();
  checks.replay_403_visible = true;
  await page.unroute("**/api/routes**");
  await page.route("**/api/status", (route) =>
    route.fulfill({
      status: 403,
      contentType: "text/html",
      body: "<h1>Forbidden</h1>",
    }),
  );
  await page.reload();
  await page
    .getByRole("alert")
    .filter({ hasText: /HTTP 403/ })
    .waitFor();
  assert.equal(await page.getByText(/Unexpected token|JSON/).count(), 0);
  checks.html_403_visible = true;
  assert.deepEqual(errors, []);
  checks.no_browser_errors = true;
  await writeFile(
    join(output, "verification.json"),
    JSON.stringify(
      { passed: true, image: process.env.WAZEX_VERIFY_IMAGE || null, checks },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ passed: true, checks, output }, null, 2));
} finally {
  await browser?.close();
  await stop();
  await rm(directory, { recursive: true, force: true });
}
