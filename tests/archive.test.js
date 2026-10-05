import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.js";
import { syncDrives } from "../server/sync.js";
import { analyze, routeCoordinates } from "../src/analytics.js";

const drive = (id, t = 1000) => ({
  id,
  startTime: t,
  endTime: t + 3600000,
  totalRoadMeters: 12000,
  hasFullSession: true,
});
function mock(pages, user = 1) {
  return {
    session: async () => ({ id: user, userName: `user${user}` }),
    list: async (r, offset) => pages[offset] || [],
    detail: async () => ({
      geometry: {
        type: "LineString",
        coordinates: [
          [103, 1],
          [103.1, 1.1],
        ],
      },
    }),
  };
}
test("pagination archives all pages, survives repeats, retains drives after source expiry, and isolates accounts", async () => {
  const s = createStore(":memory:");
  try {
    const r = await syncDrives({
      store: s,
      client: mock({ 0: [drive("a"), drive("b")], 2: [drive("c")] }),
      region: "row",
    });
    assert.equal(r.added, 3);
    assert.equal(r.seen, 3);
    assert.equal(r.fetched, 3);
    await syncDrives({
      store: s,
      client: mock({ 0: [drive("c"), drive("d")] }),
      region: "row",
    });
    assert.equal(s.drives("row:1").length, 4);
    assert.ok(s.drive("row:1", "a").detail);
    await syncDrives({
      store: s,
      client: mock({ 0: [drive("a")] }, 2),
      region: "row",
    });
    assert.equal(s.drives("row:2").length, 1);
    assert.equal(s.drives("row:1").length, 4);
    assert.equal(s.export("row:1").length, 4);
  } finally {
    s.close();
  }
});
test("a failed page keeps already saved drives and records failure", async () => {
  const s = createStore(":memory:");
  const c = mock({ 0: [drive("a")] });
  c.list = async (r, offset) => {
    if (offset) throw new Error("network unavailable");
    return [drive("a")];
  };
  try {
    await assert.rejects(
      syncDrives({ store: s, client: c, region: "row" }),
      /network/,
    );
    assert.equal(s.drives("row:1").length, 1);
    assert.equal(s.runs()[0].status, "failed");
  } finally {
    s.close();
  }
});
test("missing details retry next sync without erasing archived geometry", async () => {
  const s = createStore(":memory:");
  const c = mock({ 0: [drive("a")] });
  c.detail = async () => {
    throw new Error("route not available");
  };
  try {
    const r = await syncDrives({ store: s, client: c, region: "row" });
    assert.equal(r.routeErrors, 1);
    assert.equal(s.runs()[0].status, "partial");
    await syncDrives({
      store: s,
      client: mock({}),
      region: "row",
      now: () => Date.now() + 7 * 86400000,
    });
    assert.ok(s.drive("row:1", "a").detail);
  } finally {
    s.close();
  }
});
test("repeated source pages fail explicitly rather than claim a complete archive", async () => {
  const s = createStore(":memory:");
  const c = mock({});
  c.list = async () => [drive("a")];
  try {
    await assert.rejects(
      syncDrives({ store: s, client: c, region: "row" }),
      /repeated/,
    );
    assert.equal(s.runs()[0].status, "failed");
  } finally {
    s.close();
  }
});
test("invalid drive data cannot overwrite a saved drive", () => {
  const s = createStore(":memory:");
  try {
    s.account({ id: 1, userName: "test" }, "row");
    s.save("row:1", drive("a"));
    assert.throws(() => s.save("row:1", { ...drive("a"), endTime: -1 }));
    assert.equal(s.drive("row:1", "a").meters, 12000);
  } finally {
    s.close();
  }
});
test("statistics use requested timezone and compute time-weighted average speed", () => {
  const a = analyze(
    [
      {
        id: "a",
        start: Date.parse("2026-10-03T23:00:00Z"),
        end: Date.parse("2026-10-04T00:00:00Z"),
        meters: 12000,
      },
      {
        id: "b",
        start: Date.parse("2026-10-04T01:00:00Z"),
        end: Date.parse("2026-10-04T03:00:00Z"),
        meters: 6000,
      },
    ],
    "Asia/Singapore",
  );
  assert.equal(a.activeDays, 1);
  assert.equal(a.meters, 18000);
  assert.equal(a.seconds, 10800);
  assert.equal(a.averageSpeed, 6);
  assert.equal(a.days[0].date, "2026-10-04");
  assert.equal(a.hours[7], 1);
  assert.equal(analyze([]).averageSpeed, 0);
});
test("route extraction recognizes nested GeoJSON without treating bounding boxes as paths", () => {
  assert.deepEqual(
    routeCoordinates({
      route: {
        geometry: {
          type: "LineString",
          coordinates: [
            [103, 1],
            [103.1, 1.1],
          ],
        },
      },
    }),
    [
      [103, 1],
      [103.1, 1.1],
    ],
  );
  assert.deepEqual(routeCoordinates(null), []);
});
