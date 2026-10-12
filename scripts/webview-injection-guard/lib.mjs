// Webview injection guard — library.
//
// Enforces the CLAUDE.md rule "CEF child webviews — no new JS injection" as a
// deterministic source scan instead of a reviewer's memory. It walks the Tauri
// shell (`app/src-tauri/src`, `app/src-tauri/recipes`), counts every primitive
// that can push host-controlled JavaScript into a third-party origin, and
// compares the result against `allowlist.json`. Anything not on the allowlist
// (a new file using a primitive, a grown ceiling, a new `.js` asset, a
// mis-configured `tauri-plugin-opener`) is an error. Ceilings that can shrink
// are warnings so legacy injection trends down, never up.
//
// Pure functions only; the CLI in `cli.mjs` owns process I/O.

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** Regexes for every way the shell can run its own JS inside a webview. */
export const PRIMITIVES = Object.freeze({
  // tauri::WebviewBuilder::initialization_script — runs before every document.
  initialization_script: /\binitialization_script\s*\(/,
  // CDP: registers a script for every new document in the target.
  add_script_on_new_document: /Page\.addScriptToEvaluateOnNewDocument/,
  // CDP: evaluates an expression in the page's JS context.
  runtime_evaluate: /Runtime\.evaluate\b/,
  // Tauri plugin builder hook that injects a plugin init script.
  js_init_script: /\bjs_init_script\s*\(/,
  // Baking a JS file into the binary for later injection.
  include_js: /include_str!\s*\(\s*"[^"]*\.(?:m?js|cjs)"\s*\)/,
});

export const PRIMITIVE_IDS = Object.freeze(Object.keys(PRIMITIVES));

/** Roots (repo-relative, POSIX) scanned for Rust injection primitives. */
export const RUST_SCAN_ROOTS = Object.freeze(['app/src-tauri/src']);
/** Roots (repo-relative, POSIX) scanned for injectable JS assets. */
export const JS_ASSET_ROOTS = Object.freeze(['app/src-tauri/src', 'app/src-tauri/recipes']);
export const JS_ASSET_EXTENSIONS = Object.freeze(['.js', '.mjs', '.cjs']);
/** File that registers Tauri plugins; checked for the opener init-script opt-out. */
export const OPENER_LIB_RS = 'app/src-tauri/src/lib.rs';

/** Directory names never descended into (vendored CEF CLI, build output, deps). */
const SKIP_DIRS = new Set(['vendor', 'target', 'node_modules', 'gen', '.git']);

function toPosix(p) {
  return p.split(sep).join('/');
}

/**
 * Strip Rust comments line by line so a `// Runtime.evaluate` note does not
 * count as an injection site. Handles `//`, `///`, `//!` and `/* ... *\/`
 * blocks (including multi-line). Strings are left alone on purpose: an
 * error-message literal like `format!("Runtime.evaluate: {e}")` sits next to a
 * real call site, and counting it keeps the ceiling honest.
 */
export function stripRustComments(source) {
  const out = [];
  let inBlock = false;
  for (const rawLine of source.split('\n')) {
    let line = rawLine;
    let kept = '';
    while (line.length) {
      if (inBlock) {
        const end = line.indexOf('*/');
        if (end === -1) {
          line = '';
          break;
        }
        line = line.slice(end + 2);
        inBlock = false;
        continue;
      }
      const lineComment = line.indexOf('//');
      const blockStart = line.indexOf('/*');
      if (lineComment === -1 && blockStart === -1) {
        kept += line;
        line = '';
      } else if (blockStart !== -1 && (lineComment === -1 || blockStart < lineComment)) {
        kept += line.slice(0, blockStart);
        line = line.slice(blockStart + 2);
        inBlock = true;
      } else {
        kept += line.slice(0, lineComment);
        line = '';
      }
    }
    out.push(kept);
  }
  return out.join('\n');
}

/**
 * Count injection primitives in one Rust source. Returns `{ [primitiveId]: n }`
 * with only non-zero entries.
 */
export function countPrimitives(source) {
  const code = stripRustComments(source);
  const counts = {};
  for (const line of code.split('\n')) {
    for (const id of PRIMITIVE_IDS) {
      if (PRIMITIVES[id].test(line)) counts[id] = (counts[id] ?? 0) + 1;
    }
  }
  return counts;
}

async function walk(dir, onFile) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(full, onFile);
    } else if (entry.isFile()) {
      await onFile(full);
    }
  }
}

