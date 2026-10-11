/**
 * 切换会话不断流 —— per-session run 态快照（纯逻辑模块，无 DOM 依赖，可单测）。
 *
 * 背景：此前 applySessionKeyTransition 切走即重置全部 run 态字段并丢弃 chatQueue，
 * 进行中的 run 切回后只能从历史收养重建（工具时间线/思考流/解说全丢，排队消息
 * 直接丢失）。本模块把「run 在跑或队列非空」的会话的 run 态快照进
 * sessionKey → RunStateSnapshot 的 Map（LRU 20，对齐 sessionDraftSnapshots 范式）：
 *
 * 1. 切走前 capture：流式正文（含 pending/frozenPrefix/交叉校验计数）、思考流、
 *    中途解说、runId/起始时间/最后活动/中止在途、终态轮记录、planState、chatQueue，
 *    以及工具时间线（app-tool-stream.ts captureToolStreamTimeline）。
 * 2. 后台期间（二期）：chat/agent 事件不再被 sessionKey 硬过滤丢弃，而是分派进
 *    快照条目——快照对象本身即 ToolStreamHost/ChatState 形态，reducer 冻结/摊平
 *    逻辑以条目为宿主运行（R3/R4 失效钩子指向条目自身时间线），Lit 响应式 host
 *    字段与单份定时器（rAF/80ms 节流）完全不受影响。delta 恒带 message 全量
 *    累计文本，reducer 交叉校验自愈漏帧，条目只存最新状态。
 * 3. 后台 own-run 终态：handleChatEvent 清条目内 run 态 + resetToolStream 清时间线，
 *    chatQueue/planState 刻意保留（后台终态后切回，排队消息仍要自动续发），并标记
 *    历史脏（切回强制重拉——历史是本模块刻意不碰的维度，chatMessages 永不进快照，
 *    终态回复由 loadChatHistory 承载；快照内的合成 partial 占位随恢复丢弃）。
 * 4. 切回时 take（一次性）：pending 提交进可见字段后写回 host 并恢复工具时间线。
 *
 * 不变量：仅前台会话事件写 lastActiveSessionKey（app-gateway 守卫，本模块不涉及）；
 * 后台会话不跑看门狗/预对齐/orphan 探测（app-gateway 的探测只读 host 字段，天然
 * 只覆盖前台；后台极端丢失由切回 loadChatHistory 的 inFlightRun 收养兜底）。
 */

import {
  handleChatEvent,
  flushPendingChatStream,
  recordTerminalRunTombstone,
  type ChatEventPayload,
  type ChatState,
} from "./controllers/chat.ts";
import {
  captureToolStreamTimeline,
  flushToolStreamSync,
  handleAgentEvent,
  invalidateDuplicatedNarrationSegments,
  invalidateFrozenLeadingSegments,
  resetToolStream,
  restoreToolStreamTimeline,
  type AgentEventPayload,
  type StreamSegment,
  type ToolStreamEntry,
  type ToolStreamHost,
} from "./app-tool-stream.ts";
import type { PlanStreamState } from "./plan-stream.ts";
import type { ChatQueueItem } from "./ui-types.ts";

