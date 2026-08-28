import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import { resolveUserConfigPath, resolveUserStateDir } from "./constants";
import { syncOpenClawStateAfterWrite } from "./openclaw-health-state";
import { backupCurrentUserConfig } from "./config-backup";
import { probeImageSupport, type ImageProbeAuth, type ImageProbeOutcome } from "./provider-image-probe";
import { verifyWecom } from "./wecom-config";

// ── Provider 配置预设（与 kimiclaw ProviderSetupView.swift 对齐） ──

export interface ProviderPreset {
  baseUrl: string;
  api: string;
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  anthropic: { baseUrl: "https://api.anthropic.com/v1", api: "anthropic-messages" },
  openai: { baseUrl: "https://api.openai.com/v1", api: "openai-completions" },
  google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", api: "google-generative-ai" },
};

// Moonshot 三个子平台配置
export const MOONSHOT_SUB_PLATFORMS: Record<string, { baseUrl: string; api: string; providerKey: string }> = {
  "moonshot-cn": { baseUrl: "https://api.moonshot.cn/v1", api: "openai-completions", providerKey: "moonshot" },
  "moonshot-ai": { baseUrl: "https://api.moonshot.ai/v1", api: "openai-completions", providerKey: "moonshot" },
  "kimi-code": { baseUrl: "https://api.kimi.com/coding", api: "anthropic-messages", providerKey: "kimi-coding" },
};

// Custom tab 内置预设（国产 provider 快捷配置）
export interface CustomProviderPreset extends ProviderPreset {
  providerKey: string;
  placeholder: string;
  models: string[];
}

export const CUSTOM_PROVIDER_PRESETS: Record<string, CustomProviderPreset> = {
  "minimax": {
    providerKey: "minimax",
    baseUrl: "https://api.minimax.io/anthropic",
    api: "anthropic-messages",
    placeholder: "eyJ...",
    models: ["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.5-highspeed"],
  },
  "minimax-cn": {
    providerKey: "minimax-cn",
    baseUrl: "https://api.minimaxi.com/anthropic",
    api: "anthropic-messages",
    placeholder: "eyJ...",
    models: ["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.5-highspeed"],
  },
  "zai-global": {
    providerKey: "zai-global",
    baseUrl: "https://api.z.ai/api/paas/v4",
    api: "openai-completions",
    placeholder: "...",
    models: ["glm-5.1", "glm-5", "glm-4.7", "glm-4.7-flash", "glm-4.7-flashx"],
  },
  "zai-cn": {
    providerKey: "zai-cn",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    api: "openai-completions",
    placeholder: "...",
    models: ["glm-5.1", "glm-5", "glm-4.7", "glm-4.7-flash", "glm-4.7-flashx"],
  },
  "zai-cn-coding": {
    providerKey: "zai-cn-coding",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    api: "openai-completions",
    placeholder: "...",
    models: ["glm-5.1", "glm-5", "glm-4.7", "glm-4.7-flash", "glm-4.7-flashx"],
  },
  "volcengine": {
    providerKey: "volcengine",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    api: "openai-completions",
    placeholder: "...",
    models: ["doubao-seed-2.0-pro", "doubao-seed-2.0-lite", "doubao-seed-2.0-code", "doubao-seed-code"],
  },
  "volcengine-coding": {
    providerKey: "volcengine-coding",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
    api: "anthropic-messages",
    placeholder: "...",
    models: ["doubao-seed-2.0-code", "doubao-seed-2.0-pro", "doubao-seed-2.0-lite", "doubao-seed-code", "minimax-m2.7", "glm-5.1", "deepseek-v3.2", "kimi-k2.6", "ark-code-latest"],
  },
  "qwen": {
    providerKey: "qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions",
    placeholder: "sk-...",
    models: ["qwen3.6-max-preview", "qwen3.6-plus", "qwen-coder-plus-latest", "qwen-plus-latest", "qwen-max-latest", "qwen-turbo-latest"],
  },
  "qwen-coding": {
    providerKey: "qwen-coding",
    baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
    api: "openai-completions",
    placeholder: "sk-sp-...",
    models: ["qwen3.6-plus", "qwen3.5-plus", "kimi-k2.6", "glm-5.1", "MiniMax-M2.7"],
  },
  "deepseek": {
    providerKey: "deepseek",
    baseUrl: "https://api.deepseek.com",
    api: "openai-completions",
    placeholder: "sk-...",
    // 官方 2026-07-24 起弃用 deepseek-chat / deepseek-reasoner 别名
    models: ["deepseek-v4-pro", "deepseek-v4-flash"],
  },
};


