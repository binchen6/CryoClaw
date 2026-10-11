import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { SessionsListResult } from "../types.ts";
import type { ChatAttachment, ChatQueueItem, ConfiguredModel } from "../ui-types.ts";
import { icons } from "../icons.ts";
import { getLocale, t } from "../i18n.ts";
import { renderMarkdownSidebar } from "./markdown-sidebar.ts";
import type { CommandEntry, ExecApprovalRequest } from "../types.ts";
import type { SessionGoal } from "../types.ts";
import "../components/oc-resizable-divider.ts";
// 流式气泡独立组件（R41 Task 10）：chatStream 高频变化只命中组件自身重渲染，
// 历史列表 memo 不再被每帧 invalidate（接线见 renderChat 线程尾部 <oc-chat-stream>）
import "../components/oc-chat-stream.ts";
// 历史消息/工具时间线列表独立组件（R41 Task 11）：草稿敲击/连接态等高频更新不再重求值这棵最重子树，
// 历史 memo 调用点也随之移入组件（接线见 renderChat 线程内 hero 与 <oc-chat-stream> 之间）
import "../components/oc-chat-history.ts";
import { computeStopButtonVisible } from "./chat-stop-button-gate.ts";
import { resolveModelSelectKey } from "../controllers/models.ts";
import { resolveActiveToolName } from "../chat/tool-summary.ts";
import { appendQuoteToDraft } from "../chat/quote-text.ts";
import type { SessionBranch } from "../controllers/session-branches.ts";
import { isFailedSubagentStatus, selectSubagentCards, type SubagentCard } from "../chat/subagent-status.ts";
import { isStreamTextDuplicatedInHistory } from "../chat/stream-bubble-guard.ts";
import { selectPendingQuestions, type QuestionPrompt } from "../chat/question-cards.ts";
import { renderQuestionCards } from "./question-card.ts";
import { renderPlanPanel } from "./plan-panel.ts";
import type { PlanStreamState } from "../plan-stream.ts";
import { renderProgressCard } from "./progress-card.ts";
import type { ProgressCardState } from "../controllers/progress-card.ts";
import type { FallbackNotice } from "../app-tool-stream.ts";
import type { BoardState } from "../controllers/board.ts";
import type { GatewayConnPhase, GatewayProgressInfo } from "../gateway-connection.ts";
// compose 区 / compose 上方面板带 / 待发送队列：纯渲染模块（R2b 拆分，对齐
// question-cards/progress-card 拆出范式；本文件保留线程装配与消息级交互）
import {
  renderGatewayCallout,
  renderCompactionIndicator,
  renderFallbackNotice,
  renderBoardPanel,
  renderExecStrip,
  type CompactionIndicatorStatus,
} from "./chat-panels.ts";
import { renderQueueStrip, resetQueueStrip } from "./chat-queue.ts";
import {
  renderCompose,
  renderGoalBanner,
  renderGoalForm,
  resetComposeTransient,
} from "./chat-compose.ts";

// Gateway 连接状态（connected 为 null）——对话页顶部 callout / 占位文案据此出
// 三态友好提示（见 gateway-connection.ts）
export type GatewayConnectionProps = {
  phase: GatewayConnPhase;
  progress: GatewayProgressInfo | null;
} | null;

