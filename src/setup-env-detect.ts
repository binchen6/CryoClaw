/**
 * Setup 快速通道：检测本机环境变量中已有的 provider API Key，一键采用。
 * 纯逻辑模块（可单测）；明文 key 绝不出主进程——对外只暴露掩码。
 */
import {
  PROVIDER_PRESETS,
  MOONSHOT_SUB_PLATFORMS,
  CUSTOM_PROVIDER_PRESETS,
} from "./provider-config";

// 低于此长度的环境变量值不视为有效 API Key（防误检占位符/空串）
export const MIN_ENV_KEY_LENGTH = 8;

export interface EnvKeyCandidateDef {
  /** 环境变量名 */
  envVar: string;
  /** 写入 config 的 models.providers key */
  providerKey: string;
  /** verifyProvider 分派用的 provider 名 */
  verifyProvider: string;
  verifySubPlatform?: string;
  verifyCustomPreset?: string;
  baseUrl: string;
  api: string;
  /** 采用后写入的默认模型（agents.defaults.model.primary = "<providerKey>/<defaultModel>"） */
  defaultModel: string;
}

/**
 * 环境变量 → provider 映射表（顺序即检测输出顺序，同 provider 多变量先到先得）。
 * baseUrl/api 与 provider-config.ts 预设（前端 setup-constants.ts 同值）对齐：
 * - moonshot 走 moonshot-cn 子平台端点；deepseek 走 custom 预设。
 * 默认模型取各 provider 当前代际稳定型号，与 step2 手动配置下拉首项同一代际。
 */
export const ENV_KEY_CANDIDATES: EnvKeyCandidateDef[] = [
  {
    envVar: "OPENAI_API_KEY",
    providerKey: "openai",
    verifyProvider: "openai",
    baseUrl: PROVIDER_PRESETS.openai.baseUrl,
    api: PROVIDER_PRESETS.openai.api,
    defaultModel: "gpt-5.2",
  },
  {
    envVar: "ANTHROPIC_API_KEY",
    providerKey: "anthropic",
    verifyProvider: "anthropic",
    baseUrl: PROVIDER_PRESETS.anthropic.baseUrl,
    api: PROVIDER_PRESETS.anthropic.api,
    defaultModel: "claude-sonnet-4-5",
  },
  {
    envVar: "MOONSHOT_API_KEY",
    providerKey: "moonshot",
    verifyProvider: "moonshot",
    verifySubPlatform: "moonshot-cn",
    baseUrl: MOONSHOT_SUB_PLATFORMS["moonshot-cn"].baseUrl,
    api: MOONSHOT_SUB_PLATFORMS["moonshot-cn"].api,
    defaultModel: "kimi-k2.6",
  },
  {
    envVar: "DEEPSEEK_API_KEY",
    providerKey: "deepseek",
    verifyProvider: "custom",
    verifyCustomPreset: "deepseek",
    baseUrl: CUSTOM_PROVIDER_PRESETS.deepseek.baseUrl,
    api: CUSTOM_PROVIDER_PRESETS.deepseek.api,
    // CUSTOM_PROVIDER_PRESETS.deepseek.models[0]（官方弃用 deepseek-chat 别名后的首选）
    defaultModel: CUSTOM_PROVIDER_PRESETS.deepseek.models[0],
  },
  {
    envVar: "GOOGLE_API_KEY",
    providerKey: "google",
    verifyProvider: "google",
    baseUrl: PROVIDER_PRESETS.google.baseUrl,
    api: PROVIDER_PRESETS.google.api,
    defaultModel: "gemini-3-flash-preview",
  },
  {
    envVar: "GEMINI_API_KEY",
    providerKey: "google",
    verifyProvider: "google",
    baseUrl: PROVIDER_PRESETS.google.baseUrl,
    api: PROVIDER_PRESETS.google.api,
    defaultModel: "gemini-3-flash-preview",
  },
];

export interface DetectedEnvKey {
  providerKey: string;
  envVar: string;
  maskedKey: string;
}

/** 掩码：保留前 3 后 4，中段固定掩码；过短的 key 全掩码 */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length < MIN_ENV_KEY_LENGTH) return "****";
  return `${trimmed.slice(0, 3)}…****…${trimmed.slice(-4)}`;
}

/** 扫描环境变量，返回可采用的候选列表（仅掩码，不含明文） */
export function detectEnvProviderKeys(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): DetectedEnvKey[] {
  const seenProviders = new Set<string>();
  const out: DetectedEnvKey[] = [];
  for (const candidate of ENV_KEY_CANDIDATES) {
    if (seenProviders.has(candidate.providerKey)) continue;
    const raw = env[candidate.envVar];
    if (typeof raw !== "string") continue;
    const key = raw.trim();
    if (key.length < MIN_ENV_KEY_LENGTH) continue;
    seenProviders.add(candidate.providerKey);
    out.push({
      providerKey: candidate.providerKey,
      envVar: candidate.envVar,
      maskedKey: maskApiKey(key),
    });
  }
  return out;
}

/**
 * 白名单解析：仅允许 ENV_KEY_CANDIDATES 表内的 (providerKey, envVar) 组合，
 * 防渲染层任意指定环境变量名偷值。
 */
export function resolveEnvCandidate(providerKey: string, envVar: string): EnvKeyCandidateDef | null {
  return ENV_KEY_CANDIDATES.find((c) => c.providerKey === providerKey && c.envVar === envVar) ?? null;
}

/**
 * 服务端构造 providerConfig，结构对齐前端 buildProviderConfigForAdd：
 * { apiKey, baseUrl, api, models: [{ id, name, input }] }
 */
export function buildEnvProviderConfig(
  candidate: EnvKeyCandidateDef,
  apiKey: string,
  supportsImage?: boolean,
): Record<string, unknown> {
  return {
    apiKey,
    baseUrl: candidate.baseUrl,
    api: candidate.api,
    models: [
      {
        id: candidate.defaultModel,
        name: candidate.defaultModel,
        input: supportsImage ? ["text", "image"] : ["text"],
      },
    ],
  };
}
