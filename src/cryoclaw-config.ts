import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { resolveUserStateDir, resolveUserConfigPath } from "./constants";

// ── 类型定义 ──

export interface CryoclawConfig {
  setupCompletedAt?: string;
  cliPreference?: "installed" | "uninstalled";
  updateChannel?: "stable" | "dev" | "off";
  lastShownReleaseNotesVersion?: string;
  skillStore?: {
    registryUrl?: string;
  };
  channelId?: string;
  channelSource?: string;
  // Gateway 本地控制服务连接信息（主进程写入，gateway-ctl.mjs 只读）
  gatewayControl?: {
    port?: number;
    token?: string;
  };
}

// 四种归属状态
export type OwnershipState =
  | "cryoclaw"
  | "legacy-cryoclaw"
  | "external-openclaw"
  | "fresh";

// ── 路径 ──

// CryoClaw 专属配置文件路径
export function resolveCryoclawConfigPath(): string {
  return path.join(resolveUserStateDir(), "cryoclaw.config.json");
}

// 上一代（OneClaw 时代）配置文件路径，仅作读取 fallback，不写
function resolveLegacyConfigPath(): string {
  return path.join(resolveUserStateDir(), "oneclaw.config.json");
}

// .device-id 文件路径（与官方 CLI 共用）
function resolveDeviceIdPath(): string {
  return path.join(resolveUserStateDir(), ".device-id");
}

// legacy skill-store.json 文件路径
function resolveSkillStoreConfigPath(): string {
  return path.join(resolveUserStateDir(), "skill-store.json");
}

// ── 读写 ──

// 读取 CryoClaw 专属配置，不存在或解析失败返回 null。
// 读不到新文件（cryoclaw.config.json）时 fallback 读上一代 oneclaw.config.json，
// 保住老用户的 updateChannel / cliPreference 等设置；写只写新文件。
export function readCryoclawConfig(): CryoclawConfig | null {
  const newPath = resolveCryoclawConfigPath();
  const target = fs.existsSync(newPath) ? newPath : resolveLegacyConfigPath();
  try {
    const raw = fs.readFileSync(target, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as CryoclawConfig;
  } catch {
    return null;
  }
}

// 写入 CryoClaw 专属配置（只写新文件）
export function writeCryoclawConfig(config: CryoclawConfig): void {
  const dir = resolveUserStateDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    resolveCryoclawConfigPath(),
    JSON.stringify(config, null, 2) + "\n",
    "utf-8",
  );
}

// ── 归属检测 ──

// 老版 CryoClaw/OneClaw 独有文件：官方 CLI 不会创建 setup-baseline
function hasLegacyCryoclawMarker(): boolean {
  return fs.existsSync(
    path.join(resolveUserStateDir(), "openclaw-setup-baseline.json"),
  );
}

// 判定当前 ~/.openclaw/ 目录的归属状态
export function detectOwnership(): OwnershipState {
  const cryoclawConfig = readCryoclawConfig();
  if (cryoclawConfig?.setupCompletedAt) return "cryoclaw";

  // 老版本没有 cryoclaw.config.json，但会创建这些独有文件
  // （.device-id 和 wizard.lastRunAt 不可靠：官方 CLI 也会创建）
  if (hasLegacyCryoclawMarker()) return "legacy-cryoclaw";

  const openclawJsonExists = fs.existsSync(resolveUserConfigPath());
  if (openclawJsonExists) return "external-openclaw";

  return "fresh";
}

// ── 迁移 ──

