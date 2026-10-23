---
name: officecli-docx
description: Create, read or edit Word .docx documents using the bundled OfficeCLI; verify content and layout before delivery.
---

# OfficeCLI DOCX

Use the preinstalled `officecli`. If unavailable, report the installation issue; do not substitute another document stack.

1. Inspect an existing file before editing. Use `officecli --help` and the relevant verb help for exact properties. Read [operations](reference/operations.md) only for the command, layout or failure mode you need; do not load the whole reference tree.
2. Commands must be one plain CLI invocation per line, portable to PowerShell, cmd and macOS. Never use shell continuations, heredocs, JSON pipes, shell loops, or Python/Node/Ruby wrappers. Quote paths with spaces.
3. For bulk work, three or more property flags, or raw XML: write a JSON batch file with the host file tool, then run `officecli batch <file.docx> --input batch.json`. Work in bounded batches; inspect results before the next batch.
4. Verify metadata, heading hierarchy, table headers, image alt text and placeholders. For documents with 3+ headings include a TOC. Verify page-number fields, cover fill ≥60% and last-page fill ≥40%. No empty paragraphs for spacing.
5. Run content/issue inspection and `officecli validate <file.docx>`; inspect rendered/annotated output appropriate to the format. Repair and recheck affected areas before reporting success. Detailed commands and pitfalls remain in [operations](reference/operations.md).
6. Deliver the finished file. In CryoClaw, use the available `cryoclaw_deliver_files` tool to show cards; if unavailable, use the established file output protocol. Do not send file contents or base64 as a substitute for a file.
