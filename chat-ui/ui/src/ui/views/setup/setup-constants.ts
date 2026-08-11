/**
 * Setup / Provider 设置共享常量 — provider 元数据（placeholder/平台 URL/baseUrl/api）。
 * 模型清单一律走 controllers/models.ts 的 models.list 动态目录，此处不再硬编码。
 */
import { t } from "../../i18n.ts";

export interface ProviderDef {
  placeholder: string;
  platformUrl?: string;
  /** 直接写入 config 的端点（仅内置 provider 有；custom 由用户/预设提供） */
  baseUrl?: string;
  api?: string;
  hasSubPlatform?: boolean;
}

export interface CustomPresetDef {
  providerKey: string;
  placeholder: string;
  baseUrl: string;
  api: string;
}

export const CUSTOM_MODEL_SENTINEL = "__custom__";

/** Kimi Code 代理模式固定模型（auth proxy 只透传 coding 端点的唯一模型） */
export const KIMI_CODE_FIXED_MODEL = "kimi-for-coding";

export const PROVIDERS: Record<string, ProviderDef> = {
  moonshot: {
    placeholder: "sk-...",
    hasSubPlatform: true,
  },
  anthropic: {
    placeholder: "sk-ant-...",
    platformUrl: "https://console.anthropic.com?utm_source=oneclaw",
    baseUrl: "https://api.anthropic.com/v1",
    api: "anthropic-messages",
  },
  openai: {
    placeholder: "sk-...",
    platformUrl: "https://platform.openai.com?utm_source=oneclaw",
    baseUrl: "https://api.openai.com/v1",
    api: "openai-completions",
  },
  google: {
    placeholder: "AI...",
    platformUrl: "https://aistudio.google.com?utm_source=oneclaw",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    api: "google-generative-ai",
  },
  custom: {
    placeholder: "",
  },
};

/** Moonshot 子平台端点（与主进程 provider-config.ts 的 MOONSHOT_SUB_PLATFORMS 对齐） */
export const MOONSHOT_SUB_PLATFORMS: Record<string, { baseUrl: string; api: string; providerKey: string }> = {
  "moonshot-cn": { baseUrl: "https://api.moonshot.cn/v1", api: "openai-completions", providerKey: "moonshot" },
  "moonshot-ai": { baseUrl: "https://api.moonshot.ai/v1", api: "openai-completions", providerKey: "moonshot" },
  "kimi-code": { baseUrl: "https://api.kimi.com/coding", api: "anthropic-messages", providerKey: "kimi-coding" },
};

/** Custom tab 内置预设（国产 provider 快捷配置；与主进程 CUSTOM_PROVIDER_PRESETS 对齐，模型清单走动态目录） */
export const CUSTOM_PRESETS: Record<string, CustomPresetDef> = {
  minimax: {
    providerKey: "minimax",
    placeholder: "eyJ...",
    baseUrl: "https://api.minimax.io/anthropic",
    api: "anthropic-messages",
  },
  "minimax-cn": {
    providerKey: "minimax-cn",
    placeholder: "eyJ...",
    baseUrl: "https://api.minimaxi.com/anthropic",
    api: "anthropic-messages",
  },
  "zai-global": {
    providerKey: "zai-global",
    placeholder: "...",
    baseUrl: "https://api.z.ai/api/paas/v4",
    api: "openai-completions",
  },
  "zai-cn": {
    providerKey: "zai-cn",
    placeholder: "...",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    api: "openai-completions",
  },
  "zai-cn-coding": {
    providerKey: "zai-cn-coding",
    placeholder: "...",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    api: "openai-completions",
  },
  volcengine: {
    providerKey: "volcengine",
    placeholder: "...",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    api: "openai-completions",
  },
  "volcengine-coding": {
    providerKey: "volcengine-coding",
    placeholder: "...",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
    api: "anthropic-messages",
  },
  qwen: {
    providerKey: "qwen",
    placeholder: "sk-...",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions",
  },
  "qwen-coding": {
    providerKey: "qwen-coding",
    placeholder: "sk-sp-...",
    baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
    api: "openai-completions",
  },
  deepseek: {
    providerKey: "deepseek",
    placeholder: "sk-...",
    baseUrl: "https://api.deepseek.com",
    api: "openai-completions",
  },
};

export const SUB_PLATFORM_URLS: Record<string, string> = {
  "moonshot-cn": "https://platform.moonshot.cn?utm_source=oneclaw",
  "moonshot-ai": "https://platform.moonshot.ai?utm_source=oneclaw",
  "kimi-code": "https://kimi.com/code?utm_source=oneclaw",
};

export const PROVIDER_DISPLAY_ORDER = ["moonshot", "anthropic", "openai", "google", "custom"] as const;

/** Returns i18n-driven display labels for the provider segment selector. */
export function getProviderLabels(): Record<string, string> {
  return {
    moonshot: t("setup.provider.label.moonshot"),
    anthropic: t("setup.provider.label.anthropic"),
    openai: t("setup.provider.label.openai"),
    google: t("setup.provider.label.google"),
    custom: t("setup.provider.label.custom"),
  };
}

/** 手动 custom provider：从 baseURL 确定性派生唯一 configKey（与主进程 deriveCustomConfigKey 一致） */
export function deriveCustomConfigKey(baseURL: string): string {
  try {
    const u = new URL(baseURL);
    const slug = (u.host + u.pathname)
      .replace(/\/+$/, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    return slug ? `custom-${slug}` : "custom";
  } catch {
    return "custom";
  }
}

/** 安全面：custom baseURL 必须是合法 http(s) URL（与主进程 isValidHttpBaseUrl 一致） */
export function isValidHttpBaseUrl(baseURL: string): boolean {
  if (typeof baseURL !== "string" || baseURL.length === 0 || baseURL.length > 2048) return false;
  try {
    const u = new URL(baseURL);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
