/**
 * 动态模型清单 — 通过 gateway `models.list` RPC 拉取，按 provider 分组缓存。
 * gateway 不可达或 RPC 失败时返回 null，调用方回退到 setup-constants 的硬编码预设。
 */
import type { GatewayBrowserClient } from "../gateway.ts";

/** provider id → 模型 id 列表（与 PROVIDERS/CUSTOM_PRESETS 的 models 结构对齐） */
export type GatewayModelCatalog = Record<string, string[]>;

/** models.list 全量条目（含内核归一化的能力元数据，供 image 能力/默认元数据取用） */
export interface GatewayModelEntry {
  id: string;
  provider: string;
  name?: string;
  input?: string[];
  reasoning?: boolean;
  contextWindow?: number;
  compat?: Record<string, unknown>;
  available?: boolean;
}

// 缓存 5 分钟，避免每次渲染都发 RPC
const MODELS_CACHE_TTL_MS = 5 * 60_000;
// 失败后 30 秒内不重试，避免离线/报错时反复打 RPC
const MODELS_RETRY_AFTER_FAILURE_MS = 30_000;

let cache: { at: number; catalog: GatewayModelCatalog; entries: Record<string, GatewayModelEntry[]> } | null = null;
let lastFailureAt = 0;
let inflight: Promise<GatewayModelCatalog | null> | null = null;

/** 解析 models.list 返回：{ models: [{ provider, id, name?, input?, ... }] } → 按 provider 分组 */
function parseCatalog(payload: unknown): { catalog: GatewayModelCatalog; entries: Record<string, GatewayModelEntry[]> } | null {
  const models = (payload as { models?: unknown[] } | undefined)?.models;
  if (!Array.isArray(models)) {
    return null;
  }
  const catalog: GatewayModelCatalog = {};
  const entries: Record<string, GatewayModelEntry[]> = {};
  for (const entry of models) {
    const provider = (entry as { provider?: unknown })?.provider;
    const id = (entry as { id?: unknown })?.id;
    if (typeof provider !== "string" || !provider || typeof id !== "string" || !id) {
      continue;
    }
    const list = catalog[provider] ?? (catalog[provider] = []);
    if (!list.includes(id)) {
      list.push(id);
    }
    const e = entry as GatewayModelEntry;
    const entryList = entries[provider] ?? (entries[provider] = []);
    if (!entryList.some((item) => item.id === id)) {
      entryList.push({
        id,
        provider,
        name: typeof e.name === "string" ? e.name : undefined,
        input: Array.isArray(e.input) ? e.input.filter((v): v is string => typeof v === "string") : undefined,
        reasoning: typeof e.reasoning === "boolean" ? e.reasoning : undefined,
        contextWindow: typeof e.contextWindow === "number" ? e.contextWindow : undefined,
        compat: e.compat && typeof e.compat === "object" ? (e.compat as Record<string, unknown>) : undefined,
        available: typeof e.available === "boolean" ? e.available : undefined,
      });
    }
  }
  return Object.keys(catalog).length > 0 ? { catalog, entries } : null;
}

/** 同步读缓存（未过期才返回），供渲染路径使用 */
export function getCachedGatewayModels(): GatewayModelCatalog | null {
  if (cache && Date.now() - cache.at < MODELS_CACHE_TTL_MS) {
    return cache.catalog;
  }
  return null;
}

/** 同步读全量条目缓存（未过期才返回），含 input/reasoning/contextWindow 等元数据 */
export function getCachedGatewayModelEntries(): Record<string, GatewayModelEntry[]> | null {
  if (cache && Date.now() - cache.at < MODELS_CACHE_TTL_MS) {
    return cache.entries;
  }
  return null;
}

/** 在缓存条目中查某模型的 input 能力（如是否含 "image"） */
export function catalogModelSupportsImage(provider: string, modelId: string): boolean | undefined {
  const entry = getCachedGatewayModelEntries()?.[provider]?.find((item) => item.id === modelId);
  if (!entry?.input) return undefined;
  return entry.input.includes("image");
}

/** 拉取并缓存动态清单；失败/不可达时回退到未过期缓存或 null */
export async function loadGatewayModels(
  client: GatewayBrowserClient,
  opts?: { force?: boolean },
): Promise<GatewayModelCatalog | null> {
  if (!opts?.force) {
    const cached = getCachedGatewayModels();
    if (cached) {
      return cached;
    }
    if (Date.now() - lastFailureAt < MODELS_RETRY_AFTER_FAILURE_MS) {
      return null;
    }
  }
  if (inflight) {
    return inflight;
  }
  inflight = (async () => {
    try {
      // view: "all" 拉全量目录，覆盖尚未配置密钥的 provider
      const payload = await client.request("models.list", { view: "all" });
      const parsed = parseCatalog(payload);
      if (parsed) {
        cache = { at: Date.now(), catalog: parsed.catalog, entries: parsed.entries };
      } else {
        lastFailureAt = Date.now();
      }
      return parsed?.catalog ?? null;
    } catch {
      lastFailureAt = Date.now();
      return getCachedGatewayModels();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
