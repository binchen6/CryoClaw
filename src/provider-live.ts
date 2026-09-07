/**
 * Provider 在线能力（R58）：
 * - fetchProviderModels：从提供商 /models 端点拉取实时模型列表（手动同步入口）
 * - fetchProviderUsage：订阅套餐用量 / 账户余额查询（官方或社区验证端点，best-effort）
 *
 * 端点解析复用 verifyProvider 的预设体系（PROVIDER_PRESETS / MOONSHOT_SUB_PLATFORMS /
 * CUSTOM_PROVIDER_PRESETS），按 api 类型构造 models URL：
 * - openai-completions / openai-responses：GET {base}/models（Bearer）
 * - anthropic-messages：GET {base}/models（base 已含 /v1）或 {base}/v1/models（x-api-key）
 * - google-generative-ai：GET {base}/models?key=（响应 {models:[{name,displayName}]}）
 * - kimi-coding：走本地 auth proxy（config baseUrl 即 proxy 地址，proxy 注入 OAuth token）
 */

import {
  PROVIDER_PRESETS,
  MOONSHOT_SUB_PLATFORMS,
  CUSTOM_PROVIDER_PRESETS,
  readUserConfig,
  jsonRequestBody,
} from "./provider-config";
import { readKimiApiKey } from "./kimi-config";
import { startAuthProxy, getProxyPort } from "./kimi-auth-proxy";

export interface LiveModel {
  id: string;
  name?: string;
}

export interface FetchModelsParams {
  /** 已配置 provider 的 key（从 openclaw.json 读真实 apiKey/baseUrl/api） */
  providerKey?: string;
  /** 显式参数路径（添加流程：provider 尚未写入 config） */
  provider?: string;
  subPlatform?: string;
  customPreset?: string;
  apiKey?: string;
  baseURL?: string;
  apiType?: string;
}

export interface ResolvedEndpoint {
  baseUrl: string;
  api: string;
  apiKey: string;
}

// 已配置 provider：从 openclaw.json 读真实凭据（config.get 快照是脱敏的，主进程才能拿到真 key）
function resolveConfiguredEndpoint(providerKey: string): ResolvedEndpoint | null {
  const config = readUserConfig();
  const prov = config?.models?.providers?.[providerKey];
  if (!prov || typeof prov.baseUrl !== "string" || !prov.baseUrl) return null;
  return {
    baseUrl: prov.baseUrl,
    api: typeof prov.api === "string" ? prov.api : "openai-completions",
    apiKey: typeof prov.apiKey === "string" ? prov.apiKey : "",
  };
}

// kimi-code 代理端点：确保 proxy 存活后返回 proxy baseUrl（token 由 proxy 注入，无需 key）
async function resolveKimiProxyEndpoint(): Promise<ResolvedEndpoint> {
  let port = getProxyPort();
  if (port <= 0) {
    await startAuthProxy();
    port = getProxyPort();
  }
  const token = readKimiApiKey();
  return {
    baseUrl: `http://127.0.0.1:${port}/coding`,
    api: "anthropic-messages",
    apiKey: token || "",
  };
}

async function resolveEndpoint(params: FetchModelsParams): Promise<ResolvedEndpoint | null> {
  if (params.providerKey) {
    if (params.providerKey === "kimi-coding") {
      // 始终用当前活跃 proxy 端口：config 里存的 baseUrl 是添加时写入的端口，
      // proxy 端口跨会话可能变化（占用时顺延），陈旧端口会打空
      return resolveKimiProxyEndpoint();
    }
    return resolveConfiguredEndpoint(params.providerKey);
  }

  const { provider, subPlatform, customPreset, apiKey = "", baseURL, apiType } = params;
  if (provider === "anthropic") {
    return { ...PROVIDER_PRESETS.anthropic, apiKey };
  }
  if (provider === "openai") {
    return { ...PROVIDER_PRESETS.openai, apiKey };
  }
  if (provider === "google") {
    return { ...PROVIDER_PRESETS.google, apiKey };
  }
  if (provider === "moonshot") {
    if (subPlatform === "kimi-code") return resolveKimiProxyEndpoint();
    const sub = MOONSHOT_SUB_PLATFORMS[subPlatform || "moonshot-cn"] ?? MOONSHOT_SUB_PLATFORMS["moonshot-cn"];
    return { baseUrl: sub.baseUrl, api: sub.api, apiKey };
  }
  if (provider === "custom") {
    if (customPreset) {
      const preset = CUSTOM_PROVIDER_PRESETS[customPreset];
      if (!preset) return null;
      return { baseUrl: baseURL || preset.baseUrl, api: preset.api, apiKey };
    }
    if (!baseURL) return null;
    return { baseUrl: baseURL, api: apiType || "openai-completions", apiKey };
  }
  return null;
}

