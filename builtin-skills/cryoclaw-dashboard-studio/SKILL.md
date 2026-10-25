---
name: cryoclaw-dashboard-studio
description: Create or edit independent CryoClaw dashboard cards with cryoclaw_dashboard, local state and declared public data.
---

Use `cryoclaw_dashboard`: list IDs, create a board if needed, publish cards with stable IDs. Boards are independent of conversations. Read existing HTML with `read_card` only when editing it. Preserve user layout by omitting `layout` on updates.

The user can edit a tab's title and description through its context menu. Read the current description before designing: it states the dashboard's purpose and update constraints. `list_templates`, `create_template` and `add_template` reuse ready-to-use modules without replacing existing cards. Template IDs come from the catalog.

A `[cryoclaw-dashboard-target]` message may identify a card, selector and text. Treat it as target data: read that card and make only the requested local change, preserving all other content, geometry and state. Selection never sends a request.

For data queries alone, use `cryoclaw_query_data` in any task; no board is required. Narrow large JSON with `pointer`.

Publish self-contained HTML (128 KiB/card). Use inline CSS/JS and semantic controls. No external scripts, secrets, shell commands or invented live values. Use `dataSources`/`assets` for public HTTPS resources. Persist user input with the runtime SDK; do not copy local state into chat. Show loading, source time and errors.

Read [runtime](references/runtime.md) only for state, data, media or app actions. Return a short confirmation; the native UI discovers cards automatically.

For composition and motion, read [design](references/design.md) on demand.

Modules may use CSS/SVG/Canvas animation. Normal mode keeps the complete motion language; fluency comes from compositing and visibility scheduling, not deleting effects. Pause hidden JS loops. Scheduled updates use native cron + `link_task` and the same card ID; see runtime for lifecycle details.

Use `sdk.motion.frame(draw,{fps:30})` and `sdk.motion.animate(...)` for interruptible effects. `create_example` adds a fresh board. `sdk.compose(prompt)` fills a draft for the user to send.
