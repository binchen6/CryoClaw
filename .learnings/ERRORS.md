# Execution errors

## [ERR-20261031-011] Provider editor asynchronous lifetime
**Status**: resolved
Refactoring inline model settings into separate views exposed existing handler ownership bugs: key validation held the patch lock itself; late validation/model-list responses could update a reset or different form; successful key save cleared the editing identity while the new detail view remained open. Keep validation and patch locks separate, capture immutable form values, use reset-revoked operation tokens and lifetime gates after awaits, and let only the current operation clear its lock. Regression tests must cover switching tabs, reopening the same provider, retry, repeat save, and late finally—not only successful first save.

## [ERR-20261031-010] Windows Python app execution alias
**Status**: resolved
`python scripts/refactor-provider-workbench.py` exited 49 without output. Source was checked unchanged before retry. `command -v python` resolved WindowsApps, not a usable interpreter. Use the bundled Python returned by load_workspace_dependencies; that invocation succeeded. After script/parallel edits always re-read before targeted edit; filesystem version guard correctly rejected a stale observation.


## [ERR-20261031-001] hindsight unavailable and paid background usage
**Logged**: 2026-10-31T00:35:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: infra

### Summary
Repository memory service initially refused connections. Restoring it enabled retain/consolidation calls using the existing DeepSeek configuration, which consumed the user's paid quota without a clear upfront warning.
### Resolution
The daemon and logon task were stopped, and `disabled: true` was set in the user-level Hindsight config. Do not restart the daemon or memory tools without explicit user approval and a clear account of background model costs.

## [ERR-20261031-002] shell and repository discovery
**Logged**: 2026-10-31T00:35:00+08:00
**Priority**: low
**Status**: resolved
**Area**: infra

### Summary
The current directory is a parent of the git repository and ops_bash actually executes Bash.
### Error
`fatal: not a git repository (or any of the parent directories): .git`
`/usr/bin/bash: line 1: Get-ChildItem: command not found`
### Resolution
Use Oneclaw as command workdir, Bash syntax, and published file tools for reads/changes. No file effects occurred.

## [ERR-20261031-003] assumed optional paths
**Logged**: 2026-10-31T01:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: infra

### Summary
Optional design directory and Vitest config were assumed to exist; file reads and ls returned NOT_FOUND / exit 2.
### Resolution
Use the existing node:test/chat test runner, discover paths first, and create a scoped design directory when needed. Read-only probes had no side effects.

## [ERR-20261031-004] bounded team and reproduced style regression
**Logged**: 2026-10-31T01:10:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: frontend

### Summary
Isolated Electron visual regression reproduced black stop surface and muted (not destructive) glyph; custom textarea thin scrollbar also won the cascade. Expected red phase of regression, no real user profile/network involved.
### Evidence
`background: rgb(0, 0, 0)`, `color: rgb(86, 96, 119)`, expected `rgb(220, 38, 38)`, `textareaScrollbar: thin`; rendererExceptions [].
### Execution note
Fourth teammate creation was rejected with `subagent limit reached (active child limit: 3)`; handle tool UI scope on Lead until an existing member finishes.

## [ERR-20261031-005] abort fixture terminal-event assumption
**Priority**: low
**Status**: resolved
**Area**: testing

### Summary
The isolated smoke expected an abort ACK alone to clear an active run. Product intentionally keeps the pending guard until the matching terminal event; this is not a product bug.
### Error
`AssertionError [ERR_ASSERTION]: Abort acknowledged`
### Resolution
Preserve the original gateway client event callback in the network-isolated fixture; simulate ACK and matching terminal event separately, verify pending stays set between them. All four settled theme/width color checks already pass.
### Repeated discovery lesson
Do not guess optional module paths (including settings index/hotkeys). Run ops_glob before reading unknown paths.

## [ERR-20261031-006] native modal shortcut integration
**Priority**: medium
**Status**: resolved
**Area**: frontend

### Summary
Actual CDP keyboard dispatch found that the shared findOpenDialog helper covers custom role/aria-modal dialogs only. The new shortcut guard initially still activated Ctrl+N over a native dialog.
### Evidence
`shortcutGuards: {repeat:false, ime:false, modal:true, focus:true}`; expected modal false.
### Resolution
Explicitly include `dialog[open]` alongside the existing custom-dialog helper at the chat shortcut boundary. Keep native dialog escape/focus handling browser-owned. Rebuild and rerun real renderer integration rather than relying only on a mocked modal boolean.

