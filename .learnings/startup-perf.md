# Startup performance investigation learnings

## [ERR-20261031-SP1] optional project knowledge absent
**Logged**: 2026-10-31T00:40:00+08:00
**Priority**: low
**Status**: resolved
**Area**: docs

### Summary
The project-knowledge skill references a memory/knowledge/codebase directory not present in this repository.

### Error
`ls: cannot access 'memory/knowledge/codebase': No such file or directory` (exit 2)

### Resolution
Use CLAUDE.md, checked-in release verification and current source. No write effects occurred. Hindsight service unavailability was already recorded; do not retry it.

## [LRN-20261031-SP2] cancellation must survive coalesced awaits
**Priority**: high
**Status**: resolved by installer-perf; independently revalidated with original reproduction and scoped tests
**Area**: updater

Read-only review found that awaiting an in-flight metadata check before update creates a new quit race: quit kills the check, its rejection is deliberately ignored, and orchestration resumes into a new updater spawn after teardown already ran. Isolated VM reproduction yielded two spawns and update success after terminateKernelUpdaterForQuit. A durable quit latch must be checked after waits and before spawn; cancellation must not cause recovery/rollback work. Product fixes remain with installer-perf.

## [LRN-20261031-SP3] cache inputs include configuration file contents, not only paths
**Priority**: medium
**Status**: resolved by installer-perf; independently revalidated with original reproduction and scoped tests
**Area**: build

The dependency stamp hashes npm_config_globalconfig path but initially omitted that file's bytes. Replacing omit=optional with include=optional at the same path leaves the input hash unchanged. Hash effective global/user/project config contents or fail closed where effective configuration is unknown. Reproduction is in isolated startup-perf review probes; no installer files edited.

## [ERR-20261031-SP4] optional npmrc paths in search
**Priority**: low
**Status**: resolved
**Area**: tools

A review rg command included optional .npmrc paths absent from the repository and printed `系统找不到指定的文件。 (os error 2)`. No write effects. Future searches should glob existing paths or inspect the build helper directly rather than assume these files exist.

## [ERR-20261031-SP5] refresh file observation after continuation
**Priority**: low
**Status**: resolved
**Area**: tools

A resumed review attempted to edit this learning file using its previous-turn read/edit observation and got `file has not been read — read the file, then retry`. No write occurred. Reading current contents through ops_inspect_local_file and retrying the exact edit succeeded; no sandbox fallback was used.

## [ERR-20261031-SP6] use native glob filters for Windows source searches
**Priority**: low
**Status**: resolved
**Area**: tools

A second review rg search passed wildcard source paths that Windows rg treated literally and returned `文件名、目录名或卷标语法不正确。 (os error 123)` (exit 2). Earlier tests in the compound command passed 3/3 and there were no writes. Corrected by using ops_grep with glob arrays. Standing rule for subsequent reviews: use ops_grep/ops_glob instead of shell rg wildcard path arguments; absent optional paths and Windows filename expansion have now failed twice.

## [ERR-20261031-SP7] discover temporary test configurations instead of assuming their path
**Priority**: low
**Status**: resolved
**Area**: tools

Read-only frontend review assumed chat-ui/tsconfig.task2-test.json existed; cat returned `No such file or directory` (exit 1). No writes occurred. Discovered the actual chat-ui/tsconfig.test.json with native tools, then overrode outDir to ui/.startup-review-dist for isolated targeted tests. Do not infer teammate temporary config names from output directory names.

## [ERR-20261031-SP8] direct TypeScript stripping cannot resolve emitted-JS imports
**Priority**: low
**Status**: resolved
**Area**: testing

A direct `node --experimental-strip-types` command-history probe failed with `ERR_MODULE_NOT_FOUND` for `chat-ui/src/shared/text/reasoning-tags.js` imported by `chat-ui/ui/src/ui/format.ts`. No writes or child jobs occurred. Pure tool-presentation imports passed; the transitive UI graph mixes TypeScript sources and emitted .js specifiers, so future command-history tests must use isolated compilation or esbuild, not direct stripping. No product package type changes are needed. A follow-up in-memory esbuild probe initially used CommonJS and default CSS handling, which rejected UI top-level await and KaTeX CSS/font assets (`Top-level await is currently not supported with the "cjs" output format`, `No loader is configured for ".woff2" files`). Correct probe settings are ESM with a no-op CSS loader; product build configuration remains untouched.