/**
 * Scan a repository root. Returns
 * `{ rust: { [relPath]: counts }, jsAssets: [relPath], openerLibRs: string|null }`.
 */
export async function scanRepo(repoRoot) {
  const rust = {};
  for (const root of RUST_SCAN_ROOTS) {
    await walk(join(repoRoot, root), async full => {
      if (!full.endsWith('.rs')) return;
      const counts = countPrimitives(await readFile(full, 'utf8'));
      if (Object.keys(counts).length) rust[toPosix(relative(repoRoot, full))] = counts;
    });
  }

  const jsAssets = [];
  for (const root of JS_ASSET_ROOTS) {
    await walk(join(repoRoot, root), async full => {
      if (JS_ASSET_EXTENSIONS.some(ext => full.endsWith(ext))) {
        jsAssets.push(toPosix(relative(repoRoot, full)));
      }
    });
  }
  jsAssets.sort();

  let openerLibRs = null;
  try {
    openerLibRs = await readFile(join(repoRoot, OPENER_LIB_RS), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  return { rust, jsAssets, openerLibRs };
}

/**
 * `tauri-plugin-opener` ships `init-iife.js` (a global click listener) unless
 * built with `.open_js_links_on_click(false)`. If the shell references the
 * plugin at all, it must use the Builder with that opt-out and never the bare
 * `init()`. Returns a list of error findings (empty when fine or unused).
 */
export function checkOpenerPlugin(libRsSource) {
  if (libRsSource == null) return [];
  const code = stripRustComments(libRsSource);
  if (!/tauri_plugin_opener/.test(code)) return [];
  const findings = [];
  if (/tauri_plugin_opener::init\s*\(/.test(code)) {
    findings.push({
      code: 'opener_plugin_js_enabled',
      file: OPENER_LIB_RS,
      message:
        'tauri_plugin_opener::init() registers the plugin with its default init script ' +
        '(init-iife.js click listener). Use tauri_plugin_opener::Builder::default()' +
        '.open_js_links_on_click(false).build() instead.',
    });
  }
  const builderOk = /tauri_plugin_opener::Builder::default\(\)[\s\S]{0,400}?\.open_js_links_on_click\(\s*false\s*\)/.test(
    code
  );
  if (!builderOk && !findings.length) {
    findings.push({
      code: 'opener_plugin_js_enabled',
      file: OPENER_LIB_RS,
      message:
        'tauri_plugin_opener is referenced without .open_js_links_on_click(false) on its Builder; ' +
        'the plugin would inject its click-listener init script into every webview.',
    });
  }
  return findings;
}

/**
 * Compare a scan against the allowlist.
 * Returns `{ errors: Finding[], warnings: Finding[] }` where a Finding is
 * `{ code, file, message, primitive?, actual?, allowed? }`.
 */
export function evaluate(scan, allowlist) {
  const errors = [];
  const warnings = [];
  const sites = allowlist.rust_injection_sites ?? {};
  const assets = new Set(allowlist.js_assets ?? []);

  // Allowlist hygiene: every grandfathered site needs a written reason.
  for (const [file, entry] of Object.entries(sites)) {
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
      errors.push({
        code: 'missing_reason',
        file,
        message: `allowlist entry for ${file} has no "reason"; every grandfathered injection site must say why it exists.`,
      });
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'reason' && !PRIMITIVE_IDS.includes(key)) {
        errors.push({
          code: 'unknown_primitive',
          file,
          primitive: key,
          message: `allowlist entry for ${file} names unknown primitive "${key}" (known: ${PRIMITIVE_IDS.join(', ')}).`,
        });
      }
    }
  }

  // Rust sources: new files, new primitives, grown ceilings, shrinkable ceilings.
  for (const [file, counts] of Object.entries(scan.rust)) {
    const entry = sites[file];
    if (!entry) {
      for (const [primitive, actual] of Object.entries(counts)) {
        errors.push({
          code: 'new_injection_file',
          file,
          primitive,
          actual,
          allowed: 0,
          message: `${file} uses ${primitive} (${actual}×) but is not an allowlisted injection site. New behaviour for CEF webviews must go through CEF handlers or scanner-side CDP (Network.*, Emulation.*, Input.*, Page.* without script injection), not JS injection.`,
        });
      }
      continue;
    }
    for (const [primitive, actual] of Object.entries(counts)) {
      const allowed = entry[primitive];
      if (allowed == null) {
        errors.push({
          code: 'new_primitive_in_file',
          file,
          primitive,
          actual,
          allowed: 0,
          message: `${file} newly uses ${primitive} (${actual}×); the allowlist permits none for this file.`,
        });
      } else if (actual > allowed) {
        errors.push({
          code: 'injection_site_grew',
          file,
          primitive,
          actual,
          allowed,
          message: `${file}: ${primitive} grew from ${allowed} to ${actual} occurrences. Legacy injection must shrink, never grow.`,
        });
      } else if (actual < allowed) {
        warnings.push({
          code: 'ceiling_can_shrink',
          file,
          primitive,
          actual,
          allowed,
          message: `${file}: ${primitive} is at ${actual}, allowlist ceiling is ${allowed}. Lower it (run with --update) so it cannot creep back.`,
        });
      }
    }
  }

  // Stale allowlist entries (file gone or primitive no longer used).
  for (const [file, entry] of Object.entries(sites)) {
    const counts = scan.rust[file];
    for (const primitive of Object.keys(entry)) {
      if (primitive === 'reason' || !PRIMITIVE_IDS.includes(primitive)) continue;
      if (!counts || counts[primitive] == null) {
        warnings.push({
          code: 'stale_allowlist_entry',
          file,
          primitive,
          actual: 0,
          allowed: entry[primitive],
          message: `${file} no longer uses ${primitive}; remove it from the allowlist (run with --update).`,
        });
      }
    }
  }

  // JS assets: anything new under the shell is an error; stale entries warn.
  for (const asset of scan.jsAssets) {
    if (!assets.has(asset)) {
      errors.push({
        code: 'new_js_asset',
        file: asset,
        message: `${asset} is a new JavaScript file under the Tauri shell. No new injectable JS may be added (CLAUDE.md "CEF child webviews — no new JS injection").`,
      });
    }
  }
  const present = new Set(scan.jsAssets);
  for (const asset of assets) {
    if (!present.has(asset)) {
      warnings.push({
        code: 'stale_js_asset',
        file: asset,
        message: `${asset} is allowlisted but no longer exists; remove it (run with --update).`,
      });
    }
  }

  errors.push(...checkOpenerPlugin(scan.openerLibRs));

  return { errors, warnings };
}

/**
 * Produce an allowlist with ceilings lowered to the scanned counts and stale
 * entries/assets pruned. Never raises a ceiling or adds a site: growth needs a
 * human to edit the file and write a reason.
 */
export function shrinkAllowlist(allowlist, scan) {
  const next = {
    ...allowlist,
    rust_injection_sites: {},
    js_assets: [],
  };
  for (const [file, entry] of Object.entries(allowlist.rust_injection_sites ?? {})) {
    const counts = scan.rust[file] ?? {};
    const kept = { reason: entry.reason };
    for (const primitive of PRIMITIVE_IDS) {
      if (entry[primitive] == null) continue;
      const actual = counts[primitive];
      if (actual == null) continue;
      kept[primitive] = Math.min(entry[primitive], actual);
    }
    if (Object.keys(kept).length > 1) next.rust_injection_sites[file] = kept;
  }
  const present = new Set(scan.jsAssets);
  next.js_assets = (allowlist.js_assets ?? []).filter(a => present.has(a)).sort();
  return next;
}

/** Render findings for humans; emits GitHub annotations when `github` is true. */
export function formatReport({ errors, warnings }, { github = false } = {}) {
  const lines = [];
  for (const w of warnings) {
    lines.push(github ? `::warning file=${w.file}::${w.message}` : `warning: ${w.message}`);
  }
  for (const e of errors) {
    lines.push(github ? `::error file=${e.file}::${e.message}` : `error: ${e.message}`);
  }
  if (!errors.length) {
    lines.push(
      `[webview-injection-guard] OK — no new JS injection into CEF webviews (${warnings.length} warning${warnings.length === 1 ? '' : 's'}).`
    );
  } else {
    lines.push(
      `[webview-injection-guard] FAILED — ${errors.length} finding${errors.length === 1 ? '' : 's'}. See scripts/webview-injection-guard/README.md.`
    );
  }
  return lines.join('\n');
}
