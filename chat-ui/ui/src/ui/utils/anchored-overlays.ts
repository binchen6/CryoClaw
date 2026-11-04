import { positionAnchorPanel } from "./anchor-panel.ts";

/** Native invokers own toggle/light-dismiss. This layer owns geometry and motion. */
export function installAnchoredOverlays(root: HTMLElement): () => void {
  const openPanels = new Map<HTMLElement, HTMLElement>();
  const position = (panel: HTMLElement, trigger: HTMLElement) => {
    if (!panel.isConnected || !trigger.isConnected || !panel.matches(":popover-open")) return;
    const above = Boolean(trigger.closest(".chat-compose, .dashboard-floatbar"));
    const placement = positionAnchorPanel(panel,trigger,above);
    panel.dataset.anchorSide = placement.side;
    panel.dataset.side = placement.side;
  };
  const beforeToggle = (event: Event) => {
    for (const existing of openPanels.keys()) if (!root.contains(existing)) openPanels.delete(existing);
    const panel = event.target;
    if (!(panel instanceof HTMLElement) || panel.getAttribute("popover") !== "auto") return;
    if ((event as ToggleEvent).newState !== "open") { openPanels.delete(panel); return; }
    const source = (event as ToggleEvent & { source?: Element }).source;
    const trigger = source instanceof HTMLElement ? source : [...root.querySelectorAll<HTMLButtonElement>("[popovertarget]")]
      .find(button => button.popoverTargetElement === panel);
    if (!trigger) return;
    openPanels.set(panel, trigger);
    // Runs after native open, before paint; measurements exclude animated transforms.
    queueMicrotask(() => position(panel, trigger));
  };
  const reposition = () => { for (const [panel, trigger] of openPanels) {
    if (!panel.isConnected || !trigger.isConnected) { openPanels.delete(panel); panel.hidePopover(); }
    else position(panel, trigger);
  } };
  root.addEventListener("beforetoggle", beforeToggle, true);
  window.addEventListener("resize", reposition);
  root.addEventListener("scroll", reposition, true);
  return () => {
    root.removeEventListener("beforetoggle", beforeToggle, true);
    window.removeEventListener("resize", reposition);
    root.removeEventListener("scroll", reposition, true);
    for (const panel of openPanels.keys()) panel.hidePopover();
    openPanels.clear();
  };
}
