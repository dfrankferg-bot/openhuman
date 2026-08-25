#!/usr/bin/env node
// skill-eval — stage-0 sensitivity check for skill-document optimization.
//
//   pnpm skill-eval                      # fake runner, proves the plumbing
//   pnpm skill-eval --runner exec --exec-cmd "./my-agent.sh"
//
// Answers one question and refuses to answer any other: can this eval tell
// the shipped skill document apart from no document and from a scrambled
// one? A PASS licenses spending on stage 1. A FAIL means the eval is blind,
// and optimizing against a blind eval buys noise at full price.
//
// Zero dependencies — Node 22 stdlib only.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

import { deriveSeed, summarizeArm, compareArms, verdict } from "./lib.mjs";
import { RUBRICS, gradeRun } from "./rubric.mjs";
import { buildArms } from "./arms.mjs";
import { fakeRunner, execRunner } from "./runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

export const DEFAULTS = {
  skill: "github-issue-crusher",
  runs: 8,
  runner: "fake",
  seed: 1,
  alpha: 0.05,
  iterations: 10000,
};

export function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const needsValue = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return v;
    };
    switch (arg) {
      case "--skill":
        opts.skill = needsValue();
        break;
      case "--skill-path":
        opts.skillPath = needsValue();
        break;
      case "--tasks":
        opts.tasks = needsValue();
        break;
      case "--runs":
        opts.runs = Number.parseInt(needsValue(), 10);
        break;
      case "--runner":
        opts.runner = needsValue();
        break;
      case "--exec-cmd":
        opts.execCmd = needsValue();
        break;
      case "--seed":
        opts.seed = Number.parseInt(needsValue(), 10);
        break;
      case "--alpha":
        opts.alpha = Number.parseFloat(needsValue());
        break;
      case "--iterations":
        opts.iterations = Number.parseInt(needsValue(), 10);
        break;
      case "--out":
        opts.out = needsValue();
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(opts.runs) || opts.runs < 2) {
    throw new Error(
      "--runs must be an integer >= 2 (one run cannot measure noise)",
    );
  }
  if (opts.runner !== "fake" && opts.runner !== "exec") {
    throw new Error(`--runner must be "fake" or "exec" (got "${opts.runner}")`);
  }
  if (opts.runner === "exec" && !opts.execCmd) {
    throw new Error("--runner exec requires --exec-cmd");
  }
  return opts;
}

export function defaultSkillPath(skill) {
  return join(
    REPO_ROOT,
    "src",
    "openhuman",
    "skills",
    "defaults",
    skill,
    "SKILL.md",
  );
}

export function loadTasks(tasksPath) {
  const path = tasksPath
    ? resolve(tasksPath)
    : join(HERE, "tasks", "starter.json");
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const tasks = Array.isArray(parsed) ? parsed : parsed.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error(`no tasks found in ${path}`);
  }
  for (const t of tasks) {
    if (!t.id) throw new Error(`every task needs an "id" (in ${path})`);
  }
  return tasks;
}

/**
 * Run every arm over every task `runs` times and score each run.
 * `runnerFn` is injected so tests can drive the sweep without spawning
 * anything; the CLI supplies the fake or exec runner.
 */
export function runSweep({ arms, tasks, rules, runs, runnerFn, seed }) {
  return arms.map((arm) => {
    const runScores = [];
    for (let k = 0; k < runs; k += 1) {
      const trajectories = tasks.map((task) =>
        runnerFn({
          doc: arm.doc,
          task,
          seed: deriveSeed(seed, arm.name, k, task.id),
        }),
      );
      runScores.push(gradeRun(trajectories, rules));
    }
    return summarizeArm(arm.name, runScores);
  });
}

/** Build the stage-0 comparisons from arm summaries. */
export function buildComparisons(summaries, { iterations, seed }) {
  const byName = Object.fromEntries(summaries.map((s) => [s.name, s]));
  const pairs = [
    ["current", "none"],
    ["current", "degraded"],
  ];
  return pairs
    .filter(([a, b]) => byName[a] && byName[b])
    .map(([a, b]) => compareArms(byName[a], byName[b], { iterations, seed }));
}

export function formatReport(summaries, comparisons, decision, opts) {
  const lines = [];
  lines.push("");
  lines.push(`skill-eval stage 0 — ${opts.skill}`);
  lines.push(
    `runner=${opts.runner}  runs=${opts.runs}  seed=${opts.seed}  alpha=${opts.alpha}`,
  );
  lines.push("");
  lines.push("  arm         runs    mean   stddev");
  for (const s of summaries) {
    const sd = s.stddev === null ? "   n/a" : s.stddev.toFixed(3);
    lines.push(
      `  ${s.name.padEnd(10)}  ${String(s.runs).padStart(4)}   ${s.mean.toFixed(3)}    ${sd}`,
    );
  }
  lines.push("");
  for (const r of decision.reasons) lines.push(`  ${r}`);
  lines.push("");
  lines.push(decision.sensitive ? "  VERDICT: SENSITIVE" : "  VERDICT: BLIND");
  lines.push(
    decision.sensitive
      ? "  The eval separates the arms. Stage 1 (corpus + grader) is worth funding."
      : "  The eval cannot separate the arms. Do NOT fund stage 1 — fix the eval first.",
  );
  if (opts.runner === "fake") {
    lines.push("");
    lines.push(
      "  NOTE: runner=fake. This exercised the harness, not the skill.",
    );
    lines.push(
      "  It says nothing about the real document. Re-run with --runner exec.",
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`skill-eval: ${e.message}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(readFileSync(join(HERE, "README.md"), "utf8"));
    return 0;
  }

  const rules = RUBRICS[opts.skill];
  if (!rules) {
    process.stderr.write(
      `skill-eval: no rubric for "${opts.skill}" (have: ${Object.keys(RUBRICS).join(", ")})\n`,
    );
    return 2;
  }

  const skillPath = opts.skillPath
    ? resolve(opts.skillPath)
    : defaultSkillPath(opts.skill);
  let skillMd;
  try {
    skillMd = readFileSync(skillPath, "utf8");
  } catch (e) {
    process.stderr.write(
      `skill-eval: cannot read ${skillPath}: ${e.message}\n`,
    );
    return 2;
  }

  let tasks;
  try {
    tasks = loadTasks(opts.tasks);
  } catch (e) {
    process.stderr.write(`skill-eval: ${e.message}\n`);
    return 2;
  }

  const runnerFn =
    opts.runner === "fake"
      ? fakeRunner
      : ({ doc, task }) => execRunner({ doc, task, command: opts.execCmd });

  const arms = buildArms(skillMd, { seed: opts.seed });
  let summaries;
  try {
    summaries = runSweep({
      arms,
      tasks,
      rules,
      runs: opts.runs,
      runnerFn,
      seed: opts.seed,
    });
  } catch (e) {
    process.stderr.write(`skill-eval: rollout failed: ${e.message}\n`);
    return 1;
  }

  const comparisons = buildComparisons(summaries, {
    iterations: opts.iterations,
    seed: opts.seed,
  });
  const decision = verdict(comparisons, { alpha: opts.alpha });

  process.stdout.write(formatReport(summaries, comparisons, decision, opts));

  if (opts.out) {
    const report = {
      skill: opts.skill,
      opts,
      summaries,
      comparisons,
      decision,
    };
    const outPath = resolve(opts.out);
    writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
    process.stdout.write(`  report written to ${outPath}\n\n`);
  }

  return decision.sensitive ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main(process.argv.slice(2)));
}
