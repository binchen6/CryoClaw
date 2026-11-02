# Browser integration and project review

**Goal:** Make the existing embedded browser reliable for shared user/Agent browsing, audit the whole project, and release 2026.1101.0.

**Architecture:** Keep the sandboxed WebContentsView and authenticated local plugin route. The user approved direct execution of this direction on 2026-11-01. Keep the existing Lit UI and runtime; no new runtime dependencies.

## Review focus

- Repeated controls without IDs must be uniquely addressable; ambiguous selectors fail instead of clicking the first match.
- Canceled requests, revoked Agent access, closed windows and hidden views must prevent queued actions.
- Page scripts and navigation must have bounded waits; errors must reach the caller and UI.
- Reopening the dock must retain the live page, restore default UA, and synchronize native bounds without a resize backlog.
- Downloads and untrusted navigation must remain confined to their originating browser and HTTP(S).

## Tasks

- [x] Browser lifecycle and Agent execution: add failing behavioral tests in src/embedded-browser.test.ts, implement bounded/cancelable operations in src/embedded-browser.ts, and forward HTTP cancellation in gateway-control-server.ts/main.ts. Verify targeted tests.
- [x] Reliable page interaction: extract browser page scripts, test unique selectors, secret redaction and form input against a real isolated Electron fixture. Update plugin guidance and preserve bounded results.
- [x] Browser UI: restore state on mount/reconnect, coalesce bounds, preserve address edits, show navigation failures and add an immediate Agent access toggle. Verify real renderer interactions.
- [x] Whole-project debug and optimization review: independently review main/runtime/IO/release and renderer/performance paths. Reproduce important findings, add regression tests, fix and record outcomes.
- [x] Apply the user's 2026-11-02 Dock references: remove collapsed rail and its space; keep top-right expansion. Expanded Dock uses closeable chip tabs, plus/maximize/collapse and a centered launcher; files use a real tree and preview, browser avoids a duplicate single-page tab row. Preserve existing commands and Agent/file/subagent linkage.
- [x] Final local gates: full tests/build, independent review of final diff, isolated Electron browser/UI gates, same-source Windows package, silent install, installed full UI and live chat, actual browser/QQ/terminal checks, startup comparison and exact asset hashes.

Publication executes the draft asset assertion, public release/update discovery and final main push. Its authoritative status is the [version Release](https://github.com/binchen6/CryoClaw/releases/tag/v2026.1101.0); local evidence is recorded in [the verification record](../../RELEASE-2026.1101.0-VERIFICATION.md).

## Evidence ledger

- Baseline HEAD 533d9e9; clean main matching origin/main. Four-layer npm test passes outside the Windows sandbox (22.2 seconds). Sandboxed Vite fails before loading tests with realpath EPERM.
- GitHub authentication and latest main verified in normal-user context; sandbox network/auth failures are environmental.
- Release gates follow docs/releasing.md; historical timing is not reused as a current performance claim.
