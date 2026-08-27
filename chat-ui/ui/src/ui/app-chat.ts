import type { OpenClawApp } from "./app.ts";
import type { GatewayHelloOk } from "./gateway.ts";
import type { ChatAttachment, ChatQueueItem } from "./ui-types.ts";
import { parseAgentSessionKey } from "../../../src/sessions/session-key-utils.js";
import { scheduleChatScroll } from "./app-scroll.ts";
import { setLastActiveSessionKey } from "./app-settings.ts";
import { resetToolStream } from "./app-tool-stream.ts";
import { abortChatRun, loadChatHistory, sendChatMessage } from "./controllers/chat.ts";
import { loadSessions, patchSession } from "./controllers/sessions.ts";
import { normalizeBasePath } from "./navigation.ts";
import { pendingSessionLabels, pendingSessionResets } from "./session-pending.ts";
import { generateUUID } from "./uuid.ts";

export type ChatHost = {
  connected: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatQueue: ChatQueueItem[];
  chatRunId: string | null;
  chatSending: boolean;
  sessionKey: string;
  basePath: string;
  hello: GatewayHelloOk | null;
  chatAvatarUrl: string | null;
  // 当前 chatAvatarUrl 归属的 agentId（refreshChatAvatar 竞态守卫用，非响应式元数据）
  chatAvatarAgentId?: string | null;
  sessionsResult: { sessions: Array<{ key: string; label?: string }> } | null;
};


export function isChatBusy(host: ChatHost) {
  return host.chatSending || Boolean(host.chatRunId);
}

export function isChatStopCommand(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "/stop") {
    return true;
  }
  return (
    normalized === "stop" ||
    normalized === "esc" ||
    normalized === "abort" ||
    normalized === "wait" ||
    normalized === "exit"
  );
}

function isChatResetCommand(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "/new" || normalized === "/reset") {
    return true;
  }
  return normalized.startsWith("/new ") || normalized.startsWith("/reset ");
}

// 仅统计真实用户输入消息：排除空输入和控制命令（如 stop/new/reset）。
export function isSharePromptCountableInput(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (isChatStopCommand(trimmed) || isChatResetCommand(trimmed)) {
    return false;
  }
  return true;
}

export async function handleAbortChat(host: ChatHost) {
  if (!host.connected) {
    return;
  }
  // 中止只停 run，不动输入框草稿（清草稿是「发送 stop 命令」的语义，见 handleSendChat）
  await abortChatRun(host as unknown as OpenClawApp);
}

function enqueueChatMessage(
  host: ChatHost,
  text: string,
  attachments?: ChatAttachment[],
) {
  const trimmed = text.trim();
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  if (!trimmed && !hasAttachments) {
    return;
  }
  host.chatQueue = [
    ...host.chatQueue,
    {
      id: generateUUID(),
      message: trimmed,
      text: trimmed,
      createdAt: Date.now(),
      attachments: hasAttachments ? attachments?.map((att) => ({ ...att })) : undefined,
    },
  ];
}

const SESSION_NAME_MAX_LEN = 20;

// 从消息文本提取 label（取第一行，截断到最大长度）
function deriveSessionLabel(message: string): string | null {
  const firstLine = message.split("\n")[0]?.trim() ?? "";
  if (!firstLine) {
    return null;
  }
  return firstLine.length > SESSION_NAME_MAX_LEN
    ? firstLine.slice(0, SESSION_NAME_MAX_LEN) + "…"
    : firstLine;
}

