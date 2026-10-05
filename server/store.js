import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SYNC_INTERVAL_MS } from "./recovery.js";

export function normalizeDrive(d) {
  d ??= {};
  const start = Number(d.startTime),
    end = d.endTime == null ? null : Number(d.endTime),
    meters = Number(d.totalRoadMeters);
  if (
    !d ||
    !d.id ||
    typeof d.id !== "string" ||
    typeof d.startTime !== "number" ||
    (d.endTime != null && typeof d.endTime !== "number") ||
    typeof d.totalRoadMeters !== "number" ||
    !Number.isFinite(start) ||
    start < 0 ||
    start > 8640000000000000 ||
    (end !== null &&
      (!Number.isFinite(end) || end < start || end > 8640000000000000)) ||
    !Number.isFinite(meters) ||
    meters < 0
  )
    throw Object.assign(
      new Error("Waze returned an invalid drive. Saved data is retained."),
      { code: "INVALID_DRIVE" },
    );
  return { id: d.id, start, end, meters, hasFullSession: !!d.hasFullSession };
}

export function createStore(filename) {
  if (filename !== ":memory:")
    mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS drives (account TEXT NOT NULL REFERENCES accounts(id), id TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER, meters REAL NOT NULL, summary TEXT NOT NULL, detail TEXT, saved_at TEXT NOT NULL, PRIMARY KEY(account,id));
    CREATE INDEX IF NOT EXISTS drives_by_time ON drives(account,start);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sync_runs (id INTEGER PRIMARY KEY, account TEXT, started TEXT NOT NULL, finished TEXT, status TEXT NOT NULL, added INTEGER NOT NULL DEFAULT 0, seen INTEGER NOT NULL DEFAULT 0, error TEXT);
    CREATE TABLE IF NOT EXISTS pending_drives (account TEXT NOT NULL REFERENCES accounts(id), source TEXT NOT NULL, error TEXT NOT NULL, PRIMARY KEY(account,source));
    CREATE TABLE IF NOT EXISTS route_retries (account TEXT NOT NULL, id TEXT NOT NULL, next_at INTEGER NOT NULL, error TEXT NOT NULL, PRIMARY KEY(account,id), FOREIGN KEY(account,id) REFERENCES drives(account,id));`);
  if (
    db
      .prepare("PRAGMA table_info(drives)")
      .all()
      .find((column) => column.name === "end").notnull
  ) {
    db.exec(`BEGIN;
      CREATE TABLE drives_nullable (account TEXT NOT NULL REFERENCES accounts(id), id TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER, meters REAL NOT NULL, summary TEXT NOT NULL, detail TEXT, saved_at TEXT NOT NULL, PRIMARY KEY(account,id));
      INSERT INTO drives_nullable SELECT * FROM drives;
      DROP TABLE drives;
      ALTER TABLE drives_nullable RENAME TO drives;
      CREATE INDEX drives_by_time ON drives(account,start);
      COMMIT;`);
  }
  const put = db.prepare(
    `INSERT INTO drives(account,id,start,end,meters,summary,saved_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(account,id) DO UPDATE SET start=excluded.start,end=excluded.end,meters=excluded.meters,summary=excluded.summary`,
  );
  return {
    db,
    set(key, value) {
      db.prepare(
        "INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(key, JSON.stringify(value));
    },
    get(key, fallback = null) {
      const r = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
      return r ? JSON.parse(r.value) : fallback;
    },
    account(user, region) {
      const id = `${region}:${user.id}`;
      db.prepare(
        "INSERT INTO accounts VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name",
      ).run(id, user.userName, region);
      return { id, name: user.userName, region };
    },
    accounts() {
      return db.prepare("SELECT * FROM accounts ORDER BY name").all();
    },
    save(account, raw) {
      const d = normalizeDrive(raw);
      const existing = db
        .prepare("SELECT end FROM drives WHERE account=? AND id=?")
        .get(account, d.id);
      db.prepare(
        "DELETE FROM pending_drives WHERE account=? AND json_extract(source,'$.id')=?",
      ).run(account, d.id);
      // A sparse Waze record must not erase an already archived complete drive.
      if (existing?.end != null && d.end === null) return false;
      put.run(
        account,
        d.id,
        d.start,
        d.end,
        d.meters,
        JSON.stringify(raw),
        new Date().toISOString(),
      );
      return !existing;
    },
    deferDrive(account, raw, error) {
      db.prepare(
        "INSERT INTO pending_drives VALUES (?,?,?) ON CONFLICT(account,source) DO UPDATE SET error=excluded.error",
      ).run(account, JSON.stringify(raw), error);
    },
    pendingDrives(account) {
      return db
        .prepare("SELECT source FROM pending_drives WHERE account=?")
        .all(account);
    },
    detail(account, id, data) {
      if (
        data === null ||
        typeof data !== "object" ||
        Object.keys(data).length === 0
      )
        throw new Error(
          "Waze returned no route details. Retry on the next sync.",
        );
      db.prepare("UPDATE drives SET detail=? WHERE account=? AND id=?").run(
        JSON.stringify(data),
        account,
        id,
      );
      db.prepare("DELETE FROM route_retries WHERE account=? AND id=?").run(
        account,
        id,
      );
    },
    deferDetail(account, id, error, now = Date.now()) {
      db.prepare(
        "INSERT INTO route_retries VALUES (?,?,?,?) ON CONFLICT(account,id) DO UPDATE SET next_at=excluded.next_at,error=excluded.error",
      ).run(account, id, now + SYNC_INTERVAL_MS, error);
    },
    drive(account, id) {
      const d = db
        .prepare("SELECT * FROM drives WHERE account=? AND id=?")
        .get(account, id);
      return d
        ? {
            ...d,
            summary: JSON.parse(d.summary),
            detail: d.detail ? JSON.parse(d.detail) : null,
          }
        : null;
    },
    drives(account) {
      return db
        .prepare(
          "SELECT id,start,end,meters,saved_at,detail IS NOT NULL AS hasDetail FROM drives WHERE account=? AND meters > 0 ORDER BY start DESC",
        )
        .all(account);
    },
    routes(account, ids) {
      if (ids?.length === 0) return [];
      const selection =
        ids === undefined ? "" : ` AND id IN (${ids.map(() => "?").join(",")})`;
      return db
        .prepare(
          `SELECT id,start,detail FROM drives WHERE account=? AND meters>0 AND detail IS NOT NULL${selection} ORDER BY start ASC,id ASC`,
        )
        .all(account, ...(ids || []));
    },
    pendingDetails(account, now = Date.now()) {
      return db
        .prepare(
          "SELECT d.id,d.summary FROM drives d LEFT JOIN route_retries r ON r.account=d.account AND r.id=d.id WHERE d.account=? AND d.detail IS NULL AND d.meters > 0 AND (r.next_at IS NULL OR r.next_at<=?) ORDER BY d.start ASC",
        )
        .all(account, now)
        .filter((d) => JSON.parse(d.summary).hasFullSession);
    },
    runs() {
      return db
        .prepare("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 10")
        .all();
    },
    startRun(account) {
      return Number(
        db
          .prepare(
            "INSERT INTO sync_runs(account,started,status) VALUES (?,?,'running')",
          )
          .run(account, new Date().toISOString()).lastInsertRowid,
      );
    },
    finishRun(id, status, added, seen, error = null) {
      db.prepare(
        "UPDATE sync_runs SET finished=?,status=?,added=?,seen=?,error=? WHERE id=?",
      ).run(new Date().toISOString(), status, added, seen, error, id);
    },
    recoverRuns() {
      db.prepare(
        "UPDATE sync_runs SET status='interrupted',finished=?,error='Server stopped during sync; saved drives are retained. Run sync again.' WHERE status='running'",
      ).run(new Date().toISOString());
    },
    export(account) {
      return db
        .prepare("SELECT * FROM drives WHERE account=? ORDER BY start")
        .all(account)
        .map((d) => ({
          ...JSON.parse(d.summary),
          detail: d.detail ? JSON.parse(d.detail) : null,
          savedAt: d.saved_at,
        }));
    },
    close() {
      db.close();
    },
  };
}
