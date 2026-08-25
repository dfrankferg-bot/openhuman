// Skill-document variants ("arms") for the stage-0 sensitivity check.
//
// Three arms, because two are not enough to catch a blind eval:
//
//   current  — the SKILL.md as shipped.
//   none     — no skill at all. The floor.
//   degraded — same length, same vocabulary, guidance destroyed: the Rules
//              section is deleted and the numbered steps are shuffled.
//
// `current > none` alone is a weak result: a longer prompt can score better
// just by being longer. `current > degraded` is the test that matters,
// because it holds size and topic roughly fixed and varies only whether the
// instructions are coherent. An eval that cannot separate current from
// degraded is measuring prompt bulk, not skill content.
//
// Zero dependencies — Node 22 stdlib only.

import { mulberry32 } from "./lib.mjs";

/** Seeded Fisher-Yates. Returns a new array; input is untouched. */
export function seededShuffle(items, seed) {
  const rng = mulberry32(seed);
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Split markdown into top-level (`## `) sections. The text before the first
 * `## ` heading is returned as the preamble section with heading `null`.
 */
export function splitSections(md) {
  const lines = md.split("\n");
  const sections = [];
  let current = { heading: null, lines: [] };

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      sections.push(current);
      current = { heading: line, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections;
}

/**
 * Split a section body into top-level numbered items. A new item starts at a
 * line beginning with `N. `; continuation lines (including fenced code) ride
 * along with the item above them. Text before the first numbered line is
 * returned as `lead`.
 */
export function splitNumberedItems(lines) {
  const lead = [];
  const items = [];
  let current = null;

  for (const line of lines) {
    if (/^\d+\.\s/.test(line)) {
      if (current) items.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    } else {
      lead.push(line);
    }
  }
  if (current) items.push(current);
  return { lead, items };
}

/**
 * Produce the degraded arm: drop the Rules section, shuffle the Steps.
 * Falls back to shuffling whole sections when a document has neither, so
 * this stays usable for skills that are not shaped like issue-crusher.
 */
export function degradeSkill(md, seed = 7) {
  const sections = splitSections(md);
  const kept = sections.filter((s) => !/^##\s+Rules\b/i.test(s.heading ?? ""));
  const hadRules = kept.length !== sections.length;

  let touchedSteps = false;
  const rebuilt = kept.map((section) => {
    if (!/^##\s+Steps\b/i.test(section.heading ?? "")) return section;
    const { lead, items } = splitNumberedItems(section.lines);
    if (items.length < 2) return section;
    touchedSteps = true;
    const shuffled = seededShuffle(items, seed);
    return { heading: section.heading, lines: [...lead, ...shuffled.flat()] };
  });

  const final =
    hadRules || touchedSteps
      ? rebuilt
      : // Nothing recognisable to scramble — shuffle the sections themselves,
        // keeping the preamble pinned so the document still opens sanely.
        [rebuilt[0], ...seededShuffle(rebuilt.slice(1), seed)];

  return final
    .map((s) =>
      s.heading ? [s.heading, ...s.lines].join("\n") : s.lines.join("\n"),
    )
    .join("\n");
}

/** Build the three stage-0 arms from a skill document. */
export function buildArms(skillMd, { seed = 7 } = {}) {
  return [
    { name: "none", doc: "" },
    { name: "degraded", doc: degradeSkill(skillMd, seed) },
    { name: "current", doc: skillMd },
  ];
}
