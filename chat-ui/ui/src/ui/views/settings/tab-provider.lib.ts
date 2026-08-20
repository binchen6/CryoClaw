/**
 * Provider 设置页纯函数库 — 分组、显示名、拖拽排序、添加流程（config patch 构造）。
 * 不依赖 lit / i18n / IPC，可独立单测；setup step2 复用同一套添加流程函数。
 */
import { getPath } from "../../controllers/config.ts";
import { getCachedGatewayModelEntries } from "../../controllers/models.ts";
import {
  PROVIDERS, CUSTOM_PRESETS, MOONSHOT_SUB_PLATFORMS, SUB_PLATFORM_URLS,
  deriveCustomConfigKey,
} from "../setup/setup-constants.ts";

export type ProviderGroupId = "moonshot" | "anthropic" | "openai" | "google" | "custom";

export interface ProviderModelEntry {
  /** `providerKey/modelId` 复合键 */
  key: string;
  id: string;
  name: string;
  isDefault: boolean;
  supportsImage: boolean;
  /** 推理模型（config entry.reasoning） */
  reasoning: boolean;
  /** 上下文窗口 token 数（config entry.contextWindow） */
  contextWindow?: number;
  /** 支持的思考档位（entry.compat.supportedReasoningEfforts / thinkingLevelMap 键，off 除外） */
  thinkingLevels: string[];
}

export interface GroupedProvider {
  /** 配置中的 provider key（kimi-coding / moonshot / deepseek / custom-xxx …） */
  providerKey: string;
  /** 组内显示名（preset key 或 custom 的 hostname） */
  displayName: string;
  baseUrl: string;
  api: string;
  /** 是否已有 apiKey（含脱敏哨兵 / proxy-managed 占位） */
  hasApiKey: boolean;
  /** apiKey 是 proxy-managed 占位符（kimi-code 代理模式） */
  proxyManaged: boolean;
  models: ProviderModelEntry[];
}

export interface ProviderGroup {
  groupId: ProviderGroupId;
  providers: GroupedProvider[];
}

const GROUP_ORDER: ProviderGroupId[] = ["moonshot", "anthropic", "openai", "google", "custom"];

/** config provider key → UI 分组 */
export function resolveGroupId(providerKey: string): ProviderGroupId {
  if (providerKey === "kimi-coding" || providerKey === "moonshot") return "moonshot";
  if (providerKey === "anthropic" || providerKey === "openai" || providerKey === "google") {
    return providerKey;
  }
  return "custom";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从模型条目提取思考档位：compat.supportedReasoningEfforts 优先，其次 thinkingLevelMap 键 */
function extractEntryThinkingLevels(entry: unknown): string[] {
  if (!isRecord(entry)) return [];
  const compat = isRecord(entry.compat) ? entry.compat : undefined;
  const efforts = compat?.supportedReasoningEfforts;
  if (Array.isArray(efforts)) {
    return [
      ...new Set(
        efforts.filter((e): e is string => typeof e === "string" && Boolean(e.trim()) && e !== "off"),
      ),
    ];
  }
  const map = isRecord(entry.thinkingLevelMap) ? entry.thinkingLevelMap : undefined;
  if (map) {
    return Object.keys(map).filter((k) => k !== "off" && map[k] !== null);
  }
  return [];
}

/** 上下文窗口紧凑格式化（262144 → "256K"，1048576 → "1M"） */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1024 * 1024 && tokens % (1024 * 1024) === 0) {
    return `${tokens / (1024 * 1024)}M`;
  }
  if (tokens >= 1024) {
    const k = tokens / 1024;
    return `${Number.isInteger(k) ? k : k.toFixed(0)}K`;
  }
  return String(tokens);
}

function providerDisplayName(providerKey: string, prov: Record<string, unknown>): string {
  if (providerKey.startsWith("custom-") && typeof prov.baseUrl === "string") {
    try {
      return new URL(prov.baseUrl).hostname;
    } catch {
      /* fall through */
    }
  }
  return providerKey;
}

/**
 * 从配置快照的 models.providers 聚合分组结构。
 * 组顺序固定 moonshot → anthropic → openai → google → custom；
 * 组内 provider 顺序 = 配置对象 key 顺序；模型顺序 = 配置数组顺序（拖拽排序的唯一事实来源）。
 */
