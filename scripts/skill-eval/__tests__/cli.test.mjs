import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  parseArgs,
  DEFAULTS,
  loadTasks,
  defaultSkillPath,
  runSweep,
  buildComparisons,
  formatReport,
} from "../cli.mjs";
import { verdict } from "../lib.mjs";
import { GITHUB_ISSUE_CRUSHER_RULES } from "../rubric.mjs";
import { buildArms } from "../arms.mjs";
import { fakeRunner, parseTrajectory } from "../runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const realSkill = readFileSync(
  defaultSkillPath("github-issue-crusher"),
  "utf8",
);

test("parseArgs returns the defaults for an empty argv", () => {
  assert.deepEqual(parseArgs([]), { ...DEFAULTS });
});

test("parseArgs reads values", () => {
  const o = parseArgs([
    "--skill",
    "x",
    "--runs",
    "12",
    "--seed",
    "9",
    "--alpha",
    "0.01",
  ]);
  assert.equal(o.skill, "x");
  assert.equal(o.runs, 12);
  assert.equal(o.seed, 9);
  assert.equal(o.alpha, 0.01);
});

test("parseArgs rejects a run count that cannot measure noise", () => {
  assert.throws(() => parseArgs(["--runs", "1"]), /cannot measure noise/);
});

test("parseArgs rejects an unknown runner", () => {
  assert.throws(() => parseArgs(["--runner", "wishful"]), /--runner must be/);
});

test("parseArgs requires --exec-cmd with the exec runner", () => {
  assert.throws(() => parseArgs(["--runner", "exec"]), /requires --exec-cmd/);
  assert.doesNotThrow(() =>
    parseArgs(["--runner", "exec", "--exec-cmd", "true"]),
  );
});

test("parseArgs rejects a flag with no value and unknown flags", () => {
  assert.throws(() => parseArgs(["--skill"]), /requires a value/);
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
});

test("loadTasks reads the starter set", () => {
  const tasks = loadTasks();
  assert.ok(tasks.length >= 2);
  assert.ok(tasks.every((t) => typeof t.id === "string"));
});

test("loadTasks rejects a task with no id", () => {
  assert.throws(
    () => loadTasks(join(HERE, "fixtures", "missing-id.json")),
    /needs an "id"/,
  );
});

test("loadTasks rejects an empty task list", () => {
  assert.throws(
    () => loadTasks(join(HERE, "fixtures", "empty.json")),
    /no tasks found/,
  );
});

test("loadTasks accepts a bare array of tasks", () => {
  const tasks = loadTasks(join(HERE, "fixtures", "bare-array.json"));
  assert.deepEqual(
    tasks.map((t) => t.id),
    ["only"],
  );
});

test("parseTrajectory rejects non-JSON and shapeless output", () => {
  assert.throws(() => parseTrajectory("not json", "t"), /was not JSON/);
  assert.throws(() => parseTrajectory('{"task":"t"}', "t"), /no "steps" array/);
  assert.deepEqual(parseTrajectory('{"steps":[]}', "t"), {
    task: "t",
    steps: [],
  });
});

// ---------------------------------------------------------------------------
// The test of the test: the statistics must detect a signal we planted, and
// must not invent one that is not there. If this fails, no verdict the
// harness prints about a real skill can be trusted.
// ---------------------------------------------------------------------------

const sweepOpts = {
  tasks: loadTasks(),
  rules: GITHUB_ISSUE_CRUSHER_RULES,
  runs: 8,
  runnerFn: fakeRunner,
  seed: 1,
};

test("ground truth: the sweep ranks current above degraded above none", () => {
  const summaries = runSweep({
    arms: buildArms(realSkill, { seed: 7 }),
    ...sweepOpts,
  });
  const by = Object.fromEntries(summaries.map((s) => [s.name, s.mean]));
  assert.ok(
    by.current > by.degraded,
    `current ${by.current} !> degraded ${by.degraded}`,
  );
  assert.ok(
    by.degraded > by.none,
    `degraded ${by.degraded} !> none ${by.none}`,
  );
});