// 首条消息发送后，计算 label 并写入内存 + 加入待持久化队列。
// key 由调用方传入发送发起时的快照（发送在途期间会话可能已切换，
// 用当前 host.sessionKey 会把旧会话的自动命名写到新会话头上）。
function syncSessionLabelAfterSend(host: ChatHost, message: string, sessionKey = host.sessionKey) {
  const key = sessionKey;

  // 只信 pending 队列判定自动命名：用户在侧边栏手动改名为「新会话」时
  // 不能因 label 撞名被误覆盖（pending 条目由 createNewSession 写入）
  if (!pendingSessionLabels.has(key)) {
    return;
  }

  const label = deriveSessionLabel(message);
  if (!label) {
    return;
  }

  // 立即更新内存，侧边栏马上可见；整体替换该条目（新对象）走响应式更新，不原地 mutate
  const sessions = host.sessionsResult?.sessions ?? [];
  if (sessions.some((s) => s.key === key)) {
    host.sessionsResult = {
      ...host.sessionsResult!,
      sessions: sessions.map((s) => (s.key === key ? { ...s, label } : s)),
    };
  }

  // 记入待持久化队列，等 chat.event final 后再 patch（避免被 agent runtime 覆盖）
  pendingSessionLabels.set(key, label);
}

// chat.event state="final" 后调用：agent runtime 已写完 sessions.json，此时 patch 不会被覆盖
export async function flushPendingSessionLabel(
  state: Parameters<typeof patchSession>[0],
  sessionKey: string,
) {
  const label = pendingSessionLabels.get(sessionKey);
  if (!label) {
    return;
  }
  pendingSessionLabels.delete(sessionKey);
  // patchSession 内部吞错、永不 reject（只写 sessionsError）——用返回值判定成败：
  // 失败时把 label 放回队列，下次 final 事件时重试（否则自动命名静默丢失）
  const ok = await patchSession(state, sessionKey, { label });
  if (!ok) {
    pendingSessionLabels.set(sessionKey, label);
  }
}

async function sendChatMessageNow(
  host: ChatHost,
  message: string,
  opts?: {
    previousDraft?: string;
    restoreDraft?: boolean;
    attachments?: ChatAttachment[];
    previousAttachments?: ChatAttachment[];
    restoreAttachments?: boolean;
    // run 活跃时直发（队列「立即发送」）：不重置 toolStream，不把新 idempotencyKey
    // 覆写进 chatRunId —— 内核按 followup 并入当前 run，本轮流式状态必须原样保留。
    preserveRunState?: boolean;
  },
) {
  if (!opts?.preserveRunState) {
    resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
  }
  // 发送发起时的会话快照：await 期间会话可能已切换，后续的失败回滚/
  // 自动命名/last-active 记录都必须归属原会话，否则会误删新会话的
  // pendingReset 标记、把旧会话首行文本命名到新会话上。
  const requestSessionKey = host.sessionKey;
  // /new、/reset：内核同 key 轮换 sessionId 并清空 transcript。发送时立即清空
  // 本地视图（不等 final），并置位 pendingSessionResets 让终态刷新强制替换历史
  // （app-gateway.ts 消费）。发送失败则撤销标记并重拉历史恢复旧视图。
  const isResetCommand = !opts?.preserveRunState && isChatResetCommand(message);
  if (isResetCommand) {
    pendingSessionResets.add(requestSessionKey);
    (host as unknown as OpenClawApp).chatMessages = [];
    (host as unknown as OpenClawApp).chatVisibleMessageCount = 0;
  }
  const ok = Boolean(
    await sendChatMessage(
      host as unknown as OpenClawApp,
      message,
      opts?.attachments,
      (host as any).thinkingLevel,
      opts?.preserveRunState ? { preserveRunState: true } : undefined,
    ),
  );
  if (isResetCommand && !ok) {
    pendingSessionResets.delete(requestSessionKey);
    if (host.sessionKey === requestSessionKey) {
      void loadChatHistory(host as unknown as OpenClawApp);
    }
  }
  if (!ok && opts?.previousDraft != null) {
    host.chatMessage = opts.previousDraft;
  }
  if (!ok && opts?.previousAttachments) {
    host.chatAttachments = opts.previousAttachments;
  }
  if (ok) {
    syncSessionLabelAfterSend(host, message, requestSessionKey);
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      requestSessionKey,
    );
  }
  if (ok && opts?.restoreDraft && opts.previousDraft?.trim()) {
    host.chatMessage = opts.previousDraft;
  }
  if (ok && opts?.restoreAttachments && opts.previousAttachments?.length) {
    host.chatAttachments = opts.previousAttachments;
  }
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
  if (ok && !host.chatRunId) {
    void flushChatQueue(host);
  }
  return ok;
}

