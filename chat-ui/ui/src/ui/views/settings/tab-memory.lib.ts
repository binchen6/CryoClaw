/**
 * Settings: Memory Tab 纯函数库 — config 快照视图提取 + 单次 patch draft 应用。
 *
 * 覆盖内核 2026.9.3 记忆配置全景：
 * - 根级 `memory`（citations / search）——语义检索读写一律走根级 `memory.search`
 *   （strict schema 不认旧 `agents.defaults.memorySearch`；旧路径仅读取兜底做显示迁移）
 * - `hooks.internal.entries["session-memory"]`（会话转录归档）
 * - `plugins.entries["memory-core"].config.dreaming`（记忆固化）
 * - `plugins.entries["active-memory"]`（主动记忆；entry 存在才可管理）
 *
 * applyMemorySave 在同一个 draft 上就位全部变更（hooks.internal + memory +
 * plugins.entries 合并为一次 config.patch）；不依赖 lit / i18n / IPC，可独立单测。
 */
import { AUTH_PROXY_API_KEY_SENTINEL } from "../setup/setup-constants.ts";
import { isRecord, ensureRecord, isKimiCodeConfigured } from "./tab-channels.lib.ts";

/* ── 常量与类型 ── */

/** Kimi 本地 auth proxy 提供的 embedding 模型（与主进程 kimi-config.ts 一致） */
export const KIMI_EMBEDDING_MODEL = "bge_m3_embed";
/** Kimi 本地代理 embedding 端点前缀（写入 memory.search.remote.baseUrl） */
export function kimiEmbeddingBaseUrl(proxyPort: number): string {
  return `http://127.0.0.1:${proxyPort}/coding/v1/`;
}

export type MemoryCitationMode = "auto" | "on" | "off";
export type MemorySearchSource = "memory" | "sessions";
export type DreamingStorageMode = "inline" | "separate" | "both";
export type ActiveMemoryMode = "escalate" | "always" | "off";

/** memory.search.provider 白名单（"none" = 禁用 embedding，仅关键词检索）。
 *  此外内核接受任意 openai-compatible 的 models.providers key 作为 provider
 *  （baseUrl 自动回落该 provider 配置），UI 层下拉据此追加「已配置的服务商」。 */
export const MEMORY_SEARCH_PROVIDERS = [
  "openai", "openai-compatible", "gemini", "voyage", "mistral", "bedrock",
  "deepinfra", "github-copilot", "lmstudio", "ollama", "local", "none",
] as const;
export type MemorySearchProvider = (typeof MEMORY_SEARCH_PROVIDERS)[number];

export const MEMORY_SEARCH_DEFAULTS = {
  enabled: true,
  provider: "openai" as MemorySearchProvider,
  maxResults: 6,
  minScore: 0.35,
} as const;

export const SESSION_MEMORY_DEFAULTS = { messages: 15 } as const;
export const DREAMING_DEFAULT_FREQUENCY = "0 3 * * *";

export interface SessionMemoryView {
  enabled: boolean;
  /** 每次归档的最大消息数（默认 15） */
  messages: number;
  /** 归档文件名是否包含 LLM 标识（默认 false） */
  llmSlug: boolean;
  /** 归档用模型；空 = 跟随默认模型 */
  model: string;
}

export interface MemorySearchView {
  enabled: boolean;
  /** 内置白名单值，或任意 openai-compatible 的 models.providers key */
  provider: string;
  /** embedding 模型名；空 = 未配置 */
  model: string;
  /** memory.search.remote.baseUrl（仅展示；显式输入或 Kimi 一键时才写回） */
  baseUrl: string;
  /**
   * memory.search.remote.apiKey 现值（config.get 脱敏快照里的原样值，可能是
   * __OPENCLAW_REDACTED__ 哨兵或 proxy-managed 占位）。仅供 UI 判断「已设置」，
   * 保存语义见 apiKeyInput。
   */
  apiKey: string;
  /**
   * apiKey 保存语义：null = 不改动（透传 draft 里的现值，脱敏哨兵由内核还原）；
   * "" = 清除；非空 = 写入新值。
   */
  apiKeyInput: string | null;
  rememberAcrossConversations: boolean;
  sources: MemorySearchSource[];
  maxResults: number;
  minScore: number;
}