export type RunStateSnapshot = {
  // 事件归属会话：handleChatEvent/handleAgentEvent 内部的 sessionKey 过滤以它为锚
  sessionKey: string;
  chatStream: string | null;
  chatPendingStreamText: string | null;
  chatStreamFrozenPrefix: string;
  // R5：delta 交叉校验连续失败计数（后台累积沿用同一计数，切回后前台继续）
  chatStreamMismatchCount: number;
  // R88 实时思考/中途解说流式（pending 与可见字段并列，恢复时提交合并）
  chatThinkingStream: string | null;
  chatPendingThinkingText: string | null;
  chatNarrationText: string | null;
  chatPendingNarrationText: string | null;
  chatRunId: string | null;
  chatStreamStartedAt: number | null;
  chatLastActivityAt: number | null;
  // 中止请求在途标记（Stop 禁用期）：随快照往返，切回后终态事件/提交失败照常清零
  chatAbortPending: boolean;
  // 终态轮记录（等长滞后判定用，见 controllers/chat.ts noteRunTerminal）
  chatTerminalRun: { runId: string; startedAt: number } | null;
  chatQueue: ChatQueueItem[];
  // 后台终态合成的 cryoclawPartial 占位只写在这里（瞬态）：恢复时刻意不写回
  // host.chatMessages——历史由 loadChatHistory 承载，写回会与历史双份。
  chatMessages: unknown[];
  chatStreamFrame: number | null;
  planState: PlanStreamState | null;
  // 工具时间线（字段名即 ToolStreamHost 契约）：快照对象本身即时间线宿主，
  // 后台 agent 事件直接以它为宿主运行冻结/摊平，不写前台 host 字段。
  toolStreamById: Map<string, ToolStreamEntry>;
  toolStreamOrder: string[];
  chatToolMessages: Record<string, unknown>[];
  evictedLeadingSegments: StreamSegment[];
  toolStreamSyncTimer: number | null;
  // R3/R4 失效钩子：后台累积期间指向快照自身的时间线（handleChatEvent delta 分支消费）
  onReplaceBeyondFrozenPrefix?: () => void;
  onBodyTextAdoptsNarration?: (bodyText: string) => void;
};

// capture 的读取来源：SessionTransitionHost（ChatState）与 app 的私有工具字段
// 超集；全部字段可选以兼容测试替身（缺省按空值处理）。
export type RunStateCaptureSource = {
  sessionKey?: string;
  chatStream?: string | null;
  chatPendingStreamText?: string | null;
  chatStreamFrozenPrefix?: string;
  chatStreamMismatchCount?: number;
  chatThinkingStream?: string | null;
  chatPendingThinkingText?: string | null;
  chatNarrationText?: string | null;
  chatPendingNarrationText?: string | null;
  chatRunId?: string | null;
  chatStreamStartedAt?: number | null;
  chatLastActivityAt?: number | null;
  chatAbortPending?: boolean;
  chatTerminalRun?: { runId: string; startedAt: number } | null;
  chatQueue?: unknown[];
  chatMessages?: unknown[];
  chatStreamFrame?: number | null;
  planState?: unknown | null;
  toolStreamSyncTimer?: number | null;
  toolStreamById?: unknown;
  toolStreamOrder?: unknown;
  chatToolMessages?: unknown;
  evictedLeadingSegments?: unknown;
};

// 快照条目上限（对齐 SESSION_DRAFT_SNAPSHOT_MAX）：超限逐出最旧条目
//（Map 迭代序 = 插入序，首个 key 即最旧）。
const RUN_STATE_SNAPSHOT_MAX = 20;

const runStateSnapshots = new Map<string, RunStateSnapshot>();
// 后台 own-run 终态标记的历史脏集合：切回时强制重拉（语义见文件头第 3 点；
// applySessionKeyTransition 本就无条件重拉历史，本集合把「必须新鲜」契约显式化）。
const dirtyRunStateHistories = new Set<string>();

// ── Map 基本操作 ──

export function saveRunStateSnapshot(sessionKey: string, snapshot: RunStateSnapshot) {
  runStateSnapshots.delete(sessionKey); // 重新插入以刷新 Map 迭代序（LRU 语义）
  runStateSnapshots.set(sessionKey, snapshot);
  while (runStateSnapshots.size > RUN_STATE_SNAPSHOT_MAX) {
    // 优先逐出空闲条目（无活跃 run 且队列空）：逐出活跃条目会让后台事件失去宿主、
    // 排队消息静默丢失（切回只剩 loadChatHistory 收养兜底）。全部活跃时仍逐最旧，
    // 保住 LRU 上界（20 全活跃是理论极端，逐出后走无条目丢弃/收养兜底语义）。
    let victim: string | undefined;
    let fallback: string | undefined;
    for (const key of runStateSnapshots.keys()) {
      if (fallback === undefined) fallback = key;
      const entry = runStateSnapshots.get(key);
      if (entry && entry.chatRunId == null && entry.chatQueue.length === 0) {
        victim = key;
        break;
      }
    }
    const oldest = victim ?? fallback;
    if (oldest === undefined) break;
    runStateSnapshots.delete(oldest);
    dirtyRunStateHistories.delete(oldest);
  }
}

