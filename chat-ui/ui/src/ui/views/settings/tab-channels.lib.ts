/**
 * Settings 渠道/搜索/记忆/高级配置纯函数库 — config 快照视图提取 + draft 变更应用。
 * 移植自主进程 settings-ipc.ts 与各 *-config.ts 的读写逻辑（R4 config.patch 化），
 * 不依赖 lit / i18n / IPC，可独立单测。
 *
 * 约定：extract* 从 config.get 脱敏快照派生 UI 视图模型；apply* 在 patchConfig 的
 * draft 上就位变更（REDACTED 哨兵由内核写侧自动还原，原样保留即可）。
 */

/* ── 基础工具 ── */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!isRecord(parent[key])) {
    parent[key] = {};
  }
  return parent[key] as Record<string, unknown>;
}

export function dedupeEntries(items: string[]): string[] {
  return [...new Set(items)];
}

/** 规范化 allowFrom 列表：转字符串、去空、去重 */
export function normalizeAllowFromEntries(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return dedupeEntries(
    input
      .map((entry) => String(entry ?? "").trim())
      .filter((entry) => entry.length > 0),
  );
}

export const WILDCARD_ALLOW_ENTRY = "*";

/**
 * 启用插件时同步 plugins.allow 白名单（与主进程 kimi-config.syncPluginAllowOnEnable 一致）：
 * allow 已为非空数组时把 id 补进去，避免 openclaw config-state 的严格白名单语义
 * 把 entries.enabled=true 静默吃掉；allow 缺失/为空时不动（语义是"未启用白名单"）。
 */
export function syncPluginAllowOnEnable(draft: Record<string, unknown>, pluginId: string): void {
  const plugins = isRecord(draft.plugins) ? draft.plugins : null;
  const allow = plugins?.allow;
  if (!Array.isArray(allow) || allow.length === 0) return;
  if (!allow.includes(pluginId)) allow.push(pluginId);
}

/** kimi-coding provider 是否已配置 key（脱敏哨兵 / proxy-managed 占位均视为已配置） */
export function isKimiCodeConfigured(config: Record<string, unknown> | null | undefined): boolean {
  const key = isRecord(config?.models) && isRecord((config.models as Record<string, unknown>).providers)
    ? ((config.models as Record<string, unknown>).providers as Record<string, unknown>)["kimi-coding"]
    : undefined;
  const apiKey = isRecord(key) ? key.apiKey : undefined;
  return typeof apiKey === "string" && apiKey.trim().length > 0;
}

/* ── 飞书 ── */

export const FEISHU_CHANNEL_ID = "feishu";

export type DmPolicy = "open" | "pairing" | "allowlist";
export type GroupPolicy = "open" | "allowlist" | "disabled";
export type DmScope = "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";

export interface FeishuView {
  enabled: boolean;
  appId: string;
  appSecret: string;
  dmPolicy: DmPolicy;
  dmScope: DmScope;
  groupPolicy: GroupPolicy;
  groupAllowFrom: string[];
}

export function normalizeDmPolicy(input: unknown, fallback: DmPolicy): DmPolicy {
  const value = String(input ?? "").trim().toLowerCase();
  return value === "open" || value === "pairing" || value === "allowlist" ? value : fallback;
}

export function normalizeGroupPolicy(input: unknown, fallback: GroupPolicy): GroupPolicy {
  const value = String(input ?? "").trim().toLowerCase();
  return value === "open" || value === "allowlist" || value === "disabled" ? value : fallback;
}

export function normalizeDmScope(input: unknown, fallback: DmScope): DmScope {
  const value = String(input ?? "").trim().toLowerCase();
  return value === "main" || value === "per-peer" || value === "per-channel-peer" || value === "per-account-channel-peer"
    ? value
    : fallback;
}

export function looksLikeFeishuGroupId(value: string): boolean {
  return /^oc_[A-Za-z0-9]/.test(value);
}

export function looksLikeFeishuUserId(value: string): boolean {
  return /^ou_[A-Za-z0-9]/.test(value);
}

function legacyFeishuPluginEnabled(config: Record<string, unknown>): boolean | undefined {
  const entry = isRecord(config.plugins) && isRecord(config.plugins.entries)
    ? (config.plugins.entries as Record<string, unknown>)[FEISHU_CHANNEL_ID]
    : undefined;
  const enabled = isRecord(entry) ? entry.enabled : undefined;
  return typeof enabled === "boolean" ? enabled : undefined;
}

