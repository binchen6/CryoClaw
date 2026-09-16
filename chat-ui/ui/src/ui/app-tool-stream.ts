import { truncateText } from "./format.ts";
import { debugLog } from "./debug.ts";
import { handlePlanToolEvent, UPDATE_PLAN_TOOL_NAME, type PlanStreamHost } from "./plan-stream.ts";
import {
  scheduleChatStreamFlush,
  type ChatState,
} from "./controllers/chat.ts";
import {
  countUnifiedDiffStat,
  parseDiffStat,
  type ToolDiffStat,
} from "./chat/tool-helpers.ts";

const TOOL_STREAM_LIMIT = 50;
// 被 trimToolStream 淘汰的 leadingSegment 段数上限：不设限的话超长 run
// （数百次工具调用）的消息条目会随调用次数线性累积且每个节流帧都重建摊平，
// 流式期间渐进卡顿；超限丢弃最旧段（终态后历史刷新会完整回归）。
const EVICTED_SEGMENTS_LIMIT = 150;
// 淘汰段单段字符上限（R91 性能审查）：只限段数不限长度时，150 × 数十 KB 的
// 长解说段可常驻数 MB；截断无信息丢失（终态后历史刷新完整回归）
const EVICTED_SEGMENT_CHAR_LIMIT = 12_000;
const TOOL_STREAM_THROTTLE_MS = 80;
const TOOL_OUTPUT_CHAR_LIMIT = 120_000;

export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  sessionKey?: string;
  data: Record<string, unknown>;
};

// 每次新 tool call 到来时，把当前在打字的 assistant 文本冻结成一段，挂在这条 tool entry 上。
// 这样渲染时能按"上一段文本 → tool call → tool result → 下一段文本 …"的时间序展开，
// 与 gateway 写进 transcript 的消息形态保持一致（history 加载后也是这样分开展示）。
// renderMessage：该段摊平进 chatToolMessages 时用的包装消息，构建一次后复用同一对象
// （R72：每 80ms tick 重建时间线时若段消息每次都是新对象，下游按消息引用的
// WeakMap 派生缓存会全部落空，工具密集 run 期间派生计算退化为每 tick 全量重算）。
export type StreamSegment = {
  text: string;
  ts: number;
  renderMessage?: Record<string, unknown>;
};

export type ToolStreamEntry = {
  toolCallId: string;
  runId: string;
  sessionKey?: string;
  name: string;
  args?: unknown;
  output?: string;
  // result 阶段从 data.isError 捕获（宽容解析：仅 true 算失败）
  isError?: boolean;
  // R52 T4：diff 行数统计。input_delta 阶段为实时值（内核 250ms 节流上报），
  // result 阶段被 details.diff 解析出的最终统计替换；details 无 diff 时清除
  // （对齐 control-ui liveDiffStat 生命周期：result 到达即清实时徽标）。
  diffStat?: ToolDiffStat;
  // R52 T4：result 阶段的内核错误摘要（data.toolErrorSummary，内核侧
  // TOOL_ERROR_MAX_CHARS=400 截断），失败卡优先展示它而非裸输出开头。
  toolErrorSummary?: string;
  // R52 T4：exec 类工具退出码（data.result.exitCode，宽容解析整数）。
  exitCode?: number;
  startedAt: number;
  updatedAt: number;
  // 该 tool 之前冻结下来的 assistant 文本（若有）。只会设一次，就在 entry 创建那一刻。
  leadingSegment?: StreamSegment;
  // R88 中途解说段（agent 事件 stream:"item" kind:"preamble" 的 progressText）：
  // 内核刻意不把 narration 并入 chat delta 广播，本字段把它按时间序冻结进时间线，
  // 渲染顺序 narrationSegment → leadingSegment → callMessage。
  narrationSegment?: StreamSegment;
  // R83 合并展示：一次工具调用只产一条 message（assistant 气泡 + 内联 tool 卡）。
  // result 到达后把输出/错误/退出码/diff 并入 call 内容块重建本消息，不再单独发
  // role=toolResult 气泡——同一次调用的输入（命令/参数）与输出（结果）在同一张卡。
  callMessage: Record<string, unknown>;
};

