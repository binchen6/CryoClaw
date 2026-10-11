import type { GatewayBrowserClient } from "../gateway.ts";
import type { ChatAttachment } from "../ui-types.ts";
import { extractText } from "../chat/message-extract.ts";
import { debugLog } from "../debug.ts";
import { clearReconnectOrphanRun, hasAssistantReplyAfter, liveOrphanRunId } from "../stream-recovery.ts";
import { generateUUID } from "../uuid.ts";
import { readFileBase64 } from "../data/ipc-bridge.ts";
import { t } from "../i18n.ts";
import { showToastGlobal } from "../app-toast.ts";
import { reduceChatStreamDelta } from "./chat-stream-reducer.ts";

// delivery-mirror 是 gateway 将外发消息镜像写回 transcript 的副本。
// 当 agent 已在 transcript 中写过同文本的 assistant 消息时，mirror 条目是冗余的，
// 显示两条会让用户困惑。此函数按内容指纹去除这类重复。
function deduplicateDeliveryMirrors(messages: unknown[]): unknown[] {
  const seen = new Set<string>();
  return messages.filter((m) => {
    const rec = m as Record<string, unknown>;
    if (rec.role !== "assistant") {
      return true;
    }
    const text = extractText(m)?.trim();
    if (!text) {
      return true;
    }
    // 全文作指纹：200 字符前缀在模板化长回复/重复通告下会撞车误丢正常消息
    const fingerprint = text;
    if (rec.model === "delivery-mirror") {
      // mirror 条目：仅当同文本 agent 条目已存在时才丢弃
      return !seen.has(fingerprint);
    }
    // 非 mirror 的 assistant 条目：记录指纹
    seen.add(fingerprint);
    return true;
  });
}

export type ChatState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatVisibleMessageCount: number;
  chatThinkingLevel: string | null;
  chatSending: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatHistoryHydrationFrame: number | null;
  chatPendingStreamText: string | null;
  chatStreamFrame: number | null;
  // 已被 app-tool-stream 冻成 leadingSegment 的文本前缀。每帧 delta 进来要先把它切掉，
  // 否则旧段会被重复写进 chatStream，并和 leadingSegment 同时显示出来。
  chatStreamFrozenPrefix: string;
  // 最后一次流式活动时间戳（delta 接受/tool/thinking 事件），挂起流看门狗以此为锚
  chatLastActivityAt: number | null;
  // R88 思考过程流式：当前 reasoning phase 的累计文本（agent 事件 stream:"thinking"，
  // data.text 为该 phase 全量）。run 终态/新 phase 重启时整体替换。
  chatThinkingStream: string | null;
  chatPendingThinkingText: string | null;
  // R88 中途解说流式：内核把工具之间的 narration 文本经 agent 事件 stream:"item"
  // (kind:"preamble") 投递（刻意不进 chat delta 广播），progressText 为该段全量。
  // 下一个 tool start 到来时由 app-tool-stream 冻结进时间线。
  chatNarrationText: string | null;
  chatPendingNarrationText: string | null;
  // R5：delta 交叉校验（reducer 自检 current+delta 是否对齐 message 全量）的连续
  // 失败计数（基线漂移观测值：非前向失配一律保守追加不 resync）。run 终态清零。
  chatStreamMismatchCount?: number;
  // 中止在途标记（Stop 按钮禁用期）：own-run 终态/提交失败/切会话清零；
  // 新 run 发起时也必须清零——否则上一轮在断连窗口丢失终态的残留标记
  // 会把新一轮 run 的 Stop 按钮全程禁用。
  chatAbortPending?: boolean;
  // R3：replace 帧越过 tool 边界重生成（reducer 返回 invalidatesFrozenPrefix）时
  // 调用——作废 toolStream 里被重写的冻结段。由 app 层接线（同 onStreamSeqGap 模式）。
  onReplaceBeyondFrozenPrefix?: () => void;
  // R4 补强：正文非空 delta 上屏时调用（每个 delta 都进、幂等；时间线无 narration
  // 冻结段时零开销），携带正文累计全量（frozenPrefix+新正文）——app 层据此作废
  // toolStream 里与其头部同文/同前缀的冻结 narrationSegment（answer_candidate 先
  // narration 后正文回放的双份场景）。接线同 onReplaceBeyondFrozenPrefix。可选以兼容测试替身。
  onBodyTextAdoptsNarration?: (bodyText: string) => void;
  // 最近一次本 run 终态记录（own-run final/aborted/error 到达时写入；新 run 发起/
  // 切会话清除）。mergeIfStale 的等长滞后判定用：乐观回声/合成占位会让本地与滞后
  // 快照等长，绕过长度判定，整体替换会把刚完成的回复从视图里抹掉。
  chatTerminalRun?: { runId: string; startedAt: number } | null;
  lastError: string | null;
};

export type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  // "status"：内核 run 启动阶段广播的进度帧（preparing_workspace 等 7 phase），
  // 非终态——handleChatEvent 不得按终态清 orphan 快照/重置 run 态。
  state: "delta" | "final" | "aborted" | "error" | "status";
  message?: unknown;
  errorMessage?: string;
  // OpenClaw protocol v4 fields. deltaText is preferred when present; message
  // remains the compatibility snapshot for older gateways.
  deltaText?: string;
  replace?: boolean;
  stopReason?: string;
  errorKind?: "refusal" | "timeout" | "rate_limit" | "context_length" | "unknown";
};

const INITIAL_CHAT_HISTORY_RENDER_COUNT = 20;
const CHAT_HISTORY_RENDER_BATCH = 10;

// 取消历史消息渐进渲染，避免旧帧在 session 切换后继续写状态。
function cancelChatHistoryHydration(state: ChatState) {
  if (state.chatHistoryHydrationFrame !== null) {
    clearTimeout(state.chatHistoryHydrationFrame);
    state.chatHistoryHydrationFrame = null;
  }
}

// 大历史记录先露出一小批，后续逐帧补齐，避免首屏同步渲染把 renderer 卡死。
function scheduleChatHistoryHydration(state: ChatState, sessionKey: string, total: number) {
  cancelChatHistoryHydration(state);
  if (total <= state.chatVisibleMessageCount) {
    return;
  }
  const hydrate = () => {
    state.chatHistoryHydrationFrame = null;
    if (state.sessionKey !== sessionKey) {
      return;
    }
    const next = Math.min(total, state.chatVisibleMessageCount + CHAT_HISTORY_RENDER_BATCH);
    state.chatVisibleMessageCount = next;
    if (next < total) {
      state.chatHistoryHydrationFrame = setTimeout(hydrate, 32) as unknown as number;
    }
  };
  state.chatHistoryHydrationFrame = setTimeout(hydrate, 32) as unknown as number;
}

// chat delta 一帧只提交一次最新文本，别让每个 token 都触发 Lit 全量重渲染。
// thinking/narration 复用同一帧：三类高频流式文本统一 rAF 节流提交。
// 导出供 app-tool-stream 的 thinking/item 事件处理复用（同一 rAF 帧，合并提交）。
export function scheduleChatStreamFlush(state: ChatState) {
  if (state.chatStreamFrame !== null) {
    return;
  }
  state.chatStreamFrame = requestAnimationFrame(() => {
    state.chatStreamFrame = null;
    if (state.chatPendingStreamText !== null) {
      state.chatStream = state.chatPendingStreamText;
      state.chatPendingStreamText = null;
    }
    if (state.chatPendingThinkingText !== null) {
      state.chatThinkingStream = state.chatPendingThinkingText;
      state.chatPendingThinkingText = null;
    }
    if (state.chatPendingNarrationText !== null) {
      state.chatNarrationText = state.chatPendingNarrationText;
      state.chatPendingNarrationText = null;
    }
  });
}

