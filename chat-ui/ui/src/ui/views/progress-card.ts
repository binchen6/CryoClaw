/**
 * Progress Card（进度卡片）视图 —— 内核 progressCard.get/put + progressCard.changed 的渲染层。
 * 对齐 control-ui 官方行为（取证 docs/kernel-recon/2026.8.2-chat-capabilities.md C.2）：
 *   composer 上方浮动卡；可折叠（折叠偏好持久化在 settings.chatProgressCardCollapsed）；
 *   markdown 体 + steps 有序列表；in_progress=spinner、completed=✓、pending=时钟；
 *   {completed}/{total} 计数；无活跃 run 时 in_progress 降级显示 paused 文案；
 *   可 dismiss（内核仅放行「无步骤或全部完成」的清空，见 canDismissProgressCard）。
 * 挂载点：views/chat.ts renderChat 的 compose 上方区（与审批弹条/目标横幅同区、文档流内）。
 * 状态数据见 ../controllers/progress-card.ts；样式见 styles/chat.css 的 .chat-progress-card 块。
 */
import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import {
  canDismissProgressCard,
  progressCardStats,
  type ProgressCardState,
  type ProgressCardStepStatus,
} from "../controllers/progress-card.ts";
import { toSanitizedMarkdownHtml } from "../markdown.ts";
import { icons } from "../icons.ts";
import { t } from "../i18n.ts";

export type ProgressCardViewProps = {
  sessionKey: string;
  collapsed: boolean;
  // 是否有活跃 run（progressCardHasActiveRun）：无活跃 run 时 in_progress 步骤降级为 paused 文案
  runActive: boolean;
  dismissing?: boolean;
  onToggleCollapse?: () => void;
  onDismiss?: () => void;
};

function renderStepIcon(status: ProgressCardStepStatus) {
  if (status === "completed") {
    return html`<span class="chat-progress-card__step-icon chat-progress-card__step-icon--completed" aria-hidden="true">${icons.check}</span>`;
  }
  if (status === "in_progress") {
    return html`<span class="chat-progress-card__step-icon chat-progress-card__step-icon--active" aria-hidden="true"><span class="chat-progress-card__spinner"></span></span>`;
  }
  return html`<span class="chat-progress-card__step-icon chat-progress-card__step-icon--pending" aria-hidden="true">${icons.clock}</span>`;
}

export function renderProgressCard(
  state: ProgressCardState | null | undefined,
  props: ProgressCardViewProps,
) {
  const card = state?.card ?? null;
  const hasError = Boolean(state?.error);
  if (!card) {
    return hasError && state?.sessionKey === props.sessionKey
      ? html`<p class="chat-progress-card__error" role="status">${t("progressCard.syncError")}</p>`
      : nothing;
  }
  // 会话隔离兜底：卡片归属其它会话时不渲染（session-transition 切换时会重建状态）
  if (card.sessionKey !== props.sessionKey) {
    return nothing;
  }

  const stats = progressCardStats(card);
  const paused = !props.runActive && stats.current !== null;
  const dismissible = canDismissProgressCard(card);
  const hasMarkdown = Boolean(card.markdown?.trim());
  const hasSteps = stats.total > 0;

  return html`
    <div
      class="chat-progress-card ${stats.allDone ? "chat-progress-card--done" : ""} ${props.collapsed ? "chat-progress-card--collapsed" : ""}"
      role="status"
      aria-label=${t("progressCard.title")}
    >
      <div class="chat-progress-card__header">
        <button
          class="chat-progress-card__toggle"
          type="button"
          aria-expanded=${props.collapsed ? "false" : "true"}
          aria-label=${props.collapsed ? t("progressCard.expand") : t("progressCard.collapse")}
          data-tooltip=${props.collapsed ? t("progressCard.expand") : t("progressCard.collapse")}
          @click=${() => props.onToggleCollapse?.()}
        >
          <span
            class="chat-progress-card__dot ${stats.allDone ? "chat-progress-card__dot--done" : stats.current ? "chat-progress-card__dot--active" : ""}"
            aria-hidden="true"
          ></span>
          <span class="chat-progress-card__title">${t("progressCard.title")}</span>
          ${hasSteps
            ? html`<span class="chat-progress-card__count">${stats.done}/${stats.total}${stats.allDone ? " ✓" : ""}</span>`
            : nothing}
          ${props.collapsed && stats.current
            ? html`<span class="chat-progress-card__current">${stats.current.step}</span>`
            : nothing}
          ${props.collapsed && paused
            ? html`<span class="chat-progress-card__paused">${t("progressCard.paused")}</span>`
            : nothing}
          <span class="chat-progress-card__chevron" aria-hidden="true">${props.collapsed ? icons.arrowUp : icons.arrowDown}</span>
        </button>
        ${dismissible
          ? html`<button
              class="chat-progress-card__dismiss"
              type="button"
              aria-label=${t("progressCard.dismiss")}
              data-tooltip=${t("progressCard.dismiss")}
              ?disabled=${Boolean(props.dismissing)}
              @click=${(e: Event) => {
                e.stopPropagation();
                props.onDismiss?.();
              }}
            >
              ${icons.x}
            </button>`
          : nothing}
      </div>
      ${hasError ? html`<p class="chat-progress-card__error" role="status">${t("progressCard.syncError")}</p>` : nothing}
      ${props.collapsed
        ? nothing
        : html`
          <div class="chat-progress-card__body">
            ${hasMarkdown
              ? html`<div class="chat-progress-card__markdown chat-text">${unsafeHTML(toSanitizedMarkdownHtml(card.markdown!))}</div>`
              : nothing}
            ${hasSteps
              ? html`
                <ol class="chat-progress-card__steps">
                  ${card.steps!.map(
                    (step) => html`
                      <li class="chat-progress-card__step chat-progress-card__step--${step.status}">
                        ${renderStepIcon(step.status)}
                        <span class="chat-progress-card__step-text">${step.step}</span>
                        ${step.status === "in_progress" && paused
                          ? html`<span class="chat-progress-card__step-paused">${t("progressCard.paused")}</span>`
                          : nothing}
                      </li>
                    `,
                  )}
                </ol>
              `
              : nothing}
          </div>
        `}
    </div>
  `;
}
