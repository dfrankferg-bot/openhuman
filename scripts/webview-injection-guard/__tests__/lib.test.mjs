import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { run } from '../cli.mjs';
import {
  PRIMITIVE_IDS,
  checkOpenerPlugin,
  countPrimitives,
  evaluate,
  formatReport,
  scanRepo,
  shrinkAllowlist,
  stripRustComments,
} from '../lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..', '..', '..');
const REAL_ALLOWLIST = resolve(here, '..', 'allowlist.json');

const OPENER_OK = `
    .plugin(
        tauri_plugin_opener::Builder::default()
            .open_js_links_on_click(false)
            .build(),
    )
`;

/** Build a throwaway repo tree: { 'app/src-tauri/src/foo.rs': '...', ... }. */
async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), 'wig-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  return root;
}

function baseAllowlist(overrides = {}) {
  return {
    rust_injection_sites: {
      'app/src-tauri/src/legacy/inject.rs': {
        runtime_evaluate: 2,
        include_js: 1,
        reason: 'grandfathered bridge',
      },
    },
    js_assets: ['app/src-tauri/src/legacy/bridge.js'],
    ...overrides,
  };
}

function baseFiles(overrides = {}) {
  return {
    'app/src-tauri/src/lib.rs': OPENER_OK,
    'app/src-tauri/src/legacy/inject.rs': `
      const BRIDGE: &str = include_str!("bridge.js");
      // Runtime.evaluate mentioned in a comment must not count
      /// Runtime.evaluate in a doc comment must not count either
      fn a() { call("Runtime.evaluate", x) }
      fn b() { call("Runtime.evaluate", y) }
    `,
    'app/src-tauri/src/legacy/bridge.js': 'window.x = 1;',
    'app/src-tauri/src/clean/scanner.rs': 'fn c() { call("Network.enable") }',
    ...overrides,
  };
}

test('stripRustComments removes line, doc and block comments but keeps code', () => {
  const src = [
    'let a = 1; // Runtime.evaluate here is a comment',
    '/// Page.addScriptToEvaluateOnNewDocument doc comment',
    '//! Page.addScriptToEvaluateOnNewDocument module doc',
    '/* block Runtime.evaluate',
    '   still block */ let b = "Runtime.evaluate";',
    'let c = /* inline Runtime.evaluate */ 3;',
  ].join('\n');
  const out = stripRustComments(src);
  assert.equal((out.match(/Runtime\.evaluate/g) ?? []).length, 1);
  assert.equal((out.match(/addScriptToEvaluateOnNewDocument/g) ?? []).length, 0);
  assert.match(out, /let a = 1;/);
  assert.match(out, /let b = "Runtime\.evaluate";/);
  assert.match(out, /let c = {2}3;/);
});

test('countPrimitives counts each primitive on non-comment lines only', () => {
  const src = `
    builder = builder.initialization_script(&init);
    call("Page.addScriptToEvaluateOnNewDocument", p);
    call("Runtime.evaluate", a); // Runtime.evaluate
    .map_err(|e| format!("Runtime.evaluate failed: {e}"))
    let x = include_str!("runtime.js");
    let y = include_str!("../../recipes/foo/recipe.js");
    let z = include_str!("not_js.txt");
    plugin.js_init_script(SCRIPT);
  `;
  assert.deepEqual(countPrimitives(src), {
    initialization_script: 1,
    add_script_on_new_document: 1,
    runtime_evaluate: 2,
    include_js: 2,
    js_init_script: 1,
  });
  assert.deepEqual(countPrimitives('fn ok() {}'), {});
  for (const id of PRIMITIVE_IDS) assert.equal(typeof id, 'string');
});

