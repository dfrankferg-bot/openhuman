---
paths:
  - "app/src-tauri/src/**"
  - "app/src-tauri/recipes/**"
  - "scripts/webview-injection-guard/**"
---

# Webview injection guard (Tauri shell)

The "no new JS injection into CEF webviews" rule in CLAUDE.md is **machine-enforced**. Any change under `app/src-tauri/` must pass:

```bash
pnpm check:webview-injection        # scans app/src-tauri against scripts/webview-injection-guard/allowlist.json
pnpm check:webview-injection:test   # fixture tests + "allowlist matches tree" test
```

Run both before you report a shell change as done. CI (`webview-injection-guard.yml`) and the pre-push hook run the same scan, so a red result here is a red PR.

Rules of engagement when it fails:

- **Never** add `initialization_script`, `Page.addScriptToEvaluateOnNewDocument`, `Runtime.evaluate`, `js_init_script`, `include_str!("*.js")`, or a new `.js` file to reach a provider webview. Use CEF handlers or scanner-side CDP (`Network.*`, `Emulation.*`, `Input.*`, `Page.*` without script evaluation). If the feature cannot be built that way, say so in your report instead of shipping an init script.
- **Never** put a migrated provider (`whatsapp`, `wechat`, `telegram`, `slack`, `discord`, `browserscan`) in the allowlist.
- If a grandfathered count **dropped**, run `pnpm check:webview-injection -- --update` and commit the lowered ceiling.
- If a grandfathered count would **rise**, do not edit the allowlist on your own; report it as a blocker with the exact file and primitive. The user decides.
- New Tauri plugin in `lib.rs`: audit for `js_init_script` and configure it off (see the `tauri_plugin_opener` opt-out).
