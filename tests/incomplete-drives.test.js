import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "../server/store.js";
import { syncDrives } from "../server/sync.js";
import { analyze, driveSeconds } from "../src/analytics.js";

test("unknown and reversed durations never contribute negative driving time or speed", () => {
  const rows = [
    { start: 1000, end: null, meters: 10 },
    { start: 1000, end: 0, meters: 20 },
    { start: 1000, end: Infinity, meters: 30 },
    { start: 1000, end: 1000, meters: 40 },
    { start: 1000, end: 61000, meters: 1200 },
  ];
  assert.deepEqual(rows.map(driveSeconds), [null, null, null, 0, 60]);
  const stats = analyze(rows, "UTC");
  assert.equal(stats.seconds, 60);
  assert.equal(stats.averageSpeed, 72);
  assert.equal(stats.incomplete, 3);
});

test("reported Waze total stops pagination before its clamped final page and fetches routes", async () => {
  const store = createStore(":memory:");
  const offsets = [];
  const drive = {
    id: "one",
    startTime: 1000,
    endTime: 61000,
    totalRoadMeters: 1200,
    hasFullSession: true,
  };
  const client = {
    session: async () => ({ id: 1, userName: "fixture" }),
    list: async (_, offset) => {
      offsets.push(offset);
      return { rows: [drive], total: 1 };
    },
    detail: async () => ({
      coordinates: [
        [1, 2],
        [2, 3],
      ],
    }),
  };
  try {
    const result = await syncDrives({ store, client, region: "row" });
    assert.deepEqual(offsets, [0]);
    assert.equal(result.fetched, 1);
    assert.equal(store.runs()[0].status, "complete");
  } finally {
    store.close();
  }
});

test("Waze records without endTime are archived, do not stop pagination, and upgrade without losing complete records", async () => {
  const store = createStore(":memory:");
  const sparse = {
    id: "sparse",
    startTime: 1000,
    totalRoadMeters: 0,
    hasFullSession: true,
  };
  const complete = {
    id: "complete",
    startTime: 1000,
    endTime: 61000,
    totalRoadMeters: 1200,
  };
  const client = {
    session: async () => ({ id: 1, userName: "fixture" }),
    list: async (_, offset) =>
      offset === 0 ? [sparse] : offset === 1 ? [complete] : [],
    detail: async () => ({
      coordinates: [
        [1, 2],
        [2, 3],
      ],
    }),
  };
  try {
    const result = await syncDrives({ store, client, region: "row" });
    assert.equal(result.seen, 2);
    assert.equal(result.added, 2);
    assert.equal(store.drive("row:1", "sparse").end, null);
    assert.deepEqual(store.export("row:1")[0].endTime, undefined);
    const stats = analyze(store.drives("row:1"));
    assert.deepEqual(
      store.drives("row:1").map((d) => d.id),
      ["complete"],
    );
    assert.equal(stats.seconds, 60);
    assert.equal(stats.incomplete, 0);
    assert.equal(stats.averageSpeed, 72);
    store.save("row:1", { ...sparse, endTime: 121000, totalRoadMeters: 2400 });
    store.save("row:1", sparse);
    await syncDrives({ store, client, region: "row" });
    assert.equal(store.drive("row:1", "sparse").end, 121000);
    assert.equal(store.drive("row:1", "sparse").meters, 2400);
    assert.ok(store.drive("row:1", "sparse").detail);
    assert.equal(store.drives("row:1").length, 2);
    assert.equal(analyze(store.drives("row:1")).incomplete, 0);
  } finally {
    store.close();
  }
});

test("zero-distance drives stay in backups while positive distances remain visible", () => {
  const store = createStore(":memory:");
  try {
    store.account({ id: 1, userName: "fixture" }, "row");
    for (const [id, meters] of [
      ["zero", 0],
      ["tiny", 0.1],
    ]) {
      store.save("row:1", {
        id,
        startTime: 1000,
        endTime: 61000,
        totalRoadMeters: meters,
      });
    }
    assert.deepEqual(
      store.drives("row:1").map((d) => d.id),
      ["tiny"],
    );
    assert.equal(store.export("row:1").length, 2);
    assert.equal(store.drive("row:1", "zero").meters, 0);
  } finally {
    store.close();
  }
});

test("legacy archive migration preserves complete drives and route details while allowing unknown end times", () => {
  const directory = mkdtempSync(join(tmpdir(), "wazex-migration-"));
  const filename = join(directory, "archive.sqlite");
  const legacy = new DatabaseSync(filename);
  legacy.exec(`CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL);
    INSERT INTO accounts VALUES ('row:1','fixture','row');
    CREATE TABLE drives (account TEXT NOT NULL REFERENCES accounts(id), id TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, meters REAL NOT NULL, summary TEXT NOT NULL, detail TEXT, saved_at TEXT NOT NULL, PRIMARY KEY(account,id));`);
  const raw = {
    id: "old",
    startTime: 1000,
    endTime: 61000,
    totalRoadMeters: 1200,
  };
  legacy.prepare("INSERT INTO drives VALUES (?,?,?,?,?,?,?,?)").run(
    "row:1",
    "old",
    1000,
    61000,
    1200,
    JSON.stringify(raw),
    JSON.stringify({
      coordinates: [
        [1, 2],
        [2, 3],
      ],
    }),
    "2026-01-01T00:00:00Z",
  );
  legacy.close();
  let store;
  try {
    store = createStore(filename);
    assert.equal(store.drive("row:1", "old").end, 61000);
    assert.deepEqual(store.drive("row:1", "old").detail.coordinates, [
      [1, 2],
      [2, 3],
    ]);
    store.save("row:1", { id: "new", startTime: 1000, totalRoadMeters: 0 });
    assert.equal(store.drives("row:1").length, 1);
    store.close();
    store = null;
    store = createStore(filename);
    assert.equal(store.drive("row:1", "new").end, null);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