export interface DreamingPhaseView {
  enabled: boolean;
}

export interface DreamingView {
  enabled: boolean;
  /** cron 表达式（默认 "0 3 * * *"） */
  frequency: string;
  /** 固化用模型；空 = 跟随默认模型 */
  model: string;
  /** "" = 未设置（跟随内核默认） */
  storageMode: DreamingStorageMode | "";
  light: DreamingPhaseView;
  deep: DreamingPhaseView;
  rem: DreamingPhaseView;
}

export interface ActiveMemoryView {
  enabled: boolean;
  mode: ActiveMemoryMode;
  model: string;
}

export interface KimiProxyView {
  /** kimi-coding provider 是否已配置 key（一键启用的前提） */
  isKimiCodeConfigured: boolean;
  /** 当前 memory.search 已指向 Kimi 本地 embedding 代理 */
  embeddingActive: boolean;
}

export interface MemorySettingsView {
  sessionMemory: SessionMemoryView;
  search: MemorySearchView;
  citations: MemoryCitationMode;
  dreaming: DreamingView;
  /** 配置里无 active-memory 插件 entry 时为 null（整卡隐藏） */
  activeMemory: ActiveMemoryView | null;
  kimiProxy: KimiProxyView;
}

/** applyMemorySave 入参：与 MemorySettingsView 同构，数值/枚举字段由 UI 层解析后传入 */
export type MemorySaveView = MemorySettingsView;

/* ── 归一化助手 ── */

function normalizeCitationMode(value: unknown): MemoryCitationMode {
  return value === "on" || value === "off" ? value : "auto";
}

function normalizeProvider(value: unknown): string {
  // 白名单值原样放行；其他非空值视为 openai-compatible 的 models.providers key
  // （内核 isOpenAICompatibleMemoryProvider 解析），避免把用户选的自定义服务商
  // 静默归一成 openai；仅空值/非字符串回落默认
  const v = String(value ?? "").trim();
  return v || MEMORY_SEARCH_DEFAULTS.provider;
}

function normalizeSources(value: unknown): MemorySearchSource[] {
  const list = Array.isArray(value)
    ? value.filter((s): s is MemorySearchSource => s === "memory" || s === "sessions")
    : [];
  return list.length > 0 ? [...new Set(list)] : ["memory"];
}

function normalizeDreamingStorageMode(value: unknown): DreamingStorageMode | "" {
  return value === "inline" || value === "separate" || value === "both" ? value : "";
}

function normalizeActiveMemoryMode(value: unknown): ActiveMemoryMode {
  return value === "always" || value === "off" ? value : "escalate";
}

function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 读取根级 memory.search；不存在时兜底旧 agents.defaults.memorySearch（仅显示迁移用） */
function readSearchRecord(config: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const root = isRecord(config?.memory) ? (config.memory as Record<string, unknown>).search : undefined;
  if (isRecord(root)) return root;
  const legacy = isRecord(config?.agents) && isRecord(config.agents.defaults)
    ? (config.agents.defaults as Record<string, unknown>).memorySearch
    : undefined;
  return isRecord(legacy) ? legacy : {};
}

function readPluginEntry(
  config: Record<string, unknown> | null | undefined,
  pluginId: string,
): Record<string, unknown> | null {
  const entry = isRecord(config?.plugins) && isRecord(config.plugins.entries)
    ? (config.plugins.entries as Record<string, unknown>)[pluginId]
    : undefined;
  return isRecord(entry) ? entry : null;
}

