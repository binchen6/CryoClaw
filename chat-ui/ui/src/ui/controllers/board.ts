/**
 * Board（会话仪表盘）controller —— openclaw 2026.9.3 内核 board 一等能力的客户端适配。
 *
 * 内核契约（取证 .cache/kernel-recon-913/openclaw/dist/board-Bw3buI9O.mjs 直读）：
 * - RPC：board.get {sessionKey} → {sessionKey, revision, tabs?, widgets?: [...]}
 *   每 widget：{name, revision, contentKind, frameUrl(相对路径), viewTicket,
 *   viewTicketTtlMs(20min), kindLabel?, declaredSummary?...}
 * - frameUrl = /__openclaw__/board/<encodeURIComponent(sessionKey)>/<widget>/index.html?bt=<ticket>，
 *   需拼 gateway HTTP origin 成完整 iframe src；bt ticket 自带鉴权（HMAC，20 分钟 TTL）。
 * - 事件：board.changed {sessionKey, revision}（board.update 后定向广播）→ 失效重拉。
 *
 * 生命周期（对齐 controllers/progress-card.ts 模式）：
 * - 会话切换：resetBoardForSession（清态 + 重新拉取）。
 * - 断连重连：app-gateway onHello 调 loadBoard 重拉当前会话。
 * - 事件失效重拉：changed 按当前会话过滤；revision 与本地一致时跳过（事件回声）。
 * - 竞态守卫：拉取锚定发起时的 sessionKey，晚到响应丢弃。
 * - 容错：board.get 不可用（内核 <2026.9.3 / canvas 宿主关闭）时静默置空——面板整体不渲染。
 */
import type { GatewayBrowserClient } from "../gateway.ts";

export type BoardWidget = {
  name: string;
  kindLabel: string | null;
  /** 完整 iframe src（gateway HTTP origin + 内核 frameUrl 相对路径） */
  src: string;
};

export type BoardState = {
  sessionKey: string | null;
  revision: number | null;
  widgets: BoardWidget[];
  loading: boolean;
  error: string | null;
};

export type BoardHost = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  settings: { gatewayUrl: string };
  board: BoardState;
};

export type BoardChangedPayload = {
  sessionKey?: unknown;
  revision?: unknown;
};

export function emptyBoardState(sessionKey: string | null): BoardState {
  return { sessionKey, revision: null, widgets: [], loading: false, error: null };
}

/** ws(s)://host:port → http(s)://host:port（与 chat/managed-media.ts 同源规则） */
export function boardFrameOrigin(gatewayUrl: string): string | null {
  try {
    const url = new URL(gatewayUrl);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      return null;
    }
    return `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`;
  } catch {
    return null;
  }
}

/** 容错归一 board.get 快照：非法/空 board 归一为无 widget（面板不渲染） */
export function normalizeBoardSnapshot(
  payload: unknown,
  sessionKey: string,
  frameOrigin: string | null,
): { revision: number | null; widgets: BoardWidget[] } {
  if (!payload || typeof payload !== "object") {
    return { revision: null, widgets: [] };
  }
  const record = payload as Record<string, unknown>;
  const revision = typeof record.revision === "number" && Number.isInteger(record.revision)
    ? record.revision
    : null;
  const widgets: BoardWidget[] = [];
  const list = Array.isArray(record.widgets) ? record.widgets : [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || !frameOrigin) {
      continue;
    }
    const widget = entry as Record<string, unknown>;
    const name = typeof widget.name === "string" ? widget.name.trim() : "";
    const frameUrl = typeof widget.frameUrl === "string" ? widget.frameUrl : "";
    if (!name || !frameUrl) {
      continue;
    }
    widgets.push({
      name,
      kindLabel: typeof widget.kindLabel === "string" && widget.kindLabel.trim() ? widget.kindLabel : null,
      src: `${frameOrigin}${frameUrl}`,
    });
  }
  return { revision, widgets };
}

/** board.changed 事件是否命中当前会话且需要重拉（revision 一致即事件回声，跳过） */
export function boardChangedNeedsReload(
  payload: BoardChangedPayload | undefined,
  currentSessionKey: string,
  current: BoardState,
): boolean {
  if (!payload || typeof payload.sessionKey !== "string" || payload.sessionKey !== currentSessionKey) {
    return false;
  }
  const revision = typeof payload.revision === "number" ? payload.revision : null;
  if (revision === null) {
    return true;
  }
  return current.revision !== revision;
}

// 在途拉取期间再次请求（changed/会话切换）时置脏，完成后补跑一轮（对齐 progress-card）
const boardRefreshPending = new WeakMap<BoardHost, string>();

export async function loadBoard(host: BoardHost): Promise<void> {
  if (!host.client || !host.connected) {
    return;
  }
  const key = host.sessionKey;
  if (!key.trim()) {
    return;
  }
  if (host.board.loading) {
    boardRefreshPending.set(host, key);
    return;
  }
  host.board = { ...host.board, sessionKey: key, loading: true };
  let stale = false;
  try {
    const res = await host.client.request<unknown>("board.get", { sessionKey: key });
    if (host.sessionKey !== key) {
      stale = true;
      return;
    }
    const normalized = normalizeBoardSnapshot(res, key, boardFrameOrigin(host.settings.gatewayUrl));
    host.board = {
      sessionKey: key,
      revision: normalized.revision,
      widgets: normalized.widgets,
      loading: false,
      error: null,
    };
  } catch {
    // board 不可用（旧内核 / canvas 宿主关闭 / 无 board）：等价「无仪表盘」，不报错
    if (host.sessionKey !== key) {
      stale = true;
      return;
    }
    host.board = { sessionKey: key, revision: null, widgets: [], loading: false, error: null };
  } finally {
    const pendingSessionKey = boardRefreshPending.get(host);
    const refreshPending = !stale && pendingSessionKey === key;
    if (pendingSessionKey === key) {
      boardRefreshPending.delete(host);
    }
    if (refreshPending) {
      void loadBoard(host);
    }
  }
}

/** board.changed 事件入口 */
export function handleBoardChanged(host: BoardHost, payload: BoardChangedPayload | undefined): void {
  if (!boardChangedNeedsReload(payload, host.sessionKey, host.board)) {
    return;
  }
  void loadBoard(host);
}

/** 会话切换入口：清空上一会话 board 并拉取新会话 */
export function resetBoardForSession(host: BoardHost, sessionKey: string): void {
  boardRefreshPending.delete(host);
  host.board = emptyBoardState(sessionKey);
  if (host.client && host.connected) {
    void loadBoard(host);
  }
}
