import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import type { GatewaySessionRow, SessionsListResult } from "../types.ts";
import type { ChatItem, MessageGroup } from "../types/chat-types.ts";
import type { ChatAttachment, ChatQueueItem, ConfiguredModel } from "../ui-types.ts";
import {
  renderMessageGroup,
  renderReadingIndicatorGroup,
  renderStreamingGroup,
} from "../chat/grouped-render.ts";
import { computeSessionFileChanges, type FileChange } from "../chat/file-changes.ts";
import { normalizeMessage, normalizeRoleForGrouping } from "../chat/message-normalizer.ts";
import { icons } from "../icons.ts";
import { getLocale, t } from "../i18n.ts";
import { detectTextDirection } from "../text-direction.ts";
import { renderMarkdownSidebar } from "./markdown-sidebar.ts";
import { resolveContextMeterStats } from "../context-meter.ts";
import type { CommandEntry, ExecApprovalRequest } from "../types.ts";
import { filterCommands, resolveCommandDescription } from "../controllers/commands.ts";
import type { SessionGoal } from "../types.ts";
import {
  goalElapsedMs,
  goalStatusKey,
  goalStatusKind,
  goalSummaryText,
  goalTokenPercent,
  goalTokensLabel,
} from "../chat/goal-display.ts";
import type { SessionCompactionCheckpoint } from "../controllers/session-compaction.ts";
import "../components/resizable-divider.ts";
import { renderConfiguredModelOptions } from "../components/model-options.ts";
import { loadModelOrg } from "./settings/model-org.lib.ts";
import { computeStopButtonVisible } from "./chat-stop-button-gate.ts";
import { KNOWN_THINKING_LEVELS } from "../chat/thinking-levels.ts";
import { resolveActiveToolName } from "../chat/tool-summary.ts";
import { appendQuoteToDraft } from "../chat/quote-text.ts";
import { isFailedSubagentStatus, selectSubagentCards, type SubagentCard } from "../chat/subagent-status.ts";
import { renderPlanPanel } from "./plan-panel.ts";
import type { PlanStreamState } from "../plan-stream.ts";
import type { FallbackNotice } from "../app-tool-stream.ts";

export { computeStopButtonVisible };

// 思考档位标签：已知档走 i18n（chat.thinkLevel.*），未知档原样显示内核 id
function thinkingLevelLabel(level: string): string {
  return (KNOWN_THINKING_LEVELS as readonly string[]).includes(level)
    ? t(`chat.thinkLevel.${level}`)
    : level;
}

export type CompactionIndicatorStatus = {
  active: boolean;
  startedAt: number | null;
  completedAt: number | null;
};

export type ChatProps = {
  sessionKey: string;
  onSessionKeyChange: (next: string) => void;
  thinkingLevel: string | null;
  showThinking: boolean;
  loading: boolean;
  sending: boolean;
  canAbort?: boolean;
  compactionStatus?: CompactionIndicatorStatus | null;
  // 模型 fallback 提示（lifecycle 事件驱动，5s 自动消失）
  fallbackNotice?: FallbackNotice | null;
  // 计划悬浮面板（update_plan 工具事件驱动，独立于 toolStream）
  plan?: PlanStreamState | null;
  onDismissPlan?: () => void;
  messages: unknown[];
  visibleHistoryCount: number;
  toolMessages: unknown[];
  // R23：任务列表与主 run 活跃标记（子代理等待状态卡投影用，引用稳定供 memo 比较）
  tasks?: unknown[];
  runActive?: boolean;
  stream: string | null;
  streamStartedAt: number | null;
  assistantAvatarUrl?: string | null;
  draft: string;
  queue: ChatQueueItem[];
  connected: boolean;
  canSend: boolean;
  error: string | null;
  sessions: SessionsListResult | null;
  // Sidebar state
  sidebarOpen?: boolean;
  sidebarContent?: string | null;
  sidebarError?: string | null;
  splitRatio?: number;
  assistantName: string;
  assistantAvatar: string | null;
  // 模型选择器
  configuredModels?: ConfiguredModel[];
  currentModel?: string | null;
  dirtyMeterSessions?: ReadonlySet<string>;
  onModelChange?: (modelKey: string) => void;
  // 思考开关
  thinkingToggleLevel?: string;
  thinkingToggleLevels?: string[];
  isBinaryThinking?: boolean;
  onThinkingToggle?: () => void;
  onThinkingLevelChange?: (level: string) => void;
  // 会话回放/分支（rewind/fork）
  compactionCheckpoints?: SessionCompactionCheckpoint[];
  /** checkpoints 加载时对应的 sessionKey，与当前 sessionKey 不匹配时按加载中处理 */
  compactionCheckpointsKey?: string | null;
  compactionCheckpointsLoading?: boolean;
  compactionCheckpointsError?: string | null;
  compactionBusyCheckpointId?: string | null;
  onOpenCompactionCheckpoints?: () => void;
  onRestoreCheckpoint?: (checkpointId: string) => void;
  onBranchCheckpoint?: (checkpointId: string) => void;
  // 消息引用：把原文构造成引用块追加到草稿末尾，并把焦点送回输入框（可接着打字）
  onQuoteMessage?: (text: string) => void;
  // 错误卡片「重发」：重新发送失败的用户消息文本（同步发送失败路径提供），
  // attachments 为错误卡上保存的附件（resendAttachments），带回防重发附件丢失
  onResendError?: (text: string, attachments?: ChatAttachment[]) => void;
  // 目标模式（官方 session.goal）
  goal?: SessionGoal | null;
  onGoalCommand?: (text: string) => void;
  onRequestUpdate?: () => void;
  // / 命令补全目录（官方 commands.list）
  commands?: CommandEntry[] | null;
  // 执行权限三态 + 待审批队列（官方 tools.exec.mode + exec.approval）
  execMode?: "ask" | "auto" | "full";
  onExecModeChange?: (mode: "ask" | "auto" | "full") => void;
  execApprovalQueue?: ExecApprovalRequest[];
  execApprovalBusy?: boolean;
  execApprovalError?: string | null;
  // 多条审批并存时按 entry id 决议；id 缺省时由状态层回退到队首
  onApprovalDecision?: (decision: "allow-once" | "allow-always" | "deny", id?: string) => void;
  // 引用技能（官方 skills.status）：加号菜单「引用技能」的数据源，
  // 返回当前可用的技能列表（已过滤 disabled / ineligible）
  onListSkills?: () => Promise<Array<{ key: string; name: string; description?: string; emoji?: string }>>;
  // Image attachments
  attachments?: ChatAttachment[];
  // 支持函数式更新：异步回调（粘贴/选文件）基于最新 state 合并，避免闭包旧值丢附件
  onAttachmentsChange?: (
    next: ChatAttachment[] | ((prev: ChatAttachment[]) => ChatAttachment[]),
  ) => void;
  // 轻量通知条（走 app-toast 全局模块，由状态层注入）
  onShowToast?: (message: string) => void;
  // file-changes 面板「在 git 中查看」链接（P4 git 面板入口；gitAvailable===true 时才渲染）
  gitAvailable?: boolean | null;
  onOpenGitView?: () => void;
  // Scroll control
  showNewMessages?: boolean;
  onScrollToBottom?: () => void;
  // Event handlers
  onRefresh: () => void;
  onDraftChange: (next: string) => void;
  onSend: () => void;
  onAbort?: () => void;
  onQueueRemove: (id: string) => void;
  onQueueEdit?: (id: string, newText: string) => void;
  onQueueSendNow?: (id: string) => void;
  onNewSession: () => void;
  onOpenSidebar?: (content: string) => void;
  onCloseSidebar?: () => void;
  onSplitRatioChange?: (ratio: number) => void;
  onChatScroll?: (event: Event) => void;
};