// The pending RAF value is part of the visible stream and must be committed
// before a terminal/reset path clears the run. This closes the last-frame loss
// window when final/error/aborted arrives in the same frame as a delta.
export function flushPendingChatStream(state: ChatState): string {
  if (state.chatStreamFrame !== null) {
    cancelAnimationFrame(state.chatStreamFrame);
    state.chatStreamFrame = null;
  }
  if (state.chatPendingStreamText !== null) {
    state.chatStream = state.chatPendingStreamText;
    state.chatPendingStreamText = null;
  }
  if (state.chatPendingThinkingText !== null) {
    state.chatThinkingStream = state.chatPendingThinkingText;
    state.chatPendingThinkingText = null;
  }
  if (state.chatPendingNarrationText !== null) {
    state.chatNarrationText = state.chatPendingNarrationText;
    state.chatPendingNarrationText = null;
  }
  return state.chatStream ?? "";
}

export function getActiveChatStreamText(state: ChatState): string {
  return state.chatPendingStreamText ?? state.chatStream ?? "";
}

// run 结束时要连同挂起的 stream 帧一起清理，避免旧文本回写脏状态。
// 导出供 app-gateway onHello 断连清态复用（统一清理入口，防双份逻辑漂移）。
export function resetChatStreamState(state: ChatState) {
  flushPendingChatStream(state);
  state.chatPendingStreamText = null;
  state.chatStream = null;
  state.chatRunId = null;
  state.chatStreamStartedAt = null;
  state.chatLastActivityAt = null;
  // 新一轮 run 重新开始，frozenPrefix 也要清，避免上一轮的前缀切错本轮的累计文本。
  state.chatStreamFrozenPrefix = "";
  // R88：实时思考/解说随 run 终态一并清理（final 后由历史刷新按 transcript 还原）
  state.chatPendingThinkingText = null;
  state.chatThinkingStream = null;
  state.chatPendingNarrationText = null;
  state.chatNarrationText = null;
  // R5：交叉校验计数随 run 终态清零，下一 run 重新起算
  state.chatStreamMismatchCount = 0;
}

// R30：mergeIfStale 保留本地（内核快照滞后）后的延迟二次拉取。
// 此前保留后无任何重试——若本轮回复恰好撞上内核持久化窗口，用户会看到
// 「问了没答」且要等下轮 final/手动刷新才恢复。保留时按 600/1500/3000/6000ms
// 退避补拉（R62 及时性调优：首档 600ms 更快收敛，尾档 6000ms 覆盖内核慢持久化
// 窗口——旧档 2.4s 耗尽后长尾场景无人收敛），替换成功或会话切换即停止。
// 同一时刻只保留一个挂起重试。
// 补拉刻意非 silent（R41 终审记录）：滞后意味着用户可见数据不全，给用户加载反馈合理；
// 静默探测（看门狗/重连 orphan）命中滞后时也会派生本链的非 silent 补拉，属有界预期行为。
const STALE_RETRY_DELAYS_MS = [600, 1500, 3000, 6000];
let staleRetryTimer: ReturnType<typeof setTimeout> | null = null;
let staleRetryKey: string | null = null;
let staleRetryAttempt = 0;
// Bug2-2：补拉预算按「会话 + 终态轮次」复位。此前预算只按 sessionKey 复位——
// 同一会话内上一轮终态把 4 档预算耗尽后，本轮终态再撞滞后快照就直接静默放弃
// （「问了没答」永不再补拉）。新 own-run 终态/新 run 发起时换 roundKey 并重置
// 已耗档位，让新一轮重新获得满额预算。
let staleRetryRoundKey: string | null = null;

function noteStaleRetryNewRound(sessionKey: string, roundId: string) {
  const compound = `${sessionKey}${roundId}`;
  if (staleRetryRoundKey === compound) {
    return;
  }
  staleRetryRoundKey = compound;
  staleRetryAttempt = 0;
}

function cancelStaleHistoryRetry() {
  if (staleRetryTimer !== null) {
    clearTimeout(staleRetryTimer);
    staleRetryTimer = null;
  }
  staleRetryKey = null;
  staleRetryAttempt = 0;
}

// 测试专用：取消挂起的滞后补拉，避免测试进程被退避定时器拖延退出
export function cancelStaleHistoryRetryForTests() {
  cancelStaleHistoryRetry();
}

function scheduleStaleHistoryRetry(state: ChatState, sessionKey: string) {
  if (staleRetryKey !== null && staleRetryKey !== sessionKey) {
    // 目标会话切换：预算随之复位——旧会话消耗的档位不应由新会话继承，
    // 否则长期滞后的会话会吃光全局预算，其余会话「问了没答」永不再补拉。
    // 无挂起定时器（旧会话预算已耗尽）同样要复位，否则耗尽态会永久传染。
    if (staleRetryTimer !== null) {
      clearTimeout(staleRetryTimer);
      staleRetryTimer = null;
    }
    staleRetryAttempt = 0;
  }
  if (staleRetryAttempt >= STALE_RETRY_DELAYS_MS.length) {
    return;
  }
  if (staleRetryTimer !== null) {
    return; // 已有同会话的挂起重试，合并（同会话内预算不叠加消耗）
  }
  staleRetryKey = sessionKey;
  const delay = STALE_RETRY_DELAYS_MS[staleRetryAttempt];
  staleRetryTimer = setTimeout(() => {
    staleRetryTimer = null;
    staleRetryAttempt++;
    // 会话已切走/断连：放弃（loadChatHistory 内部也有守卫，这里省一次无效调用）
    if (state.sessionKey !== sessionKey || !state.client || !state.connected) {
      staleRetryKey = null;
      staleRetryAttempt = 0;
      return;
    }
    void loadChatHistory(state, { mergeIfStale: true });
  }, delay);
}

// R59：内核 chat.history / chat.startup 响应附带在途 run 快照（同 handler，字段取证见
// docs/kernel-recon/2026.8.2-chat-capabilities.md A.4 + gateway asar 实读）：
// { runId, text: 全量累计流式文本, startedAt?, sessionAbortable? }——run 不在途时缺省。
export type InFlightRunSnapshot = {
  runId?: unknown;
  text?: unknown;
  startedAt?: unknown;
};

// loadChatHistory 的返回值：把响应里的 inFlightRun 声明暴露给探测类调用方
// （预对齐/看门狗/orphan 探测）——内核显式声明本 run 在途是权威信号，历史里出现的
// assistant 内容一律视为中途落盘而非终态回复，不得据此清活跃 run。
// 早退/失败路径返回 null（无权威信息，调用方按"未知"处理）。
export type ChatHistoryLoadResult = {
  inFlightRun?: InFlightRunSnapshot;
} | null;

// 非 silent 加载的代际令牌：两个常规加载并发时，后发起者使先前加载整体失效——
// 先前加载完成时不得清 chatLoading（最新一代仍在飞，先完成者的 finally 提前清位
// 会让加载指示中途消失），也不得写回消息快照（防旧响应后至覆盖新响应的
// last-write-wins 倒置）。silent 探测不置加载态、不拥有视图快照，不参与代际。
let loadChatHistoryGeneration = 0;

