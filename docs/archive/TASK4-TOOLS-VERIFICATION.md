# Task 4 — tool sheets and command records (2026-10-31)

## Scope and reference mapping

Read the five tool/progress references under `../参考图/工具调用展示/` plus the project CLAUDE and visual-system guidance. Changes preserve CryoClaw's existing tokens and functional data boundaries:

- [Tool presentation](../../chat-ui/ui/src/ui/chat/tool-presentation.ts): read source, requested edit diff, and separate Bash command/output sheets. Requested edits are input, not proof of a successful write. Existing failure, exit-code, arguments and generic-tool fallback remain visible.
- [Tool cards](../../chat-ui/ui/src/ui/chat/tool-cards.ts): lazy details retain 8k rendering caps, explicit wrap control, complete-source copy, output line counts and full sidebar actions when a callback exists. No callback produces no inert full-output action; complete source is still available through copy.
- [Code enhancement](../../chat-ui/ui/src/ui/chat/code-block-enhance.ts): the tool ref owns an empty code element's children; Lit does not own a text ChildPart under asynchronously replaced HTML. Text enters through textContent, highlighted spans through highlight.js. Changed source/language resets state; stale async completions are discarded.
- [Command projection](../../chat-ui/ui/src/ui/chat/command-history.ts) and [component](../../chat-ui/ui/src/ui/components/oc-command-jobs.ts): read-only records of current tool-stream invocations, not an OS background process registry. Filters mean recent / awaiting tool result / result received / all. No Kill, RPC, polling or inferred background-process exit state. The stream already merges result fields into calls and replaces changed message/array references.
- [Scoped styles](../../chat-ui/ui/src/styles/chat.css): theme-token surfaces, independent code/list scrolling, centered chat-column alignment, coarse-pointer targets and reduced-motion handling. No progress/plan production changes were necessary; existing real plan/progress components were preserved.
- English/Chinese keys added only for these controls. Lead mounted the component in the chat view and owns that integration file.

## Bounded work and real interactions

Command projection is reused for locale/filter changes; shouldUpdate excludes unrelated parent draft renders. Recent displays eight records; other filters display 40 initially with explicit incremental loading. Keyed entries prefer actual tool IDs, preserving disclosure identity as new commands arrive. Each command/output render is capped at 8k, summary at 300 and tooltip at 160 characters; copy uses the full original command. Locale is reactive and a session change resets filters, page and native disclosures.

## Targeted verification

Run from repository root, with a private output directory (not the shared `.test-dist`):

```sh
node node_modules/typescript/bin/tsc -p chat-ui/tsconfig.test.json --outDir chat-ui/ui/.task4-test-dist
# create .task4-test-dist/package.json containing {"type":"module"}
node --test chat-ui/ui/.task4-test-dist/ui/src/ui/chat/tool-presentation.test.js chat-ui/ui/.task4-test-dist/ui/src/ui/chat/command-history.test.js chat-ui/ui/.task4-test-dist/ui/src/ui/components/oc-command-jobs.test.js chat-ui/ui/.task4-test-dist/ui/src/ui/chat/tool-cards.test.js
```

Final isolated compilation passed; **51/51 scoped tests passed, 220.2 ms**. Includes five presentation tests, four command-projection tests, four component gate/memo/session/bounded-render tests and existing tool-card regressions plus a new actual handler test: sidebar receives the full 9k source, missing callback renders no inert action, all three header/command/output clipboard handlers copy exact uncapped content. The private compiled directory was removed after verification. `git diff --check` passed.

The initial run caught lost line-count metadata and changed output-surface expectations (48/50); metadata was restored rather than only weakening assertions. Additional test harness corrections were logged in [the learning record](../../.learnings/installer-perf.md).

## Independent review and integration evidence

- frontend-perf reproduced the original Lit-marker failure in real Electron/Lit (`TypeError: Cannot set properties of null (setting 'data')`, stale displayed text), then verified the corrected empty-code ownership and rapid bash-to-plain-source update. Its deterministic grammar stub is explicitly **not** real grammar acceptance; its report is `.cache/task2-lit-production-review/report.json`.
- startup-perf reviewed the final frozen diff with no remaining P1/P2, independently passed all nine pure tests and verified bounded paging, stable IDs, locale and projection guards.
- Lead reported the real integrated bundle/UI smoke passed light/dark and narrow/wide variants, five sheets, wrapping, command filters, and replacement of highlighted TypeScript read output without renderer errors. Lead owns final shared build/full-suite acceptance; this teammate did not run a full suite or shared build.

## Remaining boundaries

No true background job enumeration/termination protocol is available here, so the UI deliberately does not fabricate one. Only the current supplied tool-stream timeline is shown (not a durable cross-session command database). Native progressive disclosure can intentionally load more than 40 records after repeated user actions. Full signed installation/download/rollback acceptance remains task3's separate release/isolated-VM boundary; no real-user installation or release was changed.