/** 清除旧版 plugins.entries.feishu 开关残留（与主进程 clearLegacyFeishuPluginEntry 一致） */
function clearLegacyFeishuPluginEntry(draft: Record<string, unknown>): void {
  const entries = isRecord(draft.plugins) && isRecord(draft.plugins.entries)
    ? (draft.plugins.entries as Record<string, unknown>)
    : null;
  if (entries && Object.prototype.hasOwnProperty.call(entries, FEISHU_CHANNEL_ID)) {
    delete entries[FEISHU_CHANNEL_ID];
  }
}

/** 从配置快照提取飞书视图模型（语义同旧 settings:get-channel-config） */
export function extractFeishuView(config: Record<string, unknown> | null | undefined): FeishuView {
  const channels = isRecord(config?.channels) ? config.channels : {};
  const feishu = isRecord(channels[FEISHU_CHANNEL_ID]) ? (channels[FEISHU_CHANNEL_ID] as Record<string, unknown>) : {};
  const legacyEnabled = config ? legacyFeishuPluginEnabled(config) : undefined;
  const enabled = typeof legacyEnabled === "boolean" ? legacyEnabled : feishu.enabled === true;
  const dmPolicy = normalizeDmPolicy(feishu.dmPolicy, "open");
  const allowFrom = normalizeAllowFromEntries(feishu.allowFrom);
  return {
    enabled,
    appId: typeof feishu.appId === "string" ? feishu.appId : "",
    appSecret: typeof feishu.appSecret === "string" ? feishu.appSecret : "",
    // dmPolicyOpen 语义：open 或 allowFrom 含通配符 → UI 视为 open
    dmPolicy: dmPolicy === "open" || allowFrom.includes(WILDCARD_ALLOW_ENTRY) ? "open" : dmPolicy,
    dmScope: normalizeDmScope(isRecord(config?.session) ? config.session.dmScope : undefined, "main"),
    groupPolicy: normalizeGroupPolicy(feishu.groupPolicy, "allowlist"),
    groupAllowFrom: normalizeAllowFromEntries(feishu.groupAllowFrom),
  };
}

export interface FeishuSaveParams {
  enabled: boolean;
  appId?: string;
  appSecret?: string;
  dmPolicy?: unknown;
  dmScope?: unknown;
  groupPolicy?: unknown;
  groupAllowFrom?: unknown;
}

/**
 * 在 draft 上应用飞书保存（移植自 settings:save-channel；凭据验证留在主进程 verify-key）。
 * 返回 false 表示群白名单含非法 ID（调用方应中止 patch 并提示）。
 */
export function applyFeishuSave(draft: Record<string, unknown>, params: FeishuSaveParams): boolean {
  const dmPolicy = normalizeDmPolicy(params.dmPolicy, "open");
  const groupPolicy = normalizeGroupPolicy(params.groupPolicy, "allowlist");
  const groupAllowFrom = normalizeAllowFromEntries(params.groupAllowFrom);

  if (groupPolicy === "allowlist" && groupAllowFrom.some((entry) => !looksLikeFeishuGroupId(entry))) {
    return false;
  }

  const channels = ensureRecord(draft, "channels");

  // 仅禁用 → 不触碰凭据
  if (params.enabled === false) {
    const feishu = ensureRecord(channels, FEISHU_CHANNEL_ID);
    feishu.enabled = false;
    clearLegacyFeishuPluginEntry(draft);
    return true;
  }

  const dmScope = normalizeDmScope(
    params.dmScope,
    normalizeDmScope(isRecord(draft.session) ? draft.session.dmScope : undefined, "main"),
  );

  // 保留已有飞书策略字段，避免每次保存凭据都把 allowFrom 覆盖丢失
  const prevFeishu = isRecord(channels[FEISHU_CHANNEL_ID]) ? (channels[FEISHU_CHANNEL_ID] as Record<string, unknown>) : {};
  const feishu: Record<string, unknown> = {
    ...prevFeishu,
    appId: typeof params.appId === "string" ? params.appId : "",
    appSecret: typeof params.appSecret === "string" ? params.appSecret : "",
    enabled: true,
  };
  channels[FEISHU_CHANNEL_ID] = feishu;
  clearLegacyFeishuPluginEntry(draft);

  const allowFromWithoutWildcard = normalizeAllowFromEntries(feishu.allowFrom)
    .filter((entry) => entry !== WILDCARD_ALLOW_ENTRY);
  if (dmPolicy === "open") {
    feishu.dmPolicy = "open";
    feishu.allowFrom = dedupeEntries([...allowFromWithoutWildcard, WILDCARD_ALLOW_ENTRY]);
  } else {
    feishu.dmPolicy = dmPolicy;
    if (allowFromWithoutWildcard.length > 0) {
      feishu.allowFrom = allowFromWithoutWildcard;
    } else {
      delete feishu.allowFrom;
    }
  }
  feishu.groupPolicy = groupPolicy;
  if (groupAllowFrom.length > 0) {
    feishu.groupAllowFrom = groupAllowFrom;
  } else {
    delete feishu.groupAllowFrom;
  }

  // 私聊会话隔离属于全局 session 配置，不是飞书子配置
  const session = ensureRecord(draft, "session");
  if (dmScope === "main") {
    delete session.dmScope;
    if (Object.keys(session).length === 0) {
      delete draft.session;
    }
  } else {
    session.dmScope = dmScope;
  }
  return true;
}

