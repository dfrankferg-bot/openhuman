# webview-injection-guard

Deterministic enforcement of the CLAUDE.md rule **"CEF child webviews — no new JS injection"**.

The Tauri shell embeds third-party origins (Slack, Telegram, WhatsApp, …) in CEF webviews. Any host-controlled JavaScript that runs inside those origins is a scraping and attack-surface liability, so migrated providers must load with **zero** injected JS and legacy injection must **shrink, never grow**. This guard turns that from a reviewer's memory into a check that runs in CI and on `git push`.

## What it checks

| Check | Fails when |
| --- | --- |
| Rust injection primitives | A `.rs` file under `app/src-tauri/src` uses `initialization_script(`, `Page.addScriptToEvaluateOnNewDocument`, `Runtime.evaluate`, `js_init_script(` or `include_str!("….js")` and is not in `allowlist.json`, uses a primitive the allowlist does not grant it, or exceeds its per-primitive ceiling. Comments are stripped first; string literals count. |
| JS assets | Any `.js` / `.mjs` / `.cjs` file under `app/src-tauri/src` or `app/src-tauri/recipes` that is not allowlisted. `vendor/`, `target/`, `gen/`, `node_modules/` are skipped. |
| `tauri-plugin-opener` | `app/src-tauri/src/lib.rs` references the plugin via `init()` or without `.open_js_links_on_click(false)`, which would inject its `init-iife.js` click listener into every webview. |
| Allowlist hygiene | An entry has no `reason`, or names an unknown primitive. |

Warnings (never fail): a ceiling that can be lowered, or an allowlist entry whose file / primitive / asset no longer exists. Run `--update` to apply them.

## Usage

```bash
pnpm check:webview-injection            # same as CI and the pre-push hook
pnpm check:webview-injection -- --json  # machine-readable report
pnpm check:webview-injection -- --update  # lower ceilings, prune stale entries (never raises)
pnpm check:webview-injection:test       # node:test suite, includes a repo-matches-allowlist test
```

Exit codes: `0` clean (warnings allowed), `1` findings, `2` usage or I/O error. Under `GITHUB_ACTIONS` findings are emitted as `::error file=…::` annotations.

## When the guard fails on your PR

1. **You added injection into a CEF webview.** Don't. Move the behaviour to a CEF handler (`on_navigation`, `on_new_window`, `LoadHandler::OnLoadStart`, `CefRequestHandler::*`) or to scanner-side CDP (`Network.*`, `Emulation.*`, `Input.*`, `Page.*` without script evaluation). If it truly cannot be built that way, surface the limitation instead of shipping a script.
2. **You refactored a grandfathered site and the count moved.** Lowering is free: `pnpm check:webview-injection -- --update`. Raising is a review decision: edit `allowlist.json` by hand, update the `reason`, and explain in the PR why the legacy surface grew.
3. **You added a Tauri plugin.** Audit it for `js_init_script`. If it injects by default, configure it off (see the opener example in `lib.rs`).

Migrated providers (`whatsapp`, `wechat`, `telegram`, `slack`, `discord`, `browserscan`) must never appear in the allowlist.

## Files

- `lib.mjs` — pure scan / evaluate / shrink / format functions.
- `cli.mjs` — process I/O, flags, exit codes.
- `allowlist.json` — grandfathered sites with ceilings and reasons. Source of truth for what is tolerated.
- `__tests__/lib.test.mjs` — fixture-based unit tests plus a test asserting the committed allowlist matches the tree exactly (no errors, no warnings).

Wired into: `.github/workflows/webview-injection-guard.yml`, `.husky/pre-push`, `.claude/rules/webview-injection-guard.md`.

## Scope and limits

This is a **source-level** guard: it proves no new injection *code path* exists. It does not observe a running CEF process. For a runtime audit of what a built app actually evaluates inside a provider origin, see "Deeper runtime audit" in `gitbooks/developing/cef.md`.
