/**
 * 「用量」tab 纯逻辑（v2026.913.3 重构自 tab-session-usage.lib.ts）。
 *
 * 参照 openclaw 官方 control-ui 的 /usage 页（内核 2026.9.3 取证，见
 * .cache/kernel-recon-913/openclaw/dist/usage-lCaKvodi.mjs 等）复刻核心区块：
 * 总览指标 / 每日活动 / Top 模型与服务商 / 会话明细 / 服务商配额。
 * 数据源三个 gateway RPC（scope 均为 usage / operator.read）：
 *   - usage.cost    {startDate,endDate} → daily[] + totals（token/成本）
 *   - sessions.usage {startDate,endDate,limit,groupBy} → sessions[] + aggregates
 *   - usage.status  {} → 服务商配额窗口（60s TTL，可无返回）
 */

export interface UsageTokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number | null;
  totalTokens: number | null;
  totalCost: number | null;
}

export interface UsageDailyRow {
  date: string;
  input: number;
  output: number;
  cacheRead: number;
  totalTokens: number | null;
  totalCost: number | null;
}

export interface UsageSessionRow {
  key: string;
  sessionId: string;
  isMain: boolean;
  customLabel: string | null;
  originLabel: string | null;
  model: string | null;
  updatedAt: number;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  totalCost: number | null;
}

export interface UsageTopRow {
  label: string;
  count: number;
  tokens: number;
}

export interface UsageAggregates {
  sessionCount: number | null;
  messages: { total: number | null; user: number | null; assistant: number | null; toolCalls: number | null; errors: number | null };
  byModel: UsageTopRow[];
  byProvider: UsageTopRow[];
  byChannel: UsageTopRow[];
  tools: UsageTopRow[];
}

export interface UsageCostPayload {
  totals: UsageTokenTotals | null;
  daily: UsageDailyRow[];
}

export interface UsageSessionsPayload {
  rows: UsageSessionRow[];
  totals: UsageTokenTotals | null;
  aggregates: UsageAggregates | null;
}

export interface UsageProviderWindow {
  label: string;
  usedPercent: number | null;
  resetAt: string | null;
}

export interface UsageProviderStatus {
  provider: string;
  windows: UsageProviderWindow[];
}

// ── 日期范围档位 ──

export type UsageRangeId = "today" | "7d" | "30d" | "all";

export const USAGE_RANGE_IDS: UsageRangeId[] = ["today", "7d", "30d", "all"];

