import test from "node:test";
import assert from "node:assert/strict";
import { WazeClient } from "../server/waze-direct.js";
import { createStore, normalizeDrive } from "../server/store.js";

test("connector consumes response bodies on success, expiry, and malformed JSON", async () => {
  for (const status of [200, 401, 403, 500]) {
    let disposed = false;
    const client = new WazeClient(null, {
      fetcher: async (url) => {
        assert.ok(
          url.startsWith("https://www.waze.com/row-Descartes/app/Session"),
        );
        return {
          status,
          ok: status === 200,
          headers: new Headers({ "content-type": "application/json" }),
          text: async () => {
            disposed = true;
            return JSON.stringify({ id: 42, userName: "test" });
          },
        };
      },
    });
    if (status === 200) assert.equal((await client.session("row")).id, 42);
    else
      await assert.rejects(
        client.session("row"),
        (error) => status !== 403 || error.code !== "AUTH_REQUIRED",
      );
    assert.equal(disposed, true);
  }
  let disposed = false;
  const client = new WazeClient(null, {
    fetcher: async () => ({
      status: 200,
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => {
        disposed = true;
        return "Invalid JSON";
      },
    }),
  });
  await assert.rejects(client.session("row"), /unreadable/);
  assert.equal(disposed, true);
});

test("missing numeric fields and out-of-range dates are rejected before storage", () => {
  const valid = { id: "a", startTime: 1000, endTime: 2000, totalRoadMeters: 0 };
  assert.equal(normalizeDrive(valid).meters, 0);
  for (const bad of [null, "", "1000", NaN, Infinity, 8640000000000001]) {
    assert.throws(() => normalizeDrive({ ...valid, startTime: bad }));
  }
  assert.throws(() => normalizeDrive({ ...valid, totalRoadMeters: null }));
});

test("empty route payloads remain eligible for a later retry", () => {
  const s = createStore(":memory:");
  try {
    s.account({ id: 1, userName: "test" }, "row");
    s.save("row:1", {
      id: "a",
      startTime: 1000,
      endTime: 2000,
      totalRoadMeters: 1,
      hasFullSession: true,
    });
    assert.throws(() => s.detail("row:1", "a", null));
    assert.equal(s.pendingDetails("row:1").length, 1);
    assert.equal(s.drive("row:1", "a").detail, null);
  } finally {
    s.close();
  }
});
