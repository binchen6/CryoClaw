import * as crypto from "crypto";
import * as fs from "fs";
import { resolveUserConfigPath } from "./constants";
import { backupCurrentUserConfig } from "./config-backup";
import { writeFileAtomicSync } from "./atomic-write";
import { syncOpenClawStateAfterWrite } from "./openclaw-health-state";
import * as log from "./logger";

type GatewayConfig = Record<string, any>;
interface ResolveTokenOptions {
  persist?: boolean;
}

const FILE_ORIGIN_NULL = "null";

// L15：配置缺失/损坏时随机 token 的进程内缓存。
//
// 背景：GatewayProcess 构造时用 persist:false 取一次 token 注入首窗 URL（T1），随后
// syncGatewayRuntimeConfigFromDisk() 再取一次；若配置仍不存在（首启 Setup 未完成、
// 配置被删/损坏），旧实现会随机出 T2 —— 窗口 URL 里的 T1 与 gateway 实际启动用的
// token（OPENCLAW_GATEWAY_TOKEN）不一致，首连必 401，只能靠 gateway:ready 兜底自愈。
//
// 因此：所有「读不到真实 token」的分支共用同一个随机值；一旦从配置解析出真实 token，
// 就用它覆盖缓存。令牌轮换（persist:true 写入新 token）走的是配置分支，不受影响。
let ephemeralTokenCache: string | null = null;

function resolveEphemeralToken(): string {
  ephemeralTokenCache ??= crypto.randomBytes(16).toString("hex");
  return ephemeralTokenCache;
}

// 记住配置里的真实 token：覆盖缓存后，后续「读不到 token」的调用也与真实 token 一致
function rememberResolvedToken(token: string): string {
  ephemeralTokenCache = token;
  return token;
}

// 为 Electron file:// 页面补全 Control UI 的 null origin 白名单。
function ensureControlUiAllowedOriginsInConfig(config: GatewayConfig): void {
  config.gateway ??= {};
  config.gateway.controlUi ??= {};

  const controlUi = config.gateway.controlUi as GatewayConfig;
  const rawAllowedOrigins = Array.isArray(controlUi.allowedOrigins) ? controlUi.allowedOrigins : [];

  const normalized = rawAllowedOrigins
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);

  const hasNullOrigin = normalized.some((value) => value.toLowerCase() === FILE_ORIGIN_NULL);
  if (!hasNullOrigin) {
    normalized.push(FILE_ORIGIN_NULL);
  }

  controlUi.allowedOrigins = normalized;
}

/**
 * 统一整理 gateway.auth：确保 mode=token 且 token 存在。
 */
export function ensureGatewayAuthTokenInConfig(config: GatewayConfig): string {
  config.gateway ??= {};
  config.gateway.auth ??= {};

  const auth = config.gateway.auth as GatewayConfig;
  const token = typeof auth.token === "string" ? auth.token.trim() : "";
  const resolvedToken = token || crypto.randomBytes(16).toString("hex");

  auth.mode = "token";
  auth.token = resolvedToken;

  // 本应用始终使用本地 gateway；空值时补全为 local，避免未设置状态。
  if (typeof config.gateway.mode !== "string" || !config.gateway.mode.trim()) {
    config.gateway.mode = "local";
  }
  ensureControlUiAllowedOriginsInConfig(config);

  return resolvedToken;
}

/**
 * 从 openclaw.json 读取（或补全）gateway token。
 * 仅在配置文件可解析时才回写，避免覆盖损坏配置。
 */
export function resolveGatewayAuthToken(opts: ResolveTokenOptions = {}): string {
  const configPath = resolveUserConfigPath();
  if (!fs.existsSync(configPath)) {
    return resolveEphemeralToken();
  }

  let config: GatewayConfig;
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    config = JSON.parse(raw);
  } catch {
    return resolveEphemeralToken();
  }

  // 只读模式：仅使用已有 token，避免在 Setup 判定前提前改写配置。
  if (opts.persist === false) {
    const token = typeof config.gateway?.auth?.token === "string" ? config.gateway.auth.token.trim() : "";
    return token ? rememberResolvedToken(token) : resolveEphemeralToken();
  }

  const before = JSON.stringify(config);
  const token = ensureGatewayAuthTokenInConfig(config);
  const after = JSON.stringify(config);

  if (before !== after) {
    try {
      // 自动补全 token 前先备份旧配置，保证每次变更都可回退。
      backupCurrentUserConfig();
      // 原子写（tmp + fsync + rename，R64 审查 P2）：模式对齐 writeUserConfig/writeConfigRaw，
      // 直写崩溃窗口会留下截断的 openclaw.json 触发恢复流程
      writeFileAtomicSync(configPath, JSON.stringify(config, null, 2));
      syncOpenClawStateAfterWrite(configPath);
    } catch (err: any) {
      // 持久化失败时本会话靠环境变量保持一致，但每次启动都会轮换新 token 且无法诊断，
      // 必须留痕（不能静默吞掉）
      log.error(`[gateway-auth] token 持久化失败: ${err?.message ?? err}`);
    }
  }

  return rememberResolvedToken(token);
}
