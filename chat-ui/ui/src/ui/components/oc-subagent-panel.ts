import { LitElement, html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { icons } from "../icons.ts";
import { t } from "../i18n.ts";
import "./oc-chat-history.ts";
import "./oc-chat-stream.ts";

@customElement("oc-subagent-panel")
export class OcSubagentPanel extends LitElement {
  static properties = {
    sessionKey: { attribute: false },
    title: { attribute: false },
    status: { attribute: false },
    loading: { attribute: false },
    error: { attribute: false },
    messages: { attribute: false },
    visibleHistoryCount: { attribute: false },
    toolMessages: { attribute: false },
    stream: { attribute: false },
    thinkingStream: { attribute: false },
    narrationText: { attribute: false },
    streamStartedAt: { attribute: false },
    assistantName: { attribute: false },
    assistantAvatar: { attribute: false },
    onClose: { attribute: false },
    onOpenSidebar: { attribute: false },
  };

  sessionKey = "";
  title = "";
  status = "";
  loading = false;
  error: string | null = null;
  messages: unknown[] = [];
  visibleHistoryCount = 0;
  toolMessages: Record<string, unknown>[] = [];
  stream: string | null = null;
  thinkingStream: string | null = null;
  narrationText: string | null = null;
  streamStartedAt: number | null = null;
  assistantName = "";
  assistantAvatar: string | null = null;
  onClose?: () => void;
  onOpenSidebar?: (content: string) => void;

  createRenderRoot() {
    return this;
  }

  render() {
    const live = this.stream !== null || this.thinkingStream !== null || this.narrationText !== null;
    return html`
      <section class="subagent-panel" aria-label=${this.title || this.sessionKey}>
        <header class="subagent-panel__header">
          <span class="subagent-panel__identity">
            <span class="subagent-panel__icon" aria-hidden="true">${icons.gitBranch}</span>
            <span class="subagent-panel__heading">
              <strong class="subagent-panel__title" title=${this.title}>${this.title || this.sessionKey}</strong>
              <span class="subagent-panel__subtitle">${this.status || this.sessionKey}</span>
            </span>
          </span>
          <button class="icon-btn icon-btn--sm" type="button" aria-label=${t("markdownSidebar.close")}
            title=${t("markdownSidebar.close")} @click=${() => this.onClose?.()}>${icons.x}</button>
        </header>
        <div class="subagent-panel__thread" role="log" aria-live="polite">
          ${this.loading && this.messages.length === 0
            ? html`<div class="subagent-panel__state" role="status">${t("chat.loading")}</div>`
            : this.error && this.messages.length === 0
              ? html`<div class="subagent-panel__state subagent-panel__state--error" role="alert">${this.error}</div>`
              : nothing}
          <oc-chat-history
            .messages=${this.messages}
            .toolMessages=${this.toolMessages}
            .visibleHistoryCount=${this.visibleHistoryCount}
            .showReasoning=${false}
            .assistantName=${this.assistantName}
            .assistantAvatar=${this.assistantAvatar}
            .workspacePath=${""}
            .runActive=${live}
            .onOpenSidebar=${this.onOpenSidebar}
          ></oc-chat-history>
          ${live
            ? html`<oc-chat-stream
                aria-live="off"
                .toolMessages=${this.toolMessages}
                .stream=${this.stream}
                .thinkingStream=${this.thinkingStream}
                .narrationText=${this.narrationText}
                .streamStartedAt=${this.streamStartedAt}
                .assistantName=${this.assistantName}
                .assistantAvatar=${this.assistantAvatar}
                .onOpenSidebar=${this.onOpenSidebar}
              ></oc-chat-stream>`
            : nothing}
          ${!this.loading && !this.error && this.messages.length === 0 && this.toolMessages.length === 0 && !live
            ? html`<div class="subagent-panel__state">${t("chat.emptySubtitle")}</div>`
            : nothing}
        </div>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "oc-subagent-panel": OcSubagentPanel;
  }
}