// Bug2-3：全部历史加载（silent 与否）的全局发起序号 + 最近一次非 silent 加载的
// 发起序号。silent 探测（预对齐/看门狗/orphan/补拉）拿到响应前，终态刷新等非
// silent 加载可能已发起并完成写回——迟到的 silent 响应再落地会把旧快照盖回去，
// 甚至经 adoptInFlightRunFromHistory 把已终态 run 收养成僵尸流。silent 完成时
// 若已有更新的非 silent 加载发起过（lastNonSilentLoadSeq > 本次序号），丢弃写回。
let loadChatHistorySeq = 0;
let lastNonSilentLoadSeq = 0;

// 终态 tombstone（Bug2-3）：已收过终态帧的 runId 黑名单。内核 chat.history 由
// 无 TTL 的会话快照缓存提供，可返回任意时刻的滞后响应——迟到的历史拉取仍可能
// 声明已终结的 run 在途（inFlightRun），adopt 会把已终态 run 收养成僵尸流
// （气泡与 Stop 挂起直到看门狗）。收养前查此表拒收。有界（FIFO 上限）+ TTL 逐出。
const TERMINAL_RUN_TOMBSTONE_TTL_MS = 30 * 60 * 1000;
const TERMINAL_RUN_TOMBSTONE_MAX = 100;
const terminalRunTombstones = new Map<string, number>();

// 导出供 run-state-store.ts 的后台终态分派复用：后台会话收不到终态帧时同样要
// 黑名单该 runId，防内核无 TTL 快照缓存迟到声明它在途、切回被收养成僵尸流。
export function recordTerminalRunTombstone(runId: string, now = Date.now()) {
  const id = runId.trim();
  if (!id) {
    return;
  }
  terminalRunTombstones.set(id, now);
  if (terminalRunTombstones.size > TERMINAL_RUN_TOMBSTONE_MAX) {
    const oldest = terminalRunTombstones.keys().next().value;
    if (oldest !== undefined) {
      terminalRunTombstones.delete(oldest);
    }
  }
}

function isTerminalRunTombstoned(runId: string, now = Date.now()): boolean {
  const id = runId.trim();
  if (!id) {
    return false;
  }
  const at = terminalRunTombstones.get(id);
  if (at === undefined) {
    return false;
  }
  if (now - at > TERMINAL_RUN_TOMBSTONE_TTL_MS) {
    terminalRunTombstones.delete(id);
    return false;
  }
  return true;
}

// 记录 own-run 终态（final/aborted/error 分支在清 run 态前调用）：
// chatTerminalRun（等长滞后判定用，必须抢在 resetChatStreamState 清 startedAt 前）、
// tombstone（迟到的在途声明拒收养）、补拉预算换轮（新一轮终态重新获得满额预算）。
function noteRunTerminal(state: ChatState, runId: string | null, startedAt: number | null) {
  if (!runId) {
    return;
  }
  state.chatTerminalRun = { runId, startedAt: startedAt ?? Date.now() };
  recordTerminalRunTombstone(runId);
  noteStaleRetryNewRound(state.sessionKey, runId);
}

// 列表是否已含某终态 run 的回复：优先 runId 精确匹配（内核终态条目带 runId 时
// 无歧义），时间戳兜底（与本端回声同源，规则见 stream-recovery.hasAssistantReplyAfter；
// 合成占位 cryoclawPartial 计入，合成错误卡 cryoclawError 不计）。
function historyHasRunReply(messages: unknown[], run: { runId: string; startedAt: number }): boolean {
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as Record<string, unknown> | undefined;
      if (m?.role !== "assistant") {
        continue;
      }
      if (typeof m.runId === "string" && m.runId === run.runId) {
        return true;
      }
    }
  }
  return hasAssistantReplyAfter(messages, run.startedAt);
}

// strip 归属判定的时钟容忍：内核中途落盘条目的时间戳来自内核侧，与本端 run 起点
// （本地 Date.now()）存在正常时钟偏移（数十 ms 级）。只把明确早于「起点 − 容忍」
// 的条目判为上一轮回复（分钟级旧物），其余仍按同文/前缀剔除。
const STRIP_OWNERSHIP_CLOCK_TOLERANCE_MS = 5_000;

/**
 * Bug1-A：run 在途期间内核 progressive persist 会落盘 assistant 中间产物；静默/滞后
 * 历史拉取（seq-gap/45s 预对齐/180s 看门狗/补拉）把它整体替换进 chatMessages，
 * 与流式气泡同屏双份。本纯函数在替换前从 fresh 列表剔除「与当前流式全量文本
 * （frozenPrefix + 可见正文）同文或为其前缀」的尾部 assistant 条目——只动尾部
 * 连续命中段，更早的合法回复（含前缀相同但中间夹了其他消息的条目）不受影响。
 *
 * 启用条件：内核显式声明本 run 在途（inFlightRun.runId === 本地活跃 runId）——
 * 终态后的历史替换不含此形态条目（终态回复由历史承载、流已清，activeRunId 为
 * null 时本函数恒 no-op）。会话切换回来收养在途 run 的路径天然受益：收养后
 * activeRunId 即声明 runId，同列表里的中途落盘产物在此被剔除，不再与收养流双份。
 */
export function stripInFlightStreamDuplicates(
  messages: unknown[],
  inFlightRunId: string | null | undefined,
  activeRunId: string | null,
  frozenPrefix: string,
  streamText: string,
  runStartedAtMs?: number | null,
): unknown[] {
  const declared = typeof inFlightRunId === "string" ? inFlightRunId.trim() : "";
  if (!declared || !activeRunId || declared !== activeRunId) {
    return messages;
  }
  const full = (frozenPrefix ?? "") + (streamText ?? "");
  if (!full.trim()) {
    return messages;
  }
  const out = [...messages];
  while (out.length > 0) {
    const last = out[out.length - 1] as Record<string, unknown> | undefined;
    if (last?.role !== "assistant") {
      break;
    }
    const text = extractText(last)?.trim();
    if (!text) {
      break;
    }
    // 同文（持久化追平流式）或为其前缀（中途产物）：流式气泡是这些内容当前的
    // 唯一渲染源，历史副本剔除防双份。反向（持久化比流式更长）不动——那可能是
    // 内核已领先的真实内容，剔除会丢可见文本。
    if (full !== text && !full.startsWith(text)) {
      break;
    }
    // 归属判定：时间戳早于「本轮 run 起点 − 时钟容忍」的条目是上一轮的合法回复——
    // 即使文本恰为当前流的前缀（「好的。」类短确认极常见）也不得剔除（fresh 快照
    // 滞后缺本轮 user 回声、尾部停在上一轮回复时，等长放行/compaction 分支会把
    // 上一轮回复误当中途产物出局，直到下次刷新才恢复）。无时间戳的条目维持原判定。
    if (
      typeof runStartedAtMs === "number" &&
      Number.isFinite(runStartedAtMs) &&
      typeof last.timestamp === "number" &&
      Number.isFinite(last.timestamp) &&
      (last.timestamp as number) < runStartedAtMs - STRIP_OWNERSHIP_CLOCK_TOLERANCE_MS
    ) {
      break;
    }
    out.pop();
  }
  return out;
}

