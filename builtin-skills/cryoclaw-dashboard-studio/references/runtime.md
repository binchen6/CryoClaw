# Card runtime

Every card document receives `window.cryoclawDashboard` (SDK version 2) inside an opaque
sandbox. The SDK is the only bridge: there is no host DOM, no storage, no arbitrary network and
no gateway credential inside the iframe.

```js
const sdk = window.cryoclawDashboard;
```

Feature-detect optional APIs; older cards and pinned windows may not expose all of them.

## State

```js
const state = await sdk.getState();      // null on first run, or your last JSON
await sdk.setState({ todos: [] });       // ≤ 32 KiB serialized
```

- State is private to the card and survives edits, reloads, resizing and expansion.
- Writes are rejected above 32 KiB; keep only user data, never HTML or fetched payloads.
- Debounce typing (200–400 ms) and save on blur; one write per edit, not per keystroke.
- State is shared by every placement of the same card, so do not store placement-specific UI in
  it. Placement-only view state is not exposed in this host; keep it local in memory.

## Declared data sources

Up to 4 sources, declared at publish time:

```json
{ "id": "rates", "url": "https://api.example.org/rates.json", "format": "json", "refreshSeconds": 300 }
```

```js
const { value, source, fetchedAt, stale, retryAt } = await sdk.data("rates");
```

- Public HTTPS only. Private, loopback and link-local addresses are rejected after DNS resolution,
  including redirects; credentials and API keys are not allowed.
- `refreshSeconds` ≥ 60; the broker caches and coalesces requests, so calling `sdk.data` often is
  cheap but not free.
- Responses are bounded (512 KiB); request a smaller JSON subtree from the provider when possible.
- Read the provider's own timestamp inside `value`. `fetchedAt` is retrieval time, not data time.
- Expired data waits for a shared refresh. If that refresh fails and a previous snapshot is
  available, it is returned with `stale: true` and a `retryAt` timestamp. Keep it visible with
  its original data time and an explicit stale label; do not present it as a fresh success.
- A first read without a usable cached snapshot rejects on failure. Keep any previous render
  visible, label the error, and retry after the indicated cooldown. Never invent replacement data.

## Media assets

```json
{ "assets": [{ "id": "cover", "url": "https://cdn.example.org/cover.jpg" }] }
```

```js
video.src = sdk.asset("cover");
```

Up to 8 assets; images, audio, video and fonts are proxied with supported MIME types and a 32 MiB
cap. Use licensed media with visible attribution. Audio starts only after a user action and pauses
on `pagehide`.

## System sample

```js
const sample = await sdk.system();
// { sampledAt, elapsedMs, cpuCount, cpuPercent, memoryFree, memoryTotal, diskFree, diskTotal, platform }
```

On-demand local metrics only; no file scan, no model call. Values can be `null` when the platform
does not expose them — render an explicit "—".

## Conversation actions

```js
sdk.compose("把这些笔记整理成有优先级的行动方案"); // fills the shared composer; never sends
sdk.tasks();                                  // opens this card's task dialog
```

Both require a real user click and return `false` in a pinned window or when unavailable. Show a
short route back to the main window instead of retrying.

```js
sdk.expand();    // fullscreen the same document
sdk.collapse();  // Escape also collapses
sdk.refresh();   // reload this card only
sdk.openLink("https://example.org/page"); // https only, user gesture required
```

## Motion

```js
const stop = sdk.motion.frame(time => draw(time), { fps: 30 });
const transition = sdk.motion.animate(card, [
  { opacity: .4, transform: "translateY(6px)" },
  { opacity: 1, transform: "none" }
], { duration: 220 });
const unsubscribe = sdk.motion.subscribe(({ active, reduced }) => {
  // pause/resume custom work; reduced means "draw the final state"
});
```

- `motion.frame` pauses when the card leaves the viewport, the window is hidden or the user asks
  for reduced motion. Call `stop()` on teardown.
- `motion.animate` returns a native `Animation`; it pauses/resumes in place.
- CSS animations pause automatically while the card is offscreen; `prefers-reduced-motion`
  disables them.
- No per-frame storage writes, data reads, network calls or model calls.

## Viewport

```js
sdk.viewport.width;   // current iframe CSS pixels
sdk.viewport.height;
const off = sdk.viewport.subscribe(({ width, height }) => {
  // coalesced to one call per animation frame; fires immediately with the current size
});
```

Resizing changes the iframe viewport without reloading the document. Use media queries for layout
and `viewport` for canvas/SVG drawing. Never assume a fixed surface size.

## Host behavior worth designing for

- Cards mount lazily near the viewport; offscreen documents may not exist yet. A card must not
  depend on another card's document.
- Expansion reuses the running document; navigation or refresh rebuilds it.
- Resizing does not reload; state and timers survive.
- The board forwards wheel deltas the card cannot use, so cards that fit their box scroll the board.
- At most 16 SDK requests may be pending; the host also rate-limits card requests (30 per 10 s).
  Batch reads, cache results and show progress instead of retrying in a loop.
- Timers should store deadlines, not tick counters, and must not call the model.

## Scheduled task links

A card can be linked to at most four native cron jobs. The job prompt must:

1. read the card with `read_card`,
2. produce the new document,
3. publish to the same `boardId`/`cardId` and omit `layout`,
4. start with the `[cryoclaw-dashboard-target]` marker block.

Archiving or deleting a board pauses only jobs carrying that exact marker. Restoring a board does
not resume paused jobs.

## Error handling contract

```js
async function load() {
  try {
    const snapshot = await sdk.data("rates");
    render(snapshot.value, snapshot.fetchedAt);
    if (snapshot.stale) showStale("数据已过期，等待连接恢复");
    else clearStale();
  } catch (error) {
    showStale(error.message); // keep the last good render, label the failure
  }
}
```

- Wrap every SDK call; surface a short cause and a retry that reuses the same document.
- Distinguish "no data yet" from "failed": empty is not an error.
- Never log tokens, cookies or personal data into the DOM or state.