async function flushChatQueue(host: ChatHost) {
  if (!host.connected || isChatBusy(host)) {
    return;
  }
  const [next, ...rest] = host.chatQueue;
  if (!next) {
    return;
  }
  host.chatQueue = rest;
  const ok = await sendChatMessageNow(host, next.message ?? next.text, {
    attachments: next.attachments,
  });
  if (!ok) {
    host.chatQueue = [next, ...host.chatQueue];
  }
}

export function removeQueuedMessage(host: ChatHost, id: string) {
  host.chatQueue = host.chatQueue.filter((item) => item.id !== id);
}

// 发送失败残留清理：移除匹配的发送失败错误卡（cryoclawError + resendText），
// 以及其前一条带 cryoclawSendFailed 标记的本地乐观 user 气泡（未落盘，见
// controllers/chat.ts 失败路径）。供错误卡「重发」（app-chat-props.ts）与队列
// 「立即发送」失败回退复用，防止重发/回队后新旧 user 气泡双份呈现。
// run 级 error 的 user 气泡已落盘（无标记），不受影响。返回 null 表示无匹配残留。
export function removeFailedSendArtifacts(
  messages: Array<Record<string, unknown>>,
  text: string,
): Array<Record<string, unknown>> | null {
  let cardIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].cryoclawError === true && messages[i].resendText === text) {
      cardIndex = i;
      break;
    }
  }
  if (cardIndex < 0) {
    return null;
  }
  const prev = messages[cardIndex - 1];
  const dropPrevEcho = prev?.role === "user" && prev.cryoclawSendFailed === true;
  return messages.filter(
    (_, i) => i !== cardIndex && !(dropPrevEcho && i === cardIndex - 1),
  );
}

// 行内编辑排队消息：immutable 替换该条目（仅文本；附件保持原样）。
// trim 后为空且无附件时直接删除该条目（空消息本就不允许入队，见 enqueueChatMessage）。
export function editQueuedMessage(host: ChatHost, id: string, newText: string) {
  const trimmed = newText.trim();
  const target = host.chatQueue.find((item) => item.id === id);
  const hasAttachments = Boolean(target?.attachments && target.attachments.length > 0);
  if (target && !trimmed && !hasAttachments) {
    removeQueuedMessage(host, id);
    return;
  }
  host.chatQueue = host.chatQueue.map((item) =>
    item.id === id ? { ...item, message: trimmed, text: trimmed } : item,
  );
}

// 队列项「立即发送」：绕过 busy 检查直接 chat.send（内核会把活跃 run 上的
// 新消息注册为优先 followup，比等终态出队更早被处理）。
// 失败时把消息放回队列原位置（与 flushChatQueue 失败放回队首同一契约）。
export async function sendQueuedMessageNow(host: ChatHost, id: string) {
  if (!host.connected) {
    return false;
  }
  const index = host.chatQueue.findIndex((item) => item.id === id);
  if (index < 0) {
    return false;
  }
  const item = host.chatQueue[index];
  host.chatQueue = host.chatQueue.filter((entry) => entry.id !== id);
  const ok = await sendChatMessageNow(host, item.message ?? (item.text as string) ?? "", {
    attachments: item.attachments,
    preserveRunState: isChatBusy(host),
  });
  if (!ok) {
    // 空闲路径（非 preserveRunState）的失败已向消息流注入乐观气泡+错误卡：
    // 条目放回队列前先清掉这些残留，避免与队列条目双份呈现
    // （busy 路径 preserveRunState 本就不注入，清理无匹配时为空操作）。
    const app = host as unknown as OpenClawApp;
    const cleaned = removeFailedSendArtifacts(
      app.chatMessages as unknown as Array<Record<string, unknown>>,
      item.message ?? (item.text as string) ?? "",
    );
    if (cleaned) {
      app.chatMessages = cleaned;
      app.chatVisibleMessageCount = Math.min(app.chatVisibleMessageCount, cleaned.length);
    }
    const queue = host.chatQueue;
    const at = Math.min(index, queue.length);
    host.chatQueue = [...queue.slice(0, at), item, ...queue.slice(at)];
  }
  return ok;
}

