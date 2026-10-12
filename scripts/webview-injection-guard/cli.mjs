#!/usr/bin/env node
// Webview injection guard — CLI.
//
//   node scripts/webview-injection-guard/cli.mjs            # check, exit 1 on findings
//   node scripts/webview-injection-guard/cli.mjs --json     # machine-readable report
//   node scripts/webview-injection-guard/cli.mjs --update   # lower ceilings / prune stale entries
//
// Options: --root <dir> (default: repo root), --allowlist <file>.
// Exit codes: 0 clean (warnings allowed), 1 findings, 2 usage/IO error.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluate, formatReport, scanRepo, shrinkAllowlist } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(here, '..', '..');
const DEFAULT_ALLOWLIST = join(here, 'allowlist.json');

export function parseArgs(argv) {
  const opts = { root: DEFAULT_ROOT, allowlist: DEFAULT_ALLOWLIST, json: false, update: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--': // pnpm forwards the separator literally: `pnpm check:webview-injection -- --json`
        break;
      case '--json':
        opts.json = true;
        break;
      case '--update':
        opts.update = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--root':
        opts.root = resolve(argv[++i] ?? '');
        break;
      case '--allowlist':
        opts.allowlist = resolve(argv[++i] ?? '');
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

export async function run(argv, { stdout = console.log, stderr = console.error } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    stderr(`[webview-injection-guard] ${err.message}`);
    return 2;
  }
  if (opts.help) {
    stdout(
      'usage: cli.mjs [--root <dir>] [--allowlist <file>] [--json] [--update]\n' +
        'Scans app/src-tauri for JS-injection primitives and compares against the allowlist.'
    );
    return 0;
  }

  let allowlist;
  try {
    allowlist = JSON.parse(await readFile(opts.allowlist, 'utf8'));
  } catch (err) {
    stderr(`[webview-injection-guard] cannot read allowlist ${opts.allowlist}: ${err.message}`);
    return 2;
  }

  const scan = await scanRepo(opts.root);

  if (opts.update) {
    const next = shrinkAllowlist(allowlist, scan);
    await writeFile(opts.allowlist, `${JSON.stringify(next, null, 2)}\n`);
    stderr(`[webview-injection-guard] allowlist updated (ceilings lowered / stale entries pruned): ${opts.allowlist}`);
    allowlist = next;
  }

  const result = evaluate(scan, allowlist);
  if (opts.json) {
    stdout(JSON.stringify({ ok: result.errors.length === 0, ...result, scan: { rust: scan.rust, jsAssets: scan.jsAssets } }, null, 2));
  } else {
    stdout(formatReport(result, { github: Boolean(process.env.GITHUB_ACTIONS) }));
  }
  return result.errors.length ? 1 : 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exitCode = await run(process.argv.slice(2));
}
