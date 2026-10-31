## [ERR-20261031-PF1] dashboard stylesheet location

**Logged**: 2026-10-31T01:08:00+08:00
**Priority**: low
**Status**: resolved
**Area**: frontend

### Summary
Assumed the dashboard CSS lived under ui/src/ui/styles; native file read/grep returned NOT_FOUND.

### Error
`NOT_FOUND: 系统找不到指定的文件。 (os error 2)`

### Suggested Fix
Find the actual dashboard.css path with ops_glob before reading. No files changed by the failed calls.

## [ERR-20261031-PF2] expected red regression gate

**Logged**: 2026-10-31T01:12:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary
Isolated task-2 regression gate exited 1 before fixes, confirming the three performance defects.

### Error
`AssertionError: waiting for a refresh must not freeze the first history load`;
`large escaped entries must obey the total retention budget`;
dashboard assertions exposed the DOM scan, inspector visibility coupling, and tab backdrop blur.

### Suggested Fix
Keep hydration alive until replacement; cap combined Markdown source/HTML retention; remove scrolling visibility style reads and DOM-wide iframe lookup. Re-run only isolated task-2 tests. Resolved: isolated compile and seven selected files pass 64/64 assertions at the Node test runner level.

## [ERR-20261031-PF3] offline CDP fixture readiness

**Logged**: 2026-10-31T01:58:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary
First isolated dashboard CDP run timed out waiting for all 24 srcdoc readiness messages and prewarm. Diagnostics on second run: frames24/frameReady24 but ready0, no renderer exceptions. Root cause: srcdoc inherits app CSP script-src self, so inline runtime/helper scripts never execute. Set CDP Page.setBypassCSP only for this offline fixture before creating srcdoc; network-denial + sandbox remain active and product CSP is unchanged. Bypass must be set before navigating the top document, not after initial load. Navigate canonical dist/index.html rather than Page.reload: SPA history changes file URL to /chat, and reload produces chrome-error://chromewebdata/ for nonexistent dist/chat.

### Error
`AssertionError [ERR_ASSERTION]: 24 local srcdoc runtimes and prewarm settled`

## [ERR-20261031-PF4] teammate target alias

**Status**: resolved
**Area**: coordination

Sent a review coordination message to guessed target `installer`; tool returned `Error: active teammate "installer" not found`. Re-list agents and use exact returned target `installer-perf`; never infer target from conversational shorthand.

## [LRN-20261031-PF5] verify escaped source representations

**Status**: resolved
**Area**: review

Native read output displayed backslashes in tool-presentation newline regex/strings as double-escaped. A provisional review suspicion was retracted after directly transpiling/executing the source: multiline diff and truncation both produce actual line breaks correctly. Prefer executable behavior/byte-level inspection before treating rendered escape sequences as a source defect; notified owner immediately. Probe: .cache/task2-review-tool-code.json.

## [ERR-20261031-PF6] CDP wait argument

**Status**: resolved
**Area**: tests

A disposable review probe passed a child process object as waitForPageTarget's second argument; actual signature is `(port, timeoutMs = 90_000)`. This made deadline comparison invalid and returned null immediately; subsequent access failed with `TypeError: Cannot read properties of null (reading 'url')`. Read the helper signature, pass numeric timeout, and assert page before URL access. First failed probe cleaned its owned empty staged runtime in finally; no product change.

## [ERR-20261031-PF7] Review probe killTree argument

**Status**: resolved
**Area**: tests

The disposable review probe called `killTree(child.pid)` but shared helper expects `killTree(child)` and reads `child.pid`. Probe evidence succeeded, then staged cleanup raised `EPERM: operation not permitted, unlink 'C:\Users\binchen\AppData\Local\Temp\cryoclaw-ui-runtime-ZpfhLD\ffmpeg.dll'`. Verified only this exact owned runtime directory, found zero surviving matching processes after resumption, and removed it successfully. Production dashboard probe already uses `killTree(child)` correctly. Fix disposable helper argument and read helper signatures before reuse; do not assume Node process utility conventions.

The subsequent production-function probe exited with `AssertionError [ERR_ASSERTION]: Locate actual highlighter function` because its extraction end anchor used a comment the owner had just replaced during the confirmed bug fix. Re-read current source and use the function's top-level closing brace as boundary; no product compile or mutation occurred. Helper finally cleanup was successful after correcting killTree.

Review probe lesson: native file:// import of installed highlight.js ES shim does not equal the Vite-bundled browser library. The production highlighter catches import failures, so a probe that only asserts rerender can falsely pass without performing DOM mutation. Add the mandatory `dataset.hljsDone === '1'` assertion. For isolated marker/race verification, execute the actual function with deterministic escaped token output (explicitly disclose stubbed grammar); leave full real grammar/bundle validation to the lead's offline app smoke.