// ── 用户配置读写（薄封装） ──

export function readUserConfig(): any {
  const configPath = resolveUserConfigPath();
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

export function writeUserConfig(config: any): void {
  const stateDir = resolveUserStateDir();
  fs.mkdirSync(stateDir, { recursive: true });
  // 覆盖写入前先保留一份当前可解析配置，便于用户在设置页回退。
  backupCurrentUserConfig();
  const configPath = resolveUserConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  // openclaw 4.x 每次读 openclaw.json 会与 health-state baseline 以及
  // openclaw.json.bak 做字节校验；外部直写会让两者落后，产生 .clobbered 雪崩。
  // 这里把 .bak 同步成当前内容，并清理 health entry 让 openclaw 重建基线。
  syncOpenClawStateAfterWrite(configPath);
}

// ── 验证函数 ──

// Anthropic 原生接口验证
export function verifyAnthropic(apiKey: string, modelID?: string): Promise<void> {
  return jsonRequest("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: modelID || "claude-haiku-4-5-20251001",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
}

// OpenAI 原生接口验证
export function verifyOpenAI(apiKey: string): Promise<void> {
  return jsonRequest("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

// Google Generative AI 验证
export function verifyGoogle(apiKey: string): Promise<void> {
  return jsonRequest(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
    {}
  );
}

// Kimi Code 验证：始终通过本地 auth proxy（proxy 自动注入 OAuth token）
// proxySecret：回环鉴权路径段（kimi-auth-proxy），拼进 URL 路径
export function verifyKFC(proxyPort: number, proxySecret: string, modelID?: string): Promise<void> {
  return jsonRequest(`http://127.0.0.1:${proxyPort}/${proxySecret}/coding/v1/messages`, {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: modelID || "kimi-for-coding",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
}

// Moonshot 子平台验证（moonshot-cn / moonshot-ai）
export function verifyMoonshot(apiKey: string, subPlatform?: string): Promise<void> {
  const sub = MOONSHOT_SUB_PLATFORMS[subPlatform || "moonshot-cn"];
  return jsonRequest(`${sub.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

// 通用 HTTPS JSON 验证请求：向 hostname+path POST body，用 judge 判定 JSON 响应。
// 飞书 / QQ Bot / 钉钉三渠道凭据验证共用，仅端点与判定逻辑不同。
// judge 返回 null = 通过；返回字符串 = 作为失败原因。
function httpsJsonVerify(
  hostname: string,
  reqPath: string,
  body: string,
  label: string,
  judge: (json: any, data: string) => string | null,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path: reqPath,
        method: "POST",
        headers: { "content-type": "application/json" },
        timeout: 15000,
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          try {
            const err = judge(JSON.parse(data), data);
            if (err) reject(new Error(err));
            else resolve();
          } catch {
            reject(new Error(`${label}响应解析失败: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", (e) => reject(new Error(`网络错误: ${e.message}`)));
    req.on("timeout", () => { req.destroy(); reject(new Error("请求超时")); });
    req.write(body);
    req.end();
  });
}

// 飞书应用凭据验证（通过 tenant_access_token 接口校验 appId + appSecret）
export function verifyFeishu(appId: string, appSecret: string): Promise<void> {
  return httpsJsonVerify(
    "open.feishu.cn",
    "/open-apis/auth/v3/tenant_access_token/internal",
    JSON.stringify({ app_id: appId, app_secret: appSecret }),
    "飞书",
    (json) =>
      json.code === 0 ? null : json.msg || `飞书验证失败 (code: ${json.code})`,
  );
}

// QQ Bot 凭据验证（通过 getAppAccessToken 接口校验 appId + clientSecret）。
export function verifyQqbot(appId: string, clientSecret: string): Promise<void> {
  return httpsJsonVerify(
    "bots.qq.com",
    "/app/getAppAccessToken",
    JSON.stringify({ appId, clientSecret }),
    "QQ Bot ",
    (json, data) =>
      typeof json.access_token === "string" && json.access_token.trim()
        ? null
        : json.message || json.msg || `QQ Bot 验证失败: ${data.slice(0, 200)}`,
  );
}

// 钉钉应用凭据验证（通过 accessToken 接口校验 clientId/AppKey + clientSecret/AppSecret）。
export function verifyDingtalk(clientId: string, clientSecret: string): Promise<void> {
  return httpsJsonVerify(
    "api.dingtalk.com",
    "/v1.0/oauth2/accessToken",
    JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
    "钉钉",
    (json, data) =>
      typeof json.accessToken === "string" && json.accessToken.trim()
        ? null
        : json.message ||
          json.msg ||
          json.errmsg ||
          `钉钉验证失败: ${data.slice(0, 200)}`,
  );
}

// Custom provider 验证（根据 API 类型发真实 chat 请求，而非 /models）
export async function verifyCustom(apiKey: string, baseURL?: string, apiType?: string, modelID?: string): Promise<void> {
  if (!baseURL) throw new Error("Custom provider 需要 Base URL");
  if (!modelID) throw new Error("Custom provider 需要 Model ID");
  const base = baseURL.replace(/\/$/, "");

  if (apiType === "anthropic-messages") {
    await jsonRequest(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "User-Agent": UA_ANTHROPIC,
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelID,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
  } else if (apiType === "openai-responses") {
    // OpenAI Responses API（/v1/responses）
    await jsonRequest(`${base}/v1/responses`, {
      method: "POST",
      headers: {
        "User-Agent": UA_OPENAI,
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelID,
        input: "hi",
      }),
    });
  } else {
    // openai-completions（默认）
    await jsonRequest(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "User-Agent": UA_OPENAI,
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelID,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
  }
}

type VerifyProviderParams = {
  provider: string;
  apiKey?: string;
  baseURL?: string;
  subPlatform?: string;
  apiType?: string;
  modelID?: string;
  appId?: string;
  clientId?: string;
  appSecret?: string;
  clientSecret?: string;
  botId?: string;
  secret?: string;
  customPreset?: string;
  proxyPort?: number;
  proxySecret?: string;
};

export type VerifyProviderResult = {
  success: boolean;
  message?: string;
  supportsImage?: boolean;
};

type ImageSupportDeps = {
  probeImageSupport?: typeof probeImageSupport;
  request?: typeof jsonRequest;
};

function resolveImageProbeConfig(params: VerifyProviderParams): {
  apiType: string;
  baseURL?: string;
  auth: ImageProbeAuth;
} | null {
  const { provider, baseURL, subPlatform, apiType, customPreset, proxyPort, proxySecret } = params;

  if (provider === "anthropic") {
    return { apiType: "anthropic-messages", baseURL: PROVIDER_PRESETS.anthropic.baseUrl, auth: "x-api-key" };
  }
  if (provider === "openai") {
    return { apiType: "openai-completions", baseURL: PROVIDER_PRESETS.openai.baseUrl, auth: "bearer" };
  }
  if (provider === "google") {
    return { apiType: "google-generative-ai", baseURL: PROVIDER_PRESETS.google.baseUrl, auth: "none" };
  }
  if (provider === "moonshot") {
    if (subPlatform === "kimi-code") {
      return { apiType: "anthropic-messages", baseURL: proxyPort ? `http://127.0.0.1:${proxyPort}${proxySecret ? `/${proxySecret}` : ""}/coding` : undefined, auth: "none" };
    }
    const sub = MOONSHOT_SUB_PLATFORMS[subPlatform || "moonshot-cn"] || MOONSHOT_SUB_PLATFORMS["moonshot-cn"];
    return { apiType: sub.api, baseURL: sub.baseUrl, auth: sub.api === "anthropic-messages" ? "x-api-key" : "bearer" };
  }
  if (provider === "custom") {
    const customPre = customPreset ? CUSTOM_PROVIDER_PRESETS[customPreset] : undefined;
    const effectiveApi = customPre ? customPre.api : (apiType || "openai-completions");
    return {
      apiType: effectiveApi,
      baseURL: baseURL || customPre?.baseUrl,
      auth: effectiveApi === "anthropic-messages" ? "x-api-key" : "bearer",
    };
  }

  return null;
}

export async function resolveVerifiedImageSupport(
  params: VerifyProviderParams,
  deps: ImageSupportDeps = {},
): Promise<boolean | undefined> {
  const probeConfig = resolveImageProbeConfig(params);
  if (!probeConfig) return undefined;
  const outcome: ImageProbeOutcome = await (deps.probeImageSupport ?? probeImageSupport)({
    ...probeConfig,
    modelID: params.modelID,
    apiKey: params.apiKey,
    request: deps.request ?? jsonRequest,
  });
  // 探测不确定时返回 undefined：渲染层回退到 models.list 目录的 input 能力判断
  // （旧路径的 CLI model-catalog 兜底已随 R4 退役）
  if (outcome.kind === "supported") return true;
  if (outcome.kind === "unsupported") return false;
  return undefined;
}

// ── 统一验证入口（根据 provider 名称分派） ──

export async function verifyProvider(
  params: VerifyProviderParams,
): Promise<VerifyProviderResult> {
  const {
    provider,
    apiKey,
    baseURL,
    subPlatform,
    apiType,
    modelID,
    appId,
    clientId,
    appSecret,
    clientSecret,
    customPreset,
    proxyPort,
    proxySecret,
  } = params;
  try {
    switch (provider) {
      case "anthropic":
        await verifyAnthropic(apiKey!, modelID);
        break;
      case "openai":
        await verifyOpenAI(apiKey!);
        break;
      case "google":
        await verifyGoogle(apiKey!);
        break;
      case "moonshot":
        if (subPlatform === "kimi-code") {
          if (!proxyPort || proxyPort <= 0) throw new Error("Kimi Code auth proxy not running");
          await verifyKFC(proxyPort, proxySecret ?? "", modelID);
        } else {
          await verifyMoonshot(apiKey!, subPlatform);
        }
        break;
      case "custom": {
        const customPre = customPreset ? CUSTOM_PROVIDER_PRESETS[customPreset] : undefined;
        // 内置预设命中时，使用预设的 baseUrl 和 api 进行验证（前端传了 baseURL 时优先）
        const effectiveBaseURL = baseURL || (customPre ? customPre.baseUrl : undefined);
        const effectiveApiType = customPre ? customPre.api : apiType;
        await verifyCustom(apiKey!, effectiveBaseURL, effectiveApiType, modelID);
        break;
      }
      case "feishu":
        await verifyFeishu(appId!, appSecret!);
        break;
      case "qqbot":
        await verifyQqbot(appId!, clientSecret!);
        break;
      case "dingtalk":
        await verifyDingtalk(clientId!, clientSecret!);
        break;
      case "wecom":
        await verifyWecom(params.botId!, params.secret!);
        break;
      default:
        return { success: false, message: `未知 Provider: ${provider}` };
    }
    const supportsImage = await resolveVerifiedImageSupport(params);
    return supportsImage === undefined
      ? { success: true }
      : { success: true, supportsImage };
  } catch (err: any) {
    return { success: false, message: err.message || String(err) };
  }
}

// ── HTTP 请求工具 ──

// 与 runtime SDK 保持一致的 User-Agent（见 node_modules/@anthropic-ai/sdk 和 openai）
const UA_ANTHROPIC = "Anthropic/JS 0.73.0";
const UA_OPENAI = "OpenAI/JS 6.10.0";

// 从 provider 响应体中尽力抽出可读的错误消息，避免把 JSON 转义（如 >）泄漏给用户。
// 兼容常见 provider 形态：anthropic/openai 的 {error:{message}}、moonshot 的 {error:{message}}、
// 部分代理网关返回 {message} / {msg}、上游字符串 {error:"text"} 等。
function extractProviderErrorMessage(rawBody: string): string {
  const trimmed = rawBody.trim();
  if (!trimmed) return "";
  try {
    const json = JSON.parse(trimmed);
    const candidates: unknown[] = [
      json?.error?.message,
      json?.error?.error?.message,
      json?.error?.msg,
      json?.error,
      json?.message,
      json?.msg,
      json?.detail,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c.trim();
    }
  } catch {
    // body 不是合法 JSON（HTML 错误页 / 纯文本 / 截断），按原文处理
  }
  return trimmed;
}

export function jsonRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const urlObj = new URL(url);

    const req = mod.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: opts.method || "GET",
        headers: opts.headers,
        timeout: 15000,
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          const code = res.statusCode ?? 0;
          if (code >= 200 && code < 300) {
            resolve();
          } else if (code === 401 || code === 403) {
            const err: Error & { status?: number } = new Error(`API Key 无效 (${code})`);
            err.status = code;
            reject(err);
          } else {
            // 真实错误文本（已 JSON 解码），上限 1000 字以兼容罕见的极长 message。
            const text = extractProviderErrorMessage(body);
            const trimmed = text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
            const err: Error & { status?: number } = new Error(`请求失败 (${code}): ${trimmed}`);
            err.status = code;
            reject(err);
          }
        });
      }
    );
    req.on("error", (e) => reject(new Error(`网络错误: ${e.message}`)));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("请求超时"));
    });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