const COMPACTION_TOAST_DURATION_MS = 5000;

// 加号菜单 / 目标表单本地状态（非响应式，渲染由 requestUpdate 驱动）
let plusMenuOpen = false;
let goalFormOpen = false;
let goalDraft = "";

// 加号菜单「引用技能」子面板状态：技能列表缓存于模块级，
// 每次打开时若未加载过则拉取一次（skills.status 变化频率低）
let skillPickerOpen = false;
let skillPickerLoading = false;
let skillPickerItems: Array<{ key: string; name: string; description?: string; emoji?: string }> = [];
let skillPickerLoaded = false;

// 队列行内编辑态（非响应式，渲染由 requestUpdate 驱动）：记录正在编辑的队列项 id
let queueEditingId: string | null = null;

// 加号菜单「点击外部关闭」的 document 监听句柄；菜单关闭时必须同步注销，
// 否则监听会残留到下一次外部点击才被清掉（并持有过期 props 闭包）。
let plusMenuOutsideCloser: ((ev: MouseEvent) => void) | null = null;

// 最近一次渲染的 sessionKey：切换会话时用于重置上面的模块级瞬态
// （加号菜单 / 技能选择器 / 目标表单），避免展开状态残留到新会话。
let lastSessionKey: string | null = null;

function closePlusMenu(props: { onRequestUpdate?: () => void }) {
  plusMenuOpen = false;
  skillPickerOpen = false;
  if (plusMenuOutsideCloser) {
    document.removeEventListener("click", plusMenuOutsideCloser);
    plusMenuOutsideCloser = null;
  }
  props.onRequestUpdate?.();
}

function openPlusMenu(props: { onRequestUpdate?: () => void }) {
  plusMenuOpen = true;
  // 延迟一帧注册，避免触发本次打开的 click 立刻把菜单关掉。
  requestAnimationFrame(() => {
    if (!plusMenuOpen || plusMenuOutsideCloser) return;
    plusMenuOutsideCloser = (ev: MouseEvent) => {
      const root = document.querySelector(".chat-plus");
      if (root && !root.contains(ev.target as Node)) {
        closePlusMenu(props);
      }
    };
    document.addEventListener("click", plusMenuOutsideCloser);
  });
  props.onRequestUpdate?.();
}

// / 命令补全状态
let commandSuggestions: CommandEntry[] = [];
let commandIndex = 0;