// Bug2-1 等长滞后的内容判定（raw.length === 本地长度、mergeIfStale、存在本 run
// 终态记录）：fresh 缺本终态 run 的回复时——
// - 本地有（final 合成占位/已收敛真回复）→ 滞后：保留本地 + 补拉，不得停补拉；
// - 双方都无（空回复终态等）→ 放行替换：此时尾部消息（乐观回声 vs 内核副本）的
//   时间戳差异是合法噪音，判滞后会永久挡住收敛（「终端刷新首次拉到真历史应放行」
//   由 historyHasRunReply(raw) 命中分支保证——fresh 含回复即非滞后）。
// fresh 侧的「本终态 run 回复已落盘」判定：runId 精确命中，或带 stopReason 终态
// 标记且时间戳晚于 run 起点（对齐 historyAlreadyHasRunReply 有 startedAt 档的从严
// 判定）。刻意不用裸时间戳兜底：run 期间 progressive persist 的中途产物时间戳同样
// 晚于起点，命中会把滞后快照误判为「已含回复」→ 本地全文占位被中途产物顶掉且补拉
// 被取消（截断窗口到看门狗/下一轮才收敛）。
function freshHasTerminalRunReply(
  messages: unknown[],
  run: { runId: string; startedAt: number },
): boolean {
  if (!Array.isArray(messages)) {
    return false;
  }
  const threshold = run.startedAt - 1000;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown> | undefined;
    if (m?.role !== "assistant") {
      continue;
    }
    if (typeof m.runId === "string" && m.runId === run.runId) {
      return true;
    }
    if (typeof m.stopReason === "string" && m.stopReason) {
      const ts = typeof m.timestamp === "number" ? m.timestamp : Number.NaN;
      if (Number.isFinite(ts) && ts >= threshold) {
        return true;
      }
    }
  }
  return false;
}

function isStaleEqualLengthSnapshot(state: ChatState, raw: unknown[]): boolean {
  const terminal = state.chatTerminalRun;
  if (!terminal || !Number.isFinite(terminal.startedAt)) {
    return false;
  }
  if (freshHasTerminalRunReply(raw, terminal)) {
    return false;
  }
  // 本地侧保留裸时间戳兜底：aborted/error 的 partial 占位不带 runId，只能靠
  // 「run 起点后有 assistant 回复」判定本地已有回复（fresh 侧已按终态证据从严）
  return historyHasRunReply(state.chatMessages, terminal);
}

/**
 * 会话切换回来 / 窗口刷新 / 重连后的在途 run 恢复（用户反馈 R59）。
 *
 * 这些路径都会清掉本地 run 态（applySessionKeyTransition / onHello），此后内核仍在
 * 跑的 run 的 delta 因「无本地活跃 run」被当作别家 run（sub-agent/其他客户端/迟到帧）
 * 丢弃（handleChatEvent 的僵尸帧过滤），任务消息输出与 Stop 按钮都不再恢复。
 * 内核快照带 runId + 全量累计文本，借此重建流式状态：后续 delta 与 chatRunId 匹配
 * 自然续显；本地已有活跃 run 时不覆盖（快照只用于恢复丢失的 run 态）。
 */
/**
 * R6：历史（本地旧列表 + 本次拉取的新列表）是否已含本 run 的 assistant 终态回复。
 * 有 → 终态帧丢失但结果已持久化，收养 inFlightRun 快照会让快照累计文本与历史
 * 回复双份显示。判定分两档：
 * - runId 精确匹配（两档通用）：内核 transcript 条目带 runId 时直接命中——
 *   这是唯一无歧义的"本 run 已落终态"证据；
 * - 时间戳兜底（仅当快照缺 startedAt 时启用）：退化为「run 开始后的 assistant
 *   回复」判定（与挂起流看门狗同一规则）。有 startedAt 时不用它——run 期间内核
 *   会落盘中间产物（progressive persist、子代理公告），时间戳上它们与终态回复
 *   不可区分，靠它拒收养会把仍在途的 run 误判为已结束（切会话回来流式断掉）。
 *   有 startedAt 时改用「终态标记」判定：仅当命中消息带 stopReason（内核终态
 *   条目标记）才拒收；若内核终态条目不落 stopReason，此档退化为 runId-only——
 *   方向安全：终态帧丢失时偶尔双份显示，胜过误拒收养导致流式永久中断。
 */
function historyAlreadyHasRunReply(
  state: ChatState,
  freshMessages: unknown[],
  runId: string,
  startedAt: number,
  useTimestampFallback: boolean,
): boolean {
  for (const list of [freshMessages, state.chatMessages]) {
    if (!Array.isArray(list)) continue;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i] as Record<string, unknown> | undefined;
      if (m?.role !== "assistant") continue;
      if (typeof m.runId === "string" && m.runId === runId) return true;
    }
  }
  if (useTimestampFallback) {
    return (
      hasAssistantReplyAfter(freshMessages, startedAt) ||
      hasAssistantReplyAfter(state.chatMessages, startedAt)
    );
  }
  // 终态标记判定：仅 stopReason -bearing 的 assistant 消息才算"本 run 终态已落盘"。
  const threshold = startedAt - 1000;
  for (const list of [freshMessages, state.chatMessages]) {
    if (!Array.isArray(list)) continue;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i] as Record<string, unknown> | undefined;
      if (m?.role !== "assistant") continue;
      if (typeof m.stopReason !== "string" || !m.stopReason) continue;
      const ts = typeof m.timestamp === "number" ? m.timestamp : Number.NaN;
      if (Number.isFinite(ts) && ts >= threshold) return true;
    }
  }
  return false;
}

function adoptInFlightRunFromHistory(
  state: ChatState,
  snapshot: InFlightRunSnapshot | null | undefined,
  freshMessages?: unknown[],
): boolean {
  if (!snapshot || typeof snapshot !== "object") {
    return false;
  }
  const runId = typeof snapshot.runId === "string" ? snapshot.runId.trim() : "";
  if (!runId || state.chatRunId) {
    return false;
  }
  // Bug2-3：该 runId 已在本端收过终态帧——内核无 TTL 快照缓存可让迟到响应仍声明
  // 它在途，收养会把已终态 run 复活成僵尸流（气泡/Stop 挂起直到看门狗）。拒收。
  if (isTerminalRunTombstoned(runId)) {
    debugLog("lifecycle", "in-flight run adoption skipped: run already terminated", { runId });
    return false;
  }
  const hasKernelStartedAt =
    typeof snapshot.startedAt === "number" && Number.isFinite(snapshot.startedAt);
  const startedAt = hasKernelStartedAt ? (snapshot.startedAt as number) : Date.now();
  // R6：历史已含本 run 回复（终态帧丢失但已持久化）→ 不收养，历史是唯一渲染源。
  // 有内核 startedAt 时关闭时间戳兜底（run 中途落盘产物与终态回复时间戳不可区分，
  // 靠它拒收养会误杀仍在途的 run），仅 runId 精确匹配 / stopReason 终态标记生效。
  if (historyAlreadyHasRunReply(state, freshMessages ?? [], runId, startedAt, !hasKernelStartedAt)) {
    debugLog("lifecycle", "in-flight run adoption skipped: reply already in history", { runId });
    return false;
  }
  state.chatRunId = runId;
  // 空文本 → 流式气泡降级为思考/工具阶段指示（oc-chat-stream 语义），同样标志 run 活跃
  state.chatStream = typeof snapshot.text === "string" ? snapshot.text : "";
  state.chatStreamFrozenPrefix = "";
  state.chatStreamStartedAt = startedAt;
  state.chatLastActivityAt = Date.now();
  debugLog("lifecycle", "in-flight run adopted from chat.history", { runId });
  return true;
}

