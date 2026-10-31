## [LRN-20261031-IP1] best_practice

**Logged**: 2026-10-31
**Priority**: medium
**Status**: resolved
**Area**: infra

### Summary
Run npm-cli.js with Node, not npm.cmd with shell:true, in the new Chat build wrapper.

### Details
Lead's first real build succeeded, but Node 24 emitted DEP0190: Passing args to a child process with shell option true can lead to security vulnerabilities. The new wrapper introduced this pattern for Windows npm.cmd. Existing scripts/updater/kernel-update.mjs:153-185 already demonstrate direct npm CLI execution, avoiding both shell parsing and Program Files (x86) quoting failures.

### Suggested Action
Use npm_execpath (when npm launched the build) or the adjacent Windows npm-cli.js, with shell:false. Test actual execution from a fixture path containing spaces and shell metacharacters; verify a cached build still runs Vite.

### Metadata
- Source: user_feedback
- Related Files: scripts/build-chat.js, scripts/build-chat-deps.test.js
- Pattern-Key: harden.npm_no_shell

## [LRN-20261031-IP3] tool_sheet_regression

**Logged**: 2026-10-31
**Priority**: medium
**Status**: resolved
**Area**: frontend

The first scoped task4 run passed 48/50 but failed two existing tool-card tests: `缺卡内输出区块` and `截断时应出现「查看完整输出」入口`. Replacing generic exec output with a code sheet must preserve output size metadata and a reachable full-source action, not just syntax highlighting. Update assertions for the new sheet surface while retaining line-count/cap/full-output behavior. The clipboard test also initially counted two handlers but the unchanged card-header copy makes three; the corrected assertion verifies all three exact sources. The added clipboard-handler test initially hit TS2352 because browser+Node setTimeout has an intersection signature; the isolated fake explicitly crosses unknown and restores the original in finally. Independent real-Lit review also reproduced detached ChildPart markers after async innerHTML; the new ref owns an empty code element and rejects stale source/language completions.

## [LRN-20261031-IP2] async_shutdown_guard

**Logged**: 2026-10-31
**Priority**: high
**Status**: resolved
**Area**: infra

Independent review found a quit race introduced by awaiting a coalesced metadata check: killing the check rejected it, but the swallowed failure allowed an update to spawn during quit. The targeted regression failed as expected: `expected "vi.fn()" to be called 1 times, but got 2 times`. Use a permanent shutdown latch at child-spawn and async orchestration boundaries; cancellation must skip automatic rollback and Gateway restart (recovery journal remains for next startup). Review also reproduced missing content hashing of npm's global configuration; include explicit/default global config content and cover same-path edits. Related files: src/kernel-updater.ts, src/kernel-updater.test.ts, scripts/lib/build-chat-deps.js.