/** 非破坏性读取（后台事件分派用；恢复走一次性 take） */
export function peekRunStateSnapshot(sessionKey: string): RunStateSnapshot | null {
  return runStateSnapshots.get(sessionKey) ?? null;
}

/** 一次性读取（恢复后即删除：host 字段接管，快照不得残留成第二写入目标） */
export function takeRunStateSnapshot(sessionKey: string): RunStateSnapshot | null {
  const snapshot = runStateSnapshots.get(sessionKey) ?? null;
  runStateSnapshots.delete(sessionKey);
  return snapshot;
}

// 会话被删除时同步清理其快照（app-session-actions.ts deleteSessionFromSidebar 调用，
// 对齐 clearSessionDraftSnapshot 的同名 key 复用防护）
export function clearSessionRunStateSnapshot(sessionKey: string) {
  runStateSnapshots.delete(sessionKey);
  dirtyRunStateHistories.delete(sessionKey);
}

/**
 * 失败回队的归属兜底（app-chat.ts flushChatQueue / sendQueuedMessageNow）：
 * 发送 await 窗口内已切走会话时，条目不得写进当前 host 的队列（那是新会话的）。
 * 归还原会话的快照条目队列；原会话无条目时（发送窗口内队列已弹空且 run 不在跑，
 * 不满足 capture 条件）补一个仅含队列的最小条目——切回时走既有恢复路径，队列继续
 * 自动冲刷（restoreToolStreamTimeline 以空时间线整体换回，等价于无快照重置路径）。
 */
export function requeueChatMessageForSession(sessionKey: string, item: ChatQueueItem): void {
  const entry = runStateSnapshots.get(sessionKey);
  if (entry) {
    entry.chatQueue = [item, ...entry.chatQueue];
    // 重新插入刷新 LRU 迭代序：回队视作新活动，原会话不因最旧被优先逐出
    runStateSnapshots.delete(sessionKey);
    runStateSnapshots.set(sessionKey, entry);
    return;
  }
  saveRunStateSnapshot(sessionKey, {
    sessionKey,
    chatStream: null,
    chatPendingStreamText: null,
    chatStreamFrozenPrefix: "",
    chatStreamMismatchCount: 0,
    chatThinkingStream: null,
    chatPendingThinkingText: null,
    chatNarrationText: null,
    chatPendingNarrationText: null,
    chatRunId: null,
    chatStreamStartedAt: null,
    chatLastActivityAt: null,
    chatAbortPending: false,
    chatTerminalRun: null,
    chatQueue: [item],
    chatMessages: [],
    chatStreamFrame: null,
    planState: null,
    toolStreamById: new Map<string, ToolStreamEntry>(),
    toolStreamOrder: [],
    chatToolMessages: [],
    evictedLeadingSegments: [],
    toolStreamSyncTimer: null,
  });
}

export function markRunStateHistoryDirty(sessionKey: string) {
  dirtyRunStateHistories.add(sessionKey);
}

export function consumeRunStateHistoryDirty(sessionKey: string): boolean {
  const dirty = dirtyRunStateHistories.has(sessionKey);
  dirtyRunStateHistories.delete(sessionKey);
  return dirty;
}

/** 测试专用：清空快照 Map 与历史脏集合（node:test 各用例共享模块态）。 */
export function resetRunStateStoreForTests(): void {
  runStateSnapshots.clear();
  dirtyRunStateHistories.clear();
}

