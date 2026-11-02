import type { UiSettings } from "../storage.ts";

export type DockTabId = "changes" | "files" | "terminal" | "subagent" | "browser";

export type DockHost = {
  settings: UiSettings;
  dockActiveTab: DockTabId;
  dockOpenedTabs?: DockTabId[];
  dockLauncherOpen?: boolean;
  applySettings(next: UiSettings): void;
};

export function openDockTab(host: DockHost, tab: DockTabId): void {
  host.dockActiveTab = tab;
  host.dockLauncherOpen = false;
  host.dockOpenedTabs = [...new Set([...(host.dockOpenedTabs ?? []), tab])];
  if (host.settings.dockCollapsed) {
    host.applySettings({ ...host.settings, dockCollapsed: false });
  }
}

export function toggleDock(host: DockHost): void {
  if (host.settings.dockCollapsed) host.dockLauncherOpen = true;
  host.applySettings({ ...host.settings, dockCollapsed: !host.settings.dockCollapsed });
}

export function closeDockTab(host: DockHost, tab: DockTabId): void {
  const opened = (host.dockOpenedTabs ?? []).filter(id => id !== tab);
  host.dockOpenedTabs = opened;
  if (host.dockActiveTab === tab && opened.length) host.dockActiveTab = opened[opened.length - 1];
  if (!opened.length) host.dockLauncherOpen = true;
}
