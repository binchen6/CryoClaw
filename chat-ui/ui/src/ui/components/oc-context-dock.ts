import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement } from "lit/decorators.js";
import type { DockTabId } from "../controllers/dock.ts";
import type { SubagentCard } from "../chat/subagent-status.ts";
import { isFailedSubagentStatus } from "../chat/subagent-status.ts";
import { icons } from "../icons.ts";
import { t } from "../i18n.ts";
import { formatShortcut, getShortcutBinding } from "../keyboard-shortcuts.ts";
import { placePopover } from "../utils/popover-placement.ts";
import { renderMarkdownSidebar } from "../views/markdown-sidebar.ts";
import "./oc-subagent-panel.ts";

type SubagentPanelData = {
  key: string;
  title: string;
  status: string;
  messages: unknown[];
  visibleHistoryCount: number;
  toolMessages: Record<string, unknown>[];
  stream: string | null;
  thinkingStream: string | null;
  narrationText: string | null;
  streamStartedAt: number | null;
  loading: boolean;
  error: string | null;
};

const TAB_META: Array<{ id: DockTabId; label: string; icon: keyof typeof icons }> = [
  { id: "changes", label: "dock.changes", icon: "diff" },
  { id: "browser", label: "dock.browser", icon: "globe" },
  { id: "terminal", label: "dock.terminal", icon: "terminal" },
  { id: "files", label: "dock.files", icon: "fileText" },
  { id: "subagent", label: "dock.subagent", icon: "gitBranch" },
];

@customElement("oc-context-dock")
export class OcContextDock extends LitElement {
  static properties = {
    collapsed: { attribute: false },
    maximized: { attribute: false },
    activeTab: { attribute: false },
    launcherOpen: { attribute: false },
    openedTabs: { attribute: false },
    browserEnabled: { attribute: false },
    subagentCards: { attribute: false },
    subagentPanel: { attribute: false },
    sidebarOpen: { attribute: false },
    sidebarContent: { attribute: false },
    sidebarError: { attribute: false },
    changesContent: { attribute: false },
    filesContent: { attribute: false },
    terminalContent: { attribute: false },
    browserContent: { attribute: false },
    assistantName: { attribute: false },
    assistantAvatar: { attribute: false },
    onSelectTab: { attribute: false },
    onCloseTab: { attribute: false },
    onToggleCollapsed: { attribute: false },
    onToggleMaximized: { attribute: false },
    onOpenSubagent: { attribute: false },
    onCloseSubagent: { attribute: false },
    onOpenSidebar: { attribute: false },
    onCloseSidebar: { attribute: false },
  };

  collapsed = true;
  maximized = false;
  activeTab: DockTabId = "changes";
  launcherOpen = true;
  openedTabs: DockTabId[] = [];
  browserEnabled = false;
  subagentCards: SubagentCard[] = [];
  subagentPanel: SubagentPanelData | null = null;
  sidebarOpen = false;
  sidebarContent: string | null = null;
  sidebarError: string | null = null;
  changesContent?: TemplateResult;
  filesContent?: TemplateResult;
  terminalContent?: TemplateResult;
  browserContent?: TemplateResult;
  assistantName = "";
  assistantAvatar: string | null = null;
  onSelectTab?: (tab: DockTabId) => void;
  onCloseTab?: (tab: DockTabId) => void;
  onToggleCollapsed?: () => void;
  onToggleMaximized?: () => void;
  private newTabMenuId = `dock-new-tab-${Math.random().toString(36).slice(2, 9)}`;
  onOpenSubagent?: (key: string) => void;
  onCloseSubagent?: () => void;
  onOpenSidebar?: (content: string) => void;
  onCloseSidebar?: () => void;

  createRenderRoot() {
    return this;
  }

  private tabs() {
    return TAB_META.filter((tab) => tab.id !== "browser" || this.browserEnabled);
  }

  private renderTabButton(tab: (typeof TAB_META)[number]) {
    return html`<div class="context-dock__chip ${!this.launcherOpen && this.activeTab === tab.id ? "is-active" : ""}"><button
      class="context-dock__tab"
      type="button"
      role="tab"
      aria-selected=${String(!this.launcherOpen && this.activeTab === tab.id)}
      title=${t(tab.label)}
      aria-label=${t(tab.label)}
      @click=${() => this.onSelectTab?.(tab.id)}
    >${icons[tab.icon]}<span>${t(tab.label)}</span></button><button class="context-dock__tab-close" type="button" data-dock-close=${tab.id}
      aria-label=${`${t("workspace.browser.closeTab")}: ${t(tab.label)}`} title=${t("workspace.browser.closeTab")}
      @click=${() => this.onCloseTab?.(tab.id)}>${icons.x}</button></div>`;
  }

  private renderEntry(tab: (typeof TAB_META)[number]) {
    const shortcutId = ({ changes: "dockChanges", browser: "dockBrowser", terminal: "dockTerminal", files: "dockFiles", subagent: "dockSubagent" } as const)[tab.id];
    const keys = formatShortcut(getShortcutBinding(shortcutId));
    return html`<button type="button" data-dock-open=${tab.id} @click=${(event: Event) => {
      (event.currentTarget as HTMLElement).closest<HTMLElement>(":popover-open")?.hidePopover();
      this.onSelectTab?.(tab.id);
    }}>
      <span>${icons[tab.icon]}${t(tab.label)}</span>${keys.length ? html`<span class="context-dock__shortcut">${keys.map(key => html`<kbd>${key}</kbd>`)}</span>` : nothing}
    </button>`;
  }