export function groupProvidersFromConfig(config: Record<string, unknown> | null | undefined): ProviderGroup[] {
  const providersRaw = isRecord(config?.models) && isRecord((config.models as Record<string, unknown>).providers)
    ? ((config.models as Record<string, unknown>).providers as Record<string, unknown>)
    : {};
  const defaults = isRecord(config?.agents) && isRecord((config.agents as Record<string, unknown>).defaults)
    ? ((config.agents as Record<string, unknown>).defaults as Record<string, unknown>)
    : {};
  const modelDefaults = isRecord(defaults.model) ? (defaults.model as Record<string, unknown>) : {};
  const primary = typeof modelDefaults.primary === "string" ? modelDefaults.primary : "";

  const groups = new Map<ProviderGroupId, GroupedProvider[]>();
  for (const [providerKey, provRaw] of Object.entries(providersRaw)) {
    if (!isRecord(provRaw)) continue;
    const modelsRaw = Array.isArray(provRaw.models) ? provRaw.models : [];
    const models: ProviderModelEntry[] = [];
    for (const entry of modelsRaw) {
      const id = typeof entry === "string" ? entry : isRecord(entry) && typeof entry.id === "string" ? entry.id : "";
      if (!id) continue;
      const name = isRecord(entry) && typeof entry.name === "string" && entry.name ? entry.name : id;
      const input = isRecord(entry) && Array.isArray(entry.input) ? entry.input : [];
      const key = `${providerKey}/${id}`;
      models.push({
        key,
        id,
        name,
        isDefault: key === primary,
        supportsImage: input.includes("image"),
        reasoning: isRecord(entry) && entry.reasoning === true,
        contextWindow:
          isRecord(entry) && typeof entry.contextWindow === "number" && entry.contextWindow > 0
            ? entry.contextWindow
            : undefined,
        thinkingLevels: extractEntryThinkingLevels(entry),
      });
    }
    if (models.length === 0) continue;
    const apiKey = typeof provRaw.apiKey === "string" ? provRaw.apiKey : "";
    const groupId = resolveGroupId(providerKey);
    const list = groups.get(groupId) ?? [];
    list.push({
      providerKey,
      displayName: providerDisplayName(providerKey, provRaw),
      baseUrl: typeof provRaw.baseUrl === "string" ? provRaw.baseUrl : "",
      api: typeof provRaw.api === "string" ? provRaw.api : "",
      hasApiKey: apiKey.length > 0,
      proxyManaged: apiKey === "proxy-managed",
      models,
    });
    groups.set(groupId, list);
  }

  const result: ProviderGroup[] = [];
  for (const groupId of GROUP_ORDER) {
    const providers = groups.get(groupId);
    if (providers?.length) result.push({ groupId, providers });
  }
  return result;
}