export async function loadChatHistory(
  state: ChatState,
  opts?: { mergeIfStale?: boolean; silent?: boolean },
): Promise<ChatHistoryLoadResult> {
  if (!state.client || !state.connected) {
    return null;
  }
  const requestSessionKey = state.sessionKey;
  cancelChatHistoryHydration(state);
  const requestSeq = ++loadChatHistorySeq;
  const generation = opts?.silent ? null : ++loadChatHistoryGeneration;
  // silent：看门狗/重连探测等静默对齐路径不置加载态——视图层只要 chatLoading 为真
  // 就在消息线程顶部渲染「加载中」，探测每 30s 一次会闪屏；且置位后若被并发的常规加载
  // 交错，还会把常规加载的加载态提前清掉。
  if (!opts?.silent) {
    state.chatLoading = true;
    lastNonSilentLoadSeq = requestSeq;
  }
  state.lastError = null;
  try {
    const res = await state.client.request<{
      messages?: Array<unknown>;
      thinkingLevel?: string;
      inFlightRun?: InFlightRunSnapshot;
    }>(
      "chat.history",
      {
        sessionKey: requestSessionKey,
        limit: 200,
      },
    );
    if (state.sessionKey !== requestSessionKey) {
      return null;
    }
    // 被更新的非 silent 加载取代：旧响应不得写回（防旧快照覆盖新快照）。
    if (generation !== null && generation !== loadChatHistoryGeneration) {
      return null;
    }
    // Bug2-3：探测期间已有更新的非 silent 加载发起过——本 silent 响应是迟到读，
    // 丢弃写回（含 inFlightRun 收养），防把非 silent 刚写回的真实历史盖回旧快照、
    // 或把已终态 run 收养成僵尸流。取舍：inFlightRun 权威信号一并丢弃，探测调用方
    // （预对齐/看门狗/orphan）按「未知」处理，其 run 身份复查与会话守卫已圈住风险。
    if (opts?.silent && lastNonSilentLoadSeq > requestSeq) {
      return null;
    }
    // 权威在途声明尽早取出：下方 mergeIfStale 滞后保留分支会提前 return，
    // 探测调用方在该分支同样需要 inFlightRun 做"中途落盘 vs 终态回复"判定。
    const result: ChatHistoryLoadResult = { inFlightRun: res.inFlightRun };
    const raw = Array.isArray(res.messages) ? res.messages : [];
    // 在途 run 收养放在会话守卫之后、滞后读保留分支之前：inFlightRun 来自内核侧
    // 实时 abort-controller 表（与消息列表的持久化快照无关），即便消息列表命中滞后
    // 读走「保留本地」分支，run 态恢复也应生效（重连 mergeIfStale 路径同样受益）。
    // R6：传入本次拉取的新消息列表——历史里已含本 run 回复时拒绝收养（双份防护）。
    adoptInFlightRunFromHistory(state, res.inFlightRun, raw);
    // R12：终态刷新可能命中内核 chat.history 的滞后读（主会话实测，拉取结果落后一个回合），
    // 此时若拉取条数少于本地视图（刚结束回合的消息尚未进入快照），保留本地消息列表，
    // 等待下一次刷新收敛——避免用户可见的消息短暂“消失”。仅 mergeIfStale 调用方启用
    // （turn 终态刷新）；会话切换/回放等替换语义的调用方不受影响。
    // 例外：raw 含 compaction 标记（__openclaw.kind==="compaction"）说明服务端发生了
    // 上下文压缩，历史合法变短——滞后快照不会“长出”新压缩标记，必须替换而非保留，
    // 否则本地列表恒长于服务端，压缩后的新回复将永远无法上屏。
    // R23：空读同样保护——非重置路径（重置不走 mergeIfStale）拿到空历史是瞬时异常，
    // 保留本地等待下次刷新，防 delta 丢失叠加空读导致整个对话视图被清空。
    const localMessageCount = state.chatMessages?.length ?? 0;
    if (opts?.mergeIfStale && raw.length < localMessageCount) {
      const hasCompactionMarker = raw.some(
        (m) =>
          ((m as Record<string, unknown>).__openclaw as Record<string, unknown> | undefined)
            ?.kind === "compaction",
      );
      if (raw.length === 0 || !hasCompactionMarker) {
        // 滞后读保留本地后调度退避补拉（R30），避免「问了没答」要等下轮终态
        scheduleStaleHistoryRetry(state, requestSessionKey);
        return result;
      }
    } else if (
      // Bug2-1：等长滞后。乐观回声（+1）/final 合成占位（再 +1）会让本地与滞后
      // 快照等长，长度判定被绕过——「含 user 不含回复」的缓存快照整体替换会抹掉
      // 刚完成的回复并取消补拉（run 态已清，看门狗/预对齐全失效 → 永久丢失）。
      // 有本 run 终态记录时按内容判定，命中滞后保留本地（合成占位保住可见回复）。
      opts?.mergeIfStale &&
      raw.length === localMessageCount &&
      raw.length > 0 &&
      state.chatTerminalRun &&
      isStaleEqualLengthSnapshot(state, raw)
    ) {
      scheduleStaleHistoryRetry(state, requestSessionKey);
      return result;
    }
    // 替换成功：滞后已收敛，停掉补拉退避
    cancelStaleHistoryRetry();
    // Bug1-A：run 在途且内核显式声明时，fresh 列表尾部与流式全量同文/同前缀的
    // assistant 条目是 progressive persist 中途产物（非终态回复），替换前剔除，
    // 否则与流式气泡同屏双份（会话切换收养在途 run 的路径同此受益）。
    const declaredInFlightRunId =
      typeof res.inFlightRun?.runId === "string" ? res.inFlightRun.runId : null;
    const deduplicated = stripInFlightStreamDuplicates(
      deduplicateDeliveryMirrors(raw),
      declaredInFlightRunId,
      state.chatRunId,
      state.chatStreamFrozenPrefix,
      getActiveChatStreamText(state),
      state.chatStreamStartedAt,
    );
    // 同会话刷新（终态/看门狗/重连的 mergeIfStale 路径）保留可见数——历史只是
    // 追加/更新，重走 20 条渐进注水会让视图先缩回再补回（闪烁 + 上方插入位移）。
    // 渐进注水仅服务「整段替换」的首屏（切会话/重置/首次加载）。
    // 注意：两个条件都必须在 state.chatMessages 被替换之前读取旧值。
    // priorCount < 旧长度说明视图尚未完全展开（注水未完成），不保留，
    // 否则会把本应逐帧补出的消息一次性全量渲染（失去首屏防卡顿的意义）。
    const priorCount = state.chatVisibleMessageCount;
    const keepCount =
      Boolean(opts?.mergeIfStale) &&
      priorCount > 0 &&
      priorCount >= state.chatMessages.length;
    state.chatMessages = deduplicated;
    if (keepCount) {
      // 新历史比先前可见数长时，新增消息立即可见（无需再挂注水）。
      state.chatVisibleMessageCount = Math.max(priorCount, deduplicated.length);
    } else {
      state.chatVisibleMessageCount = Math.min(
        deduplicated.length,
        INITIAL_CHAT_HISTORY_RENDER_COUNT,
      );
      scheduleChatHistoryHydration(state, requestSessionKey, deduplicated.length);
    }
    state.chatThinkingLevel = res.thinkingLevel ?? null;
    return result;
  } catch (err) {
    if (state.sessionKey !== requestSessionKey) {
      return null;
    }
    state.lastError = String(err);
    return null;
  } finally {
    // silent 路径从未置位，不得在此回写 false：否则会清掉并发常规加载刚置起的加载态。
    // 代际守卫同理：被更新的加载取代时，清位留给最新一代的 finally。
    if (
      state.sessionKey === requestSessionKey &&
      !opts?.silent &&
      (generation === null || generation === loadChatHistoryGeneration)
    ) {
      state.chatLoading = false;
    }
  }
}