test("ground truth: a planted signal is called SENSITIVE", () => {
  const summaries = runSweep({
    arms: buildArms(realSkill, { seed: 7 }),
    ...sweepOpts,
  });
  const comparisons = buildComparisons(summaries, {
    iterations: 5000,
    seed: 1,
  });
  const d = verdict(comparisons, { alpha: 0.05 });
  assert.equal(d.sensitive, true, d.reasons.join(" | "));
});

test("negative control: identical arms are called BLIND", () => {
  // Both arms carry the same document, so there is nothing to detect. A
  // harness that reports SENSITIVE here would be manufacturing findings.
  const arms = [
    { name: "none", doc: realSkill },
    { name: "degraded", doc: realSkill },
    { name: "current", doc: realSkill },
  ];
  const summaries = runSweep({ arms, ...sweepOpts });
  const comparisons = buildComparisons(summaries, {
    iterations: 5000,
    seed: 1,
  });
  const d = verdict(comparisons, { alpha: 0.05 });
  assert.equal(d.sensitive, false, `false positive: ${d.reasons.join(" | ")}`);
});

test("the sweep is reproducible for a fixed seed", () => {
  const once = runSweep({
    arms: buildArms(realSkill, { seed: 7 }),
    ...sweepOpts,
  });
  const twice = runSweep({
    arms: buildArms(realSkill, { seed: 7 }),
    ...sweepOpts,
  });
  assert.deepEqual(once, twice);
});

test("buildComparisons pairs current against none and degraded", () => {
  const summaries = runSweep({
    arms: buildArms(realSkill, { seed: 7 }),
    ...sweepOpts,
  });
  const comparisons = buildComparisons(summaries, { iterations: 200, seed: 1 });
  assert.deepEqual(
    comparisons.map((c) => `${c.a}-${c.b}`),
    ["current-none", "current-degraded"],
  );
});

test("buildComparisons skips pairs whose arm is absent", () => {
  const summaries = runSweep({
    arms: [
      { name: "current", doc: realSkill },
      { name: "none", doc: "" },
    ],
    ...sweepOpts,
  });
  const comparisons = buildComparisons(summaries, { iterations: 200, seed: 1 });
  assert.deepEqual(
    comparisons.map((c) => `${c.a}-${c.b}`),
    ["current-none"],
  );
});

test("formatReport names the verdict and warns loudly about the fake runner", () => {
  const summaries = runSweep({
    arms: buildArms(realSkill, { seed: 7 }),
    ...sweepOpts,
  });
  const comparisons = buildComparisons(summaries, { iterations: 200, seed: 1 });
  const d = verdict(comparisons, { alpha: 0.05 });
  const opts = {
    skill: "github-issue-crusher",
    runner: "fake",
    runs: 8,
    seed: 1,
    alpha: 0.05,
  };
  const out = formatReport(summaries, comparisons, d, opts);
  assert.match(out, /VERDICT: (SENSITIVE|BLIND)/);
  assert.match(out, /runner=fake/);
  assert.match(out, /says nothing about the real document/);
});

test("formatReport omits the fake-runner warning for exec runs", () => {
  const summaries = runSweep({
    arms: buildArms(realSkill, { seed: 7 }),
    ...sweepOpts,
  });
  const comparisons = buildComparisons(summaries, { iterations: 200, seed: 1 });
  const d = verdict(comparisons, { alpha: 0.05 });
  const opts = {
    skill: "github-issue-crusher",
    runner: "exec",
    runs: 8,
    seed: 1,
    alpha: 0.05,
  };
  assert.doesNotMatch(
    formatReport(summaries, comparisons, d, opts),
    /runner=fake/,
  );
});

test("defaultSkillPath resolves inside the repo's bundled skills", () => {
  const p = defaultSkillPath("github-issue-crusher");
  assert.ok(p.endsWith("SKILL.md"));
  assert.match(
    p,
    /src[/\\]openhuman[/\\]skills[/\\]defaults[/\\]github-issue-crusher/,
  );
  assert.equal(p, resolve(p), "must be absolute");
});
