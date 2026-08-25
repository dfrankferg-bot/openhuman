import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  seededShuffle,
  splitSections,
  splitNumberedItems,
  degradeSkill,
  buildArms,
} from "../arms.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = resolve(
  HERE,
  "..",
  "..",
  "..",
  join(
    "src",
    "openhuman",
    "skills",
    "defaults",
    "github-issue-crusher",
    "SKILL.md",
  ),
);
const realSkill = readFileSync(SKILL_PATH, "utf8");

test("seededShuffle is deterministic and preserves the multiset", () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const a = seededShuffle(items, 5);
  const b = seededShuffle(items, 5);
  assert.deepEqual(a, b);
  assert.deepEqual(
    [...a].sort((x, y) => x - y),
    items,
  );
  assert.deepEqual(
    items,
    [1, 2, 3, 4, 5, 6, 7, 8],
    "input must not be mutated",
  );
});

test("seededShuffle actually reorders for some seed", () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const seeds = [1, 2, 3, 4, 5];
  assert.ok(
    seeds.some((s) => seededShuffle(items, s).join() !== items.join()),
    "no seed produced a reordering",
  );
});

test("splitSections separates the preamble from ## sections", () => {
  const md = ["intro line", "", "## One", "a", "## Two", "b"].join("\n");
  const sections = splitSections(md);
  assert.equal(sections.length, 3);
  assert.equal(sections[0].heading, null);
  assert.equal(sections[1].heading, "## One");
  assert.equal(sections[2].heading, "## Two");
});

test("splitNumberedItems groups continuation lines with their item", () => {
  const lines = [
    "lead",
    "1. first",
    "   more",
    "2. second",
    "```",
    "code",
    "```",
  ];
  const { lead, items } = splitNumberedItems(lines);
  assert.deepEqual(lead, ["lead"]);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], ["1. first", "   more"]);
  assert.deepEqual(items[1], ["2. second", "```", "code", "```"]);
});

test("splitNumberedItems handles a section with no numbered items", () => {
  const { lead, items } = splitNumberedItems(["just", "prose"]);
  assert.deepEqual(lead, ["just", "prose"]);
  assert.deepEqual(items, []);
});

test("degradeSkill removes the Rules section from the real skill", () => {
  assert.match(
    realSkill,
    /^## Rules/m,
    "fixture drifted: SKILL.md has no ## Rules",
  );
  const degraded = degradeSkill(realSkill, 7);
  assert.doesNotMatch(degraded, /^## Rules/m);
});

test("degradeSkill reorders the real skill's steps", () => {
  const degraded = degradeSkill(realSkill, 7);
  const firstStep = (md) => md.split("\n").find((l) => /^\d+\.\s/.test(l));
  assert.notEqual(
    firstStep(degraded),
    firstStep(realSkill),
    "steps were not shuffled — the degraded arm would be too close to current",
  );
});

test("degradeSkill keeps roughly the same bulk", () => {
  const degraded = degradeSkill(realSkill, 7);
  const ratio = degraded.length / realSkill.length;
  assert.ok(
    ratio > 0.7,
    `degraded arm lost too much text (ratio ${ratio.toFixed(2)})`,
  );
});

test("degradeSkill is deterministic", () => {
  assert.equal(degradeSkill(realSkill, 7), degradeSkill(realSkill, 7));
});

test("degradeSkill falls back to shuffling sections when there are no steps or rules", () => {
  const md = [
    "preamble",
    "## A",
    "a body",
    "## B",
    "b body",
    "## C",
    "c body",
  ].join("\n");
  const degraded = degradeSkill(md, 3);
  assert.match(degraded, /^preamble/);
  for (const h of ["## A", "## B", "## C"]) assert.ok(degraded.includes(h));
});

test("buildArms produces none, degraded and current", () => {
  const arms = buildArms(realSkill, { seed: 7 });
  assert.deepEqual(
    arms.map((a) => a.name),
    ["none", "degraded", "current"],
  );
  assert.equal(arms.find((a) => a.name === "none").doc, "");
  assert.equal(arms.find((a) => a.name === "current").doc, realSkill);
  assert.notEqual(arms.find((a) => a.name === "degraded").doc, realSkill);
});