type ToolStreamHost = {
  sessionKey: string;
  chatRunId: string | null;
  toolStreamById: Map<string, ToolStreamEntry>;
  toolStreamOrder: string[];
  // 已摊平的时间线：segment text / call msg / result msg 混合，供渲染直接 iterate。
  chatToolMessages: Record<string, unknown>[];
  toolStreamSyncTimer: number | null;
  // 当前在打字的 assistant 文本（尚未被任何 tool call 触发冻结，只有这一段闪红光）
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  // handleChatEvent delta 走 raf 节流，pending 是下一帧要写进 chatStream 的值
  chatPendingStreamText: string | null;
  // 已被 leadingSegment 冻结的累计前缀。每次冻结要把当前 chatStream 增量并入；
  // controllers/chat.ts 的 delta handler 用它从"累计文本"里切片出新段。
  chatStreamFrozenPrefix: string;
  // 最后一次流式活动时间戳（挂起流看门狗锚点；可选以兼容测试替身）
  chatLastActivityAt?: number | null;
  // R88 思考流式（chatThinkingStream 及其 pending）与中途解说（chatNarrationText
  // 及其 pending）：字段定义见 controllers/chat.ts ChatState。可选以兼容测试替身。
  chatThinkingStream?: string | null;
  chatPendingThinkingText?: string | null;
  chatNarrationText?: string | null;
  chatPendingNarrationText?: string | null;
  // R88 seq-gap agent 错误事件（stream:"error" reason:"seq gap"）触发的历史对齐钩子
  onStreamSeqGap?: () => void;
  // 被 trimToolStream 淘汰的 entry 上的 leadingSegment 要保留下来，否则一轮工具调用很多时
  // （超过 TOOL_STREAM_LIMIT），早期段会被一起删掉，渲染层只剩 chatStream 的尾段，让用户看着像"开头丢了"。
  evictedLeadingSegments: StreamSegment[];
};

function extractToolOutputText(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  const content = record.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const entry = item as Record<string, unknown>;
      if (entry.type === "text" && typeof entry.text === "string") {
        return entry.text;
      }
      return null;
    })
    .filter((part): part is string => Boolean(part));
  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n");
}

function formatToolOutput(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const contentText = extractToolOutputText(value);
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (contentText) {
    text = contentText;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      // oxlint-disable typescript/no-base-to-string
      text = String(value);
    }
  }
  const truncated = truncateText(text, TOOL_OUTPUT_CHAR_LIMIT);
  if (!truncated.truncated) {
    return truncated.text;
  }
  return `${truncated.text}\n\n… truncated (${truncated.total} chars, showing first ${truncated.text.length}).`;
}

// 构造 tool call 消息：**不挂 toolCallId 到顶层**。
// 挂了的话 normalizeMessage 会把它归类成 toolResult，渲染走无气泡的 renderCollapsedToolCards 路径；
// 不挂则 role 保持 assistant → 走正常气泡分支，tool card 以折叠形式嵌在气泡里（和 history 一致）。
// R83：result 到达后（entry.output 有值），输出文本与 isError/toolErrorSummary/exitCode
// 直接并入同一个 toolCall 内容块——渲染层从块上读到这些字段即得「输入+输出」合并卡。
function buildToolCallMessage(entry: ToolStreamEntry): Record<string, unknown> {
  const hasResult = entry.output !== undefined;
  return {
    role: "assistant",
    runId: entry.runId,
    content: [
      {
        type: "toolCall",
        id: entry.toolCallId,
        name: entry.name,
        arguments: entry.args ?? {},
        // R52 T4：实时/最终 diff 统计随 call 内容块进渲染层（extractToolCards 读 item.diffStat）
        ...(entry.diffStat ? { diffStat: { ...entry.diffStat } } : {}),
        // R83：result 载荷并入（字段形态与 toolResult block 对齐，渲染层统一读取）
        ...(hasResult
          ? {
              text: entry.output ?? "",
              ...(entry.isError === true ? { isError: true } : {}),
              ...(entry.toolErrorSummary ? { toolErrorSummary: entry.toolErrorSummary } : {}),
              ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
            }
          : {}),
      },
    ],
    timestamp: entry.startedAt,
    // 尚无 result 的 call 标记为 pending → 渲染层显示「执行中」而非「已完成」。
    // result 到达后 callMessage 会被重建（块上带输出），此标记随之消失；
    // 历史消息无此字段（历史合并见 cc-chat-history.ts::mergeToolResultHistory），不受影响。
    ...(hasResult ? {} : { pending: true }),
  };
}