  private async toggleNewTabMenu(event: Event) {
    const open = (event as Event & { newState: string }).newState === "open";
    const browser = this.querySelector("oc-embedded-browser") as (HTMLElement & { setChromeOverlay(open: boolean): Promise<boolean> }) | null;
    await browser?.setChromeOverlay(open);
    if (!open || !this.isConnected) return;
    await this.updateComplete;
    const menu = this.querySelector<HTMLElement>(".context-dock__new-tab-menu");
    const trigger = this.querySelector<HTMLElement>(`[popovertarget="${this.newTabMenuId}"]`);
    if (!menu?.matches(":popover-open") || !trigger) return;
    const anchor = trigger.getBoundingClientRect();
    const position = placePopover({ anchor, panel: menu.getBoundingClientRect(), viewport: { width: innerWidth, height: innerHeight }, candidates: [{ side: "bottom", align: "end" }, { side: "top", align: "end" }], avoid: [anchor] });
    Object.assign(menu.style, { inset: "auto", left: `${position.left}px`, top: `${position.top}px` });
  }

  private renderSubagentList() {
    if (this.subagentCards.length === 0) {
      return html`<div class="context-dock__empty">${t("chat.subagent.empty")}</div>`;
    }
    return html`<div class="context-dock__subagents">${this.subagentCards.map((card) => html`
      <button class="context-dock__subagent ${card.active ? "is-active" : isFailedSubagentStatus(card.status) ? "is-failed" : "is-done"}"
        type="button" @click=${() => this.onOpenSubagent?.(card.sessionKey)}>
        <span class="context-dock__subagent-icon">${icons.gitBranch}</span>
        <span class="context-dock__subagent-body">
          <strong>${card.title}</strong>
          <span>${card.progress ?? card.status}</span>
        </span>
        ${icons.arrowRight}
      </button>
    `)}</div>`;
  }

  private renderBody() {
    switch (this.activeTab) {
      case "changes":
        return this.changesContent ?? nothing;
      case "files":
        return this.sidebarOpen
          ? renderMarkdownSidebar({
              content: this.sidebarContent,
              error: this.sidebarError,
              onClose: this.onCloseSidebar!,
              onViewRawText: () => {
                if (this.sidebarContent) this.onOpenSidebar?.(`\`\`\`\n${this.sidebarContent}\n\`\`\``);
              },
            })
          : this.filesContent ?? nothing;
      case "terminal":
        return this.terminalContent ?? nothing;
      case "subagent":
        return this.subagentPanel
          ? html`<oc-subagent-panel
              .sessionKey=${this.subagentPanel.key}
              .title=${this.subagentPanel.title}
              .status=${this.subagentPanel.status}
              .loading=${this.subagentPanel.loading}
              .error=${this.subagentPanel.error}
              .messages=${this.subagentPanel.messages}
              .visibleHistoryCount=${this.subagentPanel.visibleHistoryCount}
              .toolMessages=${this.subagentPanel.toolMessages}
              .stream=${this.subagentPanel.stream}
              .thinkingStream=${this.subagentPanel.thinkingStream}
              .narrationText=${this.subagentPanel.narrationText}
              .streamStartedAt=${this.subagentPanel.streamStartedAt}
              .assistantName=${this.assistantName}
              .assistantAvatar=${this.assistantAvatar}
              .onClose=${this.onCloseSubagent}
              .onOpenSidebar=${this.onOpenSidebar}
            ></oc-subagent-panel>`
          : this.renderSubagentList();
      case "browser":
        return this.browserContent ?? nothing;
    }
  }

  render() {
    if (this.collapsed) return nothing;
    const tabs = this.tabs();
    const openedIds = this.openedTabs.length ? this.openedTabs : this.launcherOpen ? [] : [this.activeTab];
    const openedTabs = openedIds.map(id => tabs.find(tab => tab.id === id)).filter((tab): tab is (typeof TAB_META)[number] => Boolean(tab));
    return html`<section class="context-dock context-dock--expanded" aria-label=${t("dock.title")}>
      <header class="context-dock__header">
        <nav class="context-dock__tabs" role="tablist" aria-label=${t("dock.title")}>
          ${openedTabs.map((tab) => this.renderTabButton(tab))}
        </nav>
        <div class="context-dock__actions">
          <button class="icon-btn icon-btn--sm" type="button" title=${t("dock.newTab")} aria-label=${t("dock.newTab")}
            popovertarget=${this.newTabMenuId}>${icons.plus}</button>
          <button class="icon-btn icon-btn--sm" type="button" title=${this.maximized ? t("dock.restore") : t("dock.maximize")}
            aria-label=${this.maximized ? t("dock.restore") : t("dock.maximize")}
            @click=${() => this.onToggleMaximized?.()}>${icons.layout}</button>
          <button class="icon-btn icon-btn--sm" type="button" title=${t("dock.collapse")} aria-label=${t("dock.collapse")}
            @click=${() => this.onToggleCollapsed?.()}>${icons.panelRight}</button>
        </div>
        <div class="context-dock__new-tab-menu" id=${this.newTabMenuId} popover="auto" @beforetoggle=${(event: Event) => void this.toggleNewTabMenu(event)}>
          ${tabs.map((tab) => this.renderEntry(tab))}
        </div>
      </header>
      <div class="context-dock__body" role=${this.launcherOpen ? "region" : "tabpanel"}>${this.launcherOpen
        ? html`<nav class="context-dock__launcher" aria-label=${t("dock.newTab")}>${tabs.map(tab => this.renderEntry(tab))}</nav>`
        : this.renderBody()}</div>
    </section>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "oc-context-dock": OcContextDock;
  }
}