// 自适应高度（首次挂载时延迟到下一帧，确保 CSS 已应用）。
// lit ref 回调是内联箭头函数，每次渲染 commit 都会重新执行——流式期间每帧
// 重渲染都会调度一次 rAF 布局，而 draft 未变时高度必然不变。用 value+宽度
// 指纹跳过冗余布局（style 类与字体均不变，指纹不变则高度不变）。
function adjustTextareaHeight(el: HTMLTextAreaElement, deferred = false) {
  const apply = () => {
    const fingerprint = `${el.value.length}:${el.clientWidth}`;
    if (el.dataset.hAdjust === fingerprint) {
      return;
    }
    el.dataset.hAdjust = fingerprint;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  if (deferred) {
    requestAnimationFrame(apply);
  } else {
    apply();
  }
}

/**
 * Context Meter — 放在发送按钮左侧，展示当前对话记忆占用。
 * 数据源：
 *   - used = session.totalTokens（最后一次调用的 prompt token 数，gateway 在
 *            turn 结束后持久化）
 *   - max  = session.contextTokens（gateway 按调用时用的模型写入的窗口大小）
 *            缺失时回退到 lookupContextWindow(session.model)，不跨会话信任 currentModel
 * 仅展示「当前会话」占用比例，跨会话独立；模型未知且 used>0 时整体隐藏。
 *
 * 模型切换：用户切完 model 后，该 sessionKey 会被加入 dirtyMeterSessions 集合，
 * 直到下一轮 usage（totalTokens 单调推进）落库才清除——天然 per-session 独立。
 */
function contextMeterText(
  key: string,
  values: { percent: string; used: string; max: string },
) {
  return t(key)
    .replace("{percent}", values.percent)
    .replace("{used}", values.used)
    .replace("{max}", values.max);
}

function renderContextMeter(
  session: GatewaySessionRow | null | undefined,
  dirtySessions: ReadonlySet<string> | undefined,
) {
  if (!session) return nothing;
  const stats = resolveContextMeterStats(session, dirtySessions);
  if (!stats) return nothing;
  const values = {
    percent: String(stats.percent),
    used: stats.used.toLocaleString(),
    max: stats.max.toLocaleString(),
  };
  const label = contextMeterText("chat.contextMeterAria", values);
  const title = contextMeterText("chat.contextMeterHint", values);
  return html`
    <div class="chat-compose__ctx-meter" data-tooltip=${title} data-tooltip-wide="true">
      <div
        class="chat-compose__ctx-meter-bar"
        role="progressbar"
        aria-label=${label}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow=${String(stats.percent)}
      >
        <div class="chat-compose__ctx-meter-fill" style=${`width: ${stats.widthPct}%`}></div>
      </div>
    </div>
  `;
}

function renderCompactionIndicator(status: CompactionIndicatorStatus | null | undefined) {
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
function renderFallbackNotice(notice: FallbackNotice | null | undefined) {
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

function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// 回放点（checkpoint）的触发原因标签，未知原因原样展示
function formatCheckpointReason(reason?: string): string {
  if (!reason) {
    return t("chat.rewind.reasonUnknown");
  }
  const key = `chat.rewind.reason.${reason}`;
  const label = t(key);
  return label === key ? reason : label;
}

// 回放/分支 popover：列出当前会话的回放点，支持回放（restore）与创建分支（branch）
function renderRewindPopover(props: ChatProps) {
  const busyId = props.compactionBusyCheckpointId ?? null;
  // 缓存的 checkpoints 属于别的会话时视为加载中，不把旧会话的回放点展示/暴露给当前会话
  const keyMismatch =
    props.compactionCheckpointsKey != null && props.compactionCheckpointsKey !== props.sessionKey;
  const loading = props.compactionCheckpointsLoading || keyMismatch;
  const checkpoints = keyMismatch ? [] : (props.compactionCheckpoints ?? []);
  return html`
    <div class="chat-compose__rewind-popover">
      <div class="chat-compose__rewind-title">${t("chat.rewind.title")}</div>
      ${loading
        ? html`<div class="chat-compose__rewind-status">${t("chat.loading")}</div>`
        : nothing}
      ${props.compactionCheckpointsError
        ? html`<div class="chat-compose__rewind-status chat-compose__rewind-status--error">
            ${t("chat.rewind.loadFailed")}: ${props.compactionCheckpointsError}
          </div>`
        : nothing}
      ${!loading && !props.compactionCheckpointsError && !checkpoints.length
        ? html`<div class="chat-compose__rewind-status">${t("chat.rewind.empty")}</div>`
        : nothing}
      ${checkpoints.map(
        (cp) => html`
          <div class="chat-compose__rewind-item">
            <div class="chat-compose__rewind-item-meta">
              ${Number.isFinite(cp.createdAt)
                ? html`<span class="chat-compose__rewind-item-time">
                    ${new Date(cp.createdAt).toLocaleString()}
                  </span>`
                : nothing}
              <span class="chat-compose__rewind-item-reason">${formatCheckpointReason(cp.reason)}</span>
              ${typeof cp.tokensBefore === "number"
                ? html`<span class="chat-compose__rewind-item-tokens">
                    ${cp.tokensBefore} → ${typeof cp.tokensAfter === "number" ? cp.tokensAfter : "?"}
                  </span>`
                : nothing}
              ${cp.summary
                ? html`<div class="chat-compose__rewind-item-summary" title=${cp.summary}>${cp.summary}</div>`
                : nothing}
            </div>
            <div class="chat-compose__rewind-item-actions">
              <button
                class="chat-compose__rewind-action"
                type="button"
                ?disabled=${busyId !== null}
                @click=${() => props.onRestoreCheckpoint?.(cp.checkpointId)}
              >
                ${busyId === cp.checkpointId ? icons.loader : nothing}${t("chat.rewind.restore")}
              </button>
              <button
                class="chat-compose__rewind-action"
                type="button"
                ?disabled=${busyId !== null}
                @click=${() => props.onBranchCheckpoint?.(cp.checkpointId)}
              >
                ${busyId === cp.checkpointId ? icons.loader : nothing}${t("chat.rewind.branch")}
              </button>
            </div>
          </div>
        `,
      )}
    </div>
  `;
}

function handlePaste(e: ClipboardEvent, props: ChatProps) {
  if (!props.onAttachmentsChange) return;

  // 图片粘贴：走 dataUrl 内嵌
  const items = e.clipboardData?.items;
  if (items) {
    const imageItems: DataTransferItem[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) imageItems.push(items[i]);
    }
    if (imageItems.length > 0) {
      e.preventDefault();
      for (const item of imageItems) {
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.addEventListener("load", () => {
          const dataUrl = reader.result as string;
          // 函数式更新：基于最新附件列表合并，快速连贴不会互相覆盖
          props.onAttachmentsChange?.((prev) => [...prev, {
            id: generateAttachmentId(), dataUrl, mimeType: file.type,
          }]);
        });
        reader.readAsDataURL(file);
      }
      return;
    }
  }

  // 文件粘贴：从剪贴板读取文件路径（Cmd+C / Ctrl+C 复制的文件）
  // IPC 是异步的，但 preventDefault 必须同步调用——先检查剪贴板是否含文件条目
  const hasFileItems = items && Array.from({ length: items.length }, (_, i) => items[i])
    .some((item) => item.kind === "file");
  if (!hasFileItems) return;
  e.preventDefault();
  const w = window as unknown as Record<string, unknown>;
  const cryoclaw = w.cryoclaw as Record<string, (...args: unknown[]) => Promise<string[]>> | undefined;
  if (!cryoclaw?.readClipboardFilePaths) return;
  cryoclaw.readClipboardFilePaths().then((paths: string[]) => {
    if (!paths?.length) return;
    const additions = paths.map((p: string) => ({
      id: generateAttachmentId(), filePath: p, name: basename(p),
    }));
    // 函数式更新：基于最新附件列表合并，快速连贴不会互相覆盖
    props.onAttachmentsChange?.((prev) => [...prev, ...additions]);
  }).catch(() => {
    // 读取剪贴板文件路径失败时静默忽略（用户可重试粘贴）
  });
}

// 从路径提取文件名
function basename(path: string): string {
  const sep = path.includes("\\") ? "\\" : "/";
  return path.split(sep).pop() || path;
}

function renderAttachmentPreview(props: ChatProps) {
  const attachments = props.attachments ?? [];
  if (attachments.length === 0) {
    return nothing;
  }

  return html`
    <div class="chat-attachments">
      ${attachments.map(
        (att) => html`
          <div class="chat-attachment ${att.filePath && !att.dataUrl ? "chat-attachment--file" : ""}">
            ${
              att.dataUrl
                ? html`<img
                    src=${att.dataUrl}
                    alt=${t("chat.attachmentPreview")}
                    class="chat-attachment__img"
                  />`
                : html`<div class="chat-attachment__file">
                    <span class="chat-attachment__file-icon">${icons.fileText}</span>
                    <span class="chat-attachment__file-name">${att.name || basename(att.filePath ?? "")}</span>
                  </div>`
            }
            <button
              class="chat-attachment__remove"
              type="button"
              aria-label=${t("chat.removeAttachment")}
              @click=${() => {
                const next = (props.attachments ?? []).filter((a) => a.id !== att.id);
                props.onAttachmentsChange?.(next);
              }}
            >
              ${icons.x}
            </button>
          </div>
        `,
      )}
    </div>
  `;
}

// ── 待审批队列（compose 上方；执行权限三态已整合进加号菜单） ──
function renderExecStrip(props: ChatProps) {
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
              <div class="chat-approval-item__cmd ${entry.kind === "exec" ? "mono" : ""}">${label}</div>
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

// ── 目标横幅（compose 上方；窄屏折叠为胶囊） ──
function renderGoalBanner(props: ChatProps) {
  const goal = props.goal;
  if (!goal) {
    return nothing;
  }
  const kind = goalStatusKind(goal.status);
  const tokens = goalTokensLabel(goal);
  const percent = goalTokenPercent(goal);
  const duration = goalSummaryText(goal);
  const active = goal.status === "active";
  return html`
    <div class="chat-goal chat-goal--${kind}" role="status">
      <div class="chat-goal__main">
        <div class="chat-goal__status">${t(goalStatusKey(goal.status))}</div>
        <div class="chat-goal__objective" title=${goal.objective}>${goal.objective}</div>
        <div class="chat-goal__meta">
          <span class="chat-goal__timer">${duration}</span>
          ${tokens ? html`<span class="chat-goal__tokens">${tokens}</span>` : nothing}
        </div>
        ${percent !== null
          ? html`<div class="chat-goal__bar"><div class="chat-goal__bar-fill" style=${`width: ${percent}%`}></div></div>`
          : nothing}
      </div>
      <div class="chat-goal__actions">
        ${active
          ? html`<button class="chat-goal__btn" type="button" @click=${() => props.onGoalCommand?.("/goal pause")}>${t("goal.pause")}</button>`
          : goal.status !== "complete"
            ? html`<button class="chat-goal__btn" type="button" @click=${() => props.onGoalCommand?.("/goal resume")}>${t("goal.resume")}</button>`
            : nothing}
        <button class="chat-goal__btn" type="button" @click=${() => props.onGoalCommand?.("/goal clear")}>${t("goal.clear")}</button>
      </div>
    </div>
  `;
}

// ── 目标表单（加号菜单 → 目标模式） ──
function renderGoalForm(props: ChatProps) {
  if (!goalFormOpen) {
    return nothing;
  }
  return html`
    <div class="chat-goal-form">
      <input
        class="chat-goal-form__input"
        type="text"
        .value=${goalDraft}
        placeholder=${t("goal.placeholder")}
        @input=${(e: Event) => { goalDraft = (e.target as HTMLInputElement).value; }}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter" && goalDraft.trim()) {
            props.onGoalCommand?.(`/goal ${goalDraft.trim()}`);
            goalFormOpen = false;
            goalDraft = "";
            props.onRequestUpdate?.();
          } else if (e.key === "Escape") {
            goalFormOpen = false;
            props.onRequestUpdate?.();
          }
        }}
      />
      <button class="chat-goal-form__submit" type="button" ?disabled=${!goalDraft.trim()} @click=${() => {
        if (!goalDraft.trim()) return;
        props.onGoalCommand?.(`/goal ${goalDraft.trim()}`);
        goalFormOpen = false;
        goalDraft = "";
        props.onRequestUpdate?.();
      }}>${t("goal.start")}</button>
      <button class="chat-goal-form__cancel" type="button" @click=${() => { goalFormOpen = false; props.onRequestUpdate?.(); }}>${t("chat.cancel")}</button>
    </div>
  `;
}

// ── 引用技能子面板（加号菜单 → 引用技能） ──
async function openSkillPicker(props: ChatProps) {
  skillPickerOpen = true;
  if (!skillPickerLoaded && !skillPickerLoading && props.onListSkills) {
    skillPickerLoading = true;
    props.onRequestUpdate?.();
    try {
      skillPickerItems = await props.onListSkills();
      skillPickerLoaded = true;
    } catch {
      skillPickerItems = [];
    } finally {
      skillPickerLoading = false;
    }
  }
  props.onRequestUpdate?.();
}

function insertSkillReference(props: ChatProps, name: string) {
  const mention = `@${name} `;
  const draft = props.draft ?? "";
  const next = draft.trim().length === 0
    ? mention
    : draft.endsWith(" ") || draft.endsWith("\n")
      ? `${draft}${mention}`
      : `${draft} ${mention}`;
  props.onDraftChange(next);
  closePlusMenu(props);
  // 焦点送回输入框，引用完可以接着打字
  requestAnimationFrame(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>(".chat-compose__field textarea");
    textarea?.focus();
  });
}

// 消息引用：构造引用块追加到草稿，并把焦点送回输入框（与「引用技能」同模式）
function handleQuoteMessage(props: ChatProps, text: string) {
  const next = appendQuoteToDraft(props.draft ?? "", text);
  if (next === (props.draft ?? "")) {
    return;
  }
  props.onDraftChange(next);
  requestAnimationFrame(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>(".chat-compose__field textarea");
    textarea?.focus();
  });
}

function renderSkillPicker(props: ChatProps) {
  if (!skillPickerOpen) {
    return nothing;
  }
  return html`
    <div class="chat-plus__skill-picker" @click=${(e: Event) => e.stopPropagation()}>
      <div class="chat-plus__skill-picker-title">${t("chat.plusSkillPickerTitle")}</div>
      ${skillPickerLoading
        ? html`<div class="chat-plus__skill-picker-status">${t("chat.loading")}</div>`
        : skillPickerItems.length === 0
          ? html`<div class="chat-plus__skill-picker-status">${t("chat.plusSkillEmpty")}</div>`
          : skillPickerItems.map((skill) => html`
            <button class="chat-plus__skill-item" type="button"
              @click=${() => insertSkillReference(props, skill.name)}>
              <span class="chat-plus__skill-item-name">${skill.emoji ? `${skill.emoji} ` : nothing}${skill.name}</span>
              ${skill.description
                ? html`<span class="chat-plus__skill-item-desc" title=${skill.description}>${skill.description}</span>`
                : nothing}
            </button>
          `)}
    </div>
  `;
}

// ── 加号菜单（添加文件 / 引用技能 / 目标模式 / 执行权限三态） ──
function renderPlusMenu(props: ChatProps) {
  const openFilePicker = async () => {
    const w = window as unknown as Record<string, unknown>;
    const cryoclaw = w.cryoclaw as Record<string, (...args: unknown[]) => Promise<string[]>> | undefined;
    if (!cryoclaw?.selectFiles) {
      return;
    }
    try {
      const paths = await cryoclaw.selectFiles();
      if (!paths?.length) {
        return;
      }
      const additions = paths.map((p: string) => ({
        id: generateAttachmentId(),
        filePath: p,
        name: p.split(/[/\\]/).pop() || p,
      }));
      // 函数式更新：基于最新附件列表合并，避免闭包旧值覆盖并发新增的附件
      props.onAttachmentsChange?.((prev) => [...prev, ...additions]);
    } catch {
      // 选文件失败（含用户取消外的异常）静默忽略，用户可重试
    }
  };

  const execMode = props.execMode ?? "ask";
  const execModes: Array<["ask" | "auto" | "full", string]> = [
    ["ask", t("chat.execModeAsk")],
    ["auto", t("chat.execModeAuto")],
    ["full", t("chat.execModeApproveAll")],
  ];

  return html`
    <div class="chat-plus">
      <button
        class="chat-compose__tool-btn chat-plus__trigger ${plusMenuOpen ? "chat-plus__trigger--open" : ""}"
        type="button"
        @click=${(e: Event) => {
          e.stopPropagation();
          // 与 thinking popover 对齐：点击菜单外部即关闭（document 级监听，关闭即注销）
          if (plusMenuOpen) {
            closePlusMenu(props);
          } else {
            openPlusMenu(props);
          }
        }}
        data-tooltip=${t("chat.plusMenu")}
        ?disabled=${!props.connected}
        aria-expanded=${plusMenuOpen ? "true" : "false"}
      >
        ${icons.plus}
      </button>
      ${plusMenuOpen
        ? html`
            <div class="chat-plus__menu" @click=${(e: Event) => e.stopPropagation()}>
              <button class="chat-plus__item" type="button" @click=${() => {
                closePlusMenu(props);
                void openFilePicker();
              }}>
                <span class="chat-plus__item-icon">${icons.paperclip}</span>
                <span>${t("chat.plusAttachFile")}</span>
              </button>
              ${props.onListSkills
                ? html`
                  <button class="chat-plus__item ${skillPickerOpen ? "chat-plus__item--active" : ""}" type="button" @click=${() => {
                    if (skillPickerOpen) {
                      skillPickerOpen = false;
                      props.onRequestUpdate?.();
                    } else {
                      void openSkillPicker(props);
                    }
                  }}>
                    <span class="chat-plus__item-icon">${icons.puzzle}</span>
                    <span>${t("chat.plusSkill")}</span>
                  </button>
                `
                : nothing}
              <button class="chat-plus__item" type="button" @click=${() => {
                closePlusMenu(props);
                goalFormOpen = !goalFormOpen;
                goalDraft = props.goal?.objective ?? "";
                props.onRequestUpdate?.();
              }}>
                <span class="chat-plus__item-icon">${icons.brain}</span>
                <span>${t("chat.plusGoal")}</span>
              </button>
              <div class="chat-plus__divider" role="separator"></div>
              <div class="chat-plus__section">${t("chat.execMode")}</div>
              ${execModes.map(([value, label]) => html`
                <button
                  class="chat-plus__item chat-plus__item--mode ${execMode === value ? "chat-plus__item--active" : ""}"
                  type="button"
                  role="menuitemradio"
                  aria-checked=${execMode === value ? "true" : "false"}
                  @click=${() => {
                    props.onExecModeChange?.(value);
                    closePlusMenu(props);
                  }}
                >
                  <span class="chat-plus__item-icon">${execMode === value ? icons.check : nothing}</span>
                  <span>${label}</span>
                </button>
              `)}
            </div>
            ${renderSkillPicker(props)}
          `
        : nothing}
    </div>
  `;
}

function refreshCommandSuggestions(props: ChatProps, draft: string) {
  const m = /^\/(\S*)$/.exec(draft);
  if (!m || !props.commands?.length) {
    commandSuggestions = [];
    commandIndex = 0;
    return;
  }
  commandSuggestions = filterCommands(props.commands, m[1] ?? "");
  commandIndex = 0;
}

// 插入选中命令到 draft（光标在末尾）
function insertCommand(props: ChatProps, name: string) {
  // trimStart 避免 '/cmd arg' 拼接出双空格；无参数时保留一个尾随空格便于继续输入
  const rest = props.draft.replace(/^\/\S*/, "").trimStart();
  const next = rest ? `/${name} ${rest}` : `/${name} `;
  props.onDraftChange(next);
  commandSuggestions = [];
  commandIndex = 0;
}

// 渲染 / 命令建议浮层
function renderCommandSuggestions(props: ChatProps) {
  if (commandSuggestions.length === 0) {
    return nothing;
  }
  return html`
    <div class="chat-cmd-suggest" role="listbox">
      ${commandSuggestions.map((cmdEntry, idx) => html`
        <button
          class="chat-cmd-suggest__item ${idx === commandIndex ? "chat-cmd-suggest__item--active" : ""}"
          type="button"
          role="option"
          ?aria-selected=${idx === commandIndex}
          @mousedown=${(e: Event) => {
            e.preventDefault();
            insertCommand(props, cmdEntry.name);
            props.onRequestUpdate?.();
          }}
        >
          <span class="chat-cmd-suggest__name">/${cmdEntry.name}</span>
          <span class="chat-cmd-suggest__desc">${resolveCommandDescription(cmdEntry)}</span>
          ${cmdEntry.acceptsArgs ? html`<span class="chat-cmd-suggest__args">…</span>` : nothing}
        </button>
      `)}
    </div>
  `;
}

// 对话页全局快捷键（R14）：Ctrl+N 新建对话 / Ctrl+L 聚焦输入框。
// document 级监听，模块级持有最新 props 引用，避免闭包旧值（同 plusMenuOutsideCloser 思路）。
let chatShortcutProps: ChatProps | null = null;
let chatShortcutHandler: ((ev: KeyboardEvent) => void) | null = null;

function ensureChatShortcuts(props: ChatProps) {
  chatShortcutProps = props;
  if (chatShortcutHandler) return;
  chatShortcutHandler = (ev: KeyboardEvent) => {
    if (!ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return;
    const key = ev.key.toLowerCase();
    if (key === "n") {
      ev.preventDefault();
      chatShortcutProps?.onNewSession?.();
    } else if (key === "l") {
      ev.preventDefault();
      document.querySelector<HTMLTextAreaElement>(".chat-compose__field textarea")?.focus();
    }
  };
  document.addEventListener("keydown", chatShortcutHandler);
}

export function renderChat(props: ChatProps) {
  ensureChatShortcuts(props);
  if (props.sessionKey !== lastSessionKey) {
    lastSessionKey = props.sessionKey;
    closePlusMenu(props);
    goalFormOpen = false;
    goalDraft = "";
    queueEditingId = null;
  }
  const canCompose = props.connected;
  const { isBusy, showStop } = computeStopButtonVisible(props);
  const activeSession = props.sessions?.sessions?.find((row) => row.key === props.sessionKey);
  const reasoningLevel = activeSession?.reasoningLevel ?? "off";
  const thinkingActive = Boolean((props.thinkingToggleLevel && props.thinkingToggleLevel !== "off") || (props.thinkingLevel && props.thinkingLevel !== "off"));
  const showReasoning = Boolean(props.showThinking && (reasoningLevel !== "off" || thinkingActive));
  const assistantIdentity = {
    name: props.assistantName,
    avatar: props.assistantAvatar ?? props.assistantAvatarUrl ?? null,
  };

  const totalHistory = Array.isArray(props.messages) ? props.messages.length : 0;
  const isHydrating = props.visibleHistoryCount > 0 && props.visibleHistoryCount < totalHistory;

  const hasAttachments = (props.attachments?.length ?? 0) > 0;
  const composePlaceholder = !props.connected
    ? t("chat.placeholder.disconnected")
    : isBusy
      ? t("chat.placeholder.busy")
      : hasAttachments
        ? t("chat.placeholder.image")
        : t("chat.placeholder");

  const splitRatio = props.splitRatio ?? 0.6;
  const sidebarOpen = Boolean(props.sidebarOpen && props.onCloseSidebar);
  const chatItems = buildChatItemsMemoized(props);
  // 本轮改动文件列表：按组扫描 tool cards 派生（详见 chat/file-changes.ts 头注）
  const fileChangesByGroup = computeSessionFileChangesMemoized(chatItems);
  // 当前正在执行的工具（有 call 无 result），用于流式状态行的阶段提示
  const activeToolName = resolveActiveToolName(
    Array.isArray(props.toolMessages) ? props.toolMessages : [],
  );
  // 空会话（无历史/工具/流式且不在加载）：线程区显示居中 hero + starter prompts
  const isEmptySession = !props.loading && chatItems.length === 0;
  // starter prompt chips：点击即填入并发送（与 onGoalCommand 同样的同步「先改草稿再发送」时序）
  const starterKeys = ["chat.starter1", "chat.starter2", "chat.starter3", "chat.starter4"];
  const sendStarter = (text: string) => {
    if (!props.connected) return;
    props.onDraftChange(text);
    props.onSend();
  };
  const thread = html`
    <div
      class="chat-thread ${isEmptySession ? "chat-thread--empty" : ""}"
      role="log"
      aria-live="polite"
      @scroll=${props.onChatScroll}
      @click=${(e: Event) => {
        // file-changes 面板「在 git 中查看」链接（P4）：切到 git 面板视图
        const gitLink = (e.target as HTMLElement).closest(".chat-git-view-link");
        if (gitLink) {
          e.preventDefault();
          props.onOpenGitView?.();
          return;
        }
        const link = (e.target as HTMLElement).closest(".chat-path-link");
        if (!link) {
          return;
        }
        e.preventDefault();
        const path = (link as HTMLElement).dataset.path;
        if (path) {
          const w = window as unknown as Record<string, unknown>;
          const cryoclaw = w.cryoclaw as Record<string, (p: string) => unknown> | undefined;
          const result = cryoclaw?.openPath?.(path);
          // 主进程对不支持的扩展名会 reject：补 catch 并 toast 提示，避免静默失败
          if (result && typeof (result as Promise<unknown>).catch === "function") {
            (result as Promise<unknown>).catch(() => {
              props.onShowToast?.(t("chat.openPathFailed"));
            });
          }
        }
      }}
    >
      ${
        props.loading
          ? html`
              <div class="muted">${t("chat.loading")}</div>
            `
          : nothing
      }
      ${isEmptySession
        ? html`
          <div class="chat-hero">
            <div class="chat-hero__title">${t("chat.emptyTitle")}</div>
            <div class="chat-hero__subtitle">${t("chat.emptySubtitle")}</div>
            <div class="chat-hero__chips">
              ${starterKeys.map(
                (key) => html`
                  <button
                    class="chat-hero__chip"
                    type="button"
                    ?disabled=${!props.connected}
                    @click=${() => sendStarter(t(key))}
                  >
                    ${t(key)}
                  </button>
                `,
              )}
            </div>
          </div>
        `
        : nothing}
      ${repeat(
        chatItems,
        (item) => item.key,
        (item) => {
          if (item.kind === "divider") {
            return html`
              <div class="chat-divider" role="separator" data-ts=${String(item.timestamp)}>
                <span class="chat-divider__line"></span>
                <span class="chat-divider__label">${item.label}</span>
                <span class="chat-divider__line"></span>
              </div>
            `;
          }

          if (item.kind === "reading-indicator") {
            return renderReadingIndicatorGroup(assistantIdentity, activeToolName, item.subagentWaiting);
          }

          if (item.kind === "subagent-cards") {
            return renderSubagentCards(item.cards);
          }

          if (item.kind === "stream") {
            return renderStreamingGroup(
              item.text,
              item.startedAt,
              props.onOpenSidebar,
              assistantIdentity,
            );
          }

          if (item.kind === "group") {
            return renderMessageGroup(item, {
              onOpenSidebar: props.onOpenSidebar,
              showReasoning,
              assistantName: props.assistantName,
              assistantAvatar: assistantIdentity.avatar,
              isHydrating,
              fileChanges: fileChangesByGroup.get(item.key),
              gitAvailable: props.gitAvailable,
              onQuoteMessage: (text) => handleQuoteMessage(props, text),
              onResendError: props.onResendError,
            });
          }

          return nothing;
        },
      )}
    </div>
  `;

  return html`
    <section class="card chat">
      ${props.error
        ? html`<div class="callout danger chat-error-callout">
            <span class="chat-error-callout__icon" aria-hidden="true">${icons.warning}</span>
            <span>${props.error}</span>
          </div>`
        : nothing}

      <div
        class="chat-split-container ${sidebarOpen ? "chat-split-container--open" : ""}"
      >
        <div
          class="chat-main"
          style="flex: ${sidebarOpen ? `0 0 ${splitRatio * 100}%` : "1 1 100%"}"
        >
          ${thread}
        </div>

        ${
          sidebarOpen
            ? html`
              <resizable-divider
                .splitRatio=${splitRatio}
                @resize=${(e: CustomEvent) => props.onSplitRatioChange?.(e.detail.splitRatio)}
              ></resizable-divider>
              <div class="chat-sidebar">
                ${renderMarkdownSidebar({
                  content: props.sidebarContent ?? null,
                  error: props.sidebarError ?? null,
                  onClose: props.onCloseSidebar!,
                  onViewRawText: () => {
                    if (!props.sidebarContent || !props.onOpenSidebar) {
                      return;
                    }
                    props.onOpenSidebar(`\`\`\`\n${props.sidebarContent}\n\`\`\``);
                  },
                })}
              </div>
            `
            : nothing
        }
      </div>

      ${
        props.queue.length
          ? html`
            <div class="chat-queue" role="status" aria-live="polite">
              <div class="chat-queue__title">${t("chat.queued")} (${props.queue.length})</div>
              <div class="chat-queue__list">
                ${props.queue.map((item) => {
                  const editing = queueEditingId === item.id;
                  const saveEdit = (text: string) => {
                    queueEditingId = null;
                    props.onQueueEdit?.(item.id, text);
                  };
                  const cancelEdit = () => {
                    queueEditingId = null;
                    props.onRequestUpdate?.();
                  };
                  return html`
                    <div class="chat-queue__item">
                      ${
                        editing
                          ? html`
                            <textarea
                              class="chat-queue__edit-input"
                              rows="2"
                              .value=${String(item.text ?? "")}
                              ${ref((el) => {
                                if (el && document.activeElement !== el) {
                                  (el as HTMLTextAreaElement).focus();
                                }
                              })}
                              @keydown=${(e: KeyboardEvent) => {
                                if (e.key === "Escape") {
                                  e.preventDefault();
                                  cancelEdit();
                                } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                                  e.preventDefault();
                                  saveEdit((e.currentTarget as HTMLTextAreaElement).value);
                                }
                              }}
                            ></textarea>
                            <div class="chat-queue__actions">
                              <button
                                class="btn chat-queue__action"
                                type="button"
                                @click=${(e: Event) => {
                                  const root = (e.currentTarget as HTMLElement).closest(".chat-queue__item");
                                  const input = root?.querySelector(".chat-queue__edit-input");
                                  saveEdit((input as HTMLTextAreaElement | null)?.value ?? "");
                                }}
                              >
                                ${t("chat.queueSave")}
                              </button>
                              <button
                                class="btn chat-queue__action"
                                type="button"
                                @click=${cancelEdit}
                              >
                                ${t("chat.cancel")}
                              </button>
                            </div>
                          `
                          : html`
                            <div class="chat-queue__text">
                              ${
                                item.text ||
                                (item.attachments?.length ? `${t("chat.image")} (${item.attachments.length})` : "")
                              }
                            </div>
                            <div class="chat-queue__actions">
                              <button
                                class="btn chat-queue__action"
                                type="button"
                                aria-label=${t("chat.queueEdit")}
                                data-tooltip=${t("chat.queueEdit")}
                                ?disabled=${!props.onQueueEdit}
                                @click=${() => {
                                  queueEditingId = item.id;
                                  props.onRequestUpdate?.();
                                }}
                              >
                                ${icons.edit}
                              </button>
                              <button
                                class="btn chat-queue__action"
                                type="button"
                                aria-label=${t("chat.queueSendNow")}
                                data-tooltip=${t("chat.queueSendNow")}
                                ?disabled=${!props.connected || !props.onQueueSendNow}
                                @click=${() => props.onQueueSendNow?.(item.id)}
                              >
                                ${icons.send}
                              </button>
                              <button
                                class="btn chat-queue__remove"
                                type="button"
                                aria-label=${t("chat.removeQueuedMessage")}
                                @click=${() => props.onQueueRemove(item.id)}
                              >
                                ${icons.x}
                              </button>
                            </div>
                          `
                      }
                    </div>
                  `;
                })}
              </div>
            </div>
          `
          : nothing
      }

      ${renderCompactionIndicator(props.compactionStatus)}
      ${renderFallbackNotice(props.fallbackNotice)}

      ${renderPlanPanel(props.plan ?? null, {
        sessionKey: props.sessionKey,
        onDismiss: props.onDismissPlan,
      })}

      ${
        props.showNewMessages
          ? html`
            <button
              class="btn chat-new-messages"
              type="button"
              @click=${props.onScrollToBottom}
            >
              ${icons.arrowDown}
            </button>
          `
          : nothing
      }

      ${renderExecStrip(props)}
      ${renderGoalBanner(props)}
      ${renderGoalForm(props)}

      <div class="chat-compose">
        ${renderAttachmentPreview(props)}
        <div class="field chat-compose__field">
          <span>${t("chat.messageLabel")}</span>
          <textarea
            ${ref((el) => el && adjustTextareaHeight(el as HTMLTextAreaElement, true))}
            .value=${props.draft}
            dir=${detectTextDirection(props.draft)}
            ?disabled=${!props.connected}
            @keydown=${(e: KeyboardEvent) => {
              if (commandSuggestions.length > 0) {
                if (e.key === "Tab" || e.key === "Enter") {
                  e.preventDefault();
                  const pick = commandSuggestions[commandIndex];
                  if (pick) {
                    insertCommand(props, pick.name);
                    props.onRequestUpdate?.();
                  }
                  return;
                }
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  commandIndex = (commandIndex + 1) % commandSuggestions.length;
                  props.onRequestUpdate?.();
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  commandIndex = (commandIndex - 1 + commandSuggestions.length) % commandSuggestions.length;
                  props.onRequestUpdate?.();
                  return;
                }
                if (e.key === "Escape") {
                  commandSuggestions = [];
                  props.onRequestUpdate?.();
                  return;
                }
              }
              if (e.key !== "Enter") {
                return;
              }
              if (e.isComposing || e.keyCode === 229) {
                return;
              }
              if (e.shiftKey) {
                return;
              } // Allow Shift+Enter for line breaks
              if (!props.connected) {
                return;
              }
              e.preventDefault();
              if (canCompose) {
                props.onSend();
              }
            }}
            @input=${(e: Event) => {
              const target = e.target as HTMLTextAreaElement;
              adjustTextareaHeight(target);
              props.onDraftChange(target.value);
              refreshCommandSuggestions(props, target.value);
            }}
            @paste=${(e: ClipboardEvent) => handlePaste(e, props)}
            placeholder=${composePlaceholder}
          ></textarea>
          ${renderCommandSuggestions(props)}
        <div class="chat-compose__toolbar">
          <div class="chat-compose__toolbar-left">
            ${renderPlusMenu(props)}
            ${props.thinkingToggleLevels && props.thinkingToggleLevels.length > 0
              ? html`
                  <div class="chat-compose__thinking">
                    <button
                      class="chat-compose__thinking-toggle ${props.thinkingToggleLevel && props.thinkingToggleLevel !== "off" ? "chat-compose__thinking-toggle--active" : ""}"
                      type="button"
                      data-tooltip=${t("chat.thinkingPicker")}
                      aria-label=${t("chat.thinkingPicker")}
                      ?disabled=${!props.connected}
                      @click=${(e: Event) => {
                        e.stopPropagation();
                        // 二元模型（仅 关/开）：单击直接切换；多档模型：单击展开档位 popover
                        if (props.isBinaryThinking) {
                          props.onThinkingToggle?.();
                          return;
                        }
                        const el = (e.currentTarget as HTMLElement).closest(".chat-compose__thinking") as HTMLElement;
                        const popover = el?.querySelector(".chat-compose__thinking-popover") as HTMLElement | null;
                        if (!popover) return;
                        const isOpen = popover.classList.contains("chat-compose__thinking-popover--open");
                        if (isOpen) {
                          popover.classList.remove("chat-compose__thinking-popover--open");
                        } else {
                          popover.classList.add("chat-compose__thinking-popover--open");
                          const close = (ev: MouseEvent) => {
                            if (!el.contains(ev.target as Node)) {
                              popover.classList.remove("chat-compose__thinking-popover--open");
                              document.removeEventListener("click", close);
                            }
                          };
                          requestAnimationFrame(() => {
                            document.addEventListener("click", close);
                          });
                        }
                      }}
                    >
                      ${icons.brain}
                      <span class="chat-compose__thinking-label">${thinkingLevelLabel(props.thinkingToggleLevel ?? "off")}</span>
                    </button>
                    ${!props.isBinaryThinking
                      ? html`<div class="chat-compose__thinking-popover">
                          ${props.thinkingToggleLevels!.map(level => html`
                            <button
                              class="chat-compose__thinking-option ${level === (props.thinkingToggleLevel ?? "off") ? "chat-compose__thinking-option--selected" : ""}"
                              type="button"
                              @click=${(e: Event) => {
                                e.stopPropagation();
                                props.onThinkingLevelChange?.(level);
                                const popover = (e.currentTarget as HTMLElement).closest(".chat-compose__thinking-popover") as HTMLElement;
                                if (popover) popover.classList.remove("chat-compose__thinking-popover--open");
                              }}
                            >
                              <span class="chat-compose__thinking-option-check">${level === (props.thinkingToggleLevel ?? "off") ? icons.check : nothing}</span>
                              ${thinkingLevelLabel(level)}
                            </button>
                          `)}
                        </div>`
                      : nothing
                    }
                  </div>
                `
              : nothing
            }
            ${props.configuredModels && props.configuredModels.length >= 2
              ? html`
                <select
                  class="chat-compose__model-select"
                  .value=${props.currentModel ?? ""}
                  @change=${(e: Event) => {
                    const val = (e.target as HTMLSelectElement).value;
                    props.onModelChange?.(val);
                  }}
                  ?disabled=${!props.connected}
                >
                  ${renderConfiguredModelOptions(props.configuredModels, loadModelOrg(), props.currentModel ?? undefined, true)}
                </select>
              `
              : props.configuredModels && props.configuredModels.length === 1
                ? html`
                  <select class="chat-compose__model-select" disabled>
                    <option selected>${props.configuredModels[0].name}</option>
                  </select>
                `
                : nothing
            }
            <div class="chat-compose__rewind">
              <button
                class="chat-compose__tool-btn"
                type="button"
                data-tooltip=${t("chat.rewind.tooltip")}
                aria-label=${t("chat.rewind.tooltip")}
                ?disabled=${!props.connected}
                @click=${(e: Event) => {
                  e.stopPropagation();
                  const el = (e.currentTarget as HTMLElement).closest(".chat-compose__rewind") as HTMLElement;
                  const popover = el.querySelector(".chat-compose__rewind-popover") as HTMLElement | null;
                  if (!popover) return;
                  const isOpen = popover.classList.contains("chat-compose__rewind-popover--open");
                  if (isOpen) {
                    popover.classList.remove("chat-compose__rewind-popover--open");
                  } else {
                    popover.classList.add("chat-compose__rewind-popover--open");
                    // 打开时拉取最新回放点列表
                    props.onOpenCompactionCheckpoints?.();
                    const close = (ev: MouseEvent) => {
                      if (!el.contains(ev.target as Node)) {
                        popover.classList.remove("chat-compose__rewind-popover--open");
                        document.removeEventListener("click", close);
                      }
                    };
                    requestAnimationFrame(() => {
                      document.addEventListener("click", close);
                    });
                  }
                }}
              >
                ${icons.history}
              </button>
              ${renderRewindPopover(props)}
            </div>
          </div>
          <div class="chat-compose__toolbar-right">
            ${renderContextMeter(activeSession, props.dirtyMeterSessions)}
            ${
              // busy 时停止键与发送键并存（kimi web UI 契约）：发送=入队，不再被停止键替换
              showStop
                ? html`<button
                    class="chat-compose__send-btn"
                    ?disabled=${!props.connected}
                    @click=${props.onAbort}
                    data-tooltip=${t("chat.stop")}
                  >${icons.stop}</button>`
                : nothing
            }
            <button
              class="chat-compose__send-btn"
              ?disabled=${!props.connected}
              @click=${props.onSend}
              data-tooltip=${isBusy ? t("chat.sendEnqueue") : t("chat.send")}
            >${icons.arrowUp}</button>
          </div>
        </div>
        </div>
      </div>
    </section>
  `;
}

const CHAT_HISTORY_RENDER_LIMIT = 200;

// R23：子代理等待状态卡（主 run 等待子代理期间的进度反馈；终态短暂定格）
function subagentStatusLabel(card: SubagentCard): string {
  if (card.active) {
    return t("chat.subagent.running");
  }
  if (isFailedSubagentStatus(card.status)) {
    if (card.status === "cancelled") return t("chat.subagent.cancelled");
    if (card.status === "timed_out") return t("chat.subagent.timeout");
    return t("chat.subagent.failed");
  }
  return t("chat.subagent.done");
}

function renderSubagentCards(cards: SubagentCard[]) {
  return html`
    <div class="chat-subagent-cards" role="status" aria-live="polite">
      ${repeat(
        cards,
        (card) => card.id,
        (card) => html`
          <div
            class="chat-subagent-card ${card.active
              ? "chat-subagent-card--active"
              : isFailedSubagentStatus(card.status)
                ? "chat-subagent-card--failed"
                : "chat-subagent-card--done"}"
          >
            <span class="chat-subagent-card__pulse" aria-hidden="true"></span>
            <span class="chat-subagent-card__body">
              <span class="chat-subagent-card__title">${card.title}</span>
              <span class="chat-subagent-card__status">${subagentStatusLabel(card)}</span>
              ${card.progress
                ? html`<span class="chat-subagent-card__progress">${card.progress}</span>`
                : nothing}
            </span>
          </div>
        `,
      )}
    </div>
  `;
}