## [ERR-20261031-007] file observation guard
**Priority**: low
**Status**: resolved
**Area**: infra

### Summary
Grep results do not count as reading a file before editing; i18n edits were rejected with `file has not been read` and no changes applied.
### Resolution
Read bounded ranges of both dictionaries before applying the targeted changes. Use actual token and icon catalogs instead of guessing names.

## [ERR-20261031-008] isolated settings navigation
**Priority**: low
**Status**: resolved
**Area**: test

### Summary
The isolated renderer catalog check timed out without renderer exceptions because the fixture changed the legacy `app.tab` instead of the shell's actual `settings.cryoclawView` route. Earlier catch-all RPC replies also produced invalid typed state.
### Resolution
Read the real render dispatcher, use the actual settings route and navigation hint, and keep unrelated fixture RPCs pending rather than returning malformed successful objects. This is a fixture fix, not a product routing regression.

## [ERR-20261031-009] presentation regression and async DOM ownership
**Priority**: medium
**Status**: resolved
**Area**: frontend

### Summary
Real Lit rendering demonstrated `TypeError: Cannot set properties of null (setting 'data')` when a highlighter replaced nodes owned by a text ChildPart. Existing tool-card tests also found missing output line metadata and a lost full-output action after the structured-sheet redesign.
### Resolution
Give the highlighter an empty code element owned only by its ref, guard asynchronous updates by source/language/connection, and verify a second real renderer update. Restore line metadata and the working sidebar callback with uncapped source; without a callback retain full-source copy instead of a no-op button. Freeze production edits before starting the four-layer suite; the prematurely started suite was cancelled and is not counted as a pass.

## [ERR-20261031-010] provider workbench operation lifetime
**Priority**: medium
**Status**: resolved
**Area**: frontend

### Summary
Provider key verification held the same busy flag that rejected its own config patch. Add/save/fetch continuations could also read changed form data or update a reset editor, and managed-key editing initially lost its visible editor in the new detail layout.
### Resolution
Separate verification and patch locks, capture immutable submission data, and revoke stale operations with per-operation tokens and a page lifetime. Guard late results and finally blocks without claiming to cancel an already-sent patch. Cover repeat saves and reset races with production-function VM tests, and exercise managed-key editing and append/cancel in the isolated real renderer. Discover existing paths before reading optional files instead of guessing locations; the later setup-constants lookup was a NOT_FOUND probe with no applied effect.

## [ERR-20261031-012] provider icon aliases and custom identity
**Priority**: low
**Status**: resolved
**Area**: frontend

### Summary
The first provider-icon regression run failed because the `custom` prefix alias returned before endpoint-based brand inference (`custom-host` + DeepSeek endpoint incorrectly resolved to `custom`). The user also clarified that genuinely custom providers should show their initial, not the same generic glyph as presets.
### Error
`AssertionError: actual 'custom', expected 'deepseek'` in provider-icons.test.ts.
### Resolution
Exclude the `custom` prefix from brand prefix aliases, then infer known custom-host brands from the configured endpoint. Render unknown custom providers as a Lit-escaped first character from their display name; keep the manual custom preset glyph. Four focused icon tests and UI TypeScript checking pass.

## [ERR-20261031-013] release network preflight
**Priority**: medium
**Status**: resolved
**Area**: release

### Summary
Direct Git HTTPS failed with connection reset while the GitHub API remained reachable. HTTP/1.1 did not help, but the OpenSSL backend restored `git ls-remote origin HEAD`.
### Resolution
Use command-scoped `git -c http.sslBackend=openssl ...` for remote operations; do not change global proxy settings or bypass release asset assertions.

## [ERR-20261031-014] ambiguous narrow-screen CSS edit
**Priority**: low
**Status**: resolved
**Area**: frontend

### Summary
A targeted provider-workbench edit matched two `.oc-provider-tile` blocks and was rejected without modifying the file.

### Resolution
Retried with the adjacent catalog-header context; only the intended max-width 420 container rule was changed.