/** 读取 agents.defaults.model.fallbacks（有序 model key 列表） */
export function readFallbacks(config: Record<string, unknown> | null | undefined): string[] {
  const value = getPath(config, "agents.defaults.model.fallbacks");
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

/* ── 拖拽排序 ── */

/**
 * 计算拖拽放置后的新顺序：把 draggedId 移到 targetId 的前/后。
 * draggedId 或 targetId 不存在、或位置不变时返回原数组引用。
 */
export function reorderIds(
  ids: string[],
  draggedId: string,
  targetId: string,
  position: "before" | "after",
): string[] {
  const fromIndex = ids.indexOf(draggedId);
  const targetIndex = ids.indexOf(targetId);
  if (fromIndex < 0 || targetIndex < 0 || draggedId === targetId) return ids;
  const next = [...ids];
  next.splice(fromIndex, 1);
  // 先移除再定位：目标下标以移除后的数组为准
  const insertAt = next.indexOf(targetId) + (position === "after" ? 1 : 0);
  next.splice(insertAt, 0, draggedId);
  // 位置未变时返回原引用，避免无谓的 patch
  if (next.length === ids.length && next.every((id, i) => id === ids[i])) return ids;
  return next;
}

/** 按 ids 顺序重排对象数组（以 getId 提取 id）；未列入 ids 的条目保持相对顺序追加在尾 */
export function applyIdOrder<T>(items: T[], ids: string[], getId: (item: T) => string): T[] {
  const rank = new Map(ids.map((id, index) => [id, index]));
  return [...items].sort((a, b) => {
    const ra = rank.get(getId(a)) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(getId(b)) ?? Number.MAX_SAFE_INTEGER;
    return ra - rb;
  });
}

/* ── 添加流程（tab-provider 与 setup step2 共用） ── */

export interface AddSelection {
  provider: string;
  subPlatform: string;
  customPreset: string;
  baseUrl: string;
  apiType: string;
}

export interface AddTarget {
  providerKey: string;
  baseUrl: string;
  api: string;
  catalogProvider: string | null;
  placeholder: string;
  platformUrl: string;
}

/** 添加流程当前选择对应的 config provider key 与端点 */
export function resolveAddTarget(sel: AddSelection): AddTarget | null {
  if (sel.provider === "moonshot") {
    const sub = MOONSHOT_SUB_PLATFORMS[sel.subPlatform] ?? MOONSHOT_SUB_PLATFORMS["moonshot-cn"];
    return {
      providerKey: sub.providerKey,
      baseUrl: sub.baseUrl,
      api: sub.api,
      catalogProvider: sel.subPlatform === "kimi-code" ? "kimi-coding" : "moonshot",
      placeholder: PROVIDERS.moonshot.placeholder,
      platformUrl: SUB_PLATFORM_URLS[sel.subPlatform] ?? "",
    };
  }
  if (sel.provider === "custom") {
    if (sel.customPreset) {
      const preset = CUSTOM_PRESETS[sel.customPreset];
      if (!preset) return null;
      return {
        providerKey: preset.providerKey,
        baseUrl: preset.baseUrl,
        api: preset.api,
        catalogProvider: preset.providerKey,
        placeholder: preset.placeholder,
        platformUrl: "",
      };
    }
    const baseUrl = sel.baseUrl.trim();
    return {
      providerKey: baseUrl ? deriveCustomConfigKey(baseUrl) : "custom",
      baseUrl,
      api: sel.apiType,
      catalogProvider: null,
      placeholder: "",
      platformUrl: "",
    };
  }
  const def = PROVIDERS[sel.provider];
  if (!def) return null;
  return {
    providerKey: sel.provider,
    baseUrl: def.baseUrl ?? "",
    api: def.api ?? "openai-completions",
    catalogProvider: sel.provider,
    placeholder: def.placeholder,
    platformUrl: def.platformUrl ?? "",
  };
}

/** 从动态目录条目构造模型 entry（携带内核归一化元数据） */
export function buildModelEntry(
  catalogProvider: string | null,
  modelId: string,
  alias: string,
  supportsImage: boolean,
): Record<string, unknown> {
  const catalogEntry = catalogProvider
    ? getCachedGatewayModelEntries()?.[catalogProvider]?.find((item) => item.id === modelId)
    : undefined;
  const entry: Record<string, unknown> = {
    id: modelId,
    name: alias || modelId,
    input: supportsImage ? ["text", "image"] : ["text"],
  };
  if (catalogEntry?.reasoning !== undefined) entry.reasoning = catalogEntry.reasoning;
  if (catalogEntry?.contextWindow !== undefined) entry.contextWindow = catalogEntry.contextWindow;
  if (catalogEntry?.compat) entry.compat = catalogEntry.compat;
  return entry;
}

/**
 * 构造新增 provider 的完整 config 对象（apiKey + baseUrl + api + models）。
 * setup step2 的 save-config fragment 与 tab-provider 新增使用同一份构造逻辑。
 */
export function buildProviderConfigForAdd(
  target: AddTarget,
  apiKey: string,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  return {
    apiKey,
    baseUrl: target.baseUrl,
    api: target.api,
    models: [entry],
  };
}

/** kimi-code 联动：启用 kimi-search 插件 + memory embedding 走代理 */
export function applyKimiCodeLinkage(draft: Record<string, unknown>, proxyPort: number): void {
  const d = draft as any;
  d.plugins ??= {};
  d.plugins.entries ??= {};
  const existing = typeof d.plugins.entries["kimi-search"] === "object" && d.plugins.entries["kimi-search"] !== null
    ? d.plugins.entries["kimi-search"]
    : {};
  d.plugins.entries["kimi-search"] = { ...existing, enabled: true };
  // plugins.allow 已配置白名单时同步补 id（与主进程 syncPluginAllowOnEnable 一致）
  if (Array.isArray(d.plugins.allow) && d.plugins.allow.length > 0 && !d.plugins.allow.includes("kimi-search")) {
    d.plugins.allow.push("kimi-search");
  }
  if (proxyPort > 0) {
    d.agents ??= {};
    d.agents.defaults ??= {};
    d.agents.defaults.memorySearch = {
      ...(typeof d.agents.defaults.memorySearch === "object" && d.agents.defaults.memorySearch !== null
        ? d.agents.defaults.memorySearch
        : {}),
      enabled: true,
      provider: "openai",
      model: "bge_m3_embed",
      remote: { baseUrl: `http://127.0.0.1:${proxyPort}/coding/v1/`, apiKey: "proxy-managed" },
    };
  }
}