// 分组用 role：tool 和 assistant 归为同一组，共享 avatar 和 footer
function groupingRole(role: string): string {
  const r = normalizeRoleForGrouping(role);
  return r === "tool" ? "assistant" : r;
}

function groupMessages(items: ChatItem[]): Array<ChatItem | MessageGroup> {
  const result: Array<ChatItem | MessageGroup> = [];
  let currentGroup: MessageGroup | null = null;

  for (const item of items) {
    if (item.kind !== "message") {
      if (currentGroup) {
        result.push(currentGroup);
        currentGroup = null;
      }
      result.push(item);
      continue;
    }

    const normalized = normalizeMessage(item.message);
    const role = normalizeRoleForGrouping(normalized.role);
    const gRole = groupingRole(role);
    const timestamp = normalized.timestamp || Date.now();

    if (!currentGroup || groupingRole(currentGroup.role) !== gRole) {
      if (currentGroup) {
        result.push(currentGroup);
      }
      currentGroup = {
        kind: "group",
        key: `group:${gRole}:${item.key}`,
        role: gRole,
        messages: [{ message: item.message, key: item.key }],
        timestamp,
        isStreaming: false,
      };
    } else {
      currentGroup.messages.push({ message: item.message, key: item.key });
    }
  }

  if (currentGroup) {
    result.push(currentGroup);
  }
  return result;
}

