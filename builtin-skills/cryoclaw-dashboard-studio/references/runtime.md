# Dashboard runtime

SDK v2 adds `motion.frame`, `compose` and `tasks`; the existing v1 methods remain compatible. The app reuses the Chat composer, including model selection, attachments, permissions and stop. A card can fill that composer after a user click; it cannot send a message automatically.

```js
const sdk = window.cryoclawDashboard;
const stop = sdk.motion.frame(time => draw(time), {fps: 30});
// Stops offscreen/hidden; draws one stable frame for reduced motion. Call stop() on custom teardown.
button.onclick = () => sdk.compose('Refine this board with dated public sources');
clock.onclick = () => sdk.tasks(); // open this card's native task dialog
```

`compose`/`tasks` return false in a pinned window; show a short route back to the main window. No automatic audio: create/resume AudioContext only from the user's play action. Reuse Canvas bitmaps until size or DPR changes, cap DPR and frame rate, and use real analyser data when labeling a display as a spectrum.

The example collection has 21 modules, including local notes, a step editor, original procedural soundscapes, palette controls and prompt recipes. `create_example` creates a new copy; existing boards are never overwritten on upgrade. `delete` permanently removes an archived board. It can also remove an active board only with `confirmDelete: true` after the user explicitly confirms permanent deletion. Pause or remove linked native cron jobs first; shared jobs must be preserved.

`refresh()` reloads only this card; the floating toolbar refreshes the entire board. Keep durable state in the SDK before any explicit reload. Up to 16 iframe SDK requests may be pending; pinned SDK fetches allow four concurrent requests. Debounce edits and reuse cached public data.

Standalone queries: `cryoclaw_query_data({kind:'public',url,format:'json',pointer:'/data',maxChars:4000})`, `{kind:'system'}` or `{kind:'dashboards'}` work outside panels. Public requests share the same guards/cache; results include provenance/time, and oversized output is explicitly truncated. Ask for a smaller JSON subtree rather than dumping entire API responses. Local metrics/catalog are unavailable in sandboxed sessions. The iframe SDK remains scoped to its own card.

`cryoclaw_dashboard` actions: list, create, create_example, read_card, publish_card, remove_card, rename, archive, restore, delete, link_task, unlink_task. `list` returns summaries; pass boardId for card IDs. `read_card` reads one document. Publish fields: boardId, cardId, title, html, accent (paper/ice/ink/mint), optional layout {w:2..12,h:180..1000,order:0..10000}. Updating a stable card ID preserves local state and layout. Deleting a card deletes its state. Archive preserves a whole board.

The app injects `window.cryoclawDashboard` into each document:

```js
const sdk = window.cryoclawDashboard;
const state = await sdk.getState(); // null initially; private per-card JSON
await sdk.setState({todos: []}); // <=32 KiB; save on edits, debounce keystrokes
const {value, source, fetchedAt} = await sdk.data('weather');
const sample = await sdk.system(); // CPU, RAM and current data disk; no file scan
video.src = sdk.asset('clip');
button.onclick = () => sdk.expand(); // explicit user gesture
sdk.collapse(); // Escape also closes expanded view
link.onclick = () => sdk.openLink('https://example.org/page');
sdk.motion.subscribe(({active,reduced}) => {
  // Stop high-frequency Canvas/rAF work if inactive or reduced. Unsubscribe on teardown.
});
```

Each module may design its own CSS, SVG, Web Animations or Canvas motion with inline code. CSS animation pauses automatically when the card leaves the viewport or the app is hidden; reduced-motion disables automatic example animations. Use sdk.motion.active/reduced and subscribe for JavaScript loops, animate at most once per frame, and avoid per-frame storage/data/model calls. Intentional audio may continue while its visualization pauses. Keep controls usable without animation.

Scheduled updates use the existing native cron tool, not a new timer loop or paid keep-warm heartbeat. Create/update an agentTurn job that reads this card with read_card and publishes to the SAME boardId/cardId; omit layout to preserve user edits. Then call cryoclaw_dashboard action=link_task with boardId, cardId, jobId and optional taskTitle. Up to four task links/card. All normal task channels can discover the tool; host writes remain unavailable inside sandboxed sessions. The card clock opens native task status, run-now, pause/unlink and schedule creation. For model-driven unlink/archive/removal, first pause or retarget the native cron job, then unlink_task; unlink_task only removes the association, it does not modify another scheduler's job. Archiving a board rejects later publishing until restored. Update task names and failure feedback honestly; do not silently schedule recurring model calls without a user request.

Mark board-owned cron payloads with `[cryoclaw-dashboard-target]\nboardId=<id>\ncardId=<id>\n...\n[/cryoclaw-dashboard-target]`. The app's archive and confirmed-delete flows pause linked jobs with this exact board marker; unrelated/shared jobs are left under Tasks. Restoring a board does not restart paused jobs automatically.

Declare up to 4 dataSources on publish: `{id,url,format:'json'|'text',refreshSeconds:300}`. Minimum refresh 60 seconds; native broker caches and coalesces requests. Public HTTPS only, no credentials or API keys, <=512 KiB/response, bounded timeout. DNS/redirects reject private addresses. Fetch failures reject the promise: show a useful status, keep previous values clearly dated. Query the data's own timestamp; fetchedAt is retrieval time. Never describe daily rates as real-time ticks. Timers and refreshes must not call the model.

Declare up to 8 assets `{id,url}` for images, audio, video or fonts; use sdk.asset(id), never embed a gateway token. Media proxy permits supported MIME types and <=32 MiB. Use licensed media with visible attribution. Opaque sandbox denies host DOM, storage, arbitrary network and remote scripts. Desktop pinning uses the same SDK; local state remains available. Card content uses its fixed design width and internal overflow; the app scales the canvas for smaller windows. Expansion/resizing preserves the running iframe; navigation/refresh reconstructs it. Save timer deadlines, not second-by-second counters. Pause audio on pagehide.

Window resizing scales the whole fixed-width canvas and card contents proportionally. Keep the designed card geometry; avoid viewport-driven layout changes for the embedded presentation. Expansion has a separate fixed 1600×900 surface, scaled to fit.

HTML example:

```html
<!doctype html><html><head><meta charset="utf-8">
<style>body{font:16px system-ui;margin:24px}button{padding:12px}</style></head>
<body><h2>Reading counter</h2><button id="add" disabled>Loading…</button>
<p id="status" role="status"></p><script>
(async()=>{
 const sdk=window.cryoclawDashboard,button=document.getElementById('add');
 let value=(await sdk.getState())?.count??0,busy=false;
 const draw=()=>{button.textContent=`Read ${value} pages`;button.disabled=busy;};draw();
 button.onclick=async()=>{if(busy)return;busy=true;draw();try{
  await sdk.setState({count:value+1});value++;
 }catch(e){document.getElementById('status').textContent=e.message;}
 finally{busy=false;draw();}};
})().catch(e=>document.getElementById('status').textContent=e.message);
</script></body></html>
```
