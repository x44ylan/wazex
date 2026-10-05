import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.js";
import { syncDrives } from "../server/sync.js";
import { SYNC_INTERVAL_MS } from "../server/recovery.js";

test("saved and zero-distance routes are skipped; failed routes retry once due and progress counts unavailable routes", async () => {
  const store = createStore(":memory:");
  const rows = ["saved", "missing", "zero"].map((id) => ({
    id,
    startTime: 1000,
    endTime: 61000,
    totalRoadMeters: id === "zero" ? 0 : 1200,
    hasFullSession: true,
  }));
  let clock = 10000;
  const calls = [],
    progress = [];
  const client = {
    session: async () => ({ id: 1, userName: "fixture" }),
    list: async () => ({ rows, total: 3 }),
    detail: async (_, id) => {
      calls.push(id);
      if (id === "missing" && clock < SYNC_INTERVAL_MS)
        throw Object.assign(new Error("unavailable"), { status: 404 });
      return {
        coordinates: [
          [1, 2],
          [2, 3],
        ],
      };
    },
  };
  const run = () =>
    syncDrives({
      store,
      client,
      region: "row",
      now: () => clock,
      sleep: async () => {},
      onProgress: (value) => progress.push(value),
    });
  try {
    await run();
    assert.deepEqual(calls, ["saved", "missing"]);
    assert.equal(progress.at(-1).processed, 2);
    assert.equal(progress.at(-1).fetched, 1);
    assert.equal(store.pendingDetails("row:1", clock).length, 0);
    await run();
    assert.deepEqual(calls, ["saved", "missing"]);
    clock += SYNC_INTERVAL_MS;
    await run();
    assert.deepEqual(calls, ["saved", "missing", "missing"]);
    assert.ok(store.drive("row:1", "missing").detail);
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS count FROM route_retries").get()
        .count,
      0,
    );
    await run();
    assert.equal(calls.length, 3);
  } finally {
    store.close();
  }
});
