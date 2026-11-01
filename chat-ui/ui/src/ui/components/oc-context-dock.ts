import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement } from "lit/decorators.js";
import type { DockTabId } from "../controllers/dock.ts";
import type { SubagentCard } from "../chat/subagent-status.ts";
import { isFailedSubagentStatus } from "../chat/subagent-status.ts";
import { icons } from "../icons.ts";
import { t } from "../i18n.ts";
import { formatShortcut, getShortcutBinding } from "../keyboard-shortcuts.ts";
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
  { id: "files", label: "dock.files", icon: "fileText" },
  { id: "terminal", label: "dock.terminal", icon: "terminal" },
  { id: "subagent", label: "dock.subagent", icon: "gitBranch" },
  { id: "browser", label: "dock.browser", icon: "globe" },
];

@customElement("oc-context-dock")
export class OcContextDock extends LitElement {
  static properties = {
    collapsed: { attribute: false },
    maximized: { attribute: false },
    activeTab: { attribute: false },
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

  private renderTabButton(tab: (typeof TAB_META)[number], collapsed: boolean) {
    return html`<button
      class="context-dock__tab ${this.activeTab === tab.id ? "is-active" : ""}"
      type="button"
      role="tab"
      aria-selected=${String(this.activeTab === tab.id)}
      title=${t(tab.label)}
      aria-label=${t(tab.label)}
      @click=${() => this.onSelectTab?.(tab.id)}
    >${icons[tab.icon]}${collapsed ? nothing : html`<span>${t(tab.label)}</span>`}</button>`;
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
    const tabs = this.tabs();
    if (this.collapsed) {
      return html`<aside class="context-dock context-dock--collapsed" aria-label=${t("dock.title")}>
        <button class="context-dock__collapse" type="button" title=${t("dock.expand")} aria-label=${t("dock.expand")}
          @click=${() => this.onToggleCollapsed?.()}>${icons.plus}</button>
        <div class="context-dock__collapsed-tabs">${tabs.map((tab) => this.renderTabButton(tab, true))}</div>
      </aside>`;
    }
    return html`<section class="context-dock context-dock--expanded" aria-label=${t("dock.title")}>
      <header class="context-dock__header">
        <nav class="context-dock__tabs" role="tablist" aria-label=${t("dock.title")}>
          ${tabs.map((tab) => this.renderTabButton(tab, false))}
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
        <div class="context-dock__new-tab-menu" id=${this.newTabMenuId} popover="auto">
          ${tabs.map((tab) => {
            const shortcutId = ({ changes: "dockChanges", browser: "dockBrowser", terminal: "dockTerminal", files: "dockFiles", subagent: "dockSubagent" } as const)[tab.id];
            const shortcut = formatShortcut(getShortcutBinding(shortcutId)).join(" ");
            return html`<button type="button" @click=${() => this.onSelectTab?.(tab.id)}>
              <span>${icons[tab.icon]}${t(tab.label)}</span><kbd>${shortcut || t("shortcuts.unassigned")}</kbd>
            </button>`;
          })}
        </div>
      </header>
      <div class="context-dock__body" role="tabpanel">${this.renderBody()}</div>
    </section>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "oc-context-dock": OcContextDock;
  }
}
