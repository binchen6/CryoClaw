# Workbench Improvement Implementation Plan

> **For agentic workers:** Use the existing project workflow and task ownership below; preserve pre-existing uncommitted work. Steps use checkbox syntax for tracking.

**Goal:** Complete the reference-driven dashboard workflow, protect chat request ownership, reduce unnecessary runtime I/O, and refresh product communication.

**Architecture:** Extend the Lit dashboard and its existing opaque iframe message bridge. Keep the physical Node gateway, native transactions and independent static website.

**Tech Stack:** Lit, TypeScript, Electron, Node SQLite, HTML/CSS/JavaScript.

**Spec:** `docs/superpowers/specs/2026-10-25-workbench-design.md`

## Global constraints

- Node 24.22.1, OpenClaw 2026.10.6 and physical gateway remain supported.
- Preserve current drafts, credentials, iframe state, task ownership and all existing work.
- Use design tokens, continuous motion and reduced-motion preferences.
- Verification uses owned QA data. Publication and push are explicitly authorized by the user; release after the installed-app and artifact gates.

## Review focus

- Right-clicking a background tab must edit/delete that tab, including after polling.
- Selecting an iframe button must not activate it; nested text/icon and keyboard targets remain precise.
- Switching tabs or sessions during pending work must not restore an obsolete target or draft.
- Quick layout changes during a save must persist the final layout.
- Archived boards and template previews cannot mutate user state.

## Task 1: Dashboard metadata and targeting (root)

Files: `oc-dashboard.ts`, `dashboard.css`, `dashboard-selection.ts`, `views/dashboard-compose.ts`, dashboard plugin `store.mjs` / `runtime.mjs` / inspector helper, bilingual i18n, skill references.

- [x] Add behavioral tests for empty description edits, archived mutations, bounded selection messages and model target context.
- [x] Implement tab context menu bound to its own board ID, title/description form and exact delete confirmation.
- [x] Add sandbox element inspector and whole-card selection; carry the current description and optional element target into the shared composer.
- [x] Serialize layout saves and remove duplicate editing/composer entry behavior.
- [x] Verify with isolated database tests, TypeScript and real browser interactions.

## Task 2: Template flow (root)

Files: dashboard plugin template catalog, dashboard library component/styles and plugin tests.

- [x] Add curated existing-module templates, isolated previews and add-to-board/create-preset actions.
- [x] Test repeated insertion, full/archived boards, independent state and existing-card preservation.
- [x] Exercise preview/add/edit through the rendered UI.

## Task 3: Chat audit (chat_audit)

- [x] Reproduce late send/abort callbacks and attachment preparation races.
- [x] Guard by session/run identity, preserve newer drafts and maintain busy counts.
- [x] Audit tool pairing and history allocations; run focused behavior tests.

## Task 4: Lifecycle and packaging (lifecycle)

- [x] Verify current evidence; separate historical and new measurements.
- [x] Remove unconditional cold plugin scan while preserving on-demand loading and quit guards.
- [x] Avoid copying the kernel package that the updater immediately replaces; preserve complete backup/journal.
- [x] Benchmark copy bytes/files/time and run targeted lifecycle/update tests.

## Task 5: Website and README (website)

- [x] Rebuild the five feature narratives and responsive layout with existing licensed typography.
- [x] Preserve download/checksum/platform/video behavior and synchronize initial HTML with the verified snapshot.
- [x] Refresh README, subset newly used Chinese glyphs and check links/JavaScript.

## Task 6: Integrated verification (root)

- [x] Build, run all four regression layers, inspect actual desktop/narrow/dark/reduced-motion states.
- [x] Independently review changed behavior and correct substantive findings.
- [x] Record measured improvements, evidence and remaining unverified installation/platform limits.

## Task 7: Publication closeout (2026-10-26)

- [x] Complete the final reinstalled app's full UI gate; record final hashes and installed resource identity.
- [x] Commit and push the integrated main branch; publish the exact EXE, blockmap and manifest after server-side hash checks.
- [x] Update the verified website release snapshot, deploy the blog's `/CryoClaw` page and verify production media/downloads.
- [x] Verify that both new and exact legacy official video cards play the deployed 58-second film through the actual asset proxy.
- [x] Start the next backend performance version after publication and push. The new goals are at least 50% improvement and gateway startup below 30 seconds, supported by a declared baseline and final measurements.