// models URL 构造（导出供单测：三种 api 形态的拼接规则是本模块的核心约定）
export function buildModelsUrl(endpoint: ResolvedEndpoint): string {
  const base = endpoint.baseUrl.replace(/\/+$/, "");
  if (endpoint.api === "google-generative-ai") {
    return `${base}/models?pageSize=1000&key=${encodeURIComponent(endpoint.apiKey)}`;
  }
  if (endpoint.api === "anthropic-messages") {
    // anthropic 官方 base 已含 /v1；minimax / volcengine-coding / kimi 代理的 base 不含
    return /\/v\d+$/.test(base) ? `${base}/models?limit=1000` : `${base}/v1/models?limit=1000`;
  }
  return `${base}/models`;
}

function buildModelsHeaders(endpoint: ResolvedEndpoint): Record<string, string> {
  if (endpoint.api === "google-generative-ai") return {};
  if (endpoint.api === "anthropic-messages") {
    const headers: Record<string, string> = {
      "User-Agent": "Anthropic/JS 0.73.0",
      "anthropic-version": "2023-06-01",
    };
    // kimi 代理端点由 proxy 注入 token，显式 key 只在非代理场景附加
    if (endpoint.apiKey && !/^http:\/\/127\.0\.0\.1:\d+/.test(endpoint.baseUrl)) {
      headers["x-api-key"] = endpoint.apiKey;
    }
    return headers;
  }
  return {
    "User-Agent": "OpenAI/JS 6.10.0",
    ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
  };
}

function toText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// 响应解析：openai 兼容 {data:[{id}]} / anthropic {data:[{id,display_name}]} / google {models:[{name}]}
// （导出供单测：fetchProviderModels 的网络层不可直测）
export function parseModelsResponse(api: string, payload: unknown): LiveModel[] {
  const out: LiveModel[] = [];
  const seen = new Set<string>();
  const push = (id: string, name?: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(name && name !== id ? { id, name } : { id });
  };

  if (api === "google-generative-ai") {
    const models = (payload as { models?: unknown[] } | undefined)?.models;
    if (!Array.isArray(models)) return out;
    for (const m of models) {
      const rec = m as Record<string, unknown>;
      const rawName = toText(rec?.name);
      if (!rawName) continue;
      const methods = Array.isArray(rec?.supportedGenerationMethods)
        ? (rec.supportedGenerationMethods as unknown[])
        : undefined;
      // 只列支持 generateContent 的模型（embedding/tuning 端点对 chat 无意义）
      if (methods && !methods.includes("generateContent")) continue;
      const id = rawName.startsWith("models/") ? rawName.slice("models/".length) : rawName;
      push(id, toText(rec?.displayName));
    }
    return out;
  }

  const data = (payload as { data?: unknown[] } | undefined)?.data;
  if (!Array.isArray(data)) return out;
  for (const m of data) {
    const rec = m as Record<string, unknown>;
    const id = toText(rec?.id);
    if (!id) continue;
    push(id, toText(rec?.display_name) ?? toText(rec?.name));
  }
  return out;
}

