# skill-eval — stage 0

A sensitivity check for skill-document optimization (e.g. [microsoft/SkillOpt](https://github.com/microsoft/SkillOpt),
which trains a `SKILL.md` as if it were a parameter while the model stays frozen).

**This harness does not optimize anything.** It answers one question:

> Can our eval tell the shipped skill document apart from no document, and from a scrambled one?

If it cannot, the eval is blind, and pointing an optimizer at a blind eval buys
noise at full price. Stage 0 costs almost nothing and is the step most people
skip on the way to spending a lot on a metric that was never measuring anything.

```bash
pnpm skill-eval                 # fake runner — proves the plumbing, calls no model
pnpm skill-eval:test            # unit tests, including the test-of-the-test
pnpm skill-eval --runner exec --exec-cmd "./my-agent.sh"   # the real thing
```

## The three arms

| arm        | document                              | why                           |
| ---------- | ------------------------------------- | ----------------------------- |
| `none`     | empty                                 | the floor                     |
| `degraded` | Rules section deleted, Steps shuffled | same bulk, guidance destroyed |
| `current`  | `SKILL.md` as shipped                 | the thing under test          |

`current > none` is the weak test — a longer prompt can win on length alone.
`current > degraded` is the one that matters, because it holds size and
vocabulary roughly fixed and varies only whether the instructions cohere.

## Reading the verdict

**SENSITIVE** requires, for _both_ comparisons: the gap is unlikely under chance
(permutation test, `p < alpha`) **and** it is larger than the measured
run-to-run noise. Either alone is how a blind eval passes for a sighted one — a
tiny gap can be highly significant, and a large gap can be pure variance.

Exit code is `0` for SENSITIVE, `1` for BLIND, `2` for a usage error, so this
can gate a pipeline.

## The exec runner contract

Your command runs the real agent once and prints a trajectory as JSON on stdout.
The harness supplies three environment variables:

| var                      | meaning                                                    |
| ------------------------ | ---------------------------------------------------------- |
| `SKILL_EVAL_DOC_PATH`    | path to the arm's skill document (may be empty for `none`) |
| `SKILL_EVAL_TASK_ID`     | task id                                                    |
| `SKILL_EVAL_TASK_PROMPT` | task prompt                                                |

```json
{
  "task": "missing-i18n-key",
  "steps": [
    {
      "type": "tool",
      "name": "composio_execute",
      "args": { "tool": "GITHUB_GET_AN_ISSUE", "arguments": {} }
    },
    { "type": "shell", "command": "git clone https://github.com/o/r /tmp/w" },
    { "type": "text", "text": "..." }
  ]
}
```

A non-zero exit or unparseable output raises an error rather than scoring zero —
a crashed rollout is a broken harness, not a badly behaved agent, and scoring
the two the same way silently poisons the result.

> **Sandbox before you run this for real.** `github-issue-crusher` clones
> repositories, pushes branches to a fork and opens real pull requests through
> Composio. Point the exec runner at a throwaway account or a mocked Composio,
> or a sweep will litter real repositories with real PRs. The harness never sees
> your credentials and cannot enforce this for you.

## What the rubric measures, and what it doesn't

The grader scores a trajectory against rules `SKILL.md` states outright — use
Composio not `gh`, `draft: true`, never `git add -A`, `codegraph_search` first,
hand off to the shepherd, and so on. Each rule cites the line it came from.

This is the right grader for stage 0: cheap, deterministic, low-variance, and
aimed squarely at what a text-space edit moves.

**It is the wrong grader for stage 2.** Rule adherence is a proxy for quality,
not quality. A document that merely shouts its own rules louder scores well here
without being any better at fixing issues. Harmless while we are only measuring
whether the eval can see anything; a Goodhart trap the moment an optimizer is
pointed at it. Stage 2 grades outcomes — did the fix work — or it measures
nothing worth having.

## If stage 0 passes

Stage 1 is the corpus. This clone is shallow, so start there:

```bash
git fetch --unshallow
```

Then walk closed issues that have a merged PR and emit one task per pair: the
issue body becomes the prompt, the merged diff and that PR's tests become ground
truth. Replace `tasks/starter.json` — those entries are placeholders that exist
only to exercise the harness. Hold back a split you never optimize against, and
require any final improvement to clear the noise floor you measured here.

## Files

| file                 | role                                                          |
| -------------------- | ------------------------------------------------------------- |
| `lib.mjs`            | seeded RNG, summary stats, permutation test, the verdict gate |
| `rubric.mjs`         | rules derived from `SKILL.md`, trajectory grading             |
| `arms.mjs`           | building the `none` / `degraded` / `current` documents        |
| `runner.mjs`         | `fake` and `exec` rollout runners                             |
| `cli.mjs`            | argument parsing, the sweep, the report                       |
| `tasks/starter.json` | placeholder tasks — replace in stage 1                        |

Zero dependencies, Node 22 stdlib only, matching `scripts/agent-batch/`.
