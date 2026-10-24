---
name: cryoclaw-dashboard-studio
description: Create or edit independent CryoClaw dashboard cards with cryoclaw_dashboard, local state and declared public data.
---

Use `cryoclaw_dashboard`: list IDs, create a board if needed, publish cards with stable IDs. Boards are independent of conversations. Read existing HTML with `read_card` only when editing it. Preserve user layout by omitting `layout` on updates.

For data queries alone, use `cryoclaw_query_data` in any task; no board is required. Narrow large JSON with `pointer`.

Publish self-contained HTML (128 KiB/card). Use inline CSS/JS and semantic controls. No external scripts, secrets, shell commands or invented live values. Use `dataSources`/`assets` for public HTTPS resources. Persist user input with the runtime SDK; do not copy local state into chat. Show loading, source time and errors.

Read [runtime](references/runtime.md) only for state, data, media or app actions. Return a short confirmation; the native UI discovers cards automatically.

For composition and motion, read [design](references/design.md) on demand.

Modules may use CSS/SVG/Canvas animation. Respect `sdk.motion`; pause hidden JS loops. Scheduled updates use native cron + `link_task` and the same card ID; see runtime for lifecycle details.

Prefer a few fluent, interruptible effects. `sdk.motion.frame(draw,{fps:30})` manages visibility/reduced motion. `create_example` creates a fresh example board without replacing user work. Use `sdk.compose(prompt)` to offer user-sent follow-up ideas.