test('scanRepo finds rust sites and js assets, skipping vendor/target/gen', async () => {
  const root = await fixture(
    baseFiles({
      'app/src-tauri/vendor/x/evil.rs': 'call("Runtime.evaluate", v)',
      'app/src-tauri/target/debug/evil.js': 'x',
      'app/src-tauri/gen/schemas/evil.js': 'x',
      'app/src-tauri/recipes/foo/recipe.js': 'x',
    })
  );
  try {
    const scan = await scanRepo(root);
    assert.deepEqual(Object.keys(scan.rust), ['app/src-tauri/src/legacy/inject.rs']);
    assert.deepEqual(scan.rust['app/src-tauri/src/legacy/inject.rs'], {
      include_js: 1,
      runtime_evaluate: 2,
    });
    assert.deepEqual(scan.jsAssets, [
      'app/src-tauri/recipes/foo/recipe.js',
      'app/src-tauri/src/legacy/bridge.js',
    ]);
    assert.match(scan.openerLibRs, /open_js_links_on_click/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scanRepo tolerates a tree without the shell at all', async () => {
  const root = await fixture({ 'README.md': 'nothing here' });
  try {
    const scan = await scanRepo(root);
    assert.deepEqual(scan, { rust: {}, jsAssets: [], openerLibRs: null });
    assert.deepEqual(evaluate(scan, { rust_injection_sites: {}, js_assets: [] }).errors, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('evaluate: matching scan is clean', async () => {
  const root = await fixture(baseFiles());
  try {
    const result = evaluate(await scanRepo(root), baseAllowlist());
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('evaluate: a new file using a primitive is an error', async () => {
  const root = await fixture(
    baseFiles({ 'app/src-tauri/src/slack_scanner/mod.rs': 'call("Runtime.evaluate", s)' })
  );
  try {
    const { errors } = evaluate(await scanRepo(root), baseAllowlist());
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'new_injection_file');
    assert.equal(errors[0].file, 'app/src-tauri/src/slack_scanner/mod.rs');
    assert.equal(errors[0].primitive, 'runtime_evaluate');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('evaluate: a new primitive inside an allowlisted file is an error', async () => {
  const files = baseFiles();
  files['app/src-tauri/src/legacy/inject.rs'] += '\nfn d() { b.initialization_script(s) }';
  const root = await fixture(files);
  try {
    const { errors } = evaluate(await scanRepo(root), baseAllowlist());
    assert.deepEqual(
      errors.map(e => e.code),
      ['new_primitive_in_file']
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('evaluate: growth past the ceiling is an error, shrink is a warning', async () => {
  const files = baseFiles();
  files['app/src-tauri/src/legacy/inject.rs'] += '\nfn d() { call("Runtime.evaluate", z) }';
  const grown = await fixture(files);
  const shrunk = await fixture(
    baseFiles({
      'app/src-tauri/src/legacy/inject.rs':
        'const BRIDGE: &str = include_str!("bridge.js");\nfn a() { call("Runtime.evaluate", x) }',
    })
  );
  try {
    const g = evaluate(await scanRepo(grown), baseAllowlist());
    assert.equal(g.errors.length, 1);
    assert.equal(g.errors[0].code, 'injection_site_grew');
    assert.equal(g.errors[0].actual, 3);
    assert.equal(g.errors[0].allowed, 2);

    const s = evaluate(await scanRepo(shrunk), baseAllowlist());
    assert.deepEqual(s.errors, []);
    assert.equal(s.warnings.length, 1);
    assert.equal(s.warnings[0].code, 'ceiling_can_shrink');
    assert.equal(s.warnings[0].actual, 1);
  } finally {
    await rm(grown, { recursive: true, force: true });
    await rm(shrunk, { recursive: true, force: true });
  }
});

test('evaluate: a new .js asset anywhere under the shell is an error', async () => {
  const root = await fixture(
    baseFiles({ 'app/src-tauri/src/telegram_scanner/hook.js': 'document.title = 1' })
  );
  try {
    const { errors } = evaluate(await scanRepo(root), baseAllowlist());
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'new_js_asset');
    assert.equal(errors[0].file, 'app/src-tauri/src/telegram_scanner/hook.js');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('evaluate: stale allowlist entries and assets warn, missing reason errors', async () => {
  const root = await fixture(baseFiles());
  try {
    const allowlist = baseAllowlist({
      rust_injection_sites: {
        'app/src-tauri/src/legacy/inject.rs': { runtime_evaluate: 2, include_js: 1, reason: 'ok' },
        'app/src-tauri/src/gone.rs': { runtime_evaluate: 1, reason: 'was removed' },
        'app/src-tauri/src/noreason.rs': { runtime_evaluate: 1 },
      },
      js_assets: ['app/src-tauri/src/legacy/bridge.js', 'app/src-tauri/src/gone.js'],
    });
    const { errors, warnings } = evaluate(await scanRepo(root), allowlist);
    assert.deepEqual(
      errors.map(e => e.code),
      ['missing_reason']
    );
    assert.deepEqual(
      warnings.map(w => w.code).sort(),
      ['stale_allowlist_entry', 'stale_allowlist_entry', 'stale_js_asset']
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('evaluate: unknown primitive key in allowlist is an error', () => {
  const scan = { rust: {}, jsAssets: [], openerLibRs: null };
  const { errors } = evaluate(scan, {
    rust_injection_sites: { 'app/src-tauri/src/x.rs': { eval_anything: 1, reason: 'typo' } },
    js_assets: [],
  });
  assert.deepEqual(
    errors.map(e => e.code).sort(),
    ['unknown_primitive']
  );
});

test('checkOpenerPlugin: Builder with opt-out passes, init() or missing opt-out fails, unused passes', () => {
  assert.deepEqual(checkOpenerPlugin(OPENER_OK), []);
  assert.deepEqual(checkOpenerPlugin(null), []);
  assert.deepEqual(checkOpenerPlugin('fn main() {}'), []);
  // A commented-out init() must not trip it.
  assert.deepEqual(checkOpenerPlugin(`${OPENER_OK}\n// .plugin(tauri_plugin_opener::init())`), []);

  const bad = checkOpenerPlugin('.plugin(tauri_plugin_opener::init())');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].code, 'opener_plugin_js_enabled');
  assert.match(bad[0].message, /init\(\)/);

  const noOptOut = checkOpenerPlugin('.plugin(tauri_plugin_opener::Builder::default().build())');
  assert.equal(noOptOut.length, 1);
  assert.match(noOptOut[0].message, /open_js_links_on_click\(false\)/);

  const optInTrue = checkOpenerPlugin(
    '.plugin(tauri_plugin_opener::Builder::default().open_js_links_on_click(true).build())'
  );
  assert.equal(optInTrue.length, 1);
});

test('shrinkAllowlist lowers ceilings and prunes stale entries but never raises or adds', async () => {
  const root = await fixture(
    baseFiles({
      'app/src-tauri/src/legacy/inject.rs':
        'const BRIDGE: &str = include_str!("bridge.js");\nfn a() { call("Runtime.evaluate", x) }',
      'app/src-tauri/src/new_site.rs': 'call("Runtime.evaluate", n)',
    })
  );
  try {
    const scan = await scanRepo(root);
    const next = shrinkAllowlist(
      baseAllowlist({
        rust_injection_sites: {
          'app/src-tauri/src/legacy/inject.rs': { runtime_evaluate: 2, include_js: 1, reason: 'r' },
          'app/src-tauri/src/gone.rs': { runtime_evaluate: 9, reason: 'gone' },
        },
        js_assets: ['app/src-tauri/src/legacy/bridge.js', 'app/src-tauri/src/gone.js'],
      }),
      scan
    );
    assert.deepEqual(next.rust_injection_sites, {
      'app/src-tauri/src/legacy/inject.rs': { reason: 'r', runtime_evaluate: 1, include_js: 1 },
    });
    assert.deepEqual(next.js_assets, ['app/src-tauri/src/legacy/bridge.js']);
    // The new site is still an error after shrinking: growth needs a human.
    assert.equal(evaluate(scan, next).errors[0].code, 'new_injection_file');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('formatReport renders plain text and GitHub annotations', () => {
  const result = {
    errors: [{ code: 'x', file: 'a.rs', message: 'bad thing' }],
    warnings: [{ code: 'y', file: 'b.rs', message: 'meh' }],
  };
  const plain = formatReport(result);
  assert.match(plain, /^warning: meh$/m);
  assert.match(plain, /^error: bad thing$/m);
  assert.match(plain, /FAILED — 1 finding\./);
  const gh = formatReport(result, { github: true });
  assert.match(gh, /^::error file=a\.rs::bad thing$/m);
  assert.match(gh, /^::warning file=b\.rs::meh$/m);
  assert.match(formatReport({ errors: [], warnings: [] }), /OK — no new JS injection/);
});

test('cli: exit 1 with JSON report on findings, exit 0 when clean, exit 2 on bad args', async () => {
  const root = await fixture(
    baseFiles({ 'app/src-tauri/src/discord_scanner/mod.rs': 'call("Runtime.evaluate", d)' })
  );
  const allowlistPath = join(root, 'allowlist.json');
  await writeFile(allowlistPath, JSON.stringify(baseAllowlist()));
  const capture = () => {
    const out = [];
    return { out, log: s => out.push(String(s)) };
  };
  try {
    const bad = capture();
    const code = await run(['--root', root, '--allowlist', allowlistPath, '--json'], {
      stdout: bad.log,
      stderr: bad.log,
    });
    assert.equal(code, 1);
    const report = JSON.parse(bad.out.join('\n'));
    assert.equal(report.ok, false);
    assert.equal(report.errors[0].code, 'new_injection_file');
    assert.ok(report.scan.rust['app/src-tauri/src/discord_scanner/mod.rs']);

    await rm(join(root, 'app/src-tauri/src/discord_scanner'), { recursive: true });
    const good = capture();
    assert.equal(
      await run(['--root', root, '--allowlist', allowlistPath], { stdout: good.log, stderr: good.log }),
      0
    );
    assert.match(good.out.join('\n'), /OK — no new JS injection/);

    const usage = capture();
    assert.equal(await run(['--bogus'], { stdout: usage.log, stderr: usage.log }), 2);
    assert.match(usage.out.join('\n'), /unknown argument/);

    const missing = capture();
    assert.equal(
      await run(['--root', root, '--allowlist', join(root, 'nope.json')], {
        stdout: missing.log,
        stderr: missing.log,
      }),
      2
    );
    assert.equal(await run(['--help'], { stdout: () => {}, stderr: () => {} }), 0);
    // pnpm passes the `--` separator through to the script; it must be ignored.
    const sep = capture();
    assert.equal(
      await run(['--', '--root', root, '--allowlist', allowlistPath, '--json'], { stdout: sep.log, stderr: sep.log }),
      0
    );
    assert.equal(JSON.parse(sep.out.join('\n')).ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cli --update rewrites the allowlist with lowered ceilings', async () => {
  const root = await fixture(
    baseFiles({
      'app/src-tauri/src/legacy/inject.rs':
        'const BRIDGE: &str = include_str!("bridge.js");\nfn a() { call("Runtime.evaluate", x) }',
    })
  );
  const allowlistPath = join(root, 'allowlist.json');
  await writeFile(allowlistPath, JSON.stringify(baseAllowlist()));
  try {
    const code = await run(['--root', root, '--allowlist', allowlistPath, '--update'], {
      stdout: () => {},
      stderr: () => {},
    });
    assert.equal(code, 0);
    const { readFile } = await import('node:fs/promises');
    const written = JSON.parse(await readFile(allowlistPath, 'utf8'));
    assert.equal(written.rust_injection_sites['app/src-tauri/src/legacy/inject.rs'].runtime_evaluate, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The real regression test: the committed allowlist must describe the tree
// exactly, so the guard fails the moment anyone adds injection — and nags the
// moment legacy injection shrinks without the ceiling following.
test('repo: committed allowlist matches app/src-tauri with no errors and no warnings', async () => {
  const { readFile } = await import('node:fs/promises');
  const allowlist = JSON.parse(await readFile(REAL_ALLOWLIST, 'utf8'));
  const result = evaluate(await scanRepo(REPO_ROOT), allowlist);
  assert.deepEqual(result.errors, [], formatReport(result));
  assert.deepEqual(result.warnings, [], formatReport(result));
});
