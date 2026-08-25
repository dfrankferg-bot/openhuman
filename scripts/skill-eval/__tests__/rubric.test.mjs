import { test } from "node:test";
import assert from "node:assert/strict";

import {
  GITHUB_ISSUE_CRUSHER_RULES,
  RUBRICS,
  gradeTrajectory,
  gradeRun,
  shellCommands,
  toolCalls,
  composioCalls,
} from "../rubric.mjs";
import { synthesizeTrajectory, FAKE_CUES } from "../runner.mjs";

const RULE_IDS = GITHUB_ISSUE_CRUSHER_RULES.map((r) => r.id);
const allTrue = () => Object.fromEntries(RULE_IDS.map((id) => [id, true]));
const allFalse = () => Object.fromEntries(RULE_IDS.map((id) => [id, false]));

test("every rule has a cue so the fake runner can model it", () => {
  for (const id of RULE_IDS) {
    assert.ok(FAKE_CUES[id], `rule "${id}" has no FAKE_CUES entry`);
  }
});

test("a fully compliant trajectory scores 1.0", () => {
  const t = synthesizeTrajectory("t", allTrue());
  const g = gradeTrajectory(t, GITHUB_ISSUE_CRUSHER_RULES);
  const failed = g.details
    .filter((d) => d.satisfied === false)
    .map((d) => d.id);
  assert.deepEqual(failed, [], `unexpectedly failed: ${failed.join(", ")}`);
  assert.equal(g.score, 1);
});

test("a fully non-compliant trajectory scores 0", () => {
  const t = synthesizeTrajectory("t", allFalse());
  const g = gradeTrajectory(t, GITHUB_ISSUE_CRUSHER_RULES);
  const passed = g.details.filter((d) => d.satisfied === true).map((d) => d.id);
  assert.deepEqual(passed, [], `unexpectedly passed: ${passed.join(", ")}`);
  assert.equal(g.score, 0);
});

test("each rule independently detects its own violation", () => {
  for (const id of RULE_IDS) {
    const decisions = { ...allTrue(), [id]: false };
    const g = gradeTrajectory(
      synthesizeTrajectory("t", decisions),
      GITHUB_ISSUE_CRUSHER_RULES,
    );
    assert.ok(g.score < 1, `flipping "${id}" did not lower the score`);
    const detail = g.details.find((d) => d.id === id);
    assert.equal(
      detail.satisfied,
      false,
      `rule "${id}" did not notice its own violation`,
    );
  }
});

test("cross-repo-head is skipped when no PR was ever created", () => {
  const traj = {
    task: "t",
    steps: [{ type: "shell", command: "git clone https://x/y /tmp/z" }],
  };
  const g = gradeTrajectory(traj, GITHUB_ISSUE_CRUSHER_RULES);
  const head = g.details.find((d) => d.id === "cross-repo-head");
  assert.equal(head.applies, false);
  assert.equal(head.satisfied, null);
});

test("draft-pr still fails when no PR was created at all", () => {
  const traj = { task: "t", steps: [] };
  const g = gradeTrajectory(traj, GITHUB_ISSUE_CRUSHER_RULES);
  const draft = g.details.find((d) => d.id === "draft-pr");
  assert.equal(
    draft.applies,
    true,
    "not opening a PR is a failure, not an exemption",
  );
  assert.equal(draft.satisfied, false);
});

test("codegraph-first is skipped when nothing was searched", () => {
  const traj = {
    task: "t",
    steps: [{ type: "shell", command: "git clone https://x/y /tmp/z" }],
  };
  const g = gradeTrajectory(traj, GITHUB_ISSUE_CRUSHER_RULES);
  assert.equal(
    g.details.find((d) => d.id === "codegraph-first").applies,
    false,
  );
});

test("codegraph-first fails when grep comes first", () => {
  const traj = {
    task: "t",
    steps: [
      { type: "tool", name: "grep", args: {} },
      { type: "tool", name: "codegraph_search", args: {} },
    ],
  };
  const g = gradeTrajectory(traj, GITHUB_ISSUE_CRUSHER_RULES);
  assert.equal(
    g.details.find((d) => d.id === "codegraph-first").satisfied,
    false,
  );
});

test("scoped-git-add accepts explicit paths and rejects -A and .", () => {
  const rule = GITHUB_ISSUE_CRUSHER_RULES.find(
    (r) => r.id === "scoped-git-add",
  );
  const withCmd = (command) => ({
    task: "t",
    steps: [{ type: "shell", command }],
  });
  assert.equal(rule.satisfied(withCmd("git -C /tmp/x add src/a.ts")), true);
  assert.equal(rule.satisfied(withCmd("git -C /tmp/x add -A")), false);
  assert.equal(rule.satisfied(withCmd("git add .")), false);
  assert.equal(rule.satisfied(withCmd("git add --all")), false);
});

test("composio-for-github-state tolerates unrelated commands named gh-something", () => {
  const rule = GITHUB_ISSUE_CRUSHER_RULES.find(
    (r) => r.id === "composio-for-github-state",
  );
  const traj = {
    task: "t",
    steps: [{ type: "shell", command: "ghost --version" }],
  };
  assert.equal(
    rule.satisfied(traj),
    true,
    "substring 'gh' must not trip the rule",
  );
});

test("gradeRun averages across trajectories", () => {
  const good = synthesizeTrajectory("a", allTrue());
  const bad = synthesizeTrajectory("b", allFalse());
  assert.equal(gradeRun([good, bad], GITHUB_ISSUE_CRUSHER_RULES), 0.5);
  assert.equal(gradeRun([], GITHUB_ISSUE_CRUSHER_RULES), 0);
});

test("accessors read the trajectory shape", () => {
  const t = synthesizeTrajectory("t", allTrue());
  assert.ok(shellCommands(t).length > 0);
  assert.ok(toolCalls(t, "run_skill").length === 1);
  assert.ok(composioCalls(t, "GITHUB_CREATE_A_PULL_REQUEST").length === 1);
  assert.equal(
    toolCalls({}, "anything").length,
    0,
    "missing steps must not throw",
  );
});

test("RUBRICS exposes the issue-crusher rubric by skill id", () => {
  assert.equal(RUBRICS["github-issue-crusher"], GITHUB_ISSUE_CRUSHER_RULES);
});
