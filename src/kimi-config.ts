import * as fs from "fs";
import * as path from "path";
import { resolveGatewayPackageDir, resolveUserStateDir } from "./constants";
import { readKernelVersionParts } from "./openclaw-config-migration";

export const KIMI_SEARCH_PLUGIN_ID = "kimi-search";

// 当某 plugin 被启用时，若 plugins.allow 已为非空数组（用户/启动配置主动配置过白名单），
// 把该 id 也补进去，避免 openclaw config-state 的 "allow 非空 + 不在 allow → 静默禁用" 把
// entries.enabled=true 直接吃掉。allow 缺失或为空数组时不动它（语义是"未启用白名单"）。
// 反向（disable）不从 allow 移除：用户可能临时禁用想保留授权，删除是另一个语义。
export function syncPluginAllowOnEnable(config: any, pluginId: string): void {
  const allow = config?.plugins?.allow;
  if (!Array.isArray(allow) || allow.length === 0) return;
  if (!allow.includes(pluginId)) allow.push(pluginId);
}

// ── Kimi Search 配置 ──

const KIMI_SEARCH_API_KEY_FILE = "kimi-search-api-key";

// sidecar 文件路径（~/.openclaw/credentials/kimi-search-api-key）
function resolveKimiSearchApiKeyPath(): string {
  return path.join(resolveUserStateDir(), "credentials", KIMI_SEARCH_API_KEY_FILE);
}

// 读取 sidecar 文件中的专属 key
export function readKimiSearchDedicatedApiKey(): string {
  try {
    const filePath = resolveKimiSearchApiKeyPath();
    if (!fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    return "";
  }
}

// key sidecar 文件通用写入：空字符串则删除文件；否则写入并限当前用户读写。
function writeKeySidecarFile(filePath: string, apiKey: string): void {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    try { fs.unlinkSync(filePath); } catch {}
    return;
  }
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, trimmed, "utf-8");
  // key 文件仅当前用户可读写（0o600）
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

// 写入专属 key 到 sidecar 文件（空字符串则删除文件）
export function writeKimiSearchDedicatedApiKey(apiKey: string): void {
  writeKeySidecarFile(resolveKimiSearchApiKeyPath(), apiKey);
}

// 按优先级解析 kimi-search API key：专属 key > OAuth token > 手动 key sidecar
// 注意：不再从 config 的 apiKey 读取（代理模式下为占位符 "proxy-managed"）
export function resolveKimiSearchApiKey(_config?: any): string {
  // 1. sidecar 文件中的专属 key
  const dedicatedKey = readKimiSearchDedicatedApiKey();
  if (dedicatedKey) return dedicatedKey;

  // 2. OAuth token
  try {
    const { loadOAuthToken } = require("./kimi-oauth");
    const oauthToken = loadOAuthToken();
    if (oauthToken?.access_token) return oauthToken.access_token;
  } catch {}

  // 3. 手动 key sidecar
  const manualKey = readKimiApiKey();
  if (manualKey) return manualKey;

  return "";
}

// 写入 kimi-search 配置（enabled + 可选的自定义 service base URL）
export function saveKimiSearchConfig(
  config: any,
  params: { enabled: boolean; serviceBaseUrl?: string },
): void {
  config.plugins ??= {};
  config.plugins.entries ??= {};

  const existing =
    typeof config.plugins.entries[KIMI_SEARCH_PLUGIN_ID] === "object" &&
    config.plugins.entries[KIMI_SEARCH_PLUGIN_ID] !== null
      ? config.plugins.entries[KIMI_SEARCH_PLUGIN_ID]
      : {};

  const entry: any = { ...existing, enabled: params.enabled };

  // 有自定义 base URL 时写入 search/fetch 端点，空字符串则清除回默认
  const baseUrl = params.serviceBaseUrl?.trim();
  if (baseUrl) {
    entry.config = {
      ...(typeof existing.config === "object" && existing.config !== null ? existing.config : {}),
      search: { baseUrl: `${baseUrl}/search` },
      fetch: { baseUrl: `${baseUrl}/fetch` },
    };
  } else {
    delete entry.config;
  }

  config.plugins.entries[KIMI_SEARCH_PLUGIN_ID] = entry;

  if (params.enabled) syncPluginAllowOnEnable(config, KIMI_SEARCH_PLUGIN_ID);
}

// ── Memory Search Embedding 配置（通过 auth proxy 透传鉴权） ──

const KIMI_EMBEDDING_MODEL = "bge_m3_embed";

