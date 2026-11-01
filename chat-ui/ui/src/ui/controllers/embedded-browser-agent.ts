import type { AppViewState } from "../app-view-state.ts";
import { setCryoClawView } from "../app-view-switch.ts";
import { openDockTab } from "./dock.ts";

const detachments = new WeakMap<AppViewState, () => void>();

export function syncEmbeddedBrowserAgentPolicy(host: AppViewState): void {
  void window.cryoclaw?.embeddedBrowserAgentPolicy?.({
    enabled: host.settings.embeddedBrowserEnabled && host.settings.embeddedBrowserAgentEnabled,
    priority: host.settings.embeddedBrowserPriority,
  }).catch(() => {});
}

export function attachEmbeddedBrowserAgent(host: AppViewState): void {
  detachEmbeddedBrowserAgent(host);
  const unsubscribe = window.cryoclaw?.onEmbeddedBrowserAgentOpen?.(() => {
    setCryoClawView(host, "chat");
    openDockTab(host, "browser");
    host.requestUpdate();
  });
  detachments.set(host, () => { if (typeof unsubscribe === "function") unsubscribe(); });
  syncEmbeddedBrowserAgentPolicy(host);
}

export function detachEmbeddedBrowserAgent(host: AppViewState): void {
  detachments.get(host)?.();
  detachments.delete(host);
}
