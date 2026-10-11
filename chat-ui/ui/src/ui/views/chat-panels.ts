/**
 * chat-panels.ts — 对话页「compose 上方文档流面板带」纯渲染模块
 * （对齐 question-cards/progress-card 已拆出的范式：纯函数、props 进、TemplateResult 出）。
 *
 * 挂载点（views/chat.ts renderChat，自上而下）：
 *   页顶 callout（renderGatewayCallout）→ 连接态错误条 →
 *   compaction/fallback 胶囊（renderCompactionIndicator/renderFallbackNotice）→
 *   plan/progress 卡（独立模块）→ 会话仪表盘（renderBoardPanel）→
 *   新消息回底钮 → 待审批队列（renderExecStrip）。
 * 全部无自有状态；compaction 完成胶囊的 5s 定格由渲染时刻差值判定（无定时器）。
 */
import { html, nothing } from "lit";
import { icons } from "../icons.ts";
import { t } from "../i18n.ts";
import type { ChatProps } from "./chat.ts";
import type { BoardState } from "../controllers/board.ts";
import { BOARD_WIDGET_SANDBOX } from "../controllers/board.ts";
import type { FallbackNotice } from "../app-tool-stream.ts";
import {
  GATEWAY_PROGRESS_STEPS,
  gatewayStepIndex,
  gatewayStepKey,
} from "../gateway-connection.ts";

export type CompactionIndicatorStatus = {
  active: boolean;
  startedAt: number | null;
  completedAt: number | null;
};

const COMPACTION_TOAST_DURATION_MS = 5000;

// Gateway 连接状态 callout（三态：starting / reconnecting / failed）——替代旧
// 裸 `disconnected (code): reason` 红色横幅。starting 为蓝色信息态并附启动进度
// （步骤点 + 不定进度条 + 尝试次数）；reconnecting 为过渡态提示；只有持续重连
// 失败才落 danger 态并给手动重试按钮。
export function renderGatewayCallout(props: ChatProps) {
  const conn = props.gatewayConnection;
  if (props.connected || !conn) {
    return nothing;
  }
  if (conn.phase === "starting") {
    const progress = conn.progress;
    const stepIdx = progress ? gatewayStepIndex(progress.step) : -1;
    const stepCount = GATEWAY_PROGRESS_STEPS.length;
    return html`
      <div class="callout info chat-conn-callout" role="status" aria-live="polite">
        <span class="chat-conn-callout__icon" aria-hidden="true">${icons.loader}</span>
        <div class="chat-conn-callout__body">
          <div class="chat-conn-callout__title">${t("gateway.status.starting")}</div>
          ${progress
            ? html`
                <div class="chat-conn-callout__step">
                  ${t(gatewayStepKey(progress.step))}
                  ${progress.attempt > 1
                    ? html`<span class="chat-conn-callout__attempt">${t("gateway.starting.attempt").replace("{n}", String(progress.attempt))}</span>`
                    : nothing}
                </div>
                <div class="chat-conn-callout__bar" aria-hidden="true">
                  <span
                    class="chat-conn-callout__bar-fill"
                    style=${`width: ${Math.max(8, Math.round(((stepIdx + 1) / stepCount) * 100))}%`}
                  ></span>
                </div>
              `
            : html`<div class="chat-conn-callout__step">${t("gateway.status.startingHint")}</div>`}
        </div>
      </div>
    `;
  }
  if (conn.phase === "reconnecting") {
    return html`
      <div class="callout info chat-conn-callout" role="status" aria-live="polite">
        <span class="chat-conn-callout__icon" aria-hidden="true">${icons.refreshCw}</span>
        <div class="chat-conn-callout__body">
          <div class="chat-conn-callout__title">${t("gateway.status.reconnecting")}</div>
          <div class="chat-conn-callout__step">${t("gateway.status.reconnectingHint")}</div>
        </div>
      </div>
    `;
  }
  return html`
    <div class="callout danger chat-conn-callout" role="alert">
      <span class="chat-conn-callout__icon" aria-hidden="true">${icons.warning}</span>
      <div class="chat-conn-callout__body">
        <div class="chat-conn-callout__title">${t("gateway.status.failed")}</div>
        <div class="chat-conn-callout__step">${t("gateway.status.failedHint")}</div>
      </div>
      <button
        class="btn btn--sm chat-conn-callout__retry"
        type="button"
        @click=${() => props.onReconnect?.()}
      >
        ${icons.refreshCw}
        ${t("gateway.retry")}
      </button>
    </div>
  `;
}

