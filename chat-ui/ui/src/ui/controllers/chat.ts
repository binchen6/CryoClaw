import type { GatewayBrowserClient } from "../gateway.ts";
import type { ChatAttachment } from "../ui-types.ts";
import { extractText } from "../chat/message-extract.ts";
import { debugLog } from "../debug.ts";
import { clearReconnectOrphanRun, liveOrphanRunId } from "../stream-recovery.ts";
import { generateUUID } from "../uuid.ts";

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
  lastError: string | null;
};

export type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
  // openclaw 协议 v4（≥2026.5.12）新增字段：explicit deltaText/replace 流式帧与终态元信息。
  // 当前渲染仍走 message 累计全量文本，这些字段仅为类型完整性声明。
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
function scheduleChatStreamFlush(state: ChatState) {
  if (state.chatStreamFrame !== null) {
    return;
  }
  state.chatStreamFrame = requestAnimationFrame(() => {
    state.chatStreamFrame = null;
    if (state.chatPendingStreamText === null) {
      return;
    }
    state.chatStream = state.chatPendingStreamText;
    state.chatPendingStreamText = null;
  });
}

// run 结束时要连同挂起的 stream 帧一起清理，避免旧文本回写脏状态。
// 导出供 app-gateway onHello 断连清态复用（统一清理入口，防双份逻辑漂移）。
export function resetChatStreamState(state: ChatState) {
  if (state.chatStreamFrame !== null) {
    cancelAnimationFrame(state.chatStreamFrame);
    state.chatStreamFrame = null;
  }
  state.chatPendingStreamText = null;
  state.chatStream = null;
  state.chatRunId = null;
  state.chatStreamStartedAt = null;
  state.chatLastActivityAt = null;
  // 新一轮 run 重新开始，frozenPrefix 也要清，避免上一轮的前缀切错本轮的累计文本。
  state.chatStreamFrozenPrefix = "";
}