function isKimiProxyEmbedding(ms: Record<string, unknown>): boolean {
  const remote = isRecord(ms.remote) ? ms.remote : undefined;
  const baseUrl = typeof remote?.baseUrl === "string" ? remote.baseUrl : "";
  return (
    ms.provider === "openai" &&
    ms.model === KIMI_EMBEDDING_MODEL &&
    /^http:\/\/127\.0\.0\.1:\d+\/coding\/v1\/?$/.test(baseUrl)
  );
}

/* ── 提取 ── */

/**
 * 从 config.get 脱敏快照派生 Memory 页完整视图模型。
 * 未配置的字段落内核默认值（session-memory / dreaming 未配置视为开启，
 * 与存量用户行为一致）。
 */
export function extractMemoryView(
  config: Record<string, unknown> | null | undefined,
): MemorySettingsView {
  // 会话记忆 hook
  const hookEntry = isRecord(config?.hooks) && isRecord(config.hooks.internal) &&
      isRecord(config.hooks.internal.entries)
    ? (config.hooks.internal.entries as Record<string, unknown>)["session-memory"]
    : undefined;
  const hook = isRecord(hookEntry) ? hookEntry : {};
  const sessionMemory: SessionMemoryView = {
    enabled: hook.enabled !== false,
    messages: normalizeNumber(hook.messages, SESSION_MEMORY_DEFAULTS.messages, 1, 10000),
    llmSlug: hook.llmSlug === true,
    model: normalizeString(hook.model),
  };

  // 语义检索（根级 memory.search 优先，旧 agents.defaults.memorySearch 读兜底）
  const ms = readSearchRecord(config);
  const remote = isRecord(ms.remote) ? ms.remote : {};
  const search: MemorySearchView = {
    enabled: ms.enabled !== false,
    provider: normalizeProvider(ms.provider),
    model: normalizeString(ms.model),
    baseUrl: typeof remote.baseUrl === "string" ? remote.baseUrl : "",
    apiKey: typeof remote.apiKey === "string" ? remote.apiKey : "",
    apiKeyInput: null,
    rememberAcrossConversations: ms.rememberAcrossConversations === true,
    sources: normalizeSources(ms.sources),
    maxResults: normalizeNumber(ms.query && isRecord(ms.query) ? (ms.query as Record<string, unknown>).maxResults : undefined,
      MEMORY_SEARCH_DEFAULTS.maxResults, 1, 50),
    minScore: normalizeNumber(ms.query && isRecord(ms.query) ? (ms.query as Record<string, unknown>).minScore : undefined,
      MEMORY_SEARCH_DEFAULTS.minScore, 0, 0.9),
  };

  // 记忆引用
  const citations = normalizeCitationMode(
    isRecord(config?.memory) ? (config.memory as Record<string, unknown>).citations : undefined,
  );

  // 记忆固化（memory-core 插件）
  const coreEntry = readPluginEntry(config, "memory-core");
  const dreamingCfg = isRecord(coreEntry?.config) && isRecord((coreEntry!.config as Record<string, unknown>).dreaming)
    ? ((coreEntry!.config as Record<string, unknown>).dreaming as Record<string, unknown>)
    : {};
  const phases = isRecord(dreamingCfg.phases) ? (dreamingCfg.phases as Record<string, unknown>) : {};
  const phase = (name: string): DreamingPhaseView => {
    const p = isRecord(phases[name]) ? (phases[name] as Record<string, unknown>) : {};
    return { enabled: p.enabled !== false };
  };
  const storage = isRecord(dreamingCfg.storage) ? (dreamingCfg.storage as Record<string, unknown>) : {};
  const dreaming: DreamingView = {
    enabled: dreamingCfg.enabled !== false,
    frequency: normalizeString(dreamingCfg.frequency) || DREAMING_DEFAULT_FREQUENCY,
    model: normalizeString(dreamingCfg.model),
    storageMode: normalizeDreamingStorageMode(storage.mode),
    light: phase("light"),
    deep: phase("deep"),
    rem: phase("rem"),
  };

  // 主动记忆（仅当插件 entry 存在）
  const amEntry = readPluginEntry(config, "active-memory");
  const amConfig = isRecord(amEntry?.config) ? (amEntry!.config as Record<string, unknown>) : null;
  const activeMemory: ActiveMemoryView | null = amEntry
    ? {
        enabled: amConfig?.enabled === true || amEntry.enabled === true,
        mode: normalizeActiveMemoryMode(amConfig?.mode),
        model: normalizeString(amConfig?.model),
      }
    : null;

  return {
    sessionMemory,
    search,
    citations,
    dreaming,
    activeMemory,
    kimiProxy: {
      isKimiCodeConfigured: isKimiCodeConfigured(config),
      embeddingActive: isKimiProxyEmbedding(ms),
    },
  };
}