// 将 memorySearch 指向本地 auth proxy（代理注入最新 token，免密钥刷新）
// 落位随内核版本：2026.8 起正确路径是根级 memory.search（agents.defaults.memorySearch
// 会被 strict 校验拒绝），旧内核仍是 agents.defaults.memorySearch；版本不可读时按旧路径。
export function ensureMemorySearchProxyConfig(config: any, proxyPort: number): boolean {
  if (proxyPort <= 0) return false;

  const kernel = readKernelVersionParts();
  const atLeast2026_8 = kernel !== null && (kernel.year > 2026 || (kernel.year === 2026 && kernel.month >= 8));
  const ms = atLeast2026_8
    ? (((config.memory ??= {}).search) ??= {})
    : (((config.agents ??= {}).defaults ??= {}).memorySearch ??= {});

  const expectedBase = `http://127.0.0.1:${proxyPort}/coding/v1/`;

  // 配置未变则跳过写入
  if (
    ms.enabled === true &&
    ms.provider === "openai" &&
    ms.model === KIMI_EMBEDDING_MODEL &&
    ms.remote?.baseUrl === expectedBase &&
    ms.remote?.apiKey === "proxy-managed"
  ) {
    return false;
  }

  ms.enabled = true;
  ms.provider = "openai";
  ms.model = KIMI_EMBEDDING_MODEL;
  ms.remote ??= {};
  ms.remote.baseUrl = expectedBase;
  ms.remote.apiKey = "proxy-managed";
  return true;
}

// ── 指向本地代理的遗留 provider 自愈 ──

// 历史遗留：旧版 provider（如 "kimi"）曾指向本地 auth proxy，且回环鉴权版本（R39–R48）
// 的 baseUrl 还带 path secret 段（http://127.0.0.1:<port>/<secret>/coding）。回环鉴权
// 已于 R49 移除（secret 同步缺口曾致主模型静默 401 落入 fallback），这里把所有指向
// 本地代理（127.0.0.1:*/[seg/]coding）的 provider 统一改写到当前端口、无 secret 段。
// 判别门防误伤用户自建的本地服务：apiKey 必须是应用占位符 "proxy-managed"
// （这些条目都是应用自己写的）。
// apiKey 不动：代理会注入真实 token，客户端 apiKey 仅为占位。
const LOCAL_PROXY_CODING_BASE_RE = /^http:\/\/127\.0\.0\.1:\d+\/(?:[^/]+\/)?coding\/?$/;

export function healLegacyProxyProviders(
  config: any,
  proxyPort: number,
  skipKey = "kimi-coding",
): boolean {
  if (proxyPort <= 0) return false;
  const providers = config?.models?.providers;
  if (!providers || typeof providers !== "object") return false;

  const expectedBase = `http://127.0.0.1:${proxyPort}/coding`;
  let changed = false;
  for (const [key, provider] of Object.entries(providers)) {
    if (key === skipKey) continue;
    const p = provider as any;
    if (typeof p?.baseUrl !== "string") continue;
    if (p.apiKey !== "proxy-managed") continue;
    if (!LOCAL_PROXY_CODING_BASE_RE.test(p.baseUrl)) continue;
    if (p.baseUrl === expectedBase) continue;
    p.baseUrl = expectedBase;
    changed = true;
  }
  return changed;
}

// 检查 kimi-search 插件是否随应用内置
export function isKimiSearchPluginBundled(): boolean {
  const pluginDir = path.join(resolveGatewayPackageDir(), "dist", "extensions", KIMI_SEARCH_PLUGIN_ID);
  const hasEntry =
    fs.existsSync(path.join(pluginDir, "index.ts")) ||
    fs.existsSync(path.join(pluginDir, "dist", "index.js"));
  return hasEntry && fs.existsSync(path.join(pluginDir, "openclaw.plugin.json"));
}

// ── Kimi API Key sidecar（手动输入的 key，与 OAuth token 互斥） ──

const KIMI_API_KEY_FILE = "kimi-api-key";

// sidecar 文件路径
function resolveKimiApiKeyPath(): string {
  return path.join(resolveUserStateDir(), "credentials", KIMI_API_KEY_FILE);
}

// 读取手动 key
export function readKimiApiKey(): string {
  try {
    const filePath = resolveKimiApiKeyPath();
    if (!fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    return "";
  }
}

// 写入手动 key（空字符串则删除）
export function writeKimiApiKey(apiKey: string): void {
  writeKeySidecarFile(resolveKimiApiKeyPath(), apiKey);
}