// ── capture / restore ──

export function captureRunStateSnapshot(source: RunStateCaptureSource): RunStateSnapshot {
  // 挂起的 rAF 帧属于旧宿主：取消并把 pending 提交进可见字段——快照只带走数据，
  // 帧句柄不可跨宿主（后台/切回后以新宿主自己的帧调度为准）。
  if (source.chatStreamFrame != null) {
    flushPendingChatStream(source as unknown as ChatState);
  }
  // 节流中的工具时间线同步摊平后再拷贝（chatToolMessages 与 entries 对齐）；
  // 定时器本身不跨宿主，快照侧记 null。
  if (source.toolStreamSyncTimer != null && source.toolStreamById instanceof Map) {
    flushToolStreamSync(source as unknown as ToolStreamHost);
  }
  const snapshot: RunStateSnapshot = {
    sessionKey: source.sessionKey ?? "",
    chatStream: source.chatStream ?? null,
    chatPendingStreamText: source.chatPendingStreamText ?? null,
    chatStreamFrozenPrefix: source.chatStreamFrozenPrefix ?? "",
    chatStreamMismatchCount: source.chatStreamMismatchCount ?? 0,
    chatThinkingStream: source.chatThinkingStream ?? null,
    chatPendingThinkingText: source.chatPendingThinkingText ?? null,
    chatNarrationText: source.chatNarrationText ?? null,
    chatPendingNarrationText: source.chatPendingNarrationText ?? null,
    chatRunId: source.chatRunId ?? null,
    chatStreamStartedAt: source.chatStreamStartedAt ?? null,
    chatLastActivityAt: source.chatLastActivityAt ?? null,
    chatAbortPending: source.chatAbortPending ?? false,
    chatTerminalRun: source.chatTerminalRun ?? null,
    chatQueue: Array.isArray(source.chatQueue) ? [...(source.chatQueue as ChatQueueItem[])] : [],
    // 历史永不进快照（文件头契约；浅拷也会驻留 20 份消息引用 + 附件 base64）。
    // 空数组只承载后台终态的合成 partial 占位注入形态（注入后随即清空）。
    chatMessages: [],
    chatStreamFrame: null, // 帧不跨宿主（上方已 flush）
    planState: (source.planState as PlanStreamState | null | undefined) ?? null,
    // 工具时间线：测试替身无这些字段时退化为空时间线
    ...(source.toolStreamById instanceof Map
      ? captureToolStreamTimeline(source as unknown as ToolStreamHost)
      : {
          toolStreamById: new Map<string, ToolStreamEntry>(),
          toolStreamOrder: [],
          chatToolMessages: [],
          evictedLeadingSegments: [],
        }),
    toolStreamSyncTimer: null, // 节流定时器不跨宿主（上方已同步摊平）
  };
  // R3/R4 失效钩子指向快照自身：后台 delta 的 replace/正文接管判定作用于快照时间线，
  // 绝不触碰前台 host 的冻结段（host 有自己的同名钩子，app.ts 接线）。
  snapshot.onReplaceBeyondFrozenPrefix = () => {
    invalidateFrozenLeadingSegments(snapshot as unknown as ToolStreamHost);
  };
  snapshot.onBodyTextAdoptsNarration = (bodyText: string) => {
    invalidateDuplicatedNarrationSegments(snapshot as unknown as ToolStreamHost, bodyText);
  };
  return snapshot;
}

// restore 的写入目标：SessionTransitionHost + app 的私有工具字段超集。
export type RunStateRestoreTarget = RunStateCaptureSource & {
  chatQueue: unknown[];
  resetToolStream?: () => void;
};