export function renderCompactionIndicator(status: CompactionIndicatorStatus | null | undefined) {
  if (!status) {
    return nothing;
  }

  // Show "compacting..." while active
  if (status.active) {
    return html`
      <div class="compaction-indicator compaction-indicator--active" role="status" aria-live="polite">
        ${icons.loader} ${t("chat.compacting")}
      </div>
    `;
  }

  // Show "compaction complete" briefly after completion
  if (status.completedAt) {
    const elapsed = Date.now() - status.completedAt;
    if (elapsed < COMPACTION_TOAST_DURATION_MS) {
      return html`
        <div class="compaction-indicator compaction-indicator--complete" role="status" aria-live="polite">
          ${icons.check} ${t("chat.compacted")}
        </div>
      `;
    }
  }

  return nothing;
}

// 模型 fallback 提示：复用 compaction-indicator 胶囊样式（--fallback 变体，warning 色调），
// 由 app-tool-stream 的 5s 定时器 / chat 终态负责清掉，这里只读当前值渲染。
export function renderFallbackNotice(notice: FallbackNotice | null | undefined) {
  if (!notice) {
    return nothing;
  }
  const text = notice.cleared
    ? t("chat.fallbackCleared").replace("{activeModel}", notice.activeModel)
    : t("chat.fallbackNotice")
        .replace("{activeModel}", notice.activeModel)
        .replace("{selectedModel}", notice.selectedModel ?? "");
  return html`
    <div class="compaction-indicator compaction-indicator--fallback" role="status" aria-live="polite">
      ${icons.warning} ${text}
    </div>
  `;
}

// ── R89 会话仪表盘（内核 board.get + board.changed；会话有 board 时出面板） ──
export function renderBoardPanel(props: ChatProps) {
  const board = props.board ?? null;
  if (!board || board.sessionKey !== props.sessionKey || board.widgets.length === 0) {
    return nothing;
  }
  // ticket 20 分钟 TTL（内核 BOARD_VIEW_TICKET_TICKET_TTL）：面板以 <details> 常折，
  // 展开才挂 iframe（src 由重拉换新 ticket 时刷新），最大化降低 ticket 过期面。
  return html`
    <details class="chat-board">
      <summary class="chat-board__summary">
        <svg class="chat-board__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>
        <span>${t("chat.board.title")}</span>
        <span class="chat-board__count">${board.widgets.length}</span>
      </summary>
      <div class="chat-board__body">
        ${board.widgets.map((widget) => html`
          <div class="chat-board__widget">
            <div class="chat-board__widget-name">${widget.kindLabel ?? widget.name}</div>
            <iframe
              class="chat-board__frame"
              src=${widget.src}
              title=${widget.name}
              sandbox=${BOARD_WIDGET_SANDBOX}
              loading="lazy"
            ></iframe>
          </div>
        `)}
      </div>
    </details>
  `;
}

// ── 待审批队列（compose 上方；执行权限三档已整合进加号菜单） ──
export function renderExecStrip(props: ChatProps) {
  const queue = props.execApprovalQueue ?? [];
  if (queue.length === 0) {
    return nothing;
  }
  const busy = Boolean(props.execApprovalBusy);
  return html`
    <div class="chat-exec-strip">
      <div class="chat-approval-panel">
        <div class="chat-approval-panel__title">${t("chat.approvalPending")} (${queue.length})</div>
        ${queue.map((entry) => {
          const decisions = entry.allowedDecisions;
          const allowAlways = !decisions || decisions.includes("allow-always");
          const label = entry.kind === "plugin" ? (entry.title ?? "") : entry.request.command;
          return html`
          <div class="chat-approval-item">
            <div class="chat-approval-item__body">
              <div class="chat-approval-item__cmd ${entry.kind ==="exec" ? "mono" : ""}">${label}</div>
              ${entry.description
                ? html`<div class="chat-approval-item__desc">${entry.description}</div>`
                : nothing}
            </div>
            <div class="chat-approval-item__actions">
              <button class="chat-approval-item__btn chat-approval-item__btn--allow" type="button" ?disabled=${busy} @click=${() => props.onApprovalDecision?.("allow-once", entry.id)}>${t("chat.approvalAllowOnce")}</button>
              ${allowAlways
                ? html`<button class="chat-approval-item__btn" type="button" ?disabled=${busy} @click=${() => props.onApprovalDecision?.("allow-always", entry.id)}>${t("chat.approvalAllowAlways")}</button>`
                : nothing}
              <button class="chat-approval-item__btn chat-approval-item__btn--deny" type="button" ?disabled=${busy} @click=${() => props.onApprovalDecision?.("deny", entry.id)}>${t("chat.approvalDeny")}</button>
            </div>
          </div>
        `;})}
        ${props.execApprovalError ? html`<div class="exec-approval-error">${props.execApprovalError}</div>` : nothing}
      </div>
    </div>
  `;
}
