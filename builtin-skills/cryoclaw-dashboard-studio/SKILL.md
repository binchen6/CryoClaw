---
name: cryoclaw-dashboard-studio
description: Create and maintain CryoClaw dashboard cards with cryoclaw_dashboard: boards, self-contained HTML, local state, declared public data, media, scheduled links and the runtime SDK.
---

# CryoClaw Dashboard Studio

A dashboard is a board of independent cards; each card is one self-contained HTML document in a
sandboxed iframe. The board owns placement; the card owns its document, state, declared sources
and optional scheduled link.

## Rules

- Read before editing; publish to the same `cardId` so state, placement and task links survive.
- Omit `layout` on updates. The user's geometry wins.
- Self-contained HTML under 128 KiB; no external scripts, fonts, CDNs, `fetch` or secrets.
- No invented data: show source and time, mark stale values, never guess.
- Match the user's language, including labels.
- If the target board is unclear, list boards and ask; never pick one silently.

## Flows

- Inspect `list`, then `read_card`.
- New board: `create`, `create_template` (`onboarding`/`productivity`/`briefing`/`creative`) or
  `create_example`.
- Publish: `publish_card`; reuse modules via `list_templates`/`add_template`.
- Scheduled update: `read_card` → cron republishes the same `boardId`/`cardId` → `link_task` (≤4)
  with the `[cryoclaw-dashboard-target]` marker.
- Data only: `cryoclaw_query_data` + JSON Pointer.

## References

[design](references/design.md) · [design system](references/design-system.md) ·
[layout](references/layout-and-sizing.md) · [runtime](references/runtime.md)

Verify with `read_card`: expected document and ID, placement unchanged unless asked, loading/empty/error
states, data with source and time, and a linked task never reported as running. Reply briefly; never
paste HTML.