// ── R52 T4：result 阶段附加字段的宽容解析 ──

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

// exec 退出码：内核挂在 result 对象上（control-ui 消费端 h(r.result).exitCode 确证），
// 兜底再看 data 顶层。
function extractExitCode(data: Record<string, unknown>): number | undefined {
  const result = data.result;
  if (result && typeof result === "object") {
    const fromResult = asInteger((result as Record<string, unknown>).exitCode);
    if (fromResult !== undefined) {
      return fromResult;
    }
  }
  return asInteger(data.exitCode);
}

// 最终 diff 统计：优先 details 里的数值型 stat（宽容探测），
// 否则解析 details.diff 统一 diff 文本计数（control-ui 的最终统计来源）。
function extractResultDiffStat(result: unknown): ToolDiffStat | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const details = (result as Record<string, unknown>).details;
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const record = details as Record<string, unknown>;
  const numeric = parseDiffStat(record.diffStat) ?? parseDiffStat(record.stat);
  if (numeric) {
    return numeric;
  }
  return countUnifiedDiffStat(record.diff);
}

function trimToolStream(host: ToolStreamHost) {
  if (host.toolStreamOrder.length <= TOOL_STREAM_LIMIT) {
    return;
  }
  const overflow = host.toolStreamOrder.length - TOOL_STREAM_LIMIT;
  const removed = host.toolStreamOrder.splice(0, overflow);
  for (const id of removed) {
    const entry = host.toolStreamById.get(id);
    for (const seg of [entry?.narrationSegment, entry?.leadingSegment]) {
      if (seg && seg.text.trim().length > 0) {
        // 把这条 entry 上的 leading 文本搬到 sticky 列表，渲染时仍能看到（顺序在最前面）。
        // 超长段截断（R91）：sticky 列表只为保时间线可读，整段内容终态后由历史回归
        host.evictedLeadingSegments.push(
          seg.text.length > EVICTED_SEGMENT_CHAR_LIMIT
            ? { ...seg, text: truncateText(seg.text, EVICTED_SEGMENT_CHAR_LIMIT).text }
            : seg,
        );
        if (host.evictedLeadingSegments.length > EVICTED_SEGMENTS_LIMIT) {
          host.evictedLeadingSegments.splice(
            0,
            host.evictedLeadingSegments.length - EVICTED_SEGMENTS_LIMIT,
          );
        }
        debugLog("tool", "evict tool entry, retain leadingSegment", {
          toolCallId: id,
          segmentLen: seg.text.length,
          evictedTotal: host.evictedLeadingSegments.length,
        });
      }
    }
    host.toolStreamById.delete(id);
  }
}

function segmentRenderMessage(seg: StreamSegment): Record<string, unknown> {
  seg.renderMessage ??= {
    role: "assistant",
    content: [{ type: "text", text: seg.text }],
    timestamp: seg.ts,
  };
  return seg.renderMessage;
}

function syncToolStreamMessages(host: ToolStreamHost) {
  // 摊平成时间线：每条 entry 依次贡献 leadingSegment（若有）→ callMessage（含并入的 result）
  const out: Record<string, unknown>[] = [];
  // 先放被 trim 淘汰的 leadingSegments，保证渲染时序与原本一致（它们时间最早）。
  for (const seg of host.evictedLeadingSegments) {
    if (seg.text.trim().length === 0) continue;
    out.push(segmentRenderMessage(seg));
  }
  for (const id of host.toolStreamOrder) {
    const entry = host.toolStreamById.get(id);
    if (!entry) {
      continue;
    }
    // R88 时间线顺序：解说段 → 冻结正文段 → 工具卡（与 transcript 语义一致）
    if (entry.narrationSegment && entry.narrationSegment.text.trim().length > 0) {
      out.push(segmentRenderMessage(entry.narrationSegment));
    }
    if (entry.leadingSegment && entry.leadingSegment.text.trim().length > 0) {
      out.push(segmentRenderMessage(entry.leadingSegment));
    }
    out.push(entry.callMessage);
  }
  // 内容未变（tick 间无 entry 增改）时保留旧数组引用，让下游引用比较 memo 继续命中
  const prev = host.chatToolMessages;
  if (
    prev.length === out.length &&
    prev.every((item, i) => item === out[i])
  ) {
    return;
  }
  host.chatToolMessages = out;
}

