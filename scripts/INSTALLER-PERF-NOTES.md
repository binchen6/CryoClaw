# Task 3 — installation/update/build evidence (2026-10-31)

Base commit: `0af6419a45f595f5d0770894cc29b5aadadd2459`. Working tree shared with other tasks; no commit, release, full test run or real-user installation performed.

## Implemented scope

- [package.json](../package.json): only `build:chat` changes to the [build wrapper](build-chat.js).
- [dependency preparation](lib/build-chat-deps.js) and [isolated tests](build-chat-deps.test.js): retain `npm install --prefer-offline` on cold/invalidated builds, skip only repeated npm work on a valid warm tree. Vite always rebuilds source. Fingerprint includes package/lock files, project/user/effective global npmrc, npm config environment, NODE_ENV and Node/platform/architecture. Installed npm inventory plus every installed package version and bin are checked. Deleted/corrupt/mismatching inventory/manifests/bins re-enter npm; failed install never publishes a successful stamp. `CRYOCLAW_FORCE_CHAT_INSTALL=1` forces refresh.
- [kernel updater](../src/kernel-updater.ts) and [tests](../src/kernel-updater.test.ts): concurrent `--check` requests share one child. Once settled (including failure), the next check is fresh: no TTL/stale version cache added. Update/rollback waits for an already-running check **before stopping Gateway**, preventing competing children from overwriting the live child handle. A failed check does not suppress a separately verified update. A permanent quit latch blocks new children and post-await work during teardown; quit cancellation skips automatic rollback/Gateway restart, leaving recovery journals for next startup.
- [warning learning](../.learnings/installer-perf.md): corrected the first wrapper's Windows shell routing. npm CLI runs through Node with `shell:false`; a real subprocess fixture exercises paths containing spaces, `&` and parentheses.

No edits to installer NSIS, physical directory swap, updater payload staging, signing, package-resources or startup-owned kernel patch logic.

## Fresh measurements (not installation timing)

Lead ran the real Chat build serially, avoiding shared output contention:

| Observed phase | First build | Warm build |
| --- | ---: | ---: |
| Dependency preparation (wrapper log) | 2197 ms, npm install | 21 ms, reused |
| Vite-reported build | 2.37 s | 2.31 s |

Dependency phase difference: 2176 ms (99.0% lower in this single paired observation). This is **not** an end-to-end speed claim or an installer improvement; no repeat distribution/total wall-time was captured. Warm build had no DEP0190 after the shell-free correction; existing Vite dynamic/static import warnings remain unrelated. First build was before the shell correction; tests additionally cover the corrected cold path using a fixture CLI. These initial timings preceded the final global-config hash/quit guards; adding the effective global-config content invalidates the old dependency stamp once. After those guards, the lead repeated a real cold/warm pair: dependency preparation **1655 → 20 ms** (98.8% lower in this single pair), Vite **2.28 → 2.36 s**. These measurements still describe dependency preparation only, not installation or full build wall time.

Deterministic isolated evidence: eight overlapping metadata checks produce one child, then a subsequent check produces a second child; failure is shared and next request retries. Dependency fixture does one install for initial prepare and none for eight unchanged warm prepares. Wrapper fixture runs npm once but Vite twice across cold/warm calls.

## Targeted verification

Commands run from repository root. No shared TypeScript output directory used.

```sh
node --test scripts/build-chat-deps.test.js
# 20/20 pass, 602.0 ms: invalidation including global config, failed/incomplete installs,
# credential-free stamp, shell-free spaced-path cold/warm execution.

node node_modules/vitest/vitest.mjs run src/kernel-updater.test.ts
# 47/47 pass, 608 ms: check dedup/failure/retry/race, quit cancellation plus existing
# migration, Gateway recovery, update/rollback/watchdog coverage.

node --test scripts/installer-nsh.test.mjs scripts/kernel-directory-swap.test.js scripts/stage-installer.test.js scripts/kernel-update.test.mjs
# 51/51 pass, 5914.5 ms: source assertions and disposable temp fixtures;
# same-volume move, EXDEV fallback, failed publish restoration,
# crash recovery, bounded rename retry, lock ownership and backups.

node --test scripts/release-assert.test.js scripts/update-download-benchmark.test.js
# 6/6 pass, 157.4 ms: manifest SHA512/size/blockmap requirements,
# token host restriction and local partial/blockmap-error server fixtures.

git diff --check -- package.json src/kernel-updater.ts src/kernel-updater.test.ts
# pass
```

No claim of exercising a newly signed installer or actual download/application of a release. Release-manifest tests validate guards, not Authenticode at runtime. Tests that spawn updater entrypoints point them at disposable fixture resources, never the user's installed application.

## Installation findings and intentionally retained boundaries

[Release verification](../docs/RELEASE-2026.1030.0-VERIFICATION.md) already records a 316561524-byte installer, 32936 files / 940434094 bytes physical payload and four prior silent installations (121235 / 119828 / 123562 / 115813 ms, median 120531 ms). These are **historical**, not this task's measurements. Same-volume rename, complete backup marker, atomic journal publication, bounded retry and rollback already remove the second full-tree copy without risking live mutable dependencies.

Physical update staging already copies dependencies privately once and publishes through `moveCandidate:true`. Hard-linking or reusing a live mutable installation would risk rollback isolation, so no unmeasured staging shortcut was introduced. Retained: standalone Node and physical gateway policy, SDK SHA512/manifest validation, signing/release gates, full-download fallback after blockmap failure, exact-path process safety and complete-tree rollback.

## Remaining acceptance / limitations

1. Fresh installer timing requires an authorized disposable Windows VM/sandbox or fully isolated test account: merely setting `/D` to Temp does not isolate uninstall registry/shortcuts. No real-user install was overwritten. Run the existing installer benchmark there, capture fresh `setup-timing.jsonl` and repeat cold/warm distributions.
2. Actual signed-release/checksum/download/rollback end-to-end verification is still release acceptance, not replaced by fixture tests. No artifacts were packaged or published here.
3. Dependency stamp detects input/inventory/manifest/bin drift, not arbitrary tampering of every JavaScript byte. It is a build-work cache, **not** a replacement for npm or release integrity/security boundaries. Remove the stamp or force installation when repairing dependencies; externally modified caches must not be treated as trusted payloads.
4. Re-run typecheck/full application acceptance under lead's shared-output coordination; this task used scoped tests and the lead's serial Chat builds only.

## Independent review closure

Startup-perf reproduced and reviewed two findings before closure: P1 quit while awaiting a probe incorrectly spawned an update; P2 same-path global npmrc content edits did not invalidate the stamp. Both targeted regressions were first observed failing, then fixed. Startup-perf independently reran the original probe: global `sameHash=false`; quit produced only the original check child (`spawnCount=1`, `stops=0`, `update.ok=false`). Independent dependency suite 20/20 (622 ms) and updater suite 47/47 (629 ms with private Vitest cache) passed; no remaining P1/P2 found. When the effective global npm configuration path is unknown (e.g. direct non-npm invocation), dependency reuse is conservatively disabled rather than guessing prefix/config resolution.
