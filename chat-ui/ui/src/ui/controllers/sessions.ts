import type { GatewayBrowserClient } from "../gateway.ts";
import { withPendingSessionRows } from "../session-pending.ts";
import type { SessionsListResult } from "../types.ts";

export type SessionsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionsLoading: boolean;
  sessionsResult: SessionsListResult | null;
  sessionsError: string | null;
  sessionsFilterActive: string;
  sessionsFilterLimit: string;
  sessionsIncludeGlobal: boolean;
  sessionsIncludeUnknown: boolean;
  // 侧边栏会话列表「显示已归档」开关（会话管理页已合并进侧边栏）
  sessionsIncludeArchived: boolean;
  // 会话列表刷新后回调（app 层用来按会话行内核 thinkingLevels 刷新思考档位）
  onSessionsLoaded?: () => void;
};

type SessionsLoadOverrides = {
  activeMinutes?: number;
  limit?: number;
  includeGlobal?: boolean;
  includeUnknown?: boolean;
  includeArchived?: boolean;
};

type SessionsLoadMeta = {
  activePromise: Promise<void> | null;
  pending: boolean;
  pendingOverrides: SessionsLoadOverrides | undefined;
};

const sessionsLoadMeta = new WeakMap<SessionsState, SessionsLoadMeta>();

function toNumber(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getSessionsLoadMeta(state: SessionsState): SessionsLoadMeta {
  let meta = sessionsLoadMeta.get(state);
  if (!meta) {
    meta = {
      activePromise: null,
      pending: false,
      pendingOverrides: undefined,
    };
    sessionsLoadMeta.set(state, meta);
  }
  return meta;
}

export async function loadSessions(
  state: SessionsState,
  overrides?: SessionsLoadOverrides,
) {
  if (!state.client || !state.connected) {
    return;
  }
  const meta = getSessionsLoadMeta(state);
  const client = state.client;
  meta.pending = true;
  if (overrides) {
    meta.pendingOverrides = overrides;
  }
  if (meta.activePromise) {
    return meta.activePromise;
  }
  meta.activePromise = (async () => {
    while (meta.pending) {
      const currentOverrides = meta.pendingOverrides;
      meta.pending = false;
      meta.pendingOverrides = undefined;
      state.sessionsLoading = true;
      state.sessionsError = null;
      try {
        const includeGlobal = currentOverrides?.includeGlobal ?? state.sessionsIncludeGlobal;
        const includeUnknown = currentOverrides?.includeUnknown ?? state.sessionsIncludeUnknown;
        const includeArchived = currentOverrides?.includeArchived ?? state.sessionsIncludeArchived;
        const activeMinutes = currentOverrides?.activeMinutes ?? toNumber(state.sessionsFilterActive, 0);
        const limit = currentOverrides?.limit ?? toNumber(state.sessionsFilterLimit, 0);
        const params: Record<string, unknown> = {
          includeGlobal,
          includeUnknown,
        };
        if (includeArchived) {
          // 内核语义：archived === true 时【仅】返回已归档会话（session-utils：
          // `opts.archived === true ? archived : !archived`），不是"包含归档"。
          params.archived = true;
        }
        if (activeMinutes > 0) {
          params.activeMinutes = activeMinutes;
        }
        if (limit > 0) {
          params.limit = limit;
        }
        const res = await client.request<SessionsListResult | undefined>("sessions.list", params);
        if (res) {
          state.sessionsResult = withPendingSessionRows(res);
          state.onSessionsLoaded?.();
        }
      } catch (err) {
        state.sessionsError = String(err);
      } finally {
        state.sessionsLoading = false;
      }
    }
  })().finally(() => {
    meta.activePromise = null;
  });
  return meta.activePromise;
}

export async function patchSession(
  state: SessionsState,
  key: string,
  patch: {
    label?: string | null;
    category?: string | null;
    pinned?: boolean;
    archived?: boolean;
    unread?: boolean;
    thinkingLevel?: string | null;
    verboseLevel?: string | null;
    reasoningLevel?: string | null;
    model?: string | null;
  },
) {
  if (!state.client || !state.connected) {
    return;
  }
  const params: Record<string, unknown> = { key };
  if ("label" in patch) {
    params.label = patch.label;
  }
  if ("category" in patch) {
    params.category = patch.category;
  }
  if ("pinned" in patch) {
    params.pinned = patch.pinned;
  }
  if ("archived" in patch) {
    params.archived = patch.archived;
  }
  if ("unread" in patch) {
    params.unread = patch.unread;
  }
  if ("thinkingLevel" in patch) {
    params.thinkingLevel = patch.thinkingLevel;
  }
  if ("verboseLevel" in patch) {
    params.verboseLevel = patch.verboseLevel;
  }
  if ("reasoningLevel" in patch) {
    params.reasoningLevel = patch.reasoningLevel;
  }
  if ("model" in patch) {
    params.model = patch.model;
  }
  try {
    await state.client.request("sessions.patch", params);
    await loadSessions(state);
  } catch (err) {
    state.sessionsError = String(err);
  }
}