/* ── 应用（单 draft / 单 patch） ── */

export interface MemoryApplyOptions {
  /**
   * Kimi 一键启用时本地 auth proxy 端口（主进程提供）。
   * >0 时覆盖 search 为 Kimi 预置（provider=openai + model=bge_m3_embed + proxy remote）；
   * <=0 / null 时不覆盖，按用户手填值保存。
   */
  kimiProxyPort?: number | null;
}

/**
 * 把 Memory 页全部变更就位到同一次 config.patch 的 draft 上
 * （memory + hooks.internal + plugins.entries 三域合一，见 tab-patch.ts）。
 * 只写设置页管理的字段；undefined / 空串的字段删除（RFC7396 null = 回落内核默认）。
 * 写侧只写根级 memory.search，旧 agents.defaults.memorySearch 路径不再触碰。
 */
export function applyMemorySave(
  draft: Record<string, unknown>,
  view: MemorySaveView,
  opts?: MemoryApplyOptions,
): void {
  /* 1) 根级 memory：citations + search */
  const memory = ensureRecord(draft, "memory");
  memory.citations = normalizeCitationMode(view.citations);

  const search = ensureRecord(memory, "search");
  const kimiPort = opts?.kimiProxyPort ?? 0;
  const useKimiProxy = kimiPort > 0;
  if (useKimiProxy) {
    // Kimi 一键：本地代理注入鉴权，免手动 key（对齐主进程 ensureMemorySearchProxyConfig）
    search.enabled = true;
    search.provider = "openai";
    search.model = KIMI_EMBEDDING_MODEL;
    const remote = ensureRecord(search, "remote");
    remote.baseUrl = kimiEmbeddingBaseUrl(kimiPort);
    remote.apiKey = AUTH_PROXY_API_KEY_SENTINEL;
  } else {
    search.enabled = view.search.enabled !== false;
    search.provider = normalizeProvider(view.search.provider);
    const model = view.search.model.trim();
    if (model) search.model = model;
    else delete search.model;
    // remote 三段语义（baseUrl / apiKey / 其他 headers 等未知字段原样保留）：
    // - baseUrl：显式输入才写回；清空 = 移除自定义端点（回落 provider 默认）
    // - apiKeyInput：null 不改动（draft 里的脱敏哨兵透传，内核写侧自动还原）；
    //   "" 清除；非空写入。openai-compatible 提供商（含 models.providers key）
    //   内核侧 key 可选——未填时回落该 provider 自身的鉴权配置
    const baseUrl = view.search.baseUrl.trim();
    const apiKeyInput = view.search.apiKeyInput;
    const existingRemote = isRecord(search.remote)
      ? (search.remote as Record<string, unknown>)
      : null;
    if (baseUrl || apiKeyInput != null || existingRemote) {
      const remote: Record<string, unknown> = existingRemote ? { ...existingRemote } : {};
      if (baseUrl) remote.baseUrl = baseUrl;
      else delete remote.baseUrl;
      if (apiKeyInput != null) {
        const key = apiKeyInput.trim();
        if (key) remote.apiKey = key;
        else delete remote.apiKey;
      }
      if (Object.keys(remote).length > 0) search.remote = remote;
      else if (existingRemote) delete search.remote;
    }
  }
  search.rememberAcrossConversations = view.search.rememberAcrossConversations === true;
  search.sources = normalizeSources(view.search.sources);
  const query = ensureRecord(search, "query");
  query.maxResults = normalizeNumber(view.search.maxResults, MEMORY_SEARCH_DEFAULTS.maxResults, 1, 50);
  query.minScore = normalizeNumber(view.search.minScore, MEMORY_SEARCH_DEFAULTS.minScore, 0, 0.9);

  /* 2) session-memory 内置 hook */
  const hooks = ensureRecord(draft, "hooks");
  const internal = ensureRecord(hooks, "internal");
  const hookEntries = ensureRecord(internal, "entries");
  const existingHook = isRecord(hookEntries["session-memory"])
    ? (hookEntries["session-memory"] as Record<string, unknown>)
    : {};
  const hook: Record<string, unknown> = {
    ...existingHook,
    enabled: view.sessionMemory.enabled !== false,
    messages: normalizeNumber(view.sessionMemory.messages, SESSION_MEMORY_DEFAULTS.messages, 1, 10000),
    llmSlug: view.sessionMemory.llmSlug === true,
  };
  const hookModel = view.sessionMemory.model.trim();
  if (hookModel) hook.model = hookModel;
  else delete hook.model;
  hookEntries["session-memory"] = hook;

  /* 3) memory-core 插件 dreaming */
  const plugins = ensureRecord(draft, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const existingCore = isRecord(entries["memory-core"])
    ? (entries["memory-core"] as Record<string, unknown>)
    : {};
  const existingCoreConfig = isRecord(existingCore.config)
    ? (existingCore.config as Record<string, unknown>)
    : {};
  const existingDreaming = isRecord(existingCoreConfig.dreaming)
    ? (existingCoreConfig.dreaming as Record<string, unknown>)
    : {};
  const dreaming: Record<string, unknown> = {
    ...existingDreaming,
    enabled: view.dreaming.enabled !== false,
    frequency: view.dreaming.frequency.trim() || DREAMING_DEFAULT_FREQUENCY,
  };
  const dreamModel = view.dreaming.model.trim();
  if (dreamModel) dreaming.model = dreamModel;
  else delete dreaming.model;
  if (view.dreaming.storageMode) {
    ensureRecord(dreaming as Record<string, unknown>, "storage").mode = view.dreaming.storageMode;
  }
  const dreamPhases = ensureRecord(dreaming as Record<string, unknown>, "phases");
  for (const name of ["light", "deep", "rem"] as const) {
    const existing = isRecord(dreamPhases[name]) ? (dreamPhases[name] as Record<string, unknown>) : {};
    dreamPhases[name] = { ...existing, enabled: view.dreaming[name].enabled !== false };
  }
  entries["memory-core"] = { ...existingCore, config: { ...existingCoreConfig, dreaming } };

  /* 4) active-memory 插件（entry 存在才写） */
  if (view.activeMemory) {
    const existingAm = isRecord(entries["active-memory"])
      ? (entries["active-memory"] as Record<string, unknown>)
      : {};
    const existingAmConfig = isRecord(existingAm.config)
      ? (existingAm.config as Record<string, unknown>)
      : {};
    const amConfig: Record<string, unknown> = {
      ...existingAmConfig,
      enabled: view.activeMemory.enabled === true,
      mode: normalizeActiveMemoryMode(view.activeMemory.mode),
    };
    const amModel = view.activeMemory.model.trim();
    if (amModel) amConfig.model = amModel;
    else delete amConfig.model;
    entries["active-memory"] = { ...existingAm, config: amConfig };
  }
}
