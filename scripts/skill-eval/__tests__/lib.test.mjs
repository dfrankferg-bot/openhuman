import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mulberry32,
  deriveSeed,
  mean,
  stddev,
  permutationTest,
  summarizeArm,
  compareArms,
  verdict,
} from "../lib.mjs";

test("mulberry32 is deterministic for a given seed", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  assert.ok(seqA.every((x) => x >= 0 && x < 1));
});

test("mulberry32 diverges for different seeds", () => {
  const a = mulberry32(1);
  const b = mulberry32(2);
  assert.notEqual(a(), b());
});

test("deriveSeed is stable and label-sensitive", () => {
  assert.equal(
    deriveSeed(1, "current", 0, "t1"),
    deriveSeed(1, "current", 0, "t1"),
  );
  assert.notEqual(
    deriveSeed(1, "current", 0, "t1"),
    deriveSeed(1, "none", 0, "t1"),
  );
  assert.notEqual(
    deriveSeed(1, "current", 0, "t1"),
    deriveSeed(2, "current", 0, "t1"),
  );
  // Separator guards against label concatenation collisions.
  assert.notEqual(deriveSeed(1, "ab", "c"), deriveSeed(1, "a", "bc"));
});

test("mean handles empty input", () => {
  assert.equal(mean([]), null);
  assert.equal(mean([1, 2, 3]), 2);
});

test("stddev refuses fewer than two points", () => {
  assert.equal(stddev([]), null);
  assert.equal(stddev([0.5]), null, "one run cannot measure run-to-run noise");
  assert.ok(Math.abs(stddev([1, 3]) - 1.4142135) < 1e-6);
});

test("permutationTest returns p=1 for identical arms", () => {
  const r = permutationTest([0.5, 0.5, 0.5], [0.5, 0.5, 0.5], {
    iterations: 500,
  });
  assert.equal(r.observedDiff, 0);
  assert.equal(r.p, 1, "a zero gap is matched or beaten by every shuffle");
});

test("permutationTest detects a clean separation", () => {
  const r = permutationTest([1, 1, 1, 1], [0, 0, 0, 0], { iterations: 5000 });
  assert.equal(r.observedDiff, 1);
  assert.ok(r.p < 0.05, `expected small p, got ${r.p}`);
});

test("permutationTest p is never zero", () => {
  const r = permutationTest([1, 1, 1, 1, 1], [0, 0, 0, 0, 0], {
    iterations: 100,
  });
  assert.ok(r.p > 0, "Davison-Hinkley correction keeps p strictly positive");
});

test("permutationTest flags insufficient data instead of guessing", () => {
  const r = permutationTest([], [1, 2], { iterations: 10 });
  assert.equal(r.insufficient, true);
  assert.equal(r.p, null);
});

test("permutationTest is reproducible across calls with the same seed", () => {
  const opts = { iterations: 1000, seed: 99 };
  const a = permutationTest([0.9, 0.8, 0.85], [0.3, 0.25, 0.35], opts);
  const b = permutationTest([0.9, 0.8, 0.85], [0.3, 0.25, 0.35], opts);
  assert.equal(a.p, b.p);
});

test("summarizeArm collects the numbers a verdict needs", () => {
  const s = summarizeArm("current", [0.8, 0.9]);
  assert.equal(s.name, "current");
  assert.equal(s.runs, 2);
  assert.ok(Math.abs(s.mean - 0.85) < 1e-9);
  assert.ok(s.stddev > 0);
});

test("compareArms reports the noise floor as the larger arm stddev", () => {
  const a = summarizeArm("current", [0.9, 0.9, 0.9]);
  const b = summarizeArm("none", [0.1, 0.5, 0.3]);
  const c = compareArms(a, b, { iterations: 500 });
  assert.ok(Math.abs(c.noiseFloor - b.stddev) < 1e-9);
  assert.ok(c.exceedsNoise);
});

test("verdict fails a gap that is inside the noise", () => {
  const d = verdict([
    {
      a: "current",
      b: "none",
      diff: 0.01,
      p: 0.001,
      noiseFloor: 0.2,
      exceedsNoise: false,
      insufficient: false,
    },
  ]);
  assert.equal(d.sensitive, false);
  assert.match(d.reasons[0], /noise floor/);
});

test("verdict fails a gap that could be chance", () => {
  const d = verdict([
    {
      a: "current",
      b: "none",
      diff: 0.4,
      p: 0.4,
      noiseFloor: 0.01,
      exceedsNoise: true,
      insufficient: false,
    },
  ]);
  assert.equal(d.sensitive, false);
  assert.match(d.reasons[0], /within chance/);
});

test("verdict fails on insufficient data", () => {
  const d = verdict([
    {
      a: "current",
      b: "none",
      diff: null,
      p: null,
      noiseFloor: 0,
      exceedsNoise: false,
      insufficient: true,
    },
  ]);
  assert.equal(d.sensitive, false);
  assert.match(d.reasons[0], /not enough runs/);
});

test("verdict passes only when both conditions hold", () => {
  const d = verdict([
    {
      a: "current",
      b: "none",
      diff: 0.5,
      p: 0.001,
      noiseFloor: 0.05,
      exceedsNoise: true,
      insufficient: false,
    },
  ]);
  assert.equal(d.sensitive, true);
});

test("verdict requires every comparison to pass", () => {
  const d = verdict([
    {
      a: "current",
      b: "none",
      diff: 0.5,
      p: 0.001,
      noiseFloor: 0.05,
      exceedsNoise: true,
      insufficient: false,
    },
    {
      a: "current",
      b: "degraded",
      diff: 0.02,
      p: 0.6,
      noiseFloor: 0.05,
      exceedsNoise: false,
      insufficient: false,
    },
  ]);
  assert.equal(d.sensitive, false);
});
