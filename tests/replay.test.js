import test from "node:test";
import assert from "node:assert/strict";
import { projectRoutes } from "../src/replay-geometry.js";
import { createStore } from "../server/store.js";

test("replay uses one projection, chronological order and ignores invalid geometry", () => {
  const routes = projectRoutes([
    {
      id: "later",
      start: 2,
      points: [
        [103.1, 1.1],
        [103.2, 1.2],
      ],
    },
    {
      id: "earlier",
      start: 1,
      points: [
        [103, 1],
        [103.1, 1.1],
      ],
    },
    {
      id: "invalid",
      start: 0,
      points: [
        [Infinity, 1],
        [103, 100],
      ],
    },
  ]);
  assert.deepEqual(
    routes.map((r) => r.id),
    ["earlier", "later"],
  );
  assert.equal(
    routes[0].path.split("L")[1],
    routes[1].path.split(" ")[0].slice(1),
  );
  for (const route of routes)
    for (const pair of route.path.matchAll(/[ML]([\d.]+),([\d.]+)/g)) {
      assert.ok(Number(pair[1]) >= 20 && Number(pair[1]) <= 580);
      assert.ok(Number(pair[2]) >= 20 && Number(pair[2]) <= 290);
    }
  assert.deepEqual(projectRoutes([]), []);
  assert.ok(
    !projectRoutes([
      {
        id: "point",
        start: 0,
        points: [
          [1, 1],
          [1, 1],
        ],
      },
    ])[0].path.includes("NaN"),
  );
});

test("route batch is scoped to account and excludes empty and zero-distance drives", () => {
  const store = createStore(":memory:");
  try {
    const a = store.account({ id: 1, userName: "one" }, "row").id;
    const b = store.account({ id: 2, userName: "two" }, "row").id;
    for (const [account, id, meters, detail] of [
      [a, "route", 10, true],
      [a, "zero", 0, true],
      [a, "summary", 10, false],
      [b, "private", 10, true],
    ]) {
      store.save(account, {
        id,
        startTime: 1,
        endTime: 2,
        totalRoadMeters: meters,
      });
      if (detail)
        store.detail(account, id, {
          coordinates: [
            [1, 2],
            [2, 3],
          ],
        });
    }
    assert.deepEqual(
      store.routes(a).map((r) => r.id),
      ["route"],
    );
    assert.equal(store.drives(a).length, 2);
  } finally {
    store.db.close();
  }
});
