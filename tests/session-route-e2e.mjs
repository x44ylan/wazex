// End-to-end check for connection-event logging and abandoning unservable routes.
// Failure modes covered: legacy route_retries table without attempts breaks
// startup; a persistently failing route warns forever or is dropped too early;
// abandoned routes are still fetched; a later success for a retried route is
// lost; session expiry is not recorded, loses reason/status, or disappears on
// restart; recovering the session is not recorded. No real Waze requests.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CookieJar } from "tough-cookie";
import { SessionVault } from "../server/session-vault.js";

const directory = await mkdtemp(join(tmpdir(), "wazex-session-route-"));
const faultsFile = join(directory, "faults.json");
const dbFile = join(directory, "wazex.sqlite");
const port = 4317;
const base = `http://127.0.0.1:${port}`;
const output = resolve(
  process.env.WAZEX_VERIFY_OUTPUT || "test-results/session-route",
);
await mkdir(output, { recursive: true });
const checks = {};
const jar = new CookieJar();
await jar.setCookie(
  "_web_session=fixture-approved; Path=/; Secure; HttpOnly",
  "https://www.waze.com",
);
new SessionVault(directory).save(await jar.serialize());

// Legacy schema exactly as deployed before this change.
const legacy = new DatabaseSync(dbFile);
legacy.exec(`CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL);
  CREATE TABLE drives (account TEXT NOT NULL REFERENCES accounts(id), id TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER, meters REAL NOT NULL, summary TEXT NOT NULL, detail TEXT, saved_at TEXT NOT NULL, PRIMARY KEY(account,id));
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE route_retries (account TEXT NOT NULL, id TEXT NOT NULL, next_at INTEGER NOT NULL, error TEXT NOT NULL, PRIMARY KEY(account,id), FOREIGN KEY(account,id) REFERENCES drives(account,id));`);
legacy.exec(`INSERT INTO accounts VALUES ('row:fixture-account','Fixture driver','row');
  INSERT INTO settings VALUES ('activeAccount','"row:fixture-account"'),('autoSync','false'),('syncCadence','"weekly"');
  INSERT INTO drives VALUES ('row:fixture-account','fixture-drive',1000,61000,1200,'{"id":"fixture-drive","startTime":1000,"endTime":61000,"totalRoadMeters":1200,"hasFullSession":true}',NULL,'2026-01-01T00:00:00Z');
  INSERT INTO route_retries VALUES ('row:fixture-account','fixture-drive',0,'Waze returned HTTP 500. Please retry later.');`);
legacy.close();

let child;
const logs = [];
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
        "--user",
        `${process.getuid()}:${process.getgid()}`,
        "-v",
        `${directory}:/fixture-data`,
        "-v",
        `${resolve("tests/fixtures")}:/fixtures:ro`,
        "-e",
        `PORT=${port}`,
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
    env: {
      ...process.env,
      PORT: String(port),
      WAZEX_DATA_DIR: directory,
      WAZEX_FIXTURE_FAULTS: faultsFile,
      WAZEX_PUBLIC_ORIGIN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => logs.push(d.toString()));
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error("startup timeout")), 15000);
    child.stdout.on("data", (d) => {
      logs.push(d.toString());
      if (d.toString().includes("listening")) {
        clearTimeout(timer);
        ok();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`server exited ${code}: ${logs.join("")}`));
    });
  });
  for (let i = 0; i < 200; i++) {
    const s = await status();
    if (s.connectionState !== "checking") return s;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error("connection check timeout");
}
const status = async () => (await fetch(`${base}/api/status`)).json();
async function sync() {
  const s0 = await status();
  const res = await fetch(`${base}/api/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Wazex-Token": s0.token,
      Origin: base,
    },
    body: "{}",
  });
  assert.ok(res.ok, `sync request ${res.status} ${await res.text()}`);
  for (let i = 0; i < 300; i++) {
    const s = await status();
    if (!s.running && s.runs[0]?.status !== "running") return s;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error("sync timeout");
}
// Retries are scheduled a week out; make them due without touching attempts.
async function makeRetriesDue() {
  await stop();
  const db = new DatabaseSync(dbFile);
  db.prepare("UPDATE route_retries SET next_at = 0").run();
  db.close();
}
const retry = () => {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return db.prepare("SELECT * FROM route_retries").get();
  } finally {
    db.close();
  }
};

try {
  // Legacy row counts as attempt 1. Attempt 2 must still warn.
  await faults({ detail: 500 });
  const first = await start();
  assert.equal(first.connectionState, "connected");
  assert.equal(first.connectionEvents[0].source, "startup");
  checks.legacy_schema_migrates = retry().attempts === 1;
  let s = await sync();
  assert.equal(s.runs[0].status, "partial");
  assert.match(s.runs[0].error, /1 routes unavailable: Waze returned HTTP 500/);
  assert.equal(retry().attempts, 2);
  checks.second_failure_still_warns = true;

  // Attempt 3 hits the limit: run completes, route stays without detail.
  await makeRetriesDue();
  await start();
  s = await sync();
  assert.equal(s.runs[0].status, "complete", s.runs[0].error);
  assert.equal(s.lastError, null);
  assert.equal(retry().attempts, 3);
  checks.third_failure_abandons_quietly = true;

  // Abandoned route is not fetched again even when due and Waze now succeeds.
  await makeRetriesDue();
  await faults({});
  await start();
  s = await sync();
  assert.equal(s.runs[0].status, "complete");
  const drive = await (await fetch(`${base}/api/drives/fixture-drive`)).json();
  assert.equal(drive.detail, null);
  assert.equal(retry().attempts, 3);
  checks.abandoned_route_not_refetched = true;

  // Session expiry is recorded with reason/status and survives restart.
  await faults({ session: 401 });
  s = await sync();
  assert.equal(s.connectionState, "expired");
  const expired = s.connectionEvents[0];
  assert.equal(expired.state, "expired");
  assert.equal(expired.previous, "connected");
  assert.equal(expired.source, "sync");
  assert.equal(expired.reason, "unauthorized");
  assert.equal(expired.status, 401);
  assert.ok(expired.last_verified && expired.connected_since);
  assert.ok(logs.join("").includes("wazex connection connected -> expired"));
  checks.expiry_recorded_with_reason = true;
  await stop();
  await faults({});
  s = await start();
  const persisted = s.connectionEvents.find((e) => e.id === expired.id);
  assert.ok(persisted, "expiry event survives restart");
  assert.equal(s.connectionEvents[0].state, "connected");
  assert.equal(s.connectionEvents[0].previous, "checking");
  checks.events_survive_restart = true;
  checks.recovery_recorded = true;
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      {
        image: process.env.WAZEX_VERIFY_IMAGE || null,
        checks,
        events: s.connectionEvents,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(checks));
} catch (error) {
  console.error(logs.join(""));
  throw error;
} finally {
  await stop();
}