function dataUrlToBase64(dataUrl: string): { content: string; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    return null;
  }
  return { mimeType: match[1], content: match[2] };
}

export async function sendChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
  thinkingLevel?: string | null,
  // preserveRunState：队列「立即发送」在 run 活跃时直发 chat.send（内核注册为优先
  // followup，沿用当前 runId），不能覆盖 chatRunId/chatStream 等本轮流式状态，
  // 否则进行中的 agent 事件会因 runId 不匹配被过滤层全部丢弃。
  opts?: {
    preserveRunState?: boolean;
    // out 参数：附件读取窗口内切换了会话时置 true。返回的 runId 带不出该信号，
    // 调用方（app-chat.ts）据此跳过 last-active 写回等旧会话归属操作
    sessionChangedDuringRead?: { value: boolean };
  },
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  // 会话归属快照（R64 审查 P1）：必须在首个 await（下方附件读取循环，单文件可达
  // 16MB、数百毫秒窗口）之前取。窗口内用户切换会话后，若无快照守卫：chat.send 会
  // 发进新会话、乐观气泡 append 进新会话消息流、run 态覆写新会话的流式状态。
  const requestSessionKey = state.sessionKey;
  // 先占住 busy 位再进入附件读取 await 窗口：期间队列「立即发送」等并发路径
  // 会经 isChatBusy() 判断（否则可能以 preserveRunState:false 直发并覆盖本轮流式状态）
  state.chatSending = true;
  // 分离图片附件和文件路径附件
  const imageAttachments = attachments?.filter((a) => a.dataUrl) ?? [];
  const fileAttachments = attachments?.filter((a) => a.filePath && !a.dataUrl) ?? [];
  const hasImages = imageAttachments.length > 0;
  const hasFiles = fileAttachments.length > 0;

  // 文件附件：逐个读本地文件转 base64 走 apiAttachments（type:"file"，内核 offload 到
  // media store，transcript 落 MediaPaths，刷新后附件卡片不丢）；读取失败/超过 16MB
  // 上限的降级为旧版文本前缀（路径拼进消息文本），不阻断发送。
  // 乐观气泡 MediaPaths/MediaTypes 只含成功编码进 apiAttachments 的文件（平行数组）；
  // 降级进文本前缀的文件不进 MediaPaths——否则同一路径既出现在文本前缀又渲染附件卡片。
  const echoMediaPaths: string[] = [];
  const echoMediaTypes: string[] = [];
  const fileApiAttachments: Array<{
    type: "file";
    mimeType: string;
    fileName: string;
    content: string;
  }> = [];
  const degradedFilePaths: string[] = [];
  // 内核 WS 单帧上限 25MB（MAX_PAYLOAD_BYTES）：图片+文件附件的 base64 共享同一帧预算，
  // 累计将超 ~23MB 时后续文件自动降级文本前缀（防多附件一起发必然失败、重发死循环）。
  const ATTACHMENT_FRAME_BUDGET_BYTES = 23 * 1024 * 1024;
  let frameBudgetUsed = imageAttachments.reduce(
    (sum, att) => sum + (typeof att.dataUrl === "string" ? att.dataUrl.length : 0),
    0,
  );
  for (const att of fileAttachments) {
    const p = att.filePath!;
    const displayName = att.name || p.split(/[\\/]/).pop() || p;
    try {
      const res = await readFileBase64(p);
      if ("base64" in res && frameBudgetUsed + res.base64.length <= ATTACHMENT_FRAME_BUDGET_BYTES) {
        frameBudgetUsed += res.base64.length;
        fileApiAttachments.push({
          type: "file",
          mimeType: res.mimeType,
          fileName: displayName,
          content: res.base64,
        });
        echoMediaPaths.push(p);
        echoMediaTypes.push(res.mimeType);
      } else {
        // too-large/累计帧预算超限等：降级文本前缀
        degradedFilePaths.push(p);
        showToastGlobal(t("chat.attachmentFallbackPath").replace("{name}", displayName));
      }
    } catch {
      degradedFilePaths.push(p);
      showToastGlobal(t("chat.attachmentFallbackPath").replace("{name}", displayName));
    }
  }
  const filePrefix = degradedFilePaths.length > 0
    ? degradedFilePaths.join("\n") + "\n\n"
    : "";
  const msg = (filePrefix + message).trim();

  const hasAttachments = hasImages || hasFiles;
  if (!msg && !hasAttachments) {
    state.chatSending = false;
    return null;
  }

  const now = Date.now();
  // 附件读取在途期间已切换会话：消息仍发往原会话（requestSessionKey），但本地
  // echo/run 态不写入——当前视图是新会话，写旧会话内容会污染其消息流与流式状态；
  // 切回原会话时由 loadChatHistory 从服务端刷新重建视图。
  const sessionChangedDuringRead = state.sessionKey !== requestSessionKey;
  if (opts?.sessionChangedDuringRead) {
    opts.sessionChangedDuringRead.value = sessionChangedDuringRead;
  }

  // 构建用户消息内容块（用于本地 UI 显示）
  const contentBlocks: Array<{ type: string; text?: string; source?: unknown }> = [];
  if (msg) {
    contentBlocks.push({ type: "text", text: msg });
  }
  if (hasImages) {
    for (const att of imageAttachments) {
      contentBlocks.push({
        type: "image",
        source: { type: "base64", media_type: att.mimeType, data: att.dataUrl },
      });
    }
  }

  // 保留乐观气泡的对象引用：失败路径据此撤掉（preserveRunState）或打标记（供重发识别）
  // MediaPaths/MediaTypes（本地原始 filePath 平行数组）与内核 transcript/history 的
  // 顶层字段同构，grouped-render 据此为乐观气泡与历史消息渲染同一份附件卡片。
  const echoMessage = {
    role: "user",
    content: contentBlocks,
    timestamp: now,
    ...(hasFiles && echoMediaPaths.length > 0 ? { MediaPaths: [...echoMediaPaths], MediaTypes: [...echoMediaTypes] } : {}),
  };
  if (!sessionChangedDuringRead) {
    state.chatMessages = [...state.chatMessages, echoMessage];
    state.chatVisibleMessageCount = state.chatMessages.length;
    cancelChatHistoryHydration(state);
  }

  state.chatSending = true;
  state.lastError = null;
  const runId = generateUUID();
  if (!opts?.preserveRunState && !sessionChangedDuringRead) {
    // 用户发起新 run：此前的重连 orphan 快照作废（防旧 run 的迟到帧被误收养进新 run）
    clearReconnectOrphanRun();
    state.chatRunId = runId;
    state.chatStream = "";
    state.chatStreamStartedAt = now;
    state.chatLastActivityAt = now;
    state.chatStreamFrozenPrefix = "";
    // R5：交叉校验计数随新 run 清零（此前只有终态清零，新 run 会继承上一 run 的计数）
    state.chatStreamMismatchCount = 0;
    // 上一轮中止在途标记不得带入新 run（其终态若丢在断连窗口，残留标记会
    // 把本轮 Stop 按钮全程禁用）
    state.chatAbortPending = false;
    // 新一轮 run：上一终态轮的等长滞后判定记录与补拉预算失效（预算按新 run 重新起算）
    state.chatTerminalRun = null;
    noteStaleRetryNewRound(requestSessionKey, runId);
  }

  // 图片 + 文件都走 base64 apiAttachments（文件编码失败/超限的已降级进文本前缀，不在此列）
  const imageApiAttachments = hasImages
    ? imageAttachments
        .map((att) => {
          const parsed = att.dataUrl ? dataUrlToBase64(att.dataUrl) : null;
          if (!parsed) {
            return null;
          }
          return {
            type: "image",
            mimeType: parsed.mimeType,
            content: parsed.content,
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null)
    : [];
  const apiAttachments = [...imageApiAttachments, ...fileApiAttachments];

  try {
    await state.client.request("chat.send", {
      sessionKey: requestSessionKey,
      message: msg,
      deliver: false,
      idempotencyKey: runId,
      attachments: apiAttachments.length > 0 ? apiAttachments : undefined,
      ...(thinkingLevel && thinkingLevel !== "off" ? { thinking: thinkingLevel } : {}),
    });
    return runId;
  } catch (err) {
    const error = String(err);
    // 发送期间已切换会话：旧会话的失败结果不写入新会话状态（切回旧会话时
    // 由 loadChatHistory 从服务端刷新重建视图）
    if (state.sessionKey !== requestSessionKey) {
      return null;
    }
    if (!opts?.preserveRunState) {
      state.chatRunId = null;
      state.chatStream = null;
      state.chatStreamStartedAt = null;
    }
    if (opts?.preserveRunState) {
      // 队列「立即发送」失败：条目由 sendQueuedMessageNow 放回队列兜底，这里不再向
      // 消息流注入 user 气泡+错误卡（否则与队列条目双份呈现）。撤掉未落盘的乐观
      // 气泡，错误只写 lastError 顶部提示。
      state.chatMessages = state.chatMessages.filter((m) => m !== echoMessage);
      state.chatVisibleMessageCount = state.chatMessages.length;
      state.lastError = error;
      return null;
    }
    // 发送失败的乐观 user 气泡未落盘：打 cryoclawSendFailed 标记，点「重发」时
    // （app-chat-props.ts onResendError）连同错误卡一并移除，防重发后新旧两条
    // user 气泡并存。run 级 error 的 user 气泡已落盘（无标记），不受影响。
    state.chatMessages = state.chatMessages.map((m) =>
      m === echoMessage ? { ...echoMessage, cryoclawSendFailed: true } : m,
    );
    // 不再写 lastError：错误已由下方 cryoclawError 卡片展示，避免与顶部 callout 双显示
    // 附带 resendText：消息未送达（请求失败），渲染层据此提供「重发」入口
    state.chatMessages = [
      ...state.chatMessages,
      {
        role: "assistant",
        content: [{ type: "text", text: "Error: " + error }],
        timestamp: Date.now(),
        // 渲染层据此走着色错误卡片（grouped-render.ts），而非普通文本气泡
        cryoclawError: true,
        resendText: msg,
        // 重发时带回附件（图片 dataUrl + 文件 filePath），否则重发链路附件整体丢失。
        // 文件附件重发时按 filePath 重新读盘编码；文件已删则自动降级文本前缀。
        // 已降级进 msg 文本前缀的文件不再带回（路径已在文本里，带回会重复编码/重复前缀）。
        ...(hasAttachments
          ? {
              resendAttachments: [
                ...imageAttachments,
                ...fileAttachments.filter((a) => !degradedFilePaths.includes(a.filePath!)),
              ].map((a) => ({ ...a })),
            }
          : {}),
      },
    ];
    state.chatVisibleMessageCount = state.chatMessages.length;
    return null;
  } finally {
    state.chatSending = false;
  }
}

export async function abortChatRun(state: ChatState): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const runId = state.chatRunId;
  try {
    await state.client.request(
      "chat.abort",
      runId ? { sessionKey: state.sessionKey, runId } : { sessionKey: state.sessionKey },
    );
    return true;
  } catch (err) {
    state.lastError = String(err);
    return false;
  }
}

