# Workflows and limits

## Inspect

```json
{ "action": "list" }
{ "action": "list", "boardId": "board-id" }
{ "action": "read_card", "boardId": "board-id", "cardId": "card-id" }
```

`list` returns board summaries and card IDs; `read_card` returns the current HTML, data sources,
assets and task links. Read before editing.

## Boards

```json
{ "action": "create", "title": "工作台", "description": "关注项目进度和今天的下一步。" }
{ "action": "create_template", "templateId": "onboarding" }
{ "action": "create_example", "title": "Hello World" }
```

- `create_template`: `onboarding`, `productivity`, `briefing`, `creative`.
- `create_example` builds the 21-module showcase; never the default.
- Board titles ≤ 80 characters; descriptions ≤ 240 and state purpose plus update constraints.
- Limits: 32 boards, 24 cards per board, 4 MiB catalogue.

## Publish and update

```json
{
  "action": "publish_card",
  "boardId": "board-id",
  "cardId": "weekly-focus",
  "title": "本周重点",
  "html": "<!doctype html>…",
  "accent": "paper",
  "layout": { "w": 6, "h": 320, "order": 0 }
}
```

- `html` is a complete document under 128 KiB; `kind` defaults to `html` (`system` is reserved).
- `accent`: `paper` | `ice` | `ink` | `mint`. Prefer paper; one accent card per board.
- `layout`: `w` 2–12 (fractions allowed), `h` 180–1000, `order` 0–10000, optional `free`.
- Updating without `layout` keeps geometry and local state; a new `cardId` starts fresh.
- Reusable modules: `list_templates`, then `add_template` with a template id.

## Declared data

```json
{
  "dataSources": [
    { "id": "rates", "url": "https://api.example.org/rates.json", "format": "json", "refreshSeconds": 300 }
  ],
  "assets": [{ "id": "cover", "url": "https://cdn.example.org/cover.jpg" }]
}
```

- Max 4 data sources, 8 assets. Public HTTPS only; private hosts and credentials are rejected.
- `refreshSeconds` ≥ 60; responses are cached, coalesced and bounded (512 KiB).
- In the card: `const { value, source, fetchedAt } = await sdk.data("rates")` and
  `sdk.asset("cover")`.
- Read the provider's timestamp inside `value`; `fetchedAt` is retrieval time.

## Scheduled updates

1. Create or update the card; `read_card` to confirm the saved document.
2. Create a native cron task whose prompt reads the card with `read_card` and republishes to the
   same `boardId`/`cardId`, omitting `layout`.
3. Link it:

```json
{ "action": "link_task", "boardId": "…", "cardId": "…", "jobId": "…", "taskTitle": "每日行情" }
```

4. Maximum four links per card. Mark the job payload so archive/delete only pauses related jobs:

```text
[cryoclaw-dashboard-target]
boardId=<id>
cardId=<id>
[/cryoclaw-dashboard-target]
```

A linked task is not a running task. Report its saved state; never enable recurring model calls
the user did not request. Timers and data refreshes must not call the model.

## Data-only queries

```json
{ "kind": "public", "url": "https://…/data.json", "format": "json", "pointer": "/items/0", "maxChars": 4000 }
{ "kind": "system" }
{ "kind": "dashboards" }
```

Use JSON Pointer to narrow large payloads instead of dumping whole responses.

## Verification

1. `read_card` shows the expected HTML and the same `cardId`.
2. `list` shows the expected placement when it changed.
3. The document renders at its target size; state survives refresh; loading/empty/error states
   exist.
4. Data shows source and time; failures keep the previous value and mark it stale.
5. Only report a scheduled update as working after a real run republished the card.
6. Reply in one or two sentences; the native UI discovers cards automatically.
