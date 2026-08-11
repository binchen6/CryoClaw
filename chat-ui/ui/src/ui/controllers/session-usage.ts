import type { GatewayBrowserClient } from "../gateway.ts";
import { t } from "../i18n.ts";
import {
  beginSessionUsageLoad,
  loadSessionUsageSnapshot,
  type SessionUsageRow,
  type UsageTotals,
} from "../views/settings/tab-session-usage.lib.ts";

export type SessionUsageGatewayState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
};

export type SessionUsageTabState = {
  rows: SessionUsageRow[];
  totals: UsageTotals | null;
  totalSessions: number;
  loading: boolean;
  error: string | null;
  initialized: boolean;
};

// 拉取 sessions.usage 快照；失败时清空数据并降级为错误提示。
export async function loadSessionUsage(
  state: SessionUsageTabState,
  gateway: SessionUsageGatewayState,
  requestUpdate: () => void,
) {
  const client = gateway.client;
  if (!beginSessionUsageLoad(state, gateway.connected, !!client) || !client) {
    return;
  }
  state.error = null;
  requestUpdate();
  try {
    const mapped = await loadSessionUsageSnapshot((method, params) => client.request(method, params));
    state.rows = mapped.rows;
    state.totals = mapped.totals;
    state.totalSessions = mapped.totalSessions;
    state.error = null;
  } catch {
    state.rows = [];
    state.totals = null;
    state.totalSessions = 0;
    state.error = t("settings.sessionUsage.loadFailedHint");
  } finally {
    state.loading = false;
    requestUpdate();
  }
}