function buildChatItems(props: ChatProps): Array<ChatItem | MessageGroup> {
  const items: ChatItem[] = [];
  const history = Array.isArray(props.messages) ? props.messages : [];
  const tools = Array.isArray(props.toolMessages) ? props.toolMessages : [];
  // R23：主 run 活跃时投影当前会话的子代理任务为等待状态卡（跨会话过滤在选择函数内）
  const subagentCards = props.runActive
    ? selectSubagentCards(props.tasks as Parameters<typeof selectSubagentCards>[0], props.sessionKey)
    : [];
  const visibleHistoryCount =
    props.visibleHistoryCount > 0
      ? Math.min(props.visibleHistoryCount, CHAT_HISTORY_RENDER_LIMIT, history.length)
      : Math.min(history.length, CHAT_HISTORY_RENDER_LIMIT);
  const historyStart = Math.max(0, history.length - visibleHistoryCount);
  if (historyStart > 0) {
    items.push({
      kind: "message",
      key: "chat:history:notice",
      message: {
        role: "system",
        content: t("chat.historyTruncated")
          .replace("{n}", String(visibleHistoryCount))
          .replace("{m}", String(historyStart)),
        timestamp: Date.now(),
      },
    });
  }
  for (let i = historyStart; i < history.length; i++) {
    const msg = history[i];
    const normalized = normalizeMessage(msg);
    const raw = msg as Record<string, unknown>;
    const marker = raw.__openclaw as Record<string, unknown> | undefined;
    if (marker && marker.kind === "compaction") {
      items.push({
        kind: "divider",
        key:
          typeof marker.id === "string"
            ? `divider:compaction:${marker.id}`
            : `divider:compaction:${normalized.timestamp}:${i}`,
        label: t("chat.compaction"),
        timestamp: normalized.timestamp ?? Date.now(),
      });
      continue;
    }

    items.push({
      kind: "message",
      key: messageKey(msg, i),
      message: msg,
    });
  }
  // toolMessages 本身是摊平的时间线（由 app-tool-stream.ts::syncToolStreamMessages 构造）：
  // 依次包含 leadingSegment 文本 / tool call / tool result，作为普通 message 追加即可，
  // groupMessages 会按 role 自动分组成和 history 一致的 "assistant 文本+call → toolResult" 节奏。
  // 工具调用/结果默认显示（渲染层折叠成 summary，点击展开），不依赖 showThinking 开关；
  // showThinking 只控制思考内容的展示。
  for (let i = 0; i < tools.length; i++) {
    items.push({
      kind: "message",
      // tool 消息 key 用固定命名空间基数，不与 history.length 耦合：
      // buildToolCallMessage/leadingSegment 消息无顶层 toolCallId/messageId，
      // 走 messageKey 的 index 兑底分支，若用动态偏移，run 期间 chatMessages
      // 追加（乐观 user 消息/错误卡）会让全部 tool 卡片 key 平移 → lit repeat
      // 整批重建（hljs 重高亮、details 折叠态丢失）。history 渲染上限远小于
      // 该基数，两个命名空间不会撞车。
      key: messageKey(tools[i], i + 1_000_000_000),
      message: tools[i],
    });
  }

  if (props.stream !== null) {
    const key = `stream:${props.sessionKey}:${props.streamStartedAt ?? "live"}`;
    if (props.stream.trim().length > 0) {
      items.push({
        kind: "stream",
        key,
        text: props.stream,
        startedAt: props.streamStartedAt ?? Date.now(),
      });
    } else {
      items.push({ kind: "reading-indicator", key, subagentWaiting: subagentCards.some((c) => c.active) });
    }
  }

  // R23：子代理等待状态卡置于时间线末尾（流式气泡之后），终态定格后由刷新自然移除
  if (subagentCards.length > 0) {
    items.push({
      kind: "subagent-cards",
      key: `subagent:${props.sessionKey}`,
      cards: subagentCards,
    });
  }

  return groupMessages(items);
}

// ── 派生计算 memo（R5 性能优化）──────────────────────────────────
// renderChat 每次 Lit 更新都会跑 buildChatItems + computeSessionFileChanges，
// 但绝大多数更新（draft 敲击、连接状态、计数器）messages/toolMessages 数组
// 引用不变（状态层一律重赋值、从不原地改，见 controllers/chat.ts /
// app-tool-stream.ts）。按数组引用 + 相关标量浅比较做 memo，全部相同直接复用。
type ChatItemsMemo = {
  messages: unknown[];
  toolMessages: unknown[];
  tasks: unknown[] | undefined;
  runActive: boolean;
  visibleHistoryCount: number;
  stream: string | null;
  streamStartedAt: number | null;
  sessionKey: string;
  locale: string;
  result: Array<ChatItem | MessageGroup>;
};
let chatItemsMemo: ChatItemsMemo | null = null;

export function buildChatItemsMemoized(props: ChatProps): Array<ChatItem | MessageGroup> {
  const prev = chatItemsMemo;
  if (
    prev &&
    prev.messages === props.messages &&
    prev.toolMessages === props.toolMessages &&
    prev.tasks === props.tasks &&
    prev.runActive === Boolean(props.runActive) &&
    prev.visibleHistoryCount === props.visibleHistoryCount &&
    prev.stream === props.stream &&
    prev.streamStartedAt === props.streamStartedAt &&
    prev.sessionKey === props.sessionKey &&
    prev.locale === getLocale()
  ) {
    return prev.result;
  }
  const result = buildChatItems(props);
  chatItemsMemo = {
    messages: props.messages,
    toolMessages: props.toolMessages,
    tasks: props.tasks,
    runActive: Boolean(props.runActive),
    visibleHistoryCount: props.visibleHistoryCount,
    stream: props.stream,
    streamStartedAt: props.streamStartedAt,
    sessionKey: props.sessionKey,
    locale: getLocale(),
    result,
  };
  return result;
}

// fileChanges 按 chatItems 数组引用 memo：buildChatItems 命中 memo 时此处也直接复用。
let fileChangesMemo: {
  chatItems: Array<ChatItem | MessageGroup>;
  result: Map<string, FileChange[]>;
} | null = null;

export function computeSessionFileChangesMemoized(
  chatItems: Array<ChatItem | MessageGroup>,
): Map<string, FileChange[]> {
  if (fileChangesMemo && fileChangesMemo.chatItems === chatItems) {
    return fileChangesMemo.result;
  }
  const result = computeSessionFileChanges(
    chatItems.filter((item): item is MessageGroup => item.kind === "group"),
  );
  fileChangesMemo = { chatItems, result };
  return result;
}

function messageKey(message: unknown, index: number): string {
  const m = message as Record<string, unknown>;
  const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
  if (toolCallId) {
    return `tool:${toolCallId}`;
  }
  const id = typeof m.id === "string" ? m.id : "";
  if (id) {
    return `msg:${id}`;
  }
  const messageId = typeof m.messageId === "string" ? m.messageId : "";
  if (messageId) {
    return `msg:${messageId}`;
  }
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : null;
  const role = typeof m.role === "string" ? m.role : "unknown";
  if (timestamp != null) {
    return `msg:${role}:${timestamp}:${index}`;
  }
  return `msg:${role}:${index}`;
}
