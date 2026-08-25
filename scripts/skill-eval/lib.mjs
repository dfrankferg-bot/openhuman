// Stage-0 statistics for the skill-eval harness.
//
// Stage 0 answers exactly one question: *can this eval tell the current skill
// document apart from no skill at all?* If it cannot, the eval is blind and
// every dollar spent optimizing against it buys noise. Nothing here optimizes
// anything — it only measures whether a signal exists.
//
// Zero dependencies — Node 22 stdlib only.

/** Deterministic PRNG (mulberry32). Seeded so every run reproduces exactly. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Derive a stable child seed from a base seed and some labels (FNV-1a).
 * Every rollout gets its own stream, so a sweep reproduces exactly while no
 * two arms accidentally share a random sequence.
 */
export function deriveSeed(base, ...parts) {
  let h = 0x811c9dc5 ^ (base >>> 0);
  for (const part of parts) {
    const s = String(part);
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h = Math.imul(h ^ 0x2f, 0x01000193) >>> 0; // separator, so ("ab","c") != ("a","bc")
  }
  return h >>> 0;
}

export function mean(xs) {
  if (!Array.isArray(xs) || xs.length === 0) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/**
 * Sample standard deviation (n-1). Returns null for fewer than two points —
 * a single run tells you nothing about run-to-run noise, and pretending
 * otherwise is how people ship results that were coin flips.
 */
export function stddev(xs) {
  if (!Array.isArray(xs) || xs.length < 2) return null;
  const m = mean(xs);
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/**
 * Two-sided permutation test on the difference of means.
 *
 * Chosen over a t-test because rollout scores are bounded, discrete and
 * usually not normal at these sample sizes. Makes no distributional
 * assumption: pool the observations, reshuffle the arm labels, and ask how
 * often chance alone reproduces a gap this large.
 *
 * The +1 in the p-value is the standard Davison-Hinkley correction; it keeps
 * p strictly positive, because "we sampled 10k shuffles and none beat it"
 * is evidence, not proof of impossibility.
 */
export function permutationTest(a, b, { iterations = 10000, seed = 1 } = {}) {
  if (
    !Array.isArray(a) ||
    !Array.isArray(b) ||
    a.length === 0 ||
    b.length === 0
  ) {
    return { observedDiff: null, p: null, iterations: 0, insufficient: true };
  }
  const observedDiff = mean(a) - mean(b);
  const pooled = [...a, ...b];
  const nA = a.length;
  const rng = mulberry32(seed);
  let atLeastAsExtreme = 0;

  for (let i = 0; i < iterations; i += 1) {
    // Fisher-Yates over a copy; first nA entries become the synthetic arm A.
    const shuffled = pooled.slice();
    for (let j = shuffled.length - 1; j > 0; j -= 1) {
      const k = Math.floor(rng() * (j + 1));
      [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
    }
    const diff = mean(shuffled.slice(0, nA)) - mean(shuffled.slice(nA));
    if (Math.abs(diff) >= Math.abs(observedDiff)) atLeastAsExtreme += 1;
  }

  return {
    observedDiff,
    p: (atLeastAsExtreme + 1) / (iterations + 1),
    iterations,
    insufficient: false,
  };
}

/** Collapse one arm's per-run scores into the numbers a verdict needs. */
export function summarizeArm(name, runScores) {
  return {
    name,
    runs: runScores.length,
    mean: mean(runScores),
    stddev: stddev(runScores),
    scores: runScores,
  };
}

/**
 * Compare two arms. `noiseFloor` is the larger of the two arms' run-to-run
 * standard deviations: a gap smaller than the noise you already measured is
 * not a finding, however pretty its p-value.
 */
export function compareArms(armA, armB, { iterations = 10000, seed = 1 } = {}) {
  const test = permutationTest(armA.scores, armB.scores, { iterations, seed });
  const noiseFloor = Math.max(armA.stddev ?? 0, armB.stddev ?? 0);
  const diff = test.observedDiff;
  return {
    a: armA.name,
    b: armB.name,
    diff,
    p: test.p,
    noiseFloor,
    exceedsNoise: diff === null ? false : Math.abs(diff) > noiseFloor,
    insufficient: test.insufficient,
  };
}

/**
 * The stage-0 gate.
 *
 * Sensitive requires BOTH: the gap is unlikely under chance (p < alpha) AND
 * it is bigger than the measured run-to-run noise. Either alone is how a
 * blind eval passes for a sighted one.
 */
export function verdict(comparisons, { alpha = 0.05 } = {}) {
  const reasons = [];
  let sensitive = true;

  for (const c of comparisons) {
    const label = `${c.a} vs ${c.b}`;
    if (c.insufficient) {
      sensitive = false;
      reasons.push(`${label}: not enough runs to test`);
      continue;
    }
    if (c.p >= alpha) {
      sensitive = false;
      reasons.push(
        `${label}: gap ${c.diff.toFixed(3)} is within chance (p=${c.p.toFixed(4)} >= ${alpha})`,
      );
      continue;
    }
    if (!c.exceedsNoise) {
      sensitive = false;
      reasons.push(
        `${label}: gap ${c.diff.toFixed(3)} does not clear the noise floor ${c.noiseFloor.toFixed(3)}`,
      );
      continue;
    }
    reasons.push(
      `${label}: gap ${c.diff.toFixed(3)} clears noise ${c.noiseFloor.toFixed(3)} (p=${c.p.toFixed(4)})`,
    );
  }

  return { sensitive, reasons };
}