export function handleChatEvent(state: ChatState, payload?: ChatEventPayload) {
  if (!payload) {
    return null;
  }
  if (payload.sessionKey !== state.sessionKey) {
    return null;
  }

  // 无本地活跃 run 时，带 runId 的 delta/error 是别家 run（sub-agent、其他客户端、
  // 迟到帧）的广播：delta 丢弃避免僵尸流式气泡；error 丢弃避免误注入带「重发」的
  // 错误卡（点了会把无关文本发出去）。final/aborted 仍透传以触发历史刷新。
  if (payload.runId && !state.chatRunId) {
    // R30 重连续跑恢复：断连重连后 onHello 清空了本地 run 态，但内核侧 run 可能
    // 仍在跑。断连前快照为 orphan 的 runId，其 delta（全量累计文本，天然可续）
    // 重新收养为当前 run——流式续显、Stop 恢复可用；非 orphan 的一律按僵尸丢弃。
    if (payload.state === "delta" && payload.runId === liveOrphanRunId(state.sessionKey)) {
      state.chatRunId = payload.runId;
      state.chatStreamStartedAt = Date.now();
      state.chatLastActivityAt = Date.now();
      // R6：收养是从零重建 run 态——显式清空上一 run 可能残留的流式文本
      // （chatStream/chatPendingStreamText 理论上已被终态/onHello 清态清掉，
      // 迟到帧/清态遗漏路径下会是脏数据），收养后叠加成双份。
      state.chatStream = "";
      state.chatPendingStreamText = null;
      state.chatStreamFrozenPrefix = "";
      state.chatNarrationText = null;
      state.chatPendingNarrationText = null;
      state.chatStreamMismatchCount = 0;
      debugLog("lifecycle", "orphan run adopted after reconnect", { runId: payload.runId });
      // 收养即恢复链路接管：清 orphan 快照，重连探测（scheduleReconnectOrphanProbe）
      // 的 liveOrphanRunId() 检查随之停摆，不再发冗余静默历史拉取
      clearReconnectOrphanRun(payload.runId, state.sessionKey);
      // 收养后继续走下方 delta 处理
    } else if (payload.state === "delta" || payload.state === "error") {
      return null;
    } else {
      // 终态（final/aborted）透传并清除 orphan 快照；status 等启动进度帧同样
      // 透传（返回值无消费方）但不得清 orphan——误清后该 run 的后续 delta 会被
      // 上方僵尸过滤丢弃，重连恢复链路断裂。
      if (payload.state === "final" || payload.state === "aborted") {
        clearReconnectOrphanRun(payload.runId, state.sessionKey);
        // 外来 run 的终态同样是终态证据： tombstone 之，防其迟到快照被收养。
        recordTerminalRunTombstone(payload.runId);
      }
      return payload.state;
    }
  }

  // Final from another run (e.g. sub-agent announce): refresh history to show new message.
  // See https://github.com/openclaw/openclaw/issues/1909
  if (payload.runId && state.chatRunId && payload.runId !== state.chatRunId) {
    if (payload.state === "final") {
      recordTerminalRunTombstone(payload.runId);
      return "final";
    }
    return null;
  }

  if (payload.state === "delta") {
    const current = state.chatPendingStreamText ?? state.chatStream ?? "";
    const reduced = reduceChatStreamDelta({
      currentText: current,
      deltaText: payload.deltaText,
      replace: payload.replace,
      message: payload.message,
      frozenPrefix: state.chatStreamFrozenPrefix,
      mismatchCount: state.chatStreamMismatchCount,
    });
    if (reduced?.accepted) {
      state.chatPendingStreamText = reduced.text;
      state.chatStreamMismatchCount = reduced.mismatchCount ?? 0;
      state.chatLastActivityAt = Date.now();
      if (reduced.invalidatesFrozenPrefix) {
        // R3：replace 帧越过 tool 边界整体重生成——被改写的冻结段（leadingSegment）
        // 必须从 toolStream 时间线作废，否则与新正文同屏双份；frozenPrefix 也不再
        // 适用于新的累计文本，必须同步清空（reducer 依赖它切片/交叉校验）。
        debugLog("stream", "replace beyond frozen prefix → invalidate frozen segments", {
          runId: payload.runId,
          prefixLen: state.chatStreamFrozenPrefix.length,
        });
        state.onReplaceBeyondFrozenPrefix?.();
        state.chatStreamFrozenPrefix = "";
      }
      if (reduced.text.trim().length > 0) {
        // R4：正文 delta 非空上屏后，此前经 answer_candidate narration 显示的同文本
        // 必须清掉——否则 narration 气泡与正文气泡同文双份（narration 刻意不进 chat
        // delta 广播，上屏时机互不感知，只能靠正文首次非空时收敛）。
        state.chatPendingNarrationText = null;
        state.chatNarrationText = null;
        // R4 补强：live narration 之外，已被 tool start 冻结进时间线的 narrationSegment
        // 同样可能与正文头部同文（answer_candidate → tool start 冻结 → 正文回放）。
        // 携带正文累计全量（frozenPrefix+新正文）交给 app 层作废重复冻结段。
        state.onBodyTextAdoptsNarration?.(
          state.chatStreamFrozenPrefix + reduced.text,
        );
      }
      scheduleChatStreamFlush(state);
      debugLog("stream", "delta accept", {
        source: reduced.source,
        replaced: reduced.replaced,
        currentLen: current.length,
        nextLen: reduced.text.length,
      });
    } else if (reduced) {
      debugLog("stream", "delta drop (out-of-order snapshot)", {
        currentLen: current.length,
        nextLen: reduced.text.length,
      });
    }
  } else if (payload.state === "final") {
    debugLog("lifecycle", "chat:final → reset stream state", { runId: payload.runId });
    clearReconnectOrphanRun(payload.runId, state.sessionKey);
    const terminalRunId = payload.runId || state.chatRunId;
    // Bug2-2：final 会清掉正文流式态，而紧随的终态刷新可能命中内核滞后快照——
    // 等长/短读保留分支（依赖 chatTerminalRun）留住的本地列表里并没有回复全文
    // （回复只存在于即将被清的流式态里），补拉耗尽后同会话永不复位 →「问了没答」。
    // 先把全文以合成 partial 形态注入消息流占位（只存本地、绝不持久化；补拉/刷新
    // 拿到含真回复的历史后随整体替换自然撤掉），保证回复全程可见。
    // noteRunTerminal 必须在 resetChatStreamState 之前（清态会抹 startedAt）。
    // frozenPrefix 是流式气泡全文的一部分（工具前正文冻结在时间线上）：
    // partial 占位必须带上，否则终态后可见回复缺工具前正文，直到补拉收敛。
    const fullText = (state.chatStreamFrozenPrefix + flushPendingChatStream(state)).trim();
    noteRunTerminal(state, terminalRunId, state.chatStreamStartedAt);
    resetChatStreamState(state);
    if (fullText) {
      state.chatMessages = [
        ...state.chatMessages,
        {
          role: "assistant",
          content: [{ type: "text", text: fullText }],
          timestamp: Date.now(),
          // 与 aborted/error 的 partial 保留同形态（渲染层无特殊分支），runId 标记
          // 供等长滞后判定的 historyHasRunReply 精确命中（本地已有本 run 回复）。
          cryoclawPartial: true,
          ...(terminalRunId ? { runId: terminalRunId } : {}),
        },
      ];
      state.chatVisibleMessageCount = state.chatMessages.length;
    }
  } else if (payload.state === "aborted") {
    debugLog("lifecycle", "chat:aborted → reset stream state", { runId: payload.runId });
    clearReconnectOrphanRun(payload.runId, state.sessionKey);
    noteRunTerminal(state, payload.runId || state.chatRunId, state.chatStreamStartedAt);
    // 与 error 路径同一 partial 保留逻辑：中止前已上屏的末段文本若随 reset 丢弃，
    // 而内核又未持久化该末段（abort 时内核同样可能截断持久化），用户可见内容丢失。
    // 注意只保留 partial 文本、不注入错误卡——aborted 的语义是用户主动中止，
    // 与 error 的「失败 + 可重发」不同。
    // 同 final：partial 占位要带上 frozenPrefix（工具前正文在时间线上，只在流式态里）
    const partialText = (state.chatStreamFrozenPrefix + getActiveChatStreamText(state)).trim();
    resetChatStreamState(state);
    if (partialText) {
      state.chatMessages = [
        ...state.chatMessages,
        {
          role: "assistant",
          content: [{ type: "text", text: partialText }],
          timestamp: Date.now(),
          cryoclawPartial: true,
        },
      ];
      state.chatVisibleMessageCount = state.chatMessages.length;
    }
  } else if (payload.state === "error") {
    debugLog("lifecycle", "chat:error → reset stream state", {
      runId: payload.runId,
      err: payload.errorMessage,
    });
    clearReconnectOrphanRun(payload.runId, state.sessionKey);
    noteRunTerminal(state, payload.runId || state.chatRunId, state.chatStreamStartedAt);
    // 同 final：partial 占位要带上 frozenPrefix（工具前正文在时间线上，只在流式态里）
    const partialText = (state.chatStreamFrozenPrefix + getActiveChatStreamText(state)).trim();
    resetChatStreamState(state);
    const error = payload.errorMessage ?? "chat error";
    // Preserve text already shown before the error card. A failed run may not
    // persist its last delta, so dropping it here loses visible content.
    // R17：run 级失败也提供重发入口——从本地消息流恢复最后一条 user 消息文本
    const lastUser = [...state.chatMessages].reverse().find(
      (m) => (m as Record<string, unknown>).role === "user",
    );
    const resendText = lastUser ? (extractText(lastUser) ?? "").trim() : "";
    // 不写 lastError：仅在消息流内注入 cryoclawError 卡片，避免与顶部 callout 双显示。
    // 同步在消息流内注入合成错误消息（cryoclawError → grouped-render 着色卡片），
    // 与 sendChatMessage 失败路径同一形态，对齐 control-ui 的行内错误卡片。
    const terminalMessages: unknown[] = [];
    if (partialText) {
      terminalMessages.push({
        role: "assistant",
        content: [{ type: "text", text: partialText }],
        timestamp: Date.now(),
        cryoclawPartial: true,
      });
    }
    terminalMessages.push({
      role: "assistant",
      content: [{ type: "text", text: "Error: " + error }],
      timestamp: Date.now(),
      cryoclawError: true,
      ...(resendText ? { resendText } : {}),
    });
    state.chatMessages = [...state.chatMessages, ...terminalMessages];
    state.chatVisibleMessageCount = state.chatMessages.length;
  }
  return payload.state;
}