export function flushToolStreamSync(host: ToolStreamHost) {
  if (host.toolStreamSyncTimer != null) {
    clearTimeout(host.toolStreamSyncTimer);
    host.toolStreamSyncTimer = null;
  }
  syncToolStreamMessages(host);
}

export function scheduleToolStreamSync(host: ToolStreamHost, force = false) {
  if (force) {
    flushToolStreamSync(host);
    return;
  }
  if (host.toolStreamSyncTimer != null) {
    return;
  }
  host.toolStreamSyncTimer = window.setTimeout(
    () => flushToolStreamSync(host),
    TOOL_STREAM_THROTTLE_MS,
  );
}

export function resetToolStream(host: ToolStreamHost) {
  host.toolStreamById.clear();
  host.toolStreamOrder = [];
  host.chatToolMessages = [];
  host.evictedLeadingSegments = [];
  // 清掉 frozenPrefix —— 这个 host-level 字段会跨 turn 残留，新 turn 的累计文本完全不该再切旧前缀。
  host.chatStreamFrozenPrefix = "";
  // R88：中途解说随 tool stream 一并清（与 run 级 resetChatStreamState 双保险）
  host.chatNarrationText = null;
  host.chatPendingNarrationText = null;
  flushToolStreamSync(host);
}

export type CompactionStatus = {
  active: boolean;
  startedAt: number | null;
  completedAt: number | null;
};

type CompactionHost = ToolStreamHost & {
  compactionStatus?: CompactionStatus | null;
  compactionClearTimer?: number | null;
};

const COMPACTION_TOAST_DURATION_MS = 5000;

export function handleCompactionEvent(host: CompactionHost, payload: AgentEventPayload) {
  // 与 tool/lifecycle 流一致的会话过滤：其他会话（cron 后台任务、渠道会话、sub-agent）
  // 的压缩事件不得在当前对话页显示提示胶囊
  const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : undefined;
  if (sessionKey && sessionKey !== host.sessionKey) {
    return;
  }
  const data = payload.data ?? {};
  const phase = typeof data.phase === "string" ? data.phase : "";

  // Clear any existing timer
  if (host.compactionClearTimer != null) {
    window.clearTimeout(host.compactionClearTimer);
    host.compactionClearTimer = null;
  }

  if (phase === "start") {
    host.compactionStatus = {
      active: true,
      startedAt: Date.now(),
      completedAt: null,
    };
  } else if (phase === "end") {
    host.compactionStatus = {
      active: false,
      startedAt: host.compactionStatus?.startedAt ?? null,
      completedAt: Date.now(),
    };
    // Auto-clear the toast after duration
    host.compactionClearTimer = window.setTimeout(() => {
      host.compactionStatus = null;
      host.compactionClearTimer = null;
    }, COMPACTION_TOAST_DURATION_MS);
  }
}

export type FallbackNotice = {
  // cleared=false：已切到备用模型；cleared=true：已恢复主模型
  cleared: boolean;
  activeModel: string;
  selectedModel?: string | null;
  previousActiveModel?: string | null;
  reasonSummary?: string | null;
  at: number;
};

type FallbackHost = ToolStreamHost & {
  fallbackNotice?: FallbackNotice | null;
  fallbackClearTimer?: number | null;
};

const FALLBACK_TOAST_DURATION_MS = 5000;

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function clearFallbackNotice(host: FallbackHost) {
  if (host.fallbackClearTimer != null && typeof window !== "undefined") {
    window.clearTimeout(host.fallbackClearTimer);
  }
  host.fallbackClearTimer = null;
  host.fallbackNotice = null;
}