// R30：mergeIfStale 保留本地（内核快照滞后）后的延迟二次拉取。
// 此前保留后无任何重试——若本轮回复恰好撞上内核持久化窗口，用户会看到
// 「问了没答」且要等下轮 final/手动刷新才恢复。保留时按 800/1600/2400ms
// 退避补拉（对齐 scheduleTerminalSessionsRefresh 的持久化窗口），
// 替换成功或会话切换即停止。同一时刻只保留一个挂起重试。
const STALE_RETRY_DELAYS_MS = [800, 1600, 2400];
let staleRetryTimer: ReturnType<typeof setTimeout> | null = null;
let staleRetryKey: string | null = null;
let staleRetryAttempt = 0;

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
  if (staleRetryAttempt >= STALE_RETRY_DELAYS_MS.length) {
    return;
  }
  if (staleRetryTimer !== null) {
    if (staleRetryKey === sessionKey) {
      return; // 已有同会话的挂起重试，合并
    }
    clearTimeout(staleRetryTimer);
    staleRetryTimer = null;
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

export async function loadChatHistory(
  state: ChatState,
  opts?: { mergeIfStale?: boolean },
) {
  if (!state.client || !state.connected) {
    return;
  }
  const requestSessionKey = state.sessionKey;
  cancelChatHistoryHydration(state);
  state.chatLoading = true;
  state.lastError = null;
  try {
    const res = await state.client.request<{ messages?: Array<unknown>; thinkingLevel?: string }>(
      "chat.history",
      {
        sessionKey: requestSessionKey,
        limit: 200,
      },
    );
    if (state.sessionKey !== requestSessionKey) {
      return;
    }
    const raw = Array.isArray(res.messages) ? res.messages : [];
    // R12：终态刷新可能命中内核 chat.history 的滞后读（主会话实测，拉取结果落后一个回合），
    // 此时若拉取条数少于本地视图（刚结束回合的消息尚未进入快照），保留本地消息列表，
    // 等待下一次刷新收敛——避免用户可见的消息短暂“消失”。仅 mergeIfStale 调用方启用
    // （turn 终态刷新）；会话切换/回放等替换语义的调用方不受影响。
    // 例外：raw 含 compaction 标记（__openclaw.kind==="compaction"）说明服务端发生了
    // 上下文压缩，历史合法变短——滞后快照不会“长出”新压缩标记，必须替换而非保留，
    // 否则本地列表恒长于服务端，压缩后的新回复将永远无法上屏。
    // R23：空读同样保护——非重置路径（重置不走 mergeIfStale）拿到空历史是瞬时异常，
    // 保留本地等待下次刷新，防 delta 丢失叠加空读导致整个对话视图被清空。
    if (
      opts?.mergeIfStale &&
      raw.length < (state.chatMessages?.length ?? 0)
    ) {
      const hasCompactionMarker = raw.some(
        (m) =>
          ((m as Record<string, unknown>).__openclaw as Record<string, unknown> | undefined)
            ?.kind === "compaction",
      );
      if (raw.length === 0 || !hasCompactionMarker) {
        // 滞后读保留本地后调度退避补拉（R30），避免「问了没答」要等下轮终态
        scheduleStaleHistoryRetry(state, requestSessionKey);
        return;
      }
    }
    // 替换成功：滞后已收敛，停掉补拉退避
    cancelStaleHistoryRetry();
    const deduplicated = deduplicateDeliveryMirrors(raw);
    state.chatMessages = deduplicated;
    state.chatVisibleMessageCount = Math.min(
      deduplicated.length,
      INITIAL_CHAT_HISTORY_RENDER_COUNT,
    );
    scheduleChatHistoryHydration(state, requestSessionKey, deduplicated.length);
    state.chatThinkingLevel = res.thinkingLevel ?? null;
  } catch (err) {
    if (state.sessionKey !== requestSessionKey) {
      return;
    }
    state.lastError = String(err);
  } finally {
    if (state.sessionKey === requestSessionKey) {
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
  opts?: { preserveRunState?: boolean },
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  // 分离图片附件和文件路径附件
  const imageAttachments = attachments?.filter((a) => a.dataUrl) ?? [];
  const fileAttachments = attachments?.filter((a) => a.filePath && !a.dataUrl) ?? [];
  const hasImages = imageAttachments.length > 0;
  const hasFiles = fileAttachments.length > 0;

  // 文件路径拼到消息前面，让 gateway 自行读取
  const filePaths = fileAttachments.map((a) => a.filePath!);
  const filePrefix = filePaths.length > 0
    ? filePaths.join("\n") + "\n\n"
    : "";
  const msg = (filePrefix + message).trim();

  const hasAttachments = hasImages || hasFiles;
  if (!msg && !hasAttachments) {
    return null;
  }

  const now = Date.now();
  // 会话归属守卫（对齐 loadChatHistory 的 requestSessionKey 模式）：
  // chat.send 在途期间用户可能已切换会话，迟到的失败回调若不带守卫，
  // 会把旧会话的错误卡片（含 resendText，重发会把旧文本发进新会话）注入
  // 新会话的消息流，并清掉新会话正在进行的 run 状态。
  const requestSessionKey = state.sessionKey;

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

  state.chatMessages = [
    ...state.chatMessages,
    {
      role: "user",
      content: contentBlocks,
      timestamp: now,
    },
  ];
  state.chatVisibleMessageCount = state.chatMessages.length;
  cancelChatHistoryHydration(state);

  state.chatSending = true;
  state.lastError = null;
  const runId = generateUUID();
  if (!opts?.preserveRunState) {
    // 用户发起新 run：此前的重连 orphan 快照作废（防旧 run 的迟到帧被误收养进新 run）
    clearReconnectOrphanRun();
    state.chatRunId = runId;
    state.chatStream = "";
    state.chatStreamStartedAt = now;
    state.chatLastActivityAt = now;
    state.chatStreamFrozenPrefix = "";
  }

  // 只有图片附件走 base64 API，文件路径已拼入消息文本
  const apiAttachments = hasImages
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
    : undefined;

  try {
    await state.client.request("chat.send", {
      sessionKey: state.sessionKey,
      message: msg,
      deliver: false,
      idempotencyKey: runId,
      attachments: apiAttachments,
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
    if (payload.state === "delta" && payload.runId === liveOrphanRunId()) {
      state.chatRunId = payload.runId;
      state.chatStreamStartedAt = Date.now();
      state.chatLastActivityAt = Date.now();
      state.chatStream = state.chatStream ?? "";
      state.chatStreamFrozenPrefix = "";
      debugLog("lifecycle", "orphan run adopted after reconnect", { runId: payload.runId });
      // 收养后继续走下方 delta 处理
    } else if (payload.state === "delta" || payload.state === "error") {
      return null;
    } else {
      // 终态透传；若是 orphan 的终态，快照随之失效
      clearReconnectOrphanRun(payload.runId);
      return payload.state;
    }
  }

  // Final from another run (e.g. sub-agent announce): refresh history to show new message.
  // See https://github.com/openclaw/openclaw/issues/1909
  if (payload.runId && state.chatRunId && payload.runId !== state.chatRunId) {
    if (payload.state === "final") {
      return "final";
    }
    return null;
  }

  if (payload.state === "delta") {
    // gateway 把整轮的 assistant 文本累积进同一个 text block，每帧 delta 给的是"截至现在的全部文本"。
    // 工具调用走另一条 agent 流，content 里没有 tool_use；所以需要靠 frozenPrefix 把已被
    // app-tool-stream 冻成 leadingSegment 的前缀切掉，剩下的才是当前正在打字的"新段"。
    const fullText = extractText(payload.message);
    if (typeof fullText === "string") {
      const prefix = state.chatStreamFrozenPrefix;
      let next = fullText;
      if (prefix && fullText.startsWith(prefix)) {
        next = fullText.slice(prefix.length);
      } else if (prefix) {
        // gateway 极少会"改写"已经吐出的文本，但若发生（例如 thinking-tag 重写），保守降级为原文，
        // 让用户至少看得到，渲染重复也比文本丢失好。
        next = fullText;
        debugLog("stream", "delta full-text 不再以 frozenPrefix 开头，降级直显", {
          fullLen: fullText.length,
          prefixLen: prefix.length,
        });
      }
      const current = state.chatPendingStreamText ?? state.chatStream ?? "";
      if (!current || next.length >= current.length) {
        state.chatPendingStreamText = next;
        state.chatLastActivityAt = Date.now();
        scheduleChatStreamFlush(state);
        debugLog("stream", "delta accept", {
          fullLen: fullText.length,
          prefixLen: prefix.length,
          nextLen: next.length,
        });
      } else {
        debugLog("stream", "delta drop (out-of-order)", {
          fullLen: fullText.length,
          nextLen: next.length,
          currentLen: current.length,
        });
      }
    }
  } else if (payload.state === "final") {
    debugLog("lifecycle", "chat:final → reset stream state", { runId: payload.runId });
    clearReconnectOrphanRun(payload.runId);
    resetChatStreamState(state);
  } else if (payload.state === "aborted") {
    debugLog("lifecycle", "chat:aborted → reset stream state", { runId: payload.runId });
    clearReconnectOrphanRun(payload.runId);
    resetChatStreamState(state);
  } else if (payload.state === "error") {
    debugLog("lifecycle", "chat:error → reset stream state", {
      runId: payload.runId,
      err: payload.errorMessage,
    });
    clearReconnectOrphanRun(payload.runId);
    resetChatStreamState(state);
    const error = payload.errorMessage ?? "chat error";
    // R17：run 级失败也提供重发入口——从本地消息流恢复最后一条 user 消息文本
    const lastUser = [...state.chatMessages].reverse().find(
      (m) => (m as Record<string, unknown>).role === "user",
    );
    const resendText = lastUser ? (extractText(lastUser) ?? "").trim() : "";
    // 不写 lastError：仅在消息流内注入 cryoclawError 卡片，避免与顶部 callout 双显示。
    // 同步在消息流内注入合成错误消息（cryoclawError → grouped-render 着色卡片），
    // 与 sendChatMessage 失败路径同一形态，对齐 control-ui 的行内错误卡片。
    state.chatMessages = [
      ...state.chatMessages,
      {
        role: "assistant",
        content: [{ type: "text", text: "Error: " + error }],
        timestamp: Date.now(),
        cryoclawError: true,
        ...(resendText ? { resendText } : {}),
      },
    ];
    state.chatVisibleMessageCount = state.chatMessages.length;
  }
  return payload.state;
}
