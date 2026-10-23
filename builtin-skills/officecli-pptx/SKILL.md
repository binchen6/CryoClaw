---
name: officecli-pptx
description: Create, read or edit PowerPoint .pptx decks using the bundled OfficeCLI, with slide design and visual verification.
---

# OfficeCLI PPTX

Use the preinstalled `officecli`. If unavailable, report the installation issue; do not substitute another document stack.

1. Inspect an existing file before editing. Use `officecli --help` and the relevant verb help for exact properties. Read [operations](reference/operations.md) only for the command, layout or failure mode you need; do not load the whole reference tree.
2. Commands must be one plain CLI invocation per line, portable to PowerShell, cmd and macOS. Never use shell continuations, heredocs, JSON pipes, shell loops, or Python/Node/Ruby wrappers. Quote paths with spaces.
3. For bulk work, three or more property flags, or raw XML: write a JSON batch file with the host file tool, then run `officecli batch <file.pptx> --input batch.json`. Work in bounded batches; inspect results before the next batch.
4. Body text must be ≥16pt except chart labels, legends, footnotes and short KPI captions. Use near-white text on dark backgrounds. Content slides require speaker notes; at least one in three needs a non-text visual. Do not add accent lines below titles. Read reference/design-guide.md when designing new layouts.
5. Run content/issue inspection and `officecli validate <file.pptx>`; inspect rendered/annotated output appropriate to the format. Repair and recheck affected areas before reporting success. Detailed commands and pitfalls remain in [operations](reference/operations.md).
6. Deliver the finished file. In CryoClaw, use the available `cryoclaw_deliver_files` tool to show cards; if unavailable, use the established file output protocol. Do not send file contents or base64 as a substitute for a file.