/* ── QQ Bot ── */

export const QQBOT_PLUGIN_ID = "qqbot";

export interface QqbotView {
  enabled: boolean;
  appId: string;
  clientSecret: string;
  markdownSupport: boolean;
}

export function extractQqbotView(config: Record<string, unknown> | null | undefined): QqbotView {
  const entry = isRecord(config?.plugins) && isRecord(config.plugins.entries)
    ? (config.plugins.entries as Record<string, unknown>)[QQBOT_PLUGIN_ID] : undefined;
  const channel = isRecord(config?.channels) && isRecord(config.channels[QQBOT_PLUGIN_ID])
    ? (config.channels[QQBOT_PLUGIN_ID] as Record<string, unknown>) : {};
  return {
    enabled: (isRecord(entry) && entry.enabled === true) || channel.enabled === true,
    appId: typeof channel.appId === "string" ? channel.appId : "",
    clientSecret: typeof channel.clientSecret === "string" ? channel.clientSecret : "",
    markdownSupport: channel.markdownSupport === true,
  };
}

export interface QqbotSaveParams {
  enabled: boolean;
  appId?: string;
  clientSecret?: string;
  markdownSupport?: boolean;
}

/** 移植自主进程 saveQqbotConfig：保留高级字段，仅覆盖设置页可管理的核心字段 */
export function applyQqbotSave(draft: Record<string, unknown>, params: QqbotSaveParams): void {
  const plugins = ensureRecord(draft, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const channels = ensureRecord(draft, "channels");

  const existingEntry = isRecord(entries[QQBOT_PLUGIN_ID]) ? (entries[QQBOT_PLUGIN_ID] as Record<string, unknown>) : {};
  const existingChannel = isRecord(channels[QQBOT_PLUGIN_ID]) ? (channels[QQBOT_PLUGIN_ID] as Record<string, unknown>) : {};

  entries[QQBOT_PLUGIN_ID] = { ...existingEntry, enabled: params.enabled === true };

  if (params.enabled !== true) {
    channels[QQBOT_PLUGIN_ID] = { ...existingChannel, enabled: false };
    return;
  }

  syncPluginAllowOnEnable(draft, QQBOT_PLUGIN_ID);

  const allowFrom = normalizeAllowFromEntries(existingChannel.allowFrom);
  const next: Record<string, unknown> = {
    ...existingChannel,
    enabled: true,
    appId: String(params.appId ?? "").trim(),
    clientSecret: String(params.clientSecret ?? "").trim(),
    markdownSupport: params.markdownSupport === true,
    // 未配置时默认允许所有发送者触发命令
    allowFrom: allowFrom.length > 0 ? allowFrom : [WILDCARD_ALLOW_ENTRY],
  };
  // 设置页直接写入明文密钥时，清理 file-based 旧配置，避免来源冲突
  delete next.clientSecretFile;
  channels[QQBOT_PLUGIN_ID] = next;
}

/* ── 钉钉 ── */

export const DINGTALK_CONNECTOR_PLUGIN_ID = "dingtalk-connector";
export const DEFAULT_DINGTALK_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export interface DingtalkView {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  sessionTimeout: number;
}

function normalizeDingtalkSessionTimeout(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return fallback;
}

export function extractDingtalkView(config: Record<string, unknown> | null | undefined): DingtalkView {
  const entry = isRecord(config?.plugins) && isRecord(config.plugins.entries)
    ? (config.plugins.entries as Record<string, unknown>)[DINGTALK_CONNECTOR_PLUGIN_ID] : undefined;
  const channel = isRecord(config?.channels) && isRecord(config.channels[DINGTALK_CONNECTOR_PLUGIN_ID])
    ? (config.channels[DINGTALK_CONNECTOR_PLUGIN_ID] as Record<string, unknown>) : {};
  return {
    enabled: (isRecord(entry) && entry.enabled === true) || channel.enabled === true,
    clientId: typeof channel.clientId === "string" ? channel.clientId : "",
    clientSecret: typeof channel.clientSecret === "string" ? channel.clientSecret : "",
    sessionTimeout: normalizeDingtalkSessionTimeout(channel.sessionTimeout, DEFAULT_DINGTALK_SESSION_TIMEOUT_MS),
  };
}

export interface DingtalkSaveParams {
  enabled: boolean;
  clientId?: string;
  clientSecret?: string;
}

/** openclaw 2026.4.x schema additionalProperties:false，启用/禁用路径都必须剥离旧字段 */
function stripDeprecatedDingtalkChannelFields(channel: Record<string, unknown>): Record<string, unknown> {
  const next = { ...channel };
  delete next.gatewayToken;
  delete next.sessionTimeout;
  return next;
}

/**
 * 移植自主进程 saveDingtalkConfig。
 * 差异：gateway.auth.token 已存在（含 REDACTED 哨兵）时原样保留，不在渲染层生成新 token；
 * 仅在缺失时生成随机 token（极端兜底：gateway 能连接说明 token 必然存在）。
 */
export function applyDingtalkSave(draft: Record<string, unknown>, params: DingtalkSaveParams): void {
  const plugins = ensureRecord(draft, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const channels = ensureRecord(draft, "channels");

  const existingEntry = isRecord(entries[DINGTALK_CONNECTOR_PLUGIN_ID])
    ? (entries[DINGTALK_CONNECTOR_PLUGIN_ID] as Record<string, unknown>) : {};
  const existingChannel = isRecord(channels[DINGTALK_CONNECTOR_PLUGIN_ID])
    ? (channels[DINGTALK_CONNECTOR_PLUGIN_ID] as Record<string, unknown>) : {};

  entries[DINGTALK_CONNECTOR_PLUGIN_ID] = { ...existingEntry, enabled: params.enabled === true };

  if (params.enabled !== true) {
    channels[DINGTALK_CONNECTOR_PLUGIN_ID] = {
      ...stripDeprecatedDingtalkChannelFields(existingChannel),
      enabled: false,
    };
    return;
  }

  // 钉钉连接器依赖 Gateway HTTP chatCompletions 端点 + token 鉴权，保存时自动补齐
  const gateway = ensureRecord(draft, "gateway");
  const auth = ensureRecord(gateway, "auth");
  if (typeof auth.token !== "string" || !auth.token.trim()) {
    auth.token = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  auth.mode = "token";
  if (typeof gateway.mode !== "string" || !gateway.mode.trim()) {
    gateway.mode = "local";
  }
  const http = ensureRecord(gateway, "http");
  const endpoints = ensureRecord(http, "endpoints");
  const existingEndpoint = isRecord(endpoints.chatCompletions) ? (endpoints.chatCompletions as Record<string, unknown>) : {};
  endpoints.chatCompletions = { ...existingEndpoint, enabled: true };

  // plugins.allow 非空时是严格白名单：首次启用必须把 id 补进去，否则 channel 永远不 register
  syncPluginAllowOnEnable(draft, DINGTALK_CONNECTOR_PLUGIN_ID);

  channels[DINGTALK_CONNECTOR_PLUGIN_ID] = {
    ...stripDeprecatedDingtalkChannelFields(existingChannel),
    enabled: true,
    clientId: String(params.clientId ?? "").trim(),
    clientSecret: String(params.clientSecret ?? "").trim(),
  };
}

/* ── 企业微信 ── */

export const WECOM_PLUGIN_ID = "wecom-openclaw-plugin";
export const WECOM_CHANNEL_ID = "wecom";

export type WecomDmPolicy = "pairing" | "open";

export interface WecomView {
  enabled: boolean;
  botId: string;
  secret: string;
  dmPolicy: WecomDmPolicy;
  groupPolicy: GroupPolicy;
  groupAllowFrom: string[];
}

export function extractWecomView(config: Record<string, unknown> | null | undefined): WecomView {
  const entry = isRecord(config?.plugins) && isRecord(config.plugins.entries)
    ? (config.plugins.entries as Record<string, unknown>)[WECOM_PLUGIN_ID] : undefined;
  const channel = isRecord(config?.channels) && isRecord(config.channels[WECOM_CHANNEL_ID])
    ? (config.channels[WECOM_CHANNEL_ID] as Record<string, unknown>) : {};
  return {
    enabled: (isRecord(entry) && entry.enabled === true) || channel.enabled === true,
    botId: typeof channel.botId === "string" ? channel.botId : "",
    secret: typeof channel.secret === "string" ? channel.secret : "",
    dmPolicy: channel.dmPolicy === "pairing" ? "pairing" : "open",
    groupPolicy: normalizeGroupPolicy(channel.groupPolicy, "open"),
    groupAllowFrom: normalizeAllowFromEntries(channel.groupAllowFrom),
  };
}

export interface WecomSaveParams {
  enabled: boolean;
  botId?: string;
  secret?: string;
  dmPolicy?: unknown;
  groupPolicy?: unknown;
  groupAllowFrom?: unknown;
}

/** 移植自主进程 saveWecomConfig（不含 verifyWecom，凭据验证留在主进程 verify-key） */
export function applyWecomSave(draft: Record<string, unknown>, params: WecomSaveParams): void {
  const plugins = ensureRecord(draft, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const channels = ensureRecord(draft, "channels");

  const existingEntry = isRecord(entries[WECOM_PLUGIN_ID]) ? (entries[WECOM_PLUGIN_ID] as Record<string, unknown>) : {};
  const existingChannel = isRecord(channels[WECOM_CHANNEL_ID]) ? (channels[WECOM_CHANNEL_ID] as Record<string, unknown>) : {};

  entries[WECOM_PLUGIN_ID] = { ...existingEntry, enabled: params.enabled === true };

  if (params.enabled !== true) {
    channels[WECOM_CHANNEL_ID] = { ...existingChannel, enabled: false };
    return;
  }

  const dmPolicy: WecomDmPolicy = (params.dmPolicy ?? existingChannel.dmPolicy) === "pairing" ? "pairing" : "open";
  const groupPolicy = normalizeGroupPolicy(params.groupPolicy ?? existingChannel.groupPolicy, "open");
  const nextGroupAllowFrom =
    params.groupAllowFrom === undefined
      ? normalizeAllowFromEntries(existingChannel.groupAllowFrom)
      : normalizeAllowFromEntries(params.groupAllowFrom);

  channels[WECOM_CHANNEL_ID] = {
    ...existingChannel,
    enabled: true,
    botId: String(params.botId ?? "").trim(),
    secret: String(params.secret ?? "").trim(),
    dmPolicy,
    groupPolicy,
    // 私聊策略 open 时确保 allowFrom 含通配符，避免行为和配置漂移
    allowFrom: dmPolicy === "open" ? [WILDCARD_ALLOW_ENTRY] : normalizeAllowFromEntries(existingChannel.allowFrom),
    groupAllowFrom: nextGroupAllowFrom,
  };
}

/* ── 微信 ── */

export const WEIXIN_PLUGIN_ID = "openclaw-weixin";

export function extractWeixinEnabled(config: Record<string, unknown> | null | undefined): boolean {
  const entry = isRecord(config?.plugins) && isRecord(config.plugins.entries)
    ? (config.plugins.entries as Record<string, unknown>)[WEIXIN_PLUGIN_ID] : undefined;
  const channel = isRecord(config?.channels) && isRecord(config.channels[WEIXIN_PLUGIN_ID])
    ? (config.channels[WEIXIN_PLUGIN_ID] as Record<string, unknown>) : {};
  return (isRecord(entry) && entry.enabled === true) || channel.enabled === true;
}

/** 移植自主进程 saveWeixinConfig（仅 enabled 开关；插件 reconcile 留在主进程） */
export function applyWeixinSave(draft: Record<string, unknown>, enabled: boolean): void {
  const plugins = ensureRecord(draft, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const channels = ensureRecord(draft, "channels");

  const existingEntry = isRecord(entries[WEIXIN_PLUGIN_ID]) ? (entries[WEIXIN_PLUGIN_ID] as Record<string, unknown>) : {};
  const existingChannel = isRecord(channels[WEIXIN_PLUGIN_ID]) ? (channels[WEIXIN_PLUGIN_ID] as Record<string, unknown>) : {};

  entries[WEIXIN_PLUGIN_ID] = { ...existingEntry, enabled };

  channels[WEIXIN_PLUGIN_ID] = {
    ...existingChannel,
    enabled,
    // openclaw gateway 的 hasMeaningfulChannelConfig() 只有在 channels.<id> 里
    // 存在非 enabled 字段时才把该 channel 视作 "已配置"，进而纳入启动插件集合。
    channelConfigUpdatedAt: new Date().toISOString(),
  };
}

/* ── Kimi Search ── */

export const KIMI_SEARCH_PLUGIN_ID = "kimi-search";

export interface KimiSearchView {
  enabled: boolean;
  serviceBaseUrl: string;
  isKimiCodeConfigured: boolean;
}

export function extractKimiSearchView(config: Record<string, unknown> | null | undefined): KimiSearchView {
  const entry = isRecord(config?.plugins) && isRecord(config.plugins.entries)
    ? (config.plugins.entries as Record<string, unknown>)[KIMI_SEARCH_PLUGIN_ID] : undefined;
  // 从插件 config.search.baseUrl 反推 serviceBaseUrl（去掉末尾 /search）
  const searchBaseUrl = isRecord(entry) && isRecord(entry.config) && isRecord(entry.config.search)
    ? entry.config.search.baseUrl : undefined;
  const serviceBaseUrl = typeof searchBaseUrl === "string" && searchBaseUrl.endsWith("/search")
    ? searchBaseUrl.slice(0, -"/search".length)
    : "";
  return {
    enabled: isRecord(entry) && entry.enabled === true,
    serviceBaseUrl,
    isKimiCodeConfigured: isKimiCodeConfigured(config),
  };
}

export interface KimiSearchSaveParams {
  enabled: boolean;
  serviceBaseUrl?: string;
}

/** 移植自主进程 saveKimiSearchConfig（专属 API key 的 sidecar 读写留在主进程） */
export function applyKimiSearchSave(draft: Record<string, unknown>, params: KimiSearchSaveParams): void {
  const plugins = ensureRecord(draft, "plugins");
  const entries = ensureRecord(plugins, "entries");

  const existing = isRecord(entries[KIMI_SEARCH_PLUGIN_ID]) ? (entries[KIMI_SEARCH_PLUGIN_ID] as Record<string, unknown>) : {};
  const entry: Record<string, unknown> = { ...existing, enabled: params.enabled };

  // 有自定义 base URL 时写入 search/fetch 端点，空字符串则清除回默认
  const baseUrl = params.serviceBaseUrl?.trim();
  if (baseUrl) {
    entry.config = {
      ...(isRecord(existing.config) ? existing.config : {}),
      search: { baseUrl: `${baseUrl}/search` },
      fetch: { baseUrl: `${baseUrl}/fetch` },
    };
  } else {
    delete entry.config;
  }

  entries[KIMI_SEARCH_PLUGIN_ID] = entry;
  if (params.enabled) syncPluginAllowOnEnable(draft, KIMI_SEARCH_PLUGIN_ID);
}

/* ── 记忆 ── */

export const KIMI_EMBEDDING_MODEL = "bge_m3_embed";

export interface MemoryView {
  sessionMemoryEnabled: boolean;
  embeddingEnabled: boolean;
  isKimiCodeConfigured: boolean;
}

export function extractMemoryView(config: Record<string, unknown> | null | undefined): MemoryView {
  const hookEntry = isRecord(config?.hooks) && isRecord(config.hooks.internal) && isRecord(config.hooks.internal.entries)
    ? (config.hooks.internal.entries as Record<string, unknown>)["session-memory"] : undefined;
  const ms = isRecord(config?.agents) && isRecord(config.agents.defaults)
    ? (config.agents.defaults as Record<string, unknown>).memorySearch : undefined;
  return {
    // session-memory hook：未配置过视为开启（存量用户默认开启）
    sessionMemoryEnabled: !(isRecord(hookEntry) && hookEntry.enabled === false),
    // embedding：有 provider + model 配置即为启用（memorySearch.enabled 不在此处判断）
    embeddingEnabled: isRecord(ms) && ms.provider === "openai" && typeof ms.model === "string" && ms.model.length > 0,
    isKimiCodeConfigured: isKimiCodeConfigured(config),
  };
}

export interface MemorySaveParams {
  sessionMemoryEnabled?: boolean;
  embeddingEnabled?: boolean;
  /** embedding 走本地 auth proxy 时的代理端口（主进程提供）；<=0 时不写 memorySearch */
  proxyPort?: number;
}

/** 移植自 settings:save-memory-config + ensureMemorySearchProxyConfig */
export function applyMemorySave(draft: Record<string, unknown>, params: MemorySaveParams): void {
  // session-memory hook
  const hooks = ensureRecord(draft, "hooks");
  const internal = ensureRecord(hooks, "internal");
  const entries = ensureRecord(internal, "entries");
  const existingHook = isRecord(entries["session-memory"]) ? (entries["session-memory"] as Record<string, unknown>) : {};
  entries["session-memory"] = { ...existingHook, enabled: params.sessionMemoryEnabled !== false };

  // embedding 开关：只控制 provider/model，不碰 memorySearch.enabled（关键词搜索始终可用）
  const agents = ensureRecord(draft, "agents");
  const defaults = ensureRecord(agents, "defaults");
  if (params.embeddingEnabled === true) {
    const proxyPort = params.proxyPort ?? 0;
    if (proxyPort > 0) {
      const ms = ensureRecord(defaults, "memorySearch");
      const remote = ensureRecord(ms, "remote");
      ms.enabled = true;
      ms.provider = "openai";
      ms.model = KIMI_EMBEDDING_MODEL;
      remote.baseUrl = `http://127.0.0.1:${proxyPort}/coding/v1/`;
      remote.apiKey = "proxy-managed";
    }
  } else if (params.embeddingEnabled === false && isRecord(defaults.memorySearch)) {
    const ms = defaults.memorySearch as Record<string, unknown>;
    delete ms.provider;
    delete ms.model;
    delete ms.remote;
  }
}

/* ── 高级（openclaw.json 部分） ── */

export type GatewayReloadMode = "off" | "restart" | "hot" | "hybrid";
export type ExecMode = "ask" | "auto" | "full";
export type ExecHost = "auto" | "gateway" | "node" | "sandbox";
export type SandboxMode = "off" | "non-main" | "all";
export type SandboxWorkspaceAccess = "rw" | "ro" | "none";

export interface AdvancedView {
  gatewayReloadMode: GatewayReloadMode;
  execMode: ExecMode;
  execHost: ExecHost;
  execReviewerModel: string;
  sandboxMode: SandboxMode;
  sandboxWorkspaceAccess: SandboxWorkspaceAccess;
  imessageEnabled: boolean;
}

/** 从配置快照提取高级设置视图（openclaw.json 部分；语义同旧 settings:get-advanced） */
export function extractAdvancedView(config: Record<string, unknown> | null | undefined): AdvancedView {
  const gateway = isRecord(config?.gateway) ? config.gateway : {};
  const reload = isRecord(gateway.reload) ? gateway.reload : {};
  const tools = isRecord(config?.tools) ? config.tools : {};
  const exec = isRecord(tools.exec) ? tools.exec : {};
  const reviewer = isRecord(exec.reviewer) ? exec.reviewer : {};
  const agents = isRecord(config?.agents) ? config.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const sandbox = isRecord(defaults.sandbox) ? defaults.sandbox : {};
  const channels = isRecord(config?.channels) ? config.channels : {};
  const imessage = isRecord(channels.imessage) ? channels.imessage : {};

  const rawReloadMode = reload.mode;
  const rawExecMode = exec.mode === "approve-all" ? "full" : exec.mode;
  const rawExecHost = exec.host;
  const rawSandboxMode = sandbox.mode;
  const rawWorkspaceAccess = sandbox.workspaceAccess;
  return {
    gatewayReloadMode:
      rawReloadMode === "off" || rawReloadMode === "restart" || rawReloadMode === "hot" || rawReloadMode === "hybrid"
        ? rawReloadMode : "hybrid",
    execMode: rawExecMode === "auto" || rawExecMode === "full" ? rawExecMode : "ask",
    execHost: rawExecHost === "gateway" || rawExecHost === "node" || rawExecHost === "sandbox" ? rawExecHost : "auto",
    execReviewerModel: typeof reviewer.model === "string" ? reviewer.model : "",
    sandboxMode: rawSandboxMode === "non-main" || rawSandboxMode === "all" ? rawSandboxMode : "off",
    sandboxWorkspaceAccess: rawWorkspaceAccess === "ro" || rawWorkspaceAccess === "none" ? rawWorkspaceAccess : "rw",
    imessageEnabled: imessage.enabled !== false,
  };
}

export interface AdvancedSaveParams {
  gatewayReloadMode?: unknown;
  execMode?: unknown;
  execHost?: unknown;
  execReviewerModel?: string;
  sandboxMode?: unknown;
  sandboxWorkspaceAccess?: unknown;
  imessageEnabled?: boolean;
}

/**
 * 移植自 settings:save-advanced 的 openclaw.json 部分
 * （browserMode / launchAtLogin / clawHubRegistry 属主进程职责，不在此处）。
 * gateway.reload.mode 兜底：用户从未显式设置时默认写 "hybrid"。
 */
export function applyAdvancedSave(draft: Record<string, unknown>, params: AdvancedSaveParams): void {
  // gateway 热应用模式
  const rawReloadMode = params.gatewayReloadMode;
  const reloadMode =
    rawReloadMode === "off" || rawReloadMode === "restart" || rawReloadMode === "hot" || rawReloadMode === "hybrid"
      ? rawReloadMode
      : (extractAdvancedView(draft).gatewayReloadMode ?? "hybrid");
  const gateway = ensureRecord(draft, "gateway");
  const reload = ensureRecord(gateway, "reload");
  reload.mode = reloadMode;

  // 执行权限（approve-all 历史残留归一化为 full）
  const rawExecMode = params.execMode === "approve-all" ? "full" : params.execMode;
  if (rawExecMode === "ask" || rawExecMode === "auto" || rawExecMode === "full") {
    const tools = ensureRecord(draft, "tools");
    const exec = ensureRecord(tools, "exec");
    exec.mode = rawExecMode;
  }
  const rawExecHost = params.execHost;
  if (rawExecHost === "auto" || rawExecHost === "gateway" || rawExecHost === "node" || rawExecHost === "sandbox") {
    const tools = ensureRecord(draft, "tools");
    const exec = ensureRecord(tools, "exec");
    exec.host = rawExecHost;
  }
  if (params.execReviewerModel !== undefined) {
    const tools = ensureRecord(draft, "tools");
    const exec = ensureRecord(tools, "exec");
    const trimmed = params.execReviewerModel.trim();
    if (trimmed) {
      const reviewer = ensureRecord(exec, "reviewer");
      reviewer.model = trimmed;
    } else if (isRecord(exec.reviewer)) {
      const reviewer = exec.reviewer as Record<string, unknown>;
      delete reviewer.model;
      if (Object.keys(reviewer).length === 0) delete exec.reviewer;
    }
  }

  // 沙箱
  const rawSandboxMode = params.sandboxMode;
  if (rawSandboxMode === "off" || rawSandboxMode === "non-main" || rawSandboxMode === "all") {
    const agents = ensureRecord(draft, "agents");
    const defaults = ensureRecord(agents, "defaults");
    const sandbox = ensureRecord(defaults, "sandbox");
    sandbox.mode = rawSandboxMode;
  }
  const rawWorkspaceAccess = params.sandboxWorkspaceAccess;
  if (rawWorkspaceAccess === "rw" || rawWorkspaceAccess === "ro" || rawWorkspaceAccess === "none") {
    const agents = ensureRecord(draft, "agents");
    const defaults = ensureRecord(agents, "defaults");
    const sandbox = ensureRecord(defaults, "sandbox");
    sandbox.workspaceAccess = rawWorkspaceAccess;
  }

  // iMessage 频道开关
  if (typeof params.imessageEnabled === "boolean") {
    const channels = ensureRecord(draft, "channels");
    const imessage = ensureRecord(channels, "imessage");
    imessage.enabled = params.imessageEnabled;
  }
}
