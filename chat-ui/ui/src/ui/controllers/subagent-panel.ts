import type { GatewayBrowserClient } from "../gateway.ts";
import type { ChatAttachment } from "../ui-types.ts";
import { loadChatHistory } from "./chat.ts";
import {
  clearSessionRunStateSnapshot,
  ensureRunStateSnapshot,
  peekRunStateSnapshot,
} from "../run-state-store.ts";

export type SubagentPanelHost = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  subagentPanelKey: string | null;
  subagentPanelMessages: unknown[];
  subagentPanelVisibleMessageCount: number;
  subagentPanelToolMessages: Record<string, unknown>[];
  subagentPanelStream: string | null;
  subagentPanelThinkingStream: string | null;
  subagentPanelNarrationText: string | null;
  subagentPanelStreamStartedAt: number | null;
  subagentPanelLoading: boolean;
  subagentPanelError: string | null;
  requestUpdate(): void;
};

const panelLoads = new WeakMap<SubagentPanelHost, { key: string; entry: object }>();

export function projectSubagentPanel(host: SubagentPanelHost, eventSessionKey?: string): void {
  const key = host.subagentPanelKey;
  if (!key || (eventSessionKey !== undefined && eventSessionKey !== key)) return;
  const entry = peekRunStateSnapshot(key);
  if (!entry) return;
  // 历史以不可变数组写入；流式文本投影不能使历史 memo 每 token 失效。
  host.subagentPanelMessages = entry.chatMessages;
  host.subagentPanelVisibleMessageCount = entry.chatVisibleMessageCount;
  host.subagentPanelToolMessages = entry.chatToolMessages;
  host.subagentPanelStream = entry.chatPendingStreamText ?? entry.chatStream;
  host.subagentPanelThinkingStream = entry.chatPendingThinkingText ?? entry.chatThinkingStream;
  host.subagentPanelNarrationText = entry.chatPendingNarrationText ?? entry.chatNarrationText;
  host.subagentPanelStreamStartedAt = entry.chatStreamStartedAt;
  host.subagentPanelLoading = entry.chatLoading;
  host.requestUpdate();
}

export async function loadSubagentPanelHistory(host: SubagentPanelHost): Promise<void> {
  const key = host.subagentPanelKey;
  if (!key || !host.client || !host.connected) return;
  const entry = ensureRunStateSnapshot(key);
  let token = panelLoads.get(host);
  // 观察者属于已打开的面板，而非某次请求。失败的同面板刷新不能
  // 作废此前成功历史仍在推进的 hydration。
  if (!token || token.key !== key || token.entry !== entry) {
    token = { key, entry };
    panelLoads.set(host, token);
  }
  Object.assign(entry, { client: host.client, connected: host.connected });
  const projectCurrent = () => {
    if (panelLoads.get(host) === token && host.subagentPanelKey === key &&
      peekRunStateSnapshot(key) === entry) projectSubagentPanel(host);
  };
  try {
    const loading = loadChatHistory(entry as never, { onHistoryHydrated: projectCurrent });
    projectCurrent();
    await loading;
  } finally {
    projectCurrent();
  }
}

export function openSubagentPanel(host: SubagentPanelHost, sessionKey: string): void {
  const key = sessionKey.trim();
  if (!key) return;
  host.subagentPanelKey = key;
  host.subagentPanelError = null;
  ensureRunStateSnapshot(key);
  projectSubagentPanel(host);
  void loadSubagentPanelHistory(host).catch((error) => {
    if (host.subagentPanelKey === key) {
      host.subagentPanelError = String(error);
      host.requestUpdate();
    }
  });
}

export function closeSubagentPanel(host: SubagentPanelHost): void {
  const key = host.subagentPanelKey;
  panelLoads.delete(host);
  host.subagentPanelKey = null;
  host.subagentPanelMessages = [];
  host.subagentPanelVisibleMessageCount = 0;
  host.subagentPanelToolMessages = [];
  host.subagentPanelStream = null;
  host.subagentPanelThinkingStream = null;
  host.subagentPanelNarrationText = null;
  host.subagentPanelStreamStartedAt = null;
  host.subagentPanelLoading = false;
  host.subagentPanelError = null;
  if (key) clearSessionRunStateSnapshot(key);
  host.requestUpdate();
}

export type SubagentPanelChatState = SubagentPanelHost & {
  chatMessage: string;
  chatAttachments: ChatAttachment[];
};
