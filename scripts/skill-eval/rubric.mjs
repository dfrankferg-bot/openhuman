// Rubric grading for the skill-eval harness.
//
// WHY A RUBRIC AND NOT "DID THE TESTS PASS":
// Stage 0 is a sensitivity check, and it needs a grader that is cheap,
// deterministic and low-variance. Outcome grading (did the fix work?) is the
// right final metric but it is slow, noisy, and — for github-issue-crusher —
// side-effecting, since a real rollout pushes branches and opens real PRs.
// So stage 0 grades the *trajectory* against rules the SKILL.md states
// outright. Those rules are what a text-space edit actually moves, so they
// are the most sensitive cheap probe available.
//
// KNOWN LIMIT — READ BEFORE REUSING THIS IN STAGE 2:
// Rule adherence is a proxy for quality, not quality itself. A document that
// simply shouts its own rules louder will score well here while being no
// better at fixing issues. That is harmless for stage 0 (we are measuring
// whether the eval can see anything at all, not optimizing against it) but it
// is a Goodhart trap the moment an optimizer is pointed at it. Stage 2 must
// grade outcomes.
//
// Zero dependencies — Node 22 stdlib only.

/** Shell commands issued in a trajectory. */
export function shellCommands(traj) {
  return (traj.steps ?? [])
    .filter((s) => s.type === "shell" && typeof s.command === "string")
    .map((s) => s.command);
}

/** Tool calls, optionally filtered by tool name. */
export function toolCalls(traj, name = null) {
  return (traj.steps ?? []).filter(
    (s) => s.type === "tool" && (name === null || s.name === name),
  );
}

/** Composio calls for a specific GITHUB_* action. */
export function composioCalls(traj, action) {
  return toolCalls(traj, "composio_execute").filter(
    (s) => s.args?.tool === action,
  );
}

const anyMatch = (commands, re) => commands.some((c) => re.test(c));

// Search-ish steps, in order, used by the codegraph-first rule.
const SEARCH_TOOLS = ["codegraph_search", "grep", "glob"];
function searchSteps(traj) {
  return (traj.steps ?? []).filter(
    (s) => s.type === "tool" && SEARCH_TOOLS.includes(s.name),
  );
}

/**
 * Rules for github-issue-crusher, each traceable to a line in its SKILL.md.
 * `applies` defaults to true; weights reflect how loudly the doc insists.
 */
export const GITHUB_ISSUE_CRUSHER_RULES = [
  {
    id: "composio-for-github-state",
    weight: 2,
    source: "Rules: never shell to `gh`",
    satisfied: (t) =>
      !anyMatch(shellCommands(t), /\bgh\s+(issue|pr|api|repo|release)\b/),
  },
  {
    id: "no-global-git-config",
    weight: 2,
    source: "Step 4: never --global",
    satisfied: (t) => !anyMatch(shellCommands(t), /git\s+config\s+--global/),
  },
  {
    id: "scoped-git-add",
    weight: 1,
    source: "Step 8: never git add -A",
    satisfied: (t) =>
      !anyMatch(
        shellCommands(t),
        /\bgit\s+(?:-C\s+\S+\s+)?add\s+(?:-A\b|--all\b|\.\s*$)/,
      ),
  },
  {
    id: "draft-pr",
    weight: 3,
    source: "Step 9: draft: true is non-negotiable",
    satisfied: (t) =>
      composioCalls(t, "GITHUB_CREATE_A_PULL_REQUEST").some(
        (c) => c.args?.arguments?.draft === true,
      ),
  },
  {
    id: "cross-repo-head",
    weight: 2,
    source: "Step 9: head is <fork-owner>:<branch>",
    applies: (t) => composioCalls(t, "GITHUB_CREATE_A_PULL_REQUEST").length > 0,
    satisfied: (t) =>
      composioCalls(t, "GITHUB_CREATE_A_PULL_REQUEST").some((c) =>
        /^[^:\s]+:[^\s]+$/.test(c.args?.arguments?.head ?? ""),
      ),
  },
  {
    id: "codegraph-first",
    weight: 2,
    source: "Rules: codegraph_search first for every locate step",
    applies: (t) => searchSteps(t).length > 0,
    satisfied: (t) => searchSteps(t)[0]?.name === "codegraph_search",
  },
  {
    id: "identity-pinned",
    weight: 1,
    source: "Step 4: pin local git identity in the clone",
    satisfied: (t) =>
      anyMatch(shellCommands(t), /git\s+-C\s+\S+\s+config\s+user\.name/),
  },
  {
    id: "shepherd-handoff",
    weight: 2,
    source: "Step 10: hand off to pr-review-shepherd",
    satisfied: (t) =>
      toolCalls(t, "run_skill").some(
        (s) => s.args?.skill_id === "pr-review-shepherd",
      ),
  },
  {
    id: "fresh-clone",
    weight: 1,
    source: "Step 3: clone fresh to a unique directory",
    satisfied: (t) => anyMatch(shellCommands(t), /\bgit\s+clone\b/),
  },
];

export const RUBRICS = {
  "github-issue-crusher": GITHUB_ISSUE_CRUSHER_RULES,
};

/**
 * Grade one trajectory. Returns a score in [0,1] — the weighted fraction of
 * *applicable* rules satisfied — plus the per-rule detail, so a surprising
 * score can always be traced to the rule that caused it.
 */
export function gradeTrajectory(traj, rules) {
  const details = [];
  let earned = 0;
  let possible = 0;

  for (const rule of rules) {
    const applies = rule.applies ? rule.applies(traj) : true;
    if (!applies) {
      details.push({
        id: rule.id,
        applies: false,
        satisfied: null,
        weight: rule.weight,
      });
      continue;
    }
    const ok = Boolean(rule.satisfied(traj));
    possible += rule.weight;
    if (ok) earned += rule.weight;
    details.push({
      id: rule.id,
      applies: true,
      satisfied: ok,
      weight: rule.weight,
    });
  }

  return {
    score: possible === 0 ? 0 : earned / possible,
    earned,
    possible,
    details,
  };
}

/** Mean score across a set of task trajectories — one run's score. */
export function gradeRun(trajectories, rules) {
  if (trajectories.length === 0) return 0;
  const scores = trajectories.map((t) => gradeTrajectory(t, rules).score);
  return scores.reduce((s, x) => s + x, 0) / scores.length;
}