// lifecycle 事件目前只消费 fallback / fallback_cleared（内核模型降级提示），
// 其余 phase 直接忽略。过滤规则与 tool 流一致（sessionKey/runId）。
export function handleLifecycleEvent(host: FallbackHost, payload: AgentEventPayload) {
  const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : undefined;
  if (sessionKey && sessionKey !== host.sessionKey) {
    return;
  }
  if (host.chatRunId && payload.runId !== host.chatRunId) {
    return;
  }
  if (!host.chatRunId) {
    return;
  }

  const data = payload.data ?? {};
  const phase = typeof data.phase === "string" ? data.phase : "";

  let notice: FallbackNotice | null = null;
  if (phase === "fallback") {
    const activeModel = asStringOrNull(data.activeModel);
    if (!activeModel) {
      return;
    }
    notice = {
      cleared: false,
      activeModel,
      selectedModel: asStringOrNull(data.selectedModel),
      reasonSummary: asStringOrNull(data.reasonSummary),
      at: Date.now(),
    };
  } else if (phase === "fallback_cleared") {
    const activeModel = asStringOrNull(data.activeModel);
    if (!activeModel) {
      return;
    }
    notice = {
      cleared: true,
      activeModel,
      previousActiveModel: asStringOrNull(data.previousActiveModel),
      at: Date.now(),
    };
  } else {
    return;
  }

  // node:test 环境没有 window：解析/过滤逻辑仍可测，仅跳过自动消失定时器
  if (host.fallbackClearTimer != null && typeof window !== "undefined") {
    window.clearTimeout(host.fallbackClearTimer);
    host.fallbackClearTimer = null;
  }
  host.fallbackNotice = notice;
  if (typeof window !== "undefined") {
    host.fallbackClearTimer = window.setTimeout(() => {
      host.fallbackNotice = null;
      host.fallbackClearTimer = null;
    }, FALLBACK_TOAST_DURATION_MS);
  }
}

