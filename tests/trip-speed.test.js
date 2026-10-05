import test from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/analytics.js";

const trip = (speed, seconds = 3600) => ({
  start: 1000,
  end: 1000 + seconds * 1000,
  meters: (speed * seconds) / 3.6,
});
function assertTripSpeed(actual, expected) {
  assert.equal(actual.samples, expected.samples);
  for (const key of ["median", "lower", "upper"])
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9, `${key} differs`);
}

test("typical trip speed uses median and quartiles instead of letting a long paused session dominate", () => {
  const stats = analyze(
    [trip(20), trip(30), trip(40), trip(50), trip(1, 36000)],
    "UTC",
  );
  assertTripSpeed(stats.tripSpeed, {
    median: 30,
    lower: 20,
    upper: 40,
    samples: 5,
  });
  assert.ok(stats.averageSpeed < 11);
});

test("zero distance, zero duration and unknown or reversed times do not imply a stopped or infinite trip speed", () => {
  const stats = analyze(
    [
      trip(30),
      trip(0),
      { start: 1000, end: null, meters: 1200 },
      { start: 1000, end: 1000, meters: 1200 },
      { start: 1000, end: 0, meters: 1200 },
    ],
    "UTC",
  );
  assertTripSpeed(stats.tripSpeed, {
    median: 30,
    lower: 30,
    upper: 30,
    samples: 1,
  });
  assert.equal(analyze([]).tripSpeed, null);
  assert.equal(analyze([trip(0)]).tripSpeed, null);
});

test("even sample sizes interpolate median and quartiles and summaries follow the supplied drive selection", () => {
  assertTripSpeed(analyze([trip(10), trip(30)], "UTC").tripSpeed, {
    median: 20,
    lower: 15,
    upper: 25,
    samples: 2,
  });
  assert.equal(analyze([trip(10)], "UTC").tripSpeed.median, 10);
});