// 从 legacy 文件迁移到 cryoclaw.config.json（老用户升级）。
// legacy（oneclaw.config.json）的全部已知字段都会补齐进新文件；
// 新文件已存在的值优先，不覆盖用户在新版本里已有的设置。
// 逐个核对 CryoclawConfig 后的刻意排除：gatewayControl 是主进程运行时写入的
// 控制服务连接信息（port/token 随即失效），迁移旧值反而有害。
export function migrateFromLegacy(): CryoclawConfig {
  const newPath = resolveCryoclawConfigPath();
  // readCryoclawConfig 在新文件缺失时会 fallback 读 legacy，这里必须显式只读新文件
  const config: CryoclawConfig = fs.existsSync(newPath) ? readCryoclawConfig() ?? {} : {};

  // 读取 legacy 配置（oneclaw.config.json）
  let legacy: CryoclawConfig = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveLegacyConfigPath(), "utf-8"));
    if (parsed && typeof parsed === "object") legacy = parsed as CryoclawConfig;
  } catch {}

  // setupCompletedAt 的另一个来源：openclaw.json 的 wizard.lastRunAt
  let wizardLastRunAt: string | undefined;
  try {
    const raw = fs.readFileSync(resolveUserConfigPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed?.wizard?.lastRunAt) {
      wizardLastRunAt = parsed.wizard.lastRunAt;
    }
  } catch {}

  // skillStore.registryUrl 的另一个来源：legacy skill-store.json
  let legacyRegistryUrl: string | undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(resolveSkillStoreConfigPath(), "utf-8"));
    if (raw?.registryUrl) {
      legacyRegistryUrl = raw.registryUrl;
    }
  } catch {}

  // 仅补齐缺失字段：新文件已有值一律不动
  const fillIfMissing = <K extends keyof CryoclawConfig>(key: K, value: CryoclawConfig[K] | undefined): void => {
    if (config[key] === undefined && value !== undefined) config[key] = value;
  };
  fillIfMissing("setupCompletedAt", legacy.setupCompletedAt ?? wizardLastRunAt);
  fillIfMissing("cliPreference", legacy.cliPreference);
  fillIfMissing("updateChannel", legacy.updateChannel);
  fillIfMissing("lastShownReleaseNotesVersion", legacy.lastShownReleaseNotesVersion);
  fillIfMissing("channelId", legacy.channelId);
  fillIfMissing("channelSource", legacy.channelSource);
  // skillStore 按子字段补齐：新文件已写 registryUrl 时不覆盖
  if (config.skillStore?.registryUrl === undefined) {
    const registryUrl = legacy.skillStore?.registryUrl ?? legacyRegistryUrl;
    if (registryUrl !== undefined) {
      config.skillStore = { ...config.skillStore, registryUrl };
    }
  }

  writeCryoclawConfig(config);
  return config;
}

// ── 便捷方法 ──

// 标记 Setup 完成（写入 setupCompletedAt 到 cryoclaw.config.json）
export function markSetupComplete(): void {
  let config = readCryoclawConfig();
  if (!config) {
    config = {};
  }
  config.setupCompletedAt = new Date().toISOString();
  writeCryoclawConfig(config);
}

export function getChannelId(): string {
  return readCryoclawConfig()?.channelId ?? "";
}

export function appendChannelUtm(url: string): string {
  const channelId = getChannelId();
  if (!channelId) return url;
  try {
    const u = new URL(url);
    const isKimiDomain = u.hostname === "kimi.com" || u.hostname.endsWith(".kimi.com");
    const hasOneclawUtm = u.searchParams.get("utm_source") === "oneclaw";

    if (isKimiDomain || hasOneclawUtm) {
      if (!u.searchParams.has("utm_source")) u.searchParams.set("utm_source", "oneclaw");
      if (!u.searchParams.has("utm_campaign")) u.searchParams.set("utm_campaign", channelId);
      return u.toString();
    }
  } catch {}
  return url;
}

// 确保 deviceId 存在，直接读写 .device-id 文件（与官方 CLI 共用）
export function ensureDeviceId(): string {
  const deviceIdPath = resolveDeviceIdPath();
  try {
    const existing = fs.readFileSync(deviceIdPath, "utf-8").trim();
    if (existing) return existing;
  } catch {}

  // 文件不存在或为空，生成新 ID 并写入
  const deviceId = crypto.randomUUID();
  const dir = resolveUserStateDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(deviceIdPath, deviceId + "\n", "utf-8");
  return deviceId;
}