export function handleAgentEvent(host: ToolStreamHost, payload?: AgentEventPayload) {
  if (!payload) {
    return;
  }

  // Handle compaction events
  if (payload.stream === "compaction") {
    handleCompactionEvent(host as CompactionHost, payload);
    return;
  }

  // Handle lifecycle events (model fallback notices)
  if (payload.stream === "lifecycle") {
    handleLifecycleEvent(host as FallbackHost, payload);
    return;
  }

  // R88 seq-gap：内核对 per-run 文本流乱序/丢帧广播 stream:"error"（data.reason
  // === "seq gap"，仅发给 control-ui 可见连接）。此前被静默丢弃——丢掉的 delta
  // 会让后续 append 全部建立在坏基线上。现在触发静默历史对齐；文本基线自愈由
  // chat-stream-reducer 的全量交叉校验完成（下一帧 message 快照纠正）。
  if (payload.stream === "error") {
    const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : undefined;
    if (
      (!payload.sessionKey || sessionKey === host.sessionKey) &&
      (!host.chatRunId || !payload.runId || payload.runId === host.chatRunId)
    ) {
      host.chatLastActivityAt = Date.now();
      debugLog("stream", "agent stream error (seq gap) → resync", payload.data);
      host.onStreamSeqGap?.();
    }
    return;
  }

  // R88 思考流式：内核在 reasoning 产出期间持续广播 stream:"thinking"，
  // data.text 为当前 reasoning phase 的全量累计（2026.9.3 emitReasoningStream：
  // delta 相对上次流式快照的增量，text 已包含 delta），phase 重启时 text 整体变短。
  if (payload.stream === "thinking") {
    const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : undefined;
    if (
      host.chatRunId &&
      (!payload.runId || payload.runId === host.chatRunId) &&
      (!sessionKey || sessionKey === host.sessionKey)
    ) {
      host.chatLastActivityAt = Date.now();
      const data = payload.data ?? {};
      const text = typeof data.text === "string" ? data.text : null;
      const delta = typeof data.delta === "string" ? data.delta : "";
      const prev = host.chatPendingThinkingText ?? host.chatThinkingStream ?? "";
      // text（全量）优先；仅 delta 时本地累计。phase 重启 = text 变短 → 直接替换。
      const next = text !== null ? text : prev + delta;
      if (next.trim().length > 0) {
        host.chatPendingThinkingText = next;
        scheduleChatStreamFlush(host as unknown as ChatState);
      }
    }
    return;
  }

  // R88 中途解说流式：内核把 assistant 的 commentary（工具间解说）投影为
  // stream:"item" kind:"preamble"（data.phase:"update"|"end"，data.progressText
  // 为该段全量扁平文本，data.itemId 区分段落）。该文本刻意不进 chat delta 广播
  // （shouldSuppressAssistantEventForLiveChat：commentary 对 live chat 抑制），
  // 不消费它用户就看不到中途消息的流式输出，只能等 final 后历史刷新才出现。
  if (payload.stream === "item") {
    const data = payload.data ?? {};
    const kind = typeof data.kind === "string" ? data.kind : "";
    if (kind === "preamble" || kind === "answer_candidate") {
      const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : undefined;
      if (
        host.chatRunId &&
        (!payload.runId || payload.runId === host.chatRunId) &&
        (!sessionKey || sessionKey === host.sessionKey)
      ) {
        host.chatLastActivityAt = Date.now();
        // answer_candidate 与 chat delta 的正文流可能并存：正文已在流式时不重复显示
        const liveBody = (
          (host.chatPendingStreamText ?? "") ||
          (host.chatStream ?? "")
        ).trim();
        if (kind === "preamble" || !liveBody) {
          const progressText = typeof data.progressText === "string" ? data.progressText : "";
          if (progressText.trim().length > 0) {
            host.chatPendingNarrationText = progressText;
            scheduleChatStreamFlush(host as unknown as ChatState);
          }
        }
      }
    }
    return;
  }

  if (payload.stream !== "tool") {
    // assistant 流事件：run 仍在活跃的佐证——匹配当前 run 时刷新看门狗锚点，
    // 长回复不被误判为挂起流（thinking/item 已在上方分支处理）。
    if (
      payload.stream === "assistant" &&
      host.chatRunId &&
      (!payload.runId || payload.runId === host.chatRunId) &&
      (!payload.sessionKey || payload.sessionKey === host.sessionKey)
    ) {
      host.chatLastActivityAt = Date.now();
    }
    return;
  }
  const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : undefined;
  if (sessionKey && sessionKey !== host.sessionKey) {
    return;
  }
  // Fallback: only accept session-less events for the active run.
  if (!sessionKey && host.chatRunId && payload.runId !== host.chatRunId) {
    return;
  }
  if (host.chatRunId && payload.runId !== host.chatRunId) {
    return;
  }
  if (!host.chatRunId) {
    return;
  }
  // 通过的 tool 事件即流式活动证据，刷新看门狗锚点
  host.chatLastActivityAt = Date.now();

  const data = payload.data ?? {};
  const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
  if (!toolCallId) {
    return;
  }
  const name = typeof data.name === "string" ? data.name : "tool";
  const phase = typeof data.phase === "string" ? data.phase : "";

  // update_plan 除走常规 tool card 外，额外同步到独立的计划面板状态
  // （toolStream 在 chat 终态会被 reset，计划要跨 turn 保留，故单独存）。
  if (name === UPDATE_PLAN_TOOL_NAME) {
    handlePlanToolEvent(host as ToolStreamHost & PlanStreamHost, {
      sessionKey,
      runId: payload.runId,
      phase,
      data,
    });
  }
  const args = phase === "start" ? data.args : undefined;
  const output =
    phase === "update"
      ? formatToolOutput(data.partialResult)
      : phase === "result"
        ? formatToolOutput(data.result)
        : undefined;
  // 内核 result 阶段带 isError: boolean（execute.runtime 契约），宽容解析：仅严格 true 计失败
  const isError = phase === "result" && data.isError === true ? true : undefined;
  // R52 T4：input_delta 实时 diff（data.diff:{added,removed}，内核 250ms 节流）；
  // result 阶段用 details 里的最终统计替换（details 无 diff 则清除实时徽标）。
  const liveDiffStat = phase === "input_delta" ? parseDiffStat(data.diff) : undefined;
  const finalDiffStat = phase === "result" ? extractResultDiffStat(data.result) : undefined;
  const toolErrorSummary = phase === "result" ? asNonEmptyString(data.toolErrorSummary) : undefined;
  const exitCode = phase === "result" ? extractExitCode(data) : undefined;

  const now = Date.now();
  let entry = host.toolStreamById.get(toolCallId);
  if (!entry) {
    // 新 tool call：把当前 live 的 assistant 文本冻结下来作为这条 entry 的 leadingSegment。
    // 优先 pending（raf 队列里尚未 flush 的最新值），否则用已可见的 chatStream。
    const pending = host.chatPendingStreamText;
    const live = host.chatStream;
    const liveText = (pending ?? live ?? "").trim().length > 0 ? (pending ?? live) : null;
    // R88：pending 的中途解说（未被任何 tool 冻结过的 narration）同样在此冻结。
    // 它不占 chat delta 累计文本（内核对 commentary 抑制广播），不得并入 frozenPrefix。
    const narrationPending = host.chatPendingNarrationText ?? host.chatNarrationText ?? "";
    const narrationText = narrationPending.trim().length > 0 ? narrationPending : null;
    if (narrationText) {
      host.chatNarrationText = null;
      host.chatPendingNarrationText = null;
    }
    const leading: StreamSegment | undefined = liveText
      ? { text: liveText, ts: host.chatStreamStartedAt ?? now }
      : undefined;
    if (leading) {
      // 同步把这一段并入 frozenPrefix；下一帧 delta 进来 controllers/chat.ts 才知道
      // gateway 给的"累计文本"里有多少属于已冻结部分，要切掉。
      host.chatStreamFrozenPrefix = (host.chatStreamFrozenPrefix ?? "") + (liveText ?? "");
      host.chatStream = null;
      host.chatStreamStartedAt = null;
      host.chatPendingStreamText = null;
      debugLog("tool", "freeze leadingSegment", {
        toolCallId,
        segmentLen: liveText?.length ?? 0,
        prefixLenAfter: host.chatStreamFrozenPrefix.length,
      });
    }
    entry = {
      toolCallId,
      runId: payload.runId,
      sessionKey,
      name,
      args,
      // R83：result 阶段空字符串也是有效 result（`|| undefined` 会把空输出当成「无
      // result」，卡片永远停在执行中）；update 阶段的空 partialResult 仍视为无输出
      output: phase === "result" ? (output ?? undefined) : output || undefined,
      isError,
      diffStat: phase === "input_delta" ? liveDiffStat : finalDiffStat,
      toolErrorSummary,
      exitCode,
      startedAt: typeof payload.ts === "number" ? payload.ts : now,
      updatedAt: now,
      ...(narrationText ? { narrationSegment: { text: narrationText, ts: now } } : {}),
      leadingSegment: leading,
      callMessage: {},
    };
    entry.callMessage = buildToolCallMessage(entry);
    host.toolStreamById.set(toolCallId, entry);
    host.toolStreamOrder.push(toolCallId);
  } else {
    entry.name = name;
    if (args !== undefined) {
      entry.args = args;
    }
    if (phase === "result" ? output !== null : Boolean(output)) {
      entry.output = output ?? "";
    }
    if (isError !== undefined) {
      entry.isError = isError;
    }
    // R52 T4：input_delta 刷新实时 diff 徽标；result 用最终统计替换
    // （details 无 diff 时置 undefined，实时徽标随终态消失，与 control-ui 一致）。
    if (phase === "input_delta" && liveDiffStat) {
      entry.diffStat = liveDiffStat;
    }
    if (phase === "result") {
      entry.diffStat = finalDiffStat;
      if (toolErrorSummary) {
        entry.toolErrorSummary = toolErrorSummary;
      }
      if (exitCode !== undefined) {
        entry.exitCode = exitCode;
      }
    }
    entry.updatedAt = now;
    // 名称/参数/result 载荷变更要反映到 call 消息，但保留其 timestamp（start 时钉住）。
    entry.callMessage = {
      ...buildToolCallMessage(entry),
      timestamp: entry.callMessage.timestamp ?? entry.startedAt,
    };
  }

  trimToolStream(host);
  scheduleToolStreamSync(host, phase === "result");
}
