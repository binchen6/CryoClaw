import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import { resolveUserConfigPath, resolveUserStateDir } from "./constants";
import { syncOpenClawStateAfterWrite } from "./openclaw-health-state";
import { backupCurrentUserConfig } from "./config-backup";
import { writeFileAtomicSync } from "./atomic-write";
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

// openclaw.json 原文缓存（R77）：启动链路会连续读 10+ 次（迁移 ×4、端口/auth
// 解析、健康检查、渠道确保……），每次都是全文件读 + JSON.parse——Windows 上
// Defender 实时扫描叠加后是启动期最大的重复同步 IO。键控 (mtimeMs, size)：
// 原子写 rename 必然改变 mtime，任何外部改写同样失效。每次调用仍 JSON.parse
// 缓存原文、返回全新对象——调用方「读-改-写」拿到独立副本的语义与无缓存时
// 完全一致（只省磁盘读，不共享可变引用）。
let userConfigRawCache: { mtimeMs: number; size: number; raw: string } | null = null;

export function readUserConfig(): any {
  const configPath = resolveUserConfigPath();
  let st: fs.Stats;
  try {
    st = fs.statSync(configPath);
  } catch (err: any) {
    userConfigRawCache = null;
    // 文件不存在保持返回 {}（首次启动/setup 前是合法状态）；
    // 其他 I/O 错误（Windows 杀软/索引器瞬时锁 EBUSY/EPERM/EACCES）必须抛出——
    // 吞成 {} 会让调用方把改动合并进空对象整文件写回，providers/channels/keys 全部蒸发
    if (err?.code === "ENOENT") return {};
    throw new Error(`无法读取 openclaw.json（可能被杀毒软件暂时占用），请重试: ${err?.message ?? err}`);
  }
  if (
    !userConfigRawCache ||
    userConfigRawCache.mtimeMs !== st.mtimeMs ||
    userConfigRawCache.size !== st.size
  ) {
    try {
      userConfigRawCache = { mtimeMs: st.mtimeMs, size: st.size, raw: fs.readFileSync(configPath, "utf-8") };
    } catch (err: any) {
      // 读失败（瞬时占用）≠ 文件不存在：同样不能吞成 {}（理由同上），不污染缓存
      throw new Error(`无法读取 openclaw.json（可能被杀毒软件暂时占用），请重试: ${err?.message ?? err}`);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(userConfigRawCache.raw);
  } catch {
    // 内容损坏保持返回 {} 的原语义：由启动期 inspectUserConfigHealth 恢复流程统一处理
    return {};
  }
  // 合法 JSON 标量/数组同样是损坏（openclaw.json 的根节点必须是对象）：返回 {} 而不是
  // 标量——调用方 `config.models ??= {}` 会在 strict mode 抛裸 TypeError，且文案不可读。
  // 口径对齐 cryoclaw-config.readCryoclawConfig（typeof object + !Array.isArray）。
  return isConfigObject(parsed) ? parsed : {};
}

// 读-改-写模式专用：返回当前配置 + 读时刻快照（深拷贝，与 config 无共享引用）。
// 调用方拿到 config 后普遍原地改（`config.hooks ??= {}`、Object.assign…），快照必须独立，
// 否则写前比对退化成「拿待写内容比对磁盘」，任何有意义的改动都会被误判为并发写入。
// 快照回传给 writeUserConfig(config, { baseSnapshot })，见 WriteUserConfigOptions。
//
// 强制绕过原文缓存（写入是低频路径，多读一次磁盘换确定性）：缓存键控 (mtimeMs, size)，
// 同一毫秒内同字节数的替换可能让它命中上一份原文——快照取自旧原文时，写前比对会把
// "自己的旧读"误判成第三方写入，弹一个莫名其妙的"配置已被其他流程更新"。
export function readUserConfigForWrite(): { config: any; baseSnapshot: any } {
  userConfigRawCache = null;
  const config = readUserConfig();
  return { config, baseSnapshot: JSON.parse(JSON.stringify(config)) };
}

// 顶层类型判定：openclaw.json 根节点必须是 JSON 对象（非 null、非数组）。
// 与 cryoclaw-config.readCryoclawConfig、extension-mirror.ensurePluginsAllow 的
// 根节点检查同口径。
function isConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CONFIG_CORRUPT_MESSAGE =
  "检测到 openclaw.json 内容损坏，已取消本次保存以保护现有配置；" +
  "请在下次启动时通过恢复流程（一键回退上次可用配置）或设置 → 备份与恢复页恢复";

// 覆盖前的保险丝：磁盘上存在但不可解析（含根节点非对象，见 isConfigObject）的
// openclaw.json 绝不能被整文件覆盖。
// 所有设置保存都是「readUserConfig() 改一小块 → writeUserConfig 整文件写回」，
// 若读取瞬间文件损坏/被占用（Windows 杀软/索引器 EBUSY），调用方会把改动合并进
// {} 空对象写回——providers/channels/keys 全部蒸发，且 backupCurrentUserConfig
// 跳过损坏文件、.bak 又会被同步覆盖，恢复链路一并失守。此处在唯一写咽喉点拦下：
// 损坏文件保留原位、仅抛错拒绝本次写入。绝不能 rename 移走损坏文件——启动期
// inspectUserConfigHealth 的恢复判定条件是「文件原位存在且内容非法」，移走后
// 恢复入口（config-invalid-json 弹窗：一键回退 last-known-good 快照，或打开
// 设置 → 备份与恢复页从历史备份恢复）永不触发；且 .corrupt-* 文件全代码库
// 没有任何读取/恢复入口，等同销毁用户配置。
//
// 返回值同时是「写前磁盘现状」：并发写比对（assertDiskUnchangedSinceSnapshot）
// 复用这一次读，不让同一文件在同一写路径上读两遍。
function readExistingConfigForWrite(): { exists: boolean; config: unknown } {
  const configPath = resolveUserConfigPath();
  if (!fs.existsSync(configPath)) return { exists: false, config: undefined };
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch {
    // 读失败（瞬时占用）≠ 内容损坏：不重命名（Windows 上也会因占用失败），
    // 直接让本次保存报错，用户重试即可。
    throw new Error("无法读取 openclaw.json（可能被其他程序暂时占用），已取消本次写入以保护现有配置");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(CONFIG_CORRUPT_MESSAGE);
  }
  // 解析成功但根节点是标量/数组：同样按内容损坏处理（同一条错误路径）。放行的话
  // 调用方 `config.models ??= {}` 在 strict mode 抛裸 TypeError，用户看到的是
  // "Cannot create property"，无从判断是配置损坏。
  if (!isConfigObject(parsed)) throw new Error(CONFIG_CORRUPT_MESSAGE);
  return { exists: true, config: parsed };
}

export interface WriteUserConfigOptions {
  /**
   * 读时刻的配置快照，必须与待写对象相互独立（用 readUserConfigForWrite 取得）。
   * 传入后写前重读磁盘比对：磁盘相对快照已变化，说明窗口期内有第三方（gateway 内核
   * 把前端渠道配置 config.patch 落盘、CLI 命令等）写了 openclaw.json，而本次写入是
   * 基于旧快照的整文件覆盖——继续写会静默丢掉对方刚写入的改动（lost update），
   * 因此抛错拒绝并让用户重试。
   * 启动期迁移（gateway 未启动、同一流程内连续写）与纯构造新对象的路径不必传。
   */
  baseSnapshot?: unknown;
}

// 稳定的 JSON 序列化（递归字典序键）：只用于快照比对，键序差异不算内容变化
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableSerialize(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// 顶层 key 差异（用户可见的错误里带上，便于判断是谁写的）
function describeTopLevelKeyDiff(diskValue: unknown, baseSnapshot: unknown): string {
  if (!isConfigObject(diskValue) || !isConfigObject(baseSnapshot)) return "";
  const diskKeys = new Set(Object.keys(diskValue));
  const baseKeys = new Set(Object.keys(baseSnapshot));
  const added = [...diskKeys].filter((k) => !baseKeys.has(k));
  const missing = [...baseKeys].filter((k) => !diskKeys.has(k));
  const parts: string[] = [];
  if (added.length > 0) parts.push(`新增 ${added.join(", ")}`);
  if (missing.length > 0) parts.push(`缺少 ${missing.join(", ")}`);
  return parts.length === 0 ? "" : `（磁盘顶层字段：${parts.join("；")}）`;
}

function assertDiskUnchangedSinceSnapshot(
  disk: { exists: boolean; config: unknown },
  baseSnapshot: unknown,
): void {
  // 文件不存在 = 空配置（readUserConfig 对 ENOENT 同样给 {}），两者可直接比
  const diskValue = disk.exists ? disk.config : {};
  if (stableSerialize(diskValue) === stableSerialize(baseSnapshot)) return;
  throw new Error(
    "配置已被其他流程（如 gateway 内核）更新，已取消本次保存以免覆盖对方的改动，请重试。" +
    describeTopLevelKeyDiff(diskValue, baseSnapshot),
  );
}

export function writeUserConfig(config: any, opts: WriteUserConfigOptions = {}): void {
  const disk = readExistingConfigForWrite();
  if (opts.baseSnapshot !== undefined) {
    assertDiskUnchangedSinceSnapshot(disk, opts.baseSnapshot);
  }
  const stateDir = resolveUserStateDir();
  fs.mkdirSync(stateDir, { recursive: true });
  // 覆盖写入前先保留一份当前可解析配置，便于用户在设置页回退。
  backupCurrentUserConfig();
  const configPath = resolveUserConfigPath();
  // 原子写（tmp + fsync + rename）：这是 openclaw.json 的主写路径，写一半崩溃（强杀/
  // 断电）留下截断配置会让下次启动进入恢复流程；模式对齐 config-backup 的 writeConfigRaw
  writeFileAtomicSync(configPath, JSON.stringify(config, null, 2));
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
export function verifyKFC(proxyPort: number, modelID?: string, verifyKey?: string): Promise<void> {
  return jsonRequest(`http://127.0.0.1:${proxyPort}/coding/v1/messages`, {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      // R91：逐请求验证 key —— 代理对该头优先于全局 token，验证不再劫持
      // 在途生产流量的凭据
      ...(verifyKey ? { "x-cryoclaw-verify-key": verifyKey } : {}),
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
  // subPlatform 来自渲染层入参：未知值回退默认子平台，避免 `undefined.baseUrl`
  // 的裸 TypeError 混进验证失败文案（对齐 getMoonshotProviderKey 的守卫风格）
  const sub = MOONSHOT_SUB_PLATFORMS[subPlatform || "moonshot-cn"] || MOONSHOT_SUB_PLATFORMS["moonshot-cn"];
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
  /** kimi-code 验证专用（R91）：经本地代理时逐请求携带，取代全局 token 劫持 */
  proxyVerifyKey?: string;
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
  const { provider, baseURL, subPlatform, apiType, customPreset, proxyPort } = params;

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
      return { apiType: "anthropic-messages", baseURL: proxyPort ? `http://127.0.0.1:${proxyPort}/coding` : undefined, auth: "none" };
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
    // R91：kimi-code 图像探测走本地代理时同样逐请求携带验证 key
    ...(params.proxyVerifyKey && probeConfig.baseURL?.startsWith("http://127.0.0.1")
      ? { extraHeaders: { "x-cryoclaw-verify-key": params.proxyVerifyKey } }
      : {}),
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
          await verifyKFC(proxyPort, modelID, params.proxyVerifyKey);
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
  return rawJsonRequest(url, opts).then(() => undefined);
}

// jsonRequest 的带响应体版本（拉取模型列表 / 用量查询等需要解析 JSON 响应的场景）。
// 错误语义与 jsonRequest 完全一致（401/403 归一为「API Key 无效」，其余带上游 message）。
export function jsonRequestBody<T = unknown>(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<T> {
  return rawJsonRequest(url, opts).then(body => {
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error(`响应解析失败: ${String(body).slice(0, 200)}`);
    }
  });
}

// 响应体总量上限：baseURL 可来自用户自定义 provider（任意地址），恶意/故障源的
// 超长或无限滴流响应会把主进程内存吃穿（Node http 的 timeout 只是 socket 空闲
// 超时，缓慢滴流不会触发）。上限对齐 skill-store 的 JSON_GET_MAX_BYTES。
const RAW_JSON_MAX_BYTES = 8 * 1024 * 1024;

function rawJsonRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<string> {
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
        let bytes = 0;
        res.on("data", (d) => {
          bytes += d.length;
          if (bytes > RAW_JSON_MAX_BYTES) {
            req.destroy();
            reject(new Error(`响应超过 ${Math.floor(RAW_JSON_MAX_BYTES / 1024 / 1024)}MB 上限，已中断`));
            return;
          }
          body += d;
        });
        res.on("end", () => {
          const code = res.statusCode ?? 0;
          if (code >= 200 && code < 300) {
            resolve(body);
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
