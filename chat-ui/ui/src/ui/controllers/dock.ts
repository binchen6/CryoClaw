import type { UiSettings } from "../storage.ts";

export type DockTabId = "changes" | "files" | "terminal" | "subagent" | "browser";

export type DockHost = {
  settings: UiSettings;
  dockActiveTab: DockTabId;
  applySettings(next: UiSettings): void;
};

export function openDockTab(host: DockHost, tab: DockTabId): void {
  host.dockActiveTab = tab;
  if (host.settings.dockCollapsed) {
    host.applySettings({ ...host.settings, dockCollapsed: false });
  }
}

export function toggleDock(host: DockHost): void {
  host.applySettings({ ...host.settings, dockCollapsed: !host.settings.dockCollapsed });
}