export function resolveUsageRange(id: UsageRangeId, now = new Date()): { startDate: string; endDate: string } {
  const endDate = toIsoDate(now);
  if (id === "today") {
    return { startDate: endDate, endDate };
  }
  if (id === "all") {
    // 内核 MAX_USAGE_DAYS=36600（约 100 年）：2000 起点即视为「全部」
    return { startDate: "2000-01-01", endDate };
  }
  const days = id === "7d" ? 6 : 29;
  const start = new Date(now);
  start.setDate(start.getDate() - days);
  return { startDate: toIsoDate(start), endDate };
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ── 载荷映射（宽容解析：字段缺失/类型异常降级为 0/null）──

export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function asNumberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function mapTotals(usage: unknown): UsageTokenTotals | null {
  if (!isRecord(usage)) return null;
  return {
    input: asNumber(usage.input),
    output: asNumber(usage.output),
    cacheRead: asNumber(usage.cacheRead),
    cacheWrite: asNumberOrNull(usage.cacheWrite),
    totalTokens: asNumberOrNull(usage.totalTokens),
    totalCost: asNumberOrNull(usage.totalCost),
  };
}

export function mapUsageCost(payload: unknown): UsageCostPayload {
  if (!isRecord(payload)) return { totals: null, daily: [] };
  const daily = (Array.isArray(payload.daily) ? payload.daily : []).flatMap((row) => {
    if (!isRecord(row)) return [];
    return [{
      date: asString(row.date) ?? "",
      input: asNumber(row.input),
      output: asNumber(row.output),
      cacheRead: asNumber(row.cacheRead),
      totalTokens: asNumberOrNull(row.totalTokens),
      totalCost: asNumberOrNull(row.totalCost),
    }];
  });
  daily.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { totals: mapTotals(payload.totals), daily };
}

function isMainSessionKey(sessionKey: string, agent: string): boolean {
  const lower = sessionKey.toLowerCase();
  return lower === `agent:${agent.toLowerCase()}:main` || lower === "main";
}

const MAIN_SESSION_DISPLAY_LABEL = "agent:main:main";

export function resolveUsageSessionDisplayLabel(
  row: Pick<UsageSessionRow, "customLabel" | "originLabel" | "sessionId" | "isMain"> & { key: string },
): string {
  const explicitLabel = row.customLabel || row.originLabel;
  if (row.isMain) {
    return MAIN_SESSION_DISPLAY_LABEL;
  }
  return explicitLabel || row.sessionId;
}

export function mapSessionsUsage(payload: unknown): UsageSessionsPayload {
  if (!isRecord(payload)) {
    return { rows: [], totals: null, aggregates: null };
  }
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  const rows: UsageSessionRow[] = [];
  for (const entry of sessions) {
    if (!isRecord(entry)) continue;
    const key = asString(entry.key) ?? "";
    const sessionId = asString(entry.sessionId) ?? key;
    if (!sessionId) continue;
    const agent = asString(entry.agentId) ?? "";
    const origin = isRecord(entry.origin) ? entry.origin : null;
    const usage = isRecord(entry.usage) ? entry.usage : {};
    rows.push({
      key,
      sessionId,
      isMain: isMainSessionKey(key, agent),
      customLabel: asString(entry.label),
      originLabel: origin ? asString(origin.label) : null,
      model: asString(entry.model),
      updatedAt: asNumber(entry.updatedAt),
      input: asNumberOrNull(usage.input),
      output: asNumberOrNull(usage.output),
      cacheRead: asNumberOrNull(usage.cacheRead),
      totalCost: asNumberOrNull(usage.totalCost),
    });
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return { rows, totals: mapTotals(payload.totals), aggregates: mapAggregates(payload.aggregates) };
}

// byModel: [{provider, model, count, totals}]；label = provider/model
function mapModelTopRows(value: unknown): UsageTopRow[] {
  const list = Array.isArray(value) ? value : [];
  const out: UsageTopRow[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const provider = asString(entry.provider);
    const model = asString(entry.model) ?? asString(entry.name);
    if (!model) continue;
    out.push({
      label: provider ? `${provider}/${model}` : model,
      count: asNumber(entry.count),
      tokens: isRecord(entry.totals) ? asNumber(entry.totals.totalTokens) : asNumber(entry.tokens),
    });
  }
  return out;
}

// byProvider / byChannel / tools: [{name|provider|channel, count, totals}]
function mapNamedTopRows(value: unknown, fields: string[]): UsageTopRow[] {
  const list = Array.isArray(value) ? value : [];
  const out: UsageTopRow[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    let label: string | null = null;
    for (const field of fields) {
      label = asString(entry[field]);
      if (label) break;
    }
    if (!label) continue;
    out.push({
      label,
      count: asNumber(entry.count),
      tokens: isRecord(entry.totals) ? asNumber(entry.totals.totalTokens) : asNumber(entry.tokens),
    });
  }
  return out;
}

function mapAggregates(value: unknown): UsageAggregates | null {
  if (!isRecord(value)) return null;
  const messages = isRecord(value.messages) ? value.messages : {};
  const tools = isRecord(value.tools) ? value.tools : {};
  return {
    sessionCount: asNumberOrNull(value.sessionCount),
    messages: {
      total: asNumberOrNull(messages.total),
      user: asNumberOrNull(messages.user),
      assistant: asNumberOrNull(messages.assistant),
      toolCalls: asNumberOrNull(messages.toolCalls) ?? asNumberOrNull(tools.totalCalls),
      errors: asNumberOrNull(messages.errors),
    },
    byModel: mapModelTopRows(value.byModel),
    byProvider: mapNamedTopRows(value.byProvider, ["provider", "name"]),
    byChannel: mapNamedTopRows(value.byChannel, ["channel", "name"]),
    tools: mapNamedTopRows(tools.tools, ["name"]),
  };
}

export function mapUsageStatus(payload: unknown): UsageProviderStatus[] {
  if (!isRecord(payload)) return [];
  const providers = Array.isArray(payload.providers) ? payload.providers : [];
  const out: UsageProviderStatus[] = [];
  for (const entry of providers) {
    if (!isRecord(entry)) continue;
    const provider = asString(entry.provider);
    if (!provider) continue;
    const windows = (Array.isArray(entry.windows) ? entry.windows : []).flatMap((w) => {
      if (!isRecord(w)) return [];
      const label = asString(w.label) ?? "";
      if (!label) return [];
      const pctRaw = w.usedPercent;
      const usedPercent =
        typeof pctRaw === "number" && Number.isFinite(pctRaw)
          ? Math.max(0, Math.min(100, pctRaw))
          : null;
      return [{ label, usedPercent, resetAt: asString(w.resetAt) }];
    });
    out.push({ provider, windows });
  }
  return out;
}

// ── Top 行裁剪与份额（渲染层用）──

export const USAGE_TOP_LIMIT = 5;

export function topRows(rows: UsageTopRow[], limit = USAGE_TOP_LIMIT): UsageTopRow[] {
  return [...rows].sort((a, b) => b.tokens - a.tokens || b.count - a.count).slice(0, limit);
}

export function sharePercent(value: number, max: number): number {
  if (max <= 0) return 0;
  // 上限 100：超额数据（如异常配额值）不得把条形撑出容器
  return Math.min(100, Math.max(1, Math.round((value / max) * 100)));
}
