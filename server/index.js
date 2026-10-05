import express from "express";
import { resolve, join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.js";
import { routeCoordinates } from "../src/analytics.js";
import { WazeClient } from "./waze-direct.js";
import { SessionVault } from "./session-vault.js";
import { syncDrives, REGIONS } from "./sync.js";
import { recoveryAfter, SYNC_INTERVAL_MS } from "./recovery.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dataDir = resolve(process.env.WAZEX_DATA_DIR || join(root, "data"));
mkdirSync(dataDir, { recursive: true });
const store = createStore(join(dataDir, "wazex.sqlite"));
store.recoverRuns();
if (store.get("syncCadence") !== "weekly") {
  if (store.get("syncRecovery"))
    store.set("syncRecovery", recoveryAfter(store.get("syncRecovery")));
  store.set("syncCadence", "weekly");
}
if (
  !store.get("syncRecovery") &&
  store.runs().some((run) => run.status === "interrupted")
)
  store.set("syncRecovery", recoveryAfter(null));
const client = new WazeClient(new SessionVault(dataDir));
const app = express();
const port = Number(process.env.PORT || 4310);
const token = randomBytes(32).toString("hex");
const originOption =
  process.argv
    .find((arg) => arg.startsWith("--public-origin="))
    ?.slice("--public-origin=".length) || process.env.WAZEX_PUBLIC_ORIGIN;
const publicOrigin = originOption ? new URL(originOption).origin : null;
let running = false,
  progress = null,
  connected = null,
  lastError = null;
let connecting = false,
  lastAttempt = 0;
let approvalHandled = false;
let connectionState = "checking";
async function verifyConnection() {
  try {
    const user = await client.session(region());
    connected = store.account(user, region());
    store.set("activeAccount", connected.id);
    connectionState = "connected";
    return connected;
  } catch (error) {
    if (error.code === "AUTH_REQUIRED") {
      connected = null;
      connectionState = "expired";
    } else connectionState = "unknown";
    throw error;
  }
}
app.disable("x-powered-by");
app.use((req, res, next) => {
  const allowedHosts = [
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    "127.0.0.1:5173",
    "localhost:5173",
    ...(publicOrigin ? [new URL(publicOrigin).host] : []),
  ];
  const allowedOrigins = [
    ...allowedHosts
      .filter((h) => !publicOrigin || h !== new URL(publicOrigin).host)
      .map((h) => `http://${h}`),
    ...(publicOrigin ? [publicOrigin] : []),
  ];
  if (!allowedHosts.includes(req.headers.host))
    return res.status(403).json({ error: "Invalid host" });
  if (req.headers.origin && !allowedOrigins.includes(req.headers.origin))
    return res.status(403).json({ error: "Invalid origin" });
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (
    req.path.startsWith("/api") &&
    !["GET", "HEAD"].includes(req.method) &&
    req.headers["x-wazex-token"] !== token
  )
    return res.status(403).json({ error: "Refresh the page and try again." });
  next();
});
app.use(express.json({ limit: "50mb" }));
const region = () => store.get("region", "row");
const account = (req) => {
  const id = req.query.account || store.get("activeAccount");
  if (id && !store.accounts().some((a) => a.id === id))
    throw new Error("Unknown archive account");
  return id;
};
async function sync() {
  if (running || connecting)
    throw new Error("A sync or sign-in is already running.");
  running = true;
  lastError = null;
  progress = { phase: "connecting", added: 0, seen: 0 };
  lastAttempt = Date.now();
  try {
    const result = await syncDrives({
      store,
      client,
      region: region(),
      onAccount: (account) => {
        connected = account;
        connectionState = "connected";
      },
      onProgress: (p) => {
        progress = p;
      },
    });
    connected = result.account;
    store.set(
      "syncRecovery",
      result.warning ? recoveryAfter(store.get("syncRecovery")) : null,
    );
    return result;
  } catch (error) {
    lastError = error.message;
    if (error.code === "AUTH_REQUIRED") {
      connected = null;
      connectionState = "expired";
    }
    store.set(
      "syncRecovery",
      error.code === "AUTH_REQUIRED"
        ? null
        : recoveryAfter(store.get("syncRecovery")),
    );
    throw error;
  } finally {
    running = false;
    progress = null;
  }
}
async function pollApproval() {
  if (connecting) return client.loginStatus();
  const state = await client.pollLogin();
  if (state.state === "connected" && state.account && !approvalHandled) {
    approvalHandled = true;
    store.set("region", state.region);
    connected = store.account(state.account, state.region);
    connectionState = "connected";
    store.set("activeAccount", connected.id);
    lastError = null;
    void sync().catch(() => {});
  }
  return state;
}
app.get("/api/status", (req, res) =>
  res.json({
    token,
    publicOrigin,
    connected,
    connectionState,
    activeAccount: store.get("activeAccount"),
    accounts: store.accounts(),
    region: region(),
    running,
    connecting,
    login: client.loginStatus(),
    progress,
    lastError,
    lastSync: store.get("lastSync"),
    autoSync: store.get("autoSync", true),
    syncHours: 168,
    recovery: store.get("syncRecovery"),
    runs: store.runs(),
  }),
);
app.post("/api/login", async (req, res) => {
  if (running || connecting)
    return res
      .status(409)
      .json({ error: "Wait for the current operation to finish." });
  const r = req.body.region || region();
  if (!REGIONS[r]) return res.status(400).json({ error: "Invalid region" });
  connecting = true;
  try {
    const state = await client.beginLogin(r);
    approvalHandled = false;
    res.json(state);
  } finally {
    connecting = false;
  }
});
app.post("/api/login/status", async (req, res) => {
  if (connecting)
    return res
      .status(409)
      .json({ error: "Wait for the login challenge to finish loading." });
  res.json(await pollApproval());
});
app.post("/api/login/cancel", (req, res) => {
  client.cancelLogin();
  res.json({ canceled: true });
});
app.post("/api/connection", async (req, res) => {
  if (running || connecting)
    return res
      .status(409)
      .json({ error: "Wait for the current operation to finish." });
  await verifyConnection();
  lastError = null;
  res.json(connected);
});
app.post("/api/disconnect", async (req, res) => {
  if (running || connecting)
    return res
      .status(409)
      .json({ error: "Wait for the current operation to finish." });
  client.disconnect();
  connected = null;
  connectionState = "disconnected";
  store.set("autoSync", false);
  store.set("syncRecovery", null);
  res.json({ disconnected: true });
});
app.post("/api/sync", (req, res) => {
  if (["token_created", "token_read"].includes(client.loginStatus().state))
    return res
      .status(409)
      .json({ error: "Complete or cancel QR sign-in before syncing." });
  if (running || connecting)
    return res
      .status(409)
      .json({ error: "A sync or sign-in is already running." });
  void sync().catch(() => {});
  res.status(202).json({ started: true });
});
app.post("/api/settings", (req, res) => {
  if (typeof req.body.autoSync !== "boolean")
    return res.status(400).json({ error: "Invalid setting" });
  store.set("autoSync", req.body.autoSync);
  res.json({ saved: true });
});
app.get("/api/routes", (req, res) => {
  const id = account(req);
  res.json(
    id
      ? store
          .routes(id)
          .map(({ id, start, detail }) => ({
            id,
            start,
            points: routeCoordinates(JSON.parse(detail)),
          }))
          .filter((route) => route.points.length > 1)
      : [],
  );
});
app.get("/api/drives", (req, res) => {
  const id = account(req);
  res.json(id ? store.drives(id) : []);
});
app.get("/api/drives/:id", (req, res) => {
  const id = account(req);
  const drive = id ? store.drive(id, req.params.id) : null;
  drive ? res.json(drive) : res.status(404).json({ error: "Drive not found" });
});
app.get("/api/export", (req, res) => {
  const id = account(req);
  if (!id) return res.status(400).json({ error: "Select an archive first." });
  res.attachment("wazex-archive.json").json({
    format: "wazex",
    version: 1,
    exportedAt: new Date().toISOString(),
    account: store.accounts().find((a) => a.id === id),
    drives: store.export(id),
  });
});
app.post("/api/import", (req, res) => {
  if (running || connecting)
    return res
      .status(409)
      .json({ error: "Wait for sync to finish before importing." });
  const { format, version, account: a, drives } = req.body;
  if (
    format !== "wazex" ||
    version !== 1 ||
    !a ||
    !REGIONS[a.region] ||
    typeof a.name !== "string" ||
    !a.id?.startsWith(`${a.region}:`) ||
    !Array.isArray(drives) ||
    drives.length > 100000
  )
    return res.status(400).json({ error: "Choose a wazex JSON backup." });
  let added = 0;
  store.db.exec("BEGIN");
  try {
    store.account(
      { id: a.id.slice(a.region.length + 1), userName: a.name },
      a.region,
    );
    for (const d of drives) {
      if (store.save(a.id, d)) added++;
      if (d.detail != null) store.detail(a.id, d.id, d.detail);
    }
    store.set("activeAccount", a.id);
    store.db.exec("COMMIT");
    res.json({ added, seen: drives.length, account: a.id });
  } catch (e) {
    store.db.exec("ROLLBACK");
    throw e;
  }
});
const dist = join(root, "dist");
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get("/{*path}", (req, res, next) =>
    req.path.startsWith("/api")
      ? next()
      : res.sendFile(join(dist, "index.html")),
  );
}
app.use((err, req, res, next) =>
  res
    .status(err.status || 400)
    .json({ error: err.message || "Request failed" }),
);
const server = app.listen(port, "127.0.0.1", () =>
  console.log(`wazex listening on http://127.0.0.1:${port}`),
);
void (async () => {
  if (await client.hasSession()) await verifyConnection();
  else connectionState = "disconnected";
})().catch(() => {});
const loginInterval = setInterval(() => {
  if (
    !connecting &&
    ["token_created", "token_read"].includes(client.loginStatus().state)
  )
    void pollApproval().catch((error) => {
      lastError = error.message;
    });
}, 3000);
const interval = setInterval(() => {
  const last = store.get("lastSync");
  const recovery = store.get("syncRecovery");
  if (
    store.get("activeAccount") &&
    store.get("autoSync", true) &&
    !running &&
    !connecting &&
    connectionState !== "expired" &&
    connectionState !== "disconnected" &&
    !["token_created", "token_read"].includes(client.loginStatus().state) &&
    (recovery
      ? Date.now() >= recovery.nextAt
      : Date.now() - lastAttempt >= SYNC_INTERVAL_MS &&
        (!last || Date.now() - Date.parse(last) >= SYNC_INTERVAL_MS))
  )
    void sync().catch(() => {});
}, 60000);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(interval);
  clearInterval(loginInterval);
  server.close();
  await client.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