export async function fetchProviderModels(params: FetchModelsParams): Promise<LiveModel[]> {
  const endpoint = await resolveEndpoint(params);
  if (!endpoint) throw new Error("无法解析提供商端点（缺少 Base URL 或未知预设）");
  if (endpoint.api !== "google-generative-ai" && !endpoint.apiKey && !/^http:\/\/127\.0\.0\.1:\d+/.test(endpoint.baseUrl)) {
    throw new Error("该提供商尚未配置 API Key");
  }
  const payload = await jsonRequestBody<unknown>(buildModelsUrl(endpoint), {
    headers: buildModelsHeaders(endpoint),
  });
  const models = parseModelsResponse(endpoint.api, payload);
  if (models.length === 0) {
    throw new Error("提供商未返回任何模型（接口可能不支持模型列表）");
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

/* ── 用量 / 余额查询 ── */

export type ProviderUsage =
  | { supported: false }
  | {
      supported: true;
      kind: "balance";
      /** 账户余额（可用） */
      available?: string;
      /** 总余额（含赠送） */
      total?: string;
      /** 赠送余额 */
      granted?: string;
      /** 充值余额 */
      toppedUp?: string;
      currency?: string;
      /** 余额是否充足（deepseek is_available） */
      sufficient?: boolean;
    }
  | {
      supported: true;
      kind: "progress";
      /** 用量百分比（0-100；上游 0-1 时已换算） */
      pct?: number;
      /** 套餐等级（zai level） */
      plan?: string;
      /** 距重置秒数（>0 时渲染倒计时） */
      resetSeconds?: number;
    };

function numText(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return toText(v);
}

// Moonshot 余额：GET {base}/users/me/balance（官方，Bearer）
// 响应 {code:0, data:{available_balance, balance, voucher_balance?, currency}}
async function fetchMoonshotUsage(endpoint: ResolvedEndpoint): Promise<ProviderUsage> {
  const payload = await jsonRequestBody<{ code?: number; data?: Record<string, unknown> }>(
    `${endpoint.baseUrl.replace(/\/+$/, "")}/users/me/balance`,
    { headers: { Authorization: `Bearer ${endpoint.apiKey}` } },
  );
  const data = payload?.data;
  if (!data || (typeof payload.code === "number" && payload.code !== 0)) {
    throw new Error("余额接口返回异常");
  }
  return {
    supported: true,
    kind: "balance",
    available: numText(data.available_balance),
    total: numText(data.balance),
    granted: numText(data.voucher_balance),
    currency: toText(data.currency) ?? "CNY",
  };
}

// DeepSeek 余额：GET {base}/user/balance（官方，Bearer）
// 响应 {is_available, balance_infos:[{currency, total_balance, granted_balance, topped_up_balance}]}
async function fetchDeepseekUsage(endpoint: ResolvedEndpoint): Promise<ProviderUsage> {
  const payload = await jsonRequestBody<{
    is_available?: boolean;
    balance_infos?: Array<Record<string, unknown>>;
  }>(`${endpoint.baseUrl.replace(/\/+$/, "")}/user/balance`, {
    headers: { Authorization: `Bearer ${endpoint.apiKey}` },
  });
  const info = payload?.balance_infos?.find((x) => numText(x?.total_balance) !== undefined);
  return {
    supported: true,
    kind: "balance",
    available: info ? numText(info.total_balance) : undefined,
    granted: info ? numText(info.granted_balance) : undefined,
    toppedUp: info ? numText(info.topped_up_balance) : undefined,
    currency: info ? (toText(info.currency) ?? "CNY") : undefined,
    sufficient: typeof payload?.is_available === "boolean" ? payload.is_available : undefined,
  };
}

// 智谱 GLM Coding Plan 配额：GET /api/monitor/usage/quota/limit（社区验证端点，best-effort）
// 响应 {success, data:{level, limits:[{type:"TOKENS_LIMIT", percentage, nextResetTime}]}}
async function fetchZaiUsage(monitorBase: string, apiKey: string): Promise<ProviderUsage> {
  const payload = await jsonRequestBody<{
    success?: boolean;
    data?: { level?: unknown; limits?: Array<Record<string, unknown>> };
  }>(`${monitorBase}/api/monitor/usage/quota/limit`, {
    // 智谱监控端点的 Authorization 直接携带原始 key（社区脚本一致的用法）
    headers: { Authorization: apiKey, "Accept-Language": "zh-CN" },
  });
  if (payload?.success === false) throw new Error("配额接口返回失败");
  const limit = payload?.data?.limits?.find(
    (x) => typeof x.percentage === "number" || typeof x.percentage === "string",
  );
  let pct = limit ? Number(limit.percentage) : NaN;
  if (Number.isFinite(pct) && pct >= 0 && pct <= 1) pct = pct * 100; // 0-1 → 0-100
  const resetRaw = limit ? toText(limit.nextResetTime) : undefined;
  let resetSeconds: number | undefined;
  if (resetRaw) {
    const diff = (new Date(resetRaw).getTime() - Date.now()) / 1000;
    resetSeconds = Number.isFinite(diff) && diff > 0 ? Math.round(diff) : undefined;
  }
  return {
    supported: true,
    kind: "progress",
    pct: Number.isFinite(pct) ? Math.min(100, Math.max(0, Math.round(pct))) : undefined,
    plan: toText(payload?.data?.level),
    resetSeconds,
  };
}

export async function fetchProviderUsage(providerKey: string): Promise<ProviderUsage> {
  const endpoint = resolveConfiguredEndpoint(providerKey);
  if (!endpoint) return { supported: false };
  const base = endpoint.baseUrl.replace(/\/+$/, "");

  if (providerKey === "moonshot") {
    if (!endpoint.apiKey) return { supported: false };
    return fetchMoonshotUsage(endpoint);
  }
  if (providerKey === "deepseek") {
    if (!endpoint.apiKey) return { supported: false };
    return fetchDeepseekUsage(endpoint);
  }
  if (providerKey === "zai-cn" || providerKey === "zai-cn-coding") {
    if (!endpoint.apiKey) return { supported: false };
    return fetchZaiUsage("https://open.bigmodel.cn", endpoint.apiKey);
  }
  if (providerKey === "zai-global") {
    if (!endpoint.apiKey) return { supported: false };
    return fetchZaiUsage("https://api.z.ai", endpoint.apiKey);
  }
  return { supported: false };
}
