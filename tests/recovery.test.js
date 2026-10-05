import test from "node:test";
import assert from "node:assert/strict";
import {
  retryRead,
  recoveryAfter,
  SYNC_INTERVAL_MS,
} from "../server/recovery.js";
import { createStore } from "../server/store.js";
import { syncDrives } from "../server/sync.js";

const drive = {
  id: "good",
  startTime: 1000,
  endTime: 61000,
  totalRoadMeters: 1200,
  hasFullSession: true,
};
const noWait = async () => {};

test("temporary read errors retry with bounded backoff; auth and missing routes stop immediately", async () => {
  const delays = [];
  let calls = 0;
  assert.equal(
    await retryRead(
      async () => {
        if (++calls < 3)
          throw Object.assign(new Error("busy"), { status: 503 });
        return "saved";
      },
      { sleep: async (delay) => delays.push(delay) },
    ),
    "saved",
  );
  assert.deepEqual(delays, [1000, 2000]);
  for (const metadata of [{ code: "AUTH_REQUIRED" }, { status: 404 }]) {
    calls = 0;
    await assert.rejects(
      retryRead(
        async () => {
          calls++;
          throw Object.assign(new Error("unavailable"), metadata);
        },
        { sleep: noWait },
      ),
    );
    assert.equal(calls, 1);
  }
  calls = 0;
  await assert.rejects(
    retryRead(
      async () => {
        calls++;
        throw new Error("offline");
      },
      { sleep: noWait },
    ),
  );
  assert.equal(calls, 3);
});

test("session, pages and empty routes recover in the same sync without duplicates", async () => {
  const store = createStore(":memory:");
  let sessions = 0,
    pages = 0,
    routes = 0;
  const client = {
    session: async () => {
      if (++sessions === 1) throw new Error("offline");
      return { id: 1, userName: "fixture" };
    },
    list: async () => {
      if (++pages === 1) throw new Error("offline");
      return { rows: [drive], total: 1 };
    },
    detail: async () =>
      ++routes === 1
        ? {}
        : {
            coordinates: [
              [1, 2],
              [2, 3],
            ],
          },
  };
  try {
    const result = await syncDrives({
      store,
      client,
      region: "row",
      sleep: noWait,
    });
    assert.equal(result.warning, null);
    assert.equal(store.drives("row:1").length, 1);
    assert.equal(store.runs()[0].status, "complete");
    assert.deepEqual([sessions, pages, routes], [2, 2, 2]);
  } finally {
    store.close();
  }
});

test("invalid source records do not block healthy drives and leave saved values untouched; corrected records clear recovery", async () => {
  const store = createStore(":memory:");
  let rows = [{ ...drive, endTime: -1 }, null, { ...drive, id: "another" }];
  const client = {
    session: async () => ({ id: 1, userName: "fixture" }),
    list: async () => ({ rows, total: rows.length }),
    detail: async () => ({
      coordinates: [
        [1, 2],
        [2, 3],
      ],
    }),
  };
  try {
    store.account({ id: 1, userName: "fixture" }, "row");
    store.save("row:1", drive);
    const result = await syncDrives({
      store,
      client,
      region: "row",
      sleep: noWait,
    });
    assert.equal(result.invalidDrives, 2);
    assert.equal(store.drive("row:1", "good").end, 61000);
    assert.ok(store.drive("row:1", "another").detail);
    assert.equal(store.runs()[0].status, "partial");
    rows = [drive];
    await syncDrives({ store, client, region: "row", sleep: noWait });
    assert.equal(store.pendingDrives("row:1").length, 1);
    assert.equal(JSON.parse(store.pendingDrives("row:1")[0].source), null);
  } finally {
    store.close();
  }
});

test("automatic recovery stays weekly and survives settings storage", () => {
  const store = createStore(":memory:");
  try {
    let schedule = recoveryAfter(null, 1000);
    assert.equal(schedule.nextAt, 1000 + SYNC_INTERVAL_MS);
    store.set("syncRecovery", schedule);
    schedule = recoveryAfter(store.get("syncRecovery"), 1000);
    assert.equal(schedule.nextAt, 1000 + SYNC_INTERVAL_MS);
    for (let i = 0; i < 12; i++) schedule = recoveryAfter(schedule, 1000);
    assert.equal(schedule.nextAt, 1000 + SYNC_INTERVAL_MS);
    store.set("syncRecovery", null);
    assert.equal(store.get("syncRecovery"), null);
  } finally {
    store.close();
  }
});