export async function handleSendChat(
  host: ChatHost,
  messageOverride?: string,
  opts?: { restoreDraft?: boolean },
) {
  if (!host.connected) {
    return false;
  }
  const previousDraft = host.chatMessage;
  const message = (messageOverride ?? host.chatMessage).trim();
  const attachments = host.chatAttachments ?? [];
  const attachmentsToSend = messageOverride == null ? attachments : [];
  const hasAttachments = attachmentsToSend.length > 0;

  // Allow sending with just attachments (no message text required)
  if (!message && !hasAttachments) {
    return false;
  }

  if (isChatStopCommand(message)) {
    // stop 命令本身占着输入框：命令发出后清掉它（中止操作本身保留草稿，见 handleAbortChat）
    host.chatMessage = "";
    await handleAbortChat(host);
    return false;
  }

  if (messageOverride == null) {
    host.chatMessage = "";
    // Clear attachments when sending
    host.chatAttachments = [];
  }

  if (isChatBusy(host)) {
    enqueueChatMessage(host, message, attachmentsToSend);
    return true;
  }

  const ok = await sendChatMessageNow(host, message, {
    previousDraft: messageOverride == null ? previousDraft : undefined,
    restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
    attachments: hasAttachments ? attachmentsToSend : undefined,
    previousAttachments: messageOverride == null ? attachments : undefined,
    restoreAttachments: Boolean(messageOverride && opts?.restoreDraft),
  });
  return ok;
}

export async function refreshChat(host: ChatHost, opts?: { scheduleScroll?: boolean }) {
  await Promise.all([
    loadChatHistory(host as unknown as OpenClawApp),
    loadSessions(host as unknown as OpenClawApp),
    refreshChatAvatar(host),
  ]);
  if (opts?.scheduleScroll !== false) {
    scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
  }
}

export const flushChatQueueForEvent = flushChatQueue;

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
};

function resolveAgentIdForSession(host: ChatHost): string | null {
  const parsed = parseAgentSessionKey(host.sessionKey);
  if (parsed?.agentId) {
    return parsed.agentId;
  }
  const snapshot = host.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const fallback = snapshot?.sessionDefaults?.defaultAgentId?.trim();
  return fallback || "main";
}

function buildAvatarMetaUrl(basePath: string, agentId: string): string {
  const base = normalizeBasePath(basePath);
  const encoded = encodeURIComponent(agentId);
  return base ? `${base}/avatar/${encoded}?meta=1` : `/avatar/${encoded}?meta=1`;
}

export async function refreshChatAvatar(host: ChatHost) {
  if (!host.connected) {
    host.chatAvatarUrl = null;
    host.chatAvatarAgentId = null;
    return;
  }
  const agentId = resolveAgentIdForSession(host);
  if (!agentId) {
    host.chatAvatarUrl = null;
    host.chatAvatarAgentId = null;
    return;
  }
  // 仅在 agent 切换时先清空旧头像；agent 未变且已有值时保留到 fetch 落地，避免闪空头像
  if (host.chatAvatarAgentId !== agentId) {
    host.chatAvatarUrl = null;
  }
  const url = buildAvatarMetaUrl(host.basePath, agentId);
  // 竞态守卫：fetch 期间会话可能已切换，落地前再比对一次当前 agentId
  const isStale = () => resolveAgentIdForSession(host) !== agentId;
  try {
    const res = await fetch(url, { method: "GET" });
    if (isStale()) {
      return;
    }
    if (!res.ok) {
      host.chatAvatarUrl = null;
      host.chatAvatarAgentId = agentId;
      return;
    }
    const data = (await res.json()) as { avatarUrl?: unknown };
    if (isStale()) {
      return;
    }
    const avatarUrl = typeof data.avatarUrl === "string" ? data.avatarUrl.trim() : "";
    host.chatAvatarUrl = avatarUrl || null;
    host.chatAvatarAgentId = agentId;
  } catch {
    if (isStale()) {
      return;
    }
    host.chatAvatarUrl = null;
    host.chatAvatarAgentId = agentId;
  }
}
