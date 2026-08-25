// Rollout runners for the skill-eval harness.
//
// A runner takes (skill document, task) and returns a normalized trajectory:
//
//   { task: "<id>", steps: [
//       { type: "tool",  name: "composio_execute", args: {...} },
//       { type: "shell", command: "git clone ..." },
//       { type: "text",  text: "..." },
//   ]}
//
// Two runners ship:
//
//   fake — synthesizes trajectories locally. Costs nothing, calls no model,
//          and exists to prove the harness plumbing and to sanity-check the
//          statistics against a known ground truth. NEVER cite fake-runner
//          output as evidence about a real skill; it measures this file.
//
//   exec — spawns a command you supply, which runs the real agent and prints
//          a trajectory as JSON on stdout. This is the one that costs money.
//
// !! SANDBOX WARNING for the exec runner !!
// github-issue-crusher clones repositories, pushes branches to a fork and
// opens real pull requests through Composio. Point the exec runner at a
// sandbox — a throwaway GitHub account, a local git remote, a mocked Composio
// — or an eval sweep will litter real repositories with real PRs. The harness
// cannot enforce this for you; it never sees your credentials.
//
// Zero dependencies — Node 22 stdlib only.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mulberry32 } from "./lib.mjs";

/**
 * Cues that tell the fake runner whether a document teaches a given rule.
 * Deliberately keyed to substance rather than the rule name, so the degraded
 * arm (which keeps the vocabulary but destroys the Rules section) loses the
 * cues it should lose.
 */
export const FAKE_CUES = {
  "composio-for-github-state": /never shell(ing)? (out )?to `?gh`?/i,
  "no-global-git-config": /never\s+`?--global`?/i,
  "scoped-git-add": /never\s+`?git add -A`?/i,
  "draft-pr": /draft:\s*true.*non-negotiable|DRAFT always/is,
  "cross-repo-head": /<fork-owner>:<branch>|"head":\s*"<fork-owner>/i,
  "codegraph-first": /codegraph_search\s+first/i,
  "identity-pinned": /pin the local git identity|Pin the local git identity/i,
  "shepherd-handoff": /pr-review-shepherd/i,
  "fresh-clone": /clone fresh|git clone/i,
};

const P_WITH_CUE = 0.85;
const P_WITHOUT_CUE = 0.25;

/**
 * Decide, per rule, whether the simulated agent complies. A document that
 * teaches the rule produces compliance most of the time; one that does not
 * produces it occasionally. The gap is what the statistics should detect.
 */
export function decideCompliance(doc, rng) {
  const decisions = {};
  for (const [ruleId, cue] of Object.entries(FAKE_CUES)) {
    const p = cue.test(doc) ? P_WITH_CUE : P_WITHOUT_CUE;
    decisions[ruleId] = rng() < p;
  }
  return decisions;
}

/** Build a trajectory that exhibits exactly the decided behaviours. */
export function synthesizeTrajectory(taskId, d) {
  const dir = `/tmp/repo-${taskId}`;
  const steps = [];

  if (d["composio-for-github-state"]) {
    steps.push({
      type: "tool",
      name: "composio_execute",
      args: { tool: "GITHUB_GET_AN_ISSUE", arguments: { issue_number: 1 } },
    });
  } else {
    steps.push({ type: "shell", command: `gh issue view 1` });
  }

  if (d["fresh-clone"]) {
    steps.push({
      type: "shell",
      command: `git clone https://github.com/o/r ${dir}`,
    });
  }

  if (d["identity-pinned"]) {
    steps.push({
      type: "shell",
      command: `git -C ${dir} config user.name someone`,
    });
  }
  if (!d["no-global-git-config"]) {
    steps.push({
      type: "shell",
      command: `git config --global user.name someone`,
    });
  }

  // Search order decides codegraph-first.
  if (d["codegraph-first"]) {
    steps.push({
      type: "tool",
      name: "codegraph_search",
      args: { q: "symbol" },
    });
    steps.push({ type: "tool", name: "grep", args: { q: "symbol" } });
  } else {
    steps.push({ type: "tool", name: "grep", args: { q: "symbol" } });
  }

  steps.push({
    type: "shell",
    command: d["scoped-git-add"]
      ? `git -C ${dir} add src/a.ts`
      : `git -C ${dir} add -A`,
  });
  steps.push({
    type: "shell",
    command: `git -C ${dir} commit -m "fix: thing (#1)"`,
  });

  steps.push({
    type: "tool",
    name: "composio_execute",
    args: {
      tool: "GITHUB_CREATE_A_PULL_REQUEST",
      arguments: {
        title: "fix: thing (#1)",
        head: d["cross-repo-head"] ? "forkowner:fix/1-thing" : "fix/1-thing",
        base: "main",
        draft: d["draft-pr"] === true,
      },
    },
  });

  if (d["shepherd-handoff"]) {
    steps.push({
      type: "tool",
      name: "run_skill",
      args: { skill_id: "pr-review-shepherd", inputs: { pr: 2 } },
    });
  }

  return { task: taskId, steps };
}

/** The fake runner. Deterministic given (doc, task, seed). */
export function fakeRunner({ doc, task, seed }) {
  const rng = mulberry32(seed);
  return synthesizeTrajectory(task.id, decideCompliance(doc, rng));
}

/**
 * The exec runner. Writes the skill document to a temp file, invokes the
 * command with the task on the environment, and parses trajectory JSON from
 * stdout. Any non-zero exit or unparseable output is surfaced as a thrown
 * error rather than silently scoring zero — a crashed rollout is a broken
 * harness, not a badly behaved agent, and the two must never be conflated.
 */
export function execRunner({ doc, task, command, timeoutMs = 900000 }) {
  const dir = mkdtempSync(join(tmpdir(), "skill-eval-"));
  const docPath = join(dir, "SKILL.md");
  try {
    writeFileSync(docPath, doc, "utf8");
    const result = spawnSync(command, {
      shell: true,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        SKILL_EVAL_DOC_PATH: docPath,
        SKILL_EVAL_TASK_ID: task.id,
        SKILL_EVAL_TASK_PROMPT: task.prompt ?? "",
      },
    });
    if (result.error) {
      throw new Error(`runner command failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(
        `runner exited ${result.status} for task ${task.id}: ${(result.stderr || "").slice(0, 500)}`,
      );
    }
    return parseTrajectory(result.stdout, task.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Parse and validate runner stdout into a trajectory. */
export function parseTrajectory(stdout, taskId) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new Error(
      `runner output for task ${taskId} was not JSON: ${e.message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.steps)) {
    throw new Error(`runner output for task ${taskId} has no "steps" array`);
  }
  return { task: parsed.task ?? taskId, steps: parsed.steps };
}
