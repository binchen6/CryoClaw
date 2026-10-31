const VIEW_ORDER = ["dashboard", "chat", "tasks", "workspace", "extensions", "settings"];

type NavigationPosition = { view: string; index: number };

function peerTabIndex(view: string): number {
  const tabs = Array.from(document.querySelectorAll?.("[data-page-nav]") ?? []);
  const candidates = tabs.filter(tab => (tab.getAttribute("data-page-nav") ?? "").startsWith(`${view}:`));
  return candidates.findIndex(tab => tab.getAttribute("aria-selected") === "true" ||
    Boolean(tab.getAttribute("aria-current")) || /(?:^|\s)[\w-]*active(?:\s|$)/i.test(tab.getAttribute("class") ?? ""));
}

function navigationPosition(): NavigationPosition {
  const app = document.querySelector?.("openclaw-app") as { settings?: { cryoclawView?: string } } | null;
  const view = app?.settings?.cryoclawView ?? "chat";
  if (view === "settings") {
    const tabs = Array.from(document.querySelectorAll?.(".oc-settings-nav-item") ?? []);
    const active = tabs.findIndex(tab => tab.classList.contains("oc-settings-nav-item--active"));
    return { view, index: active < 0 ? 0 : active };
  }
  if (view === "tasks") {
    const tabs = Array.from(document.querySelectorAll?.(".ts-tabs [role='tab']") ?? []);
    const active = tabs.findIndex(tab => tab.getAttribute("aria-selected") === "true");
    return { view, index: active < 0 ? 0 : active };
  }
  const peerIndex = peerTabIndex(view);
  if (peerIndex >= 0) return { view, index: peerIndex };
  const index = VIEW_ORDER.indexOf(view);
  return { view, index: index < 0 ? VIEW_ORDER.indexOf("chat") : index };
}

export function isViewTransitionActive(): boolean {
  try { return typeof document!=="undefined" && Boolean(document.documentElement?.matches(":active-view-transition")); }
  catch { return false; }
}
/** CSS owns route entrance motion; document snapshots make the new controls unclickable. */
export function transitionView(change: () => void): void {
  const before = navigationPosition();
  const doc=document as Document & {activeViewTransition?:{skipTransition():void}|null};
  try { doc.activeViewTransition?.skipTransition(); } catch { /* A finished component transition needs no cleanup. */ }
  change();
  const after = navigationPosition();
  if (before.view === after.view && before.index === after.index) return;
  const backward = before.view === after.view
    ? after.index < before.index
    : VIEW_ORDER.indexOf(after.view) < VIEW_ORDER.indexOf(before.view);
  document.documentElement.dataset.navigationDirection = backward ? "back" : "forward";
}