export function restoreRunStateSnapshot(
  host: RunStateRestoreTarget,
  snapshot: RunStateSnapshot,
): void {
  // pending 先提交进可见字段再写回：渲染层只读 chatStream/chatThinkingStream/
  // chatNarrationText 可见字段，pending 是宿主帧调度的内部态，不可原样带回。
  host.chatStream = snapshot.chatPendingStreamText ?? snapshot.chatStream;
  host.chatPendingStreamText = null;
  host.chatStreamFrozenPrefix = snapshot.chatStreamFrozenPrefix;
  host.chatStreamMismatchCount = snapshot.chatStreamMismatchCount;
  host.chatThinkingStream = snapshot.chatPendingThinkingText ?? snapshot.chatThinkingStream;
  host.chatPendingThinkingText = null;
  host.chatNarrationText = snapshot.chatPendingNarrationText ?? snapshot.chatNarrationText;
  host.chatPendingNarrationText = null;
  host.chatRunId = snapshot.chatRunId;
  host.chatStreamStartedAt = snapshot.chatStreamStartedAt;
  host.chatLastActivityAt = snapshot.chatLastActivityAt;
  host.chatAbortPending = snapshot.chatAbortPending;
  host.chatTerminalRun = snapshot.chatTerminalRun;
  host.chatQueue = [...snapshot.chatQueue];
  host.planState = snapshot.planState;
  // chatMessages 刻意不恢复：历史由 loadChatHistory 重拉承载（见文件头第 3 点）。
  // 快照的四个时间线字段即 ToolStreamTimelineSnapshot 契约，直接整体换回。
  restoreToolStreamTimeline(host as unknown as ToolStreamHost, snapshot);
}

// ── 后台事件分派（二期：payload.sessionKey !== host.sessionKey 的事件） ──

/**
 * 后台会话 chat 事件：累积进该会话的快照条目（若有）。
 * delta 走 handleChatEvent 全部分支（reducer 全量快照自愈、R3/R4 经条目自身钩子
 * 作用于条目时间线）；own-run 终态清条目内 run 态并标记历史脏；外来 run 的
 * 终态只 tombstone（与前台同一契约）。无条目 = 该会话无可恢复的 run 态：
 * 维持既有丢弃语义，仅终态 tombstone 防内核滞后快照把死 run 收养成僵尸流。
 */
export function dispatchBackgroundChatEvent(payload: ChatEventPayload): void {
  const entry = runStateSnapshots.get(payload.sessionKey);
  if (!entry) {
    if (payload.runId && payload.state !== "delta" && payload.state !== "status") {
      recordTerminalRunTombstone(payload.runId);
    }
    return;
  }
  const isTerminal =
    payload.state === "final" || payload.state === "error" || payload.state === "aborted";
  // own-run 判定必须在 handleChatEvent 之前：终态分支会清 entry.chatRunId
  const isOwnRunTerminal = isTerminal &&
    (payload.runId
      ? Boolean(entry.chatRunId && payload.runId === entry.chatRunId)
      : Boolean(entry.chatRunId));
  handleChatEvent(entry as unknown as ChatState, payload);
  if (!isOwnRunTerminal) {
    return;
  }
  // own-run 终态：run 态已由 handleChatEvent 内 resetChatStreamState 清掉；工具
  // 时间线在此清零（前台 own-run 终态由 app-gateway resetToolStream，后台自理）。
  // chatQueue/planState 刻意保留——后台终态后切回，排队消息仍要继续自动发出；
  // 合成 partial 占位随 chatMessages 清空（历史是唯一渲染源）。
  resetToolStream(entry as unknown as ToolStreamHost);
  entry.chatAbortPending = false;
  entry.chatMessages = [];
  markRunStateHistoryDirty(payload.sessionKey);
}

/** 后台会话 agent 事件（thinking/解说/tool 时间线等）：以快照条目为宿主累积。 */
export function accumulateBackgroundAgentEvent(
  sessionKey: string,
  payload: AgentEventPayload,
): void {
  const entry = runStateSnapshots.get(sessionKey);
  if (!entry) {
    return; // 无可恢复的 run 态：维持既有丢弃语义
  }
  handleAgentEvent(entry as unknown as ToolStreamHost, payload);
}