export type ChatProps = {
  sessionKey: string;
  onSessionKeyChange: (next: string) => void;
  thinkingLevel: string | null;
  showThinking: boolean;
  loading: boolean;
  sending: boolean;
  canAbort?: boolean;
  // 中止请求在途：Stop 按钮禁用（防重复 chat.abort），保持可见直到终态
  abortPending?: boolean;
  compactionStatus?: CompactionIndicatorStatus | null;
  // 模型 fallback 提示（lifecycle 事件驱动，5s 自动消失）
  fallbackNotice?: FallbackNotice | null;
  // 计划悬浮面板（update_plan 工具事件驱动，独立于 toolStream）
  plan?: PlanStreamState | null;
  onDismissPlan?: () => void;
  // Progress Card（内核 progressCard.* 每会话一卡，compose 上方浮卡）
  progressCard?: ProgressCardState | null;
  progressCardCollapsed?: boolean;
  // R89 Board（会话仪表盘，内核 board.get + board.changed）：会话有 board 时出面板
  board?: BoardState | null;
  onToggleProgressCardCollapse?: () => void;
  onDismissProgressCard?: () => void;
  messages: unknown[];
  visibleHistoryCount: number;
  toolMessages: unknown[];
  // R23：任务列表与主 run 活跃标记（子代理等待状态卡投影用，引用稳定供 memo 比较）
  tasks?: unknown[];
  runActive?: boolean;
  // R61：内核问答卡片（ask_user）——pending 问题按当前会话过滤后出卡；resolve 回调
  questionPrompts?: QuestionPrompt[];
  onResolveQuestion?: (id: string, answers: Record<string, string[]> | null) => void;
  stream: string | null;
  // R88 思考过程流式 / 中途解说流式（agent 事件驱动，run 终态清空）
  thinkingStream?: string | null;
  narrationText?: string | null;
  streamStartedAt: number | null;
  assistantAvatarUrl?: string | null;
  draft: string;
  queue: ChatQueueItem[];
  connected: boolean;
  canSend: boolean;
  gatewayConnection?: GatewayConnectionProps;
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
  // 消息引用：把原文构造成引用块追加到草稿末尾，并把焦点送回输入框（可接着打字）
  onQuoteMessage?: (text: string) => void;
  // 会话分支（rewind/fork/switch，内核 2026.9.7 branch tree）
  sessionBranches?: SessionBranch[];
  /** branches 加载时对应的 sessionKey，与当前 sessionKey 不匹配时按加载中处理 */
  sessionBranchesKey?: string | null;
  sessionBranchesLoading?: boolean;
  sessionBranchesError?: string | null;
  branchBusyAction?: string | null;
  onOpenSessionBranches?: () => void;
  onSwitchBranch?: (leafEntryId: string) => void;
  // 消息级回退/分叉：entryId 为内核 transcript 条目 id（__openclaw.id）
  onRewindToMessage?: (entryId: string) => void;
  onForkFromMessage?: (entryId: string) => void;
  // 错误卡片「重发」：重新发送失败的用户消息文本（同步发送失败路径提供），
  // attachments 为错误卡上保存的附件（resendAttachments），带回防重发附件丢失
  onResendError?: (text: string, attachments?: ChatAttachment[]) => void;
  // 连接失败 callout 的手动重试（failed 态「重试」按钮）
  onReconnect?: () => void;
  // 目标模式（官方 session.goal）
  goal?: SessionGoal | null;
  onGoalCommand?: (text: string) => void;
  onRequestUpdate?: () => void;
  // / 命令补全目录（官方 commands.list）
  commands?: CommandEntry[] | null;
  // 执行权限挡位（内核 tools.exec.mode 五档枚举）+ 待审批队列（exec.approval）
  execMode?: "deny" | "allowlist" | "ask" | "auto" | "full";
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

// 最近一次渲染的 sessionKey：切换会话时用于重置已拆出模块（compose/queue）的
// 模块级瞬态（经 resetComposeTransient/resetQueueStrip），避免展开状态残留到新会话。
let lastSessionKey: string | null = null;

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

// 路径链接打开（.chat-path-link 点击与 Enter/Space 键盘委托共用）：
// 经预加载桥 cryoclaw.openPath 走主进程 shell.openPath
function openChatPathLink(link: HTMLElement, props: ChatProps) {
  const path = link.dataset.path;
  if (!path) {
    return;
  }
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

// 对话页全局快捷键（R14）：Ctrl+N 新建对话 / Ctrl+L 聚焦输入框。
// document 级监听，模块级持有最新 props 引用，避免闭包旧值（同 plusMenuOutsideCloser 思路）。
let chatShortcutProps: ChatProps | null = null;
let chatShortcutHandler: ((ev: KeyboardEvent) => void) | null = null;

function ensureChatShortcuts(props: ChatProps) {
  chatShortcutProps = props;
  if (chatShortcutHandler) return;
  chatShortcutHandler = (ev: KeyboardEvent) => {
    // 仅对话视图生效：监听是 document 级常驻的，视图切走后仍存活——不设门的话
    // 设置/任务等页面按 Ctrl+N 会在无关视图上弹「新建对话」确认框。以聊天视图
    // 独有的输入框容器存在与否判定当前视图。
    if (!document.querySelector(".chat-compose__field")) return;
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
  const hasProgressCardForSession =
    props.progressCard?.sessionKey === props.sessionKey &&
    props.progressCard.card?.sessionKey === props.sessionKey;
  ensureChatShortcuts(props);
  if (props.sessionKey !== lastSessionKey) {
    lastSessionKey = props.sessionKey;
    // compose 模块瞬态（加号菜单/技能选择器/目标表单/思考·分支 popover/命令建议）
    // 与队列行内编辑态随会话切换统一复位（防展开状态残留到新会话）
    resetComposeTransient(props);
    resetQueueStrip();
  }
  const { isBusy, showStop } = computeStopButtonVisible(props);
  const activeSession = props.sessions?.sessions?.find((row) => row.key === props.sessionKey);
  const reasoningLevel = activeSession?.reasoningLevel ?? "off";
  // 模型选择器按会话取值：内核 per-session 持久化 model（sessions.patch），
  // 切会话后选择器必须反映该会话真实模型，否则显示上一个会话的模型而实际按本会话跑
  // （thinkingLevel 走 activeSession 同源，模型此前漏了）。会话无显式 model → 用全局默认。
  // R89：内核行 model 可能是裸模型 id（provider 缺省），先解析回 "provider/model" 全键；
  // 仍解析不出（未知模型）时 selectValue 为 null → 渲染层补一个「当前会话」动态选项，
  // 不再让选择器显示空白（v2026.913.3 修复）。
  const rawSessionModel = activeSession?.model ?? null;
  const resolvedModelKey = resolveModelSelectKey(rawSessionModel, props.configuredModels ?? []);
  const modelSelectValue: string | null = rawSessionModel
    ? (resolvedModelKey ?? rawSessionModel)
    : (props.currentModel || null);
  const thinkingActive = Boolean((props.thinkingToggleLevel && props.thinkingToggleLevel !== "off") || (props.thinkingLevel && props.thinkingLevel !== "off"));
  const showReasoning = Boolean(props.showThinking && (reasoningLevel !== "off" || thinkingActive));
  const assistantIdentity = {
    name: props.assistantName,
    avatar: props.assistantAvatar ?? props.assistantAvatarUrl ?? null,
  };

  const hasAttachments = (props.attachments?.length ?? 0) > 0;
  // 占位文案：断开时按三态软化——内核启动中显示「启动完成后即可聊天」，
  // 重连中/已断开沿用原断开占位
  const gatewayPhase: GatewayConnPhase = props.gatewayConnection?.phase ?? "reconnecting";
  const composePlaceholder = !props.connected
    ? gatewayPhase === "starting"
      ? t("chat.placeholder.starting")
      : t("chat.placeholder.disconnected")
    : isBusy
      ? t("chat.placeholder.busy")
      : hasAttachments
        ? t("chat.placeholder.image")
        : t("chat.placeholder");

  const splitRatio = props.splitRatio ?? 0.6;
  const sidebarOpen = Boolean(props.sidebarOpen && props.onCloseSidebar);
  // 当前正在执行的工具（有 call 无 result），用于流式状态行的阶段提示（供 <oc-chat-stream>）
  const activeToolName = resolveActiveToolName(
    Array.isArray(props.toolMessages) ? props.toolMessages : [],
  );
  // R23：子代理等待状态卡（原在 buildChatItems 内构造）：R41 Task 10 后随流式条目一起
  // 移出 memo（顺序契约：置于时间线末尾、流式气泡之后，见线程尾部装配）
  const subagentCards = props.runActive
    ? selectSubagentCards(props.tasks as Parameters<typeof selectSubagentCards>[0], props.sessionKey)
    : [];
  const subagentWaiting = subagentCards.some((c) => c.active);
  // 空会话（无历史/工具/流式/子代理卡且不在加载）：线程区显示居中 hero + starter prompts
  // R41 Task 11：历史子树已移入 <oc-chat-history>，空判定改为直接按源数组判断——
  // buildChatItems 保证每条消息必产一个条目（message/divider）、groupMessages 不丢条目，
  // 故「两数组皆空」与原 chatItems.length === 0 语义等价（hero 与流式/子代理判定仍耦合在外层）
  const isEmptySession =
    !props.loading &&
    (Array.isArray(props.messages) ? props.messages.length : 0) === 0 &&
    (Array.isArray(props.toolMessages) ? props.toolMessages.length : 0) === 0 &&
    props.stream === null &&
    (props.thinkingStream ?? null) === null &&
    (props.narrationText ?? null) === null &&
    subagentCards.length === 0;
  // starter prompt chips：点击即填入并发送（与 onGoalCommand 同样的同步「先改草稿再发送」时序）
  const starterKeys = ["chat.starter1", "chat.starter2", "chat.starter3", "chat.starter4"];
  // R94：starter 卡配图标（CryoIcons 现有件，与四条文案语义一一对应）
  const starterIcons = [icons.terminal, icons.clock, icons.diff, icons.folder];
  const sendStarter = (text: string) => {
    if (!props.connected) return;
    props.onDraftChange(text);
    props.onSend();
  };
  const thread = html`
    <div
      class="chat-thread ${isEmptySession ?"chat-thread--empty" : ""}"
      role="log"
      aria-live="polite"
      @scroll=${props.onChatScroll}
      @keydown=${(e: KeyboardEvent) => {
        // 路径链接键盘可达：无 href 的 <a tabindex="0"> 不响应 Enter/Space，
        // 线程级委托补齐（与 media-enhance 文件卡片的键盘处理同语义）。
        if (e.key !== "Enter" && e.key !== " ") {
          return;
        }
        const link = (e.target as HTMLElement | null)?.closest?.(".chat-path-link");
        if (!link) {
          return;
        }
        e.preventDefault();
        openChatPathLink(link as HTMLElement, props);
      }}
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
        openChatPathLink(link as HTMLElement, props);
      }}
    >
      ${
        props.loading
          ? html`
              <div class="chat-loading" role="status" aria-label=${t("chat.loading")}>
                <div class="chat-loading__row">
                  <span class="chat-loading__avatar"></span>
                  <span class="chat-loading__bubble" style="width: 62%"></span>
                </div>
                <div class="chat-loading__row chat-loading__row--user">
                  <span class="chat-loading__bubble chat-loading__bubble--user" style="width: 40%"></span>
                </div>
                <div class="chat-loading__row">
                  <span class="chat-loading__avatar"></span>
                  <span class="chat-loading__bubble" style="width: 74%"></span>
                </div>
              </div>
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
                (key, i) => html`
                  <button
                    class="chat-hero__chip stagger-${i + 1}"
                    type="button"
                    ?disabled=${!props.connected}
                    @click=${() => sendStarter(t(key))}
                  >
                    <span class="chat-hero__chip-icon" aria-hidden="true">${starterIcons[i]}</span>
                    <span class="chat-hero__chip-text">${t(key)}</span>
                  </button>
                `,
              )}
            </div>
          </div>
        `
        : nothing}
      ${
        // R41 Task 11：历史列表（repeat(chatItems) + 分组）抽为独立组件 <oc-chat-history>——
        // 只在消息数组/工具流/可见数等视觉属性真正变化时重渲染；草稿敲击、连接态、流式帧等
        // 高频状态被组件 shouldUpdate 门控，不再重求值这棵最重子树。回调每帧新闭包但属性赋值
        // 不受 shouldUpdate 影响，事件触发时仍拿最新闭包。装配顺序契约：历史先于 <oc-chat-stream>
        // 与子代理卡（流式归 Task 10 组件，状态归 OpenClawApp）。
        html`<oc-chat-history
          .messages=${props.messages}
          .toolMessages=${props.toolMessages}
          .visibleHistoryCount=${props.visibleHistoryCount}
          .showReasoning=${showReasoning}
          .assistantName=${props.assistantName}
          .assistantAvatar=${assistantIdentity.avatar}
          .gitAvailable=${props.gitAvailable}
          .locale=${getLocale()}
          .onOpenSidebar=${props.onOpenSidebar}
          .onQuoteMessage=${(text: string) => handleQuoteMessage(props, text)}
          .onResendError=${props.onResendError}
          .onRewindToMessage=${props.onRewindToMessage}
          .onForkFromMessage=${props.onForkFromMessage}
        ></oc-chat-history>`
      }
      ${
        // R41 Task 10：流式气泡/思考指示抽为独立组件，高频更新只命中其自身 render()；
        // 出现条件与原 buildChatItems 的 stream 条目一致（stream !== null，空白时组件内部
        // 降级为思考指示）。R88：思考/解说流式存在时同样挂载（组件内部渲染实时思考区）。
        // R1 渲染层双保险：终态帧丢失后历史已含本轮回复时，chatStream 与历史双份——
        // 内容相同则跳过流式气泡，历史成为唯一渲染源（app 层清态的渲染侧兜底）。
        // 收窄：同文抑制只在纯正文场景生效——thinking/narration 活跃时整个组件
        // 保留（否则内核中途落盘文本恰等于流式文本时，思考/解说指示被一并隐藏，
        // 工具间隙表现为「流式中断」）。未下沉到组件内部按段隐藏：组件结构改动
        // 成本高，此处取舍是或全显或全隐；同文导致的短暂双份由下一次 delta 收敛。
        // 子代理等待卡仍在其后（原「置于时间线末尾（流式气泡之后）」）。
        // a11y：.chat-thread 是 role="log"（aria-live polite），流式气泡每帧改文本会让
        // 屏幕阅读器逐 token 播报。oc-chat-stream 显式 aria-live="off"：离它最近的
        // live 设置生效，流式子树整体移出 live 区域；内部 role="status" 行（阶段指示/
        // 「正在生成…」）仍各自播报，终态消息经历史区进入 live 区域。
        props.stream !== null || props.thinkingStream !== null || props.narrationText !== null
          ? props.thinkingStream == null &&
            props.narrationText == null &&
            isStreamTextDuplicatedInHistory(props.messages, props.stream)
            ? nothing
            : html`<oc-chat-stream
              aria-live="off"
              .stream=${props.stream}
              .thinkingStream=${props.thinkingStream ?? null}
              .narrationText=${props.narrationText ?? null}
              .streamStartedAt=${props.streamStartedAt}
              .assistantName=${props.assistantName}
              .assistantAvatar=${assistantIdentity.avatar}
              .activeToolName=${activeToolName}
              .subagentWaiting=${subagentWaiting}
              .onOpenSidebar=${props.onOpenSidebar}
            ></oc-chat-stream>`
          : nothing
      }
      ${subagentCards.length > 0 ? renderSubagentCards(subagentCards) : nothing}
      ${
        // R61 问答卡片：pending 问题（当前会话过滤）出卡，位于子代理卡之后、compose 之前
        (() => {
          const prompts = selectPendingQuestions(props.questionPrompts, props.sessionKey);
          return prompts.length > 0
            ? renderQuestionCards(prompts, props.onResolveQuestion)
            : nothing;
        })()
      }
    </div>
  `;

  return html`
    <section class="card chat">
      ${renderGatewayCallout(props)}
      ${props.connected && props.error
        ? html`<div class="callout danger chat-error-callout">
            <span class="chat-error-callout__icon" aria-hidden="true">${icons.warning}</span>
            <span title=${props.error}>${t("chat.error.generic")}</span>
          </div>`
        : nothing}

      <div
        class="chat-split-container ${sidebarOpen ?"chat-split-container--open" : ""}"
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
              <oc-resizable-divider
                .splitRatio=${splitRatio}
                @resize=${(e: CustomEvent) => props.onSplitRatioChange?.(e.detail.splitRatio)}
              ></oc-resizable-divider>
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

      ${renderQueueStrip(props)}

      ${renderCompactionIndicator(props.compactionStatus)}
      ${renderFallbackNotice(props.fallbackNotice)}

      ${
        !hasProgressCardForSession
          ? renderPlanPanel(props.plan ?? null, {
              sessionKey: props.sessionKey,
              onDismiss: props.onDismissPlan,
            })
          : nothing
      }

      ${renderProgressCard(props.progressCard ?? null, {
        sessionKey: props.sessionKey,
        collapsed: props.progressCardCollapsed ?? false,
        runActive: props.runActive ?? false,
        dismissing: props.progressCard?.dismissing,
        onToggleCollapse: props.onToggleProgressCardCollapse,
        onDismiss: props.onDismissProgressCard,
      })}

      ${renderBoardPanel(props)}

      ${
        props.showNewMessages
          ? html`
            <button
              class="btn chat-new-messages"
              type="button"
              aria-label=${t("chat.scrollToBottom")}
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

      ${renderCompose(props, {
        activeSession,
        composePlaceholder,
        modelSelectValue,
        isBusy,
        showStop,
      })}
    </section>
  `;
}

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
            class="chat-subagent-card ${card.active ?"chat-subagent-card--active"
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