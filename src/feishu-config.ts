import * as path from "path";
import { resolveGatewayPackageDir } from "./constants";
import { isPluginPresentAnywhere, manifestOnlyPluginDirProbe } from "./plugin-presence";

export const FEISHU_CHANNEL_ID = "feishu";
export const FEISHU_PLUGIN_ID = "feishu";

// 统一解析飞书插件目录。feishu 是内核 vendored 官方扩展：构建期由
// scripts/package-resources.js（OFFICIAL_VENDOR_PLUGINS）把 @openclaw/feishu
// 原样写入 gateway dist/extensions/feishu/，形态与 qqbot 相同。
export function resolveFeishuPluginDir(): string {
  return path.join(resolveGatewayPackageDir(), "dist", "extensions", FEISHU_PLUGIN_ID);
}

// 检查飞书插件是否可用（四根判定，见 plugin-presence.ts）。vendored 入口布局
// 与 mirror 插件不同，探针只要求 openclaw.plugin.json（同 qqbot）。
export function isFeishuPluginBundled(): boolean {
  return isPluginPresentAnywhere(FEISHU_PLUGIN_ID, manifestOnlyPluginDirProbe);
}

type MutableRecord = Record<string, any>;

function isRecord(value: unknown): value is MutableRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function ensureRecord(parent: MutableRecord, key: string): MutableRecord {
  if (!isRecord(parent[key])) {
    parent[key] = {};
  }
  return parent[key];
}

function getLegacyFeishuPluginEntry(config: any): MutableRecord | null {
  const entry = config?.plugins?.entries?.[FEISHU_CHANNEL_ID];
  return isRecord(entry) ? entry : null;
}

function getLegacyFeishuEnabled(config: any): boolean | undefined {
  const enabled = getLegacyFeishuPluginEntry(config)?.enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
}

function clearLegacyFeishuPluginEntry(config: any): boolean {
  const entries = config?.plugins?.entries;
  if (!isRecord(entries) || !Object.prototype.hasOwnProperty.call(entries, FEISHU_CHANNEL_ID)) {
    return false;
  }

  delete entries[FEISHU_CHANNEL_ID];
  return true;
}

// 迁移前 OneClaw 以 plugins.entries.feishu.enabled 作为设置页开关来源。
function setFeishuChannelEnabled(config: MutableRecord, enabled: boolean): boolean {
  const channels = ensureRecord(config, "channels");
  const feishu = ensureRecord(channels, FEISHU_CHANNEL_ID);
  const previous = feishu.enabled;
  feishu.enabled = enabled;
  const cleared = clearLegacyFeishuPluginEntry(config);
  return previous !== enabled || cleared;
}

export function migrateLegacyFeishuPluginEntry(config: MutableRecord): boolean {
  const legacyEnabled = getLegacyFeishuEnabled(config);
  if (typeof legacyEnabled !== "boolean") {
    return clearLegacyFeishuPluginEntry(config);
  }
  return setFeishuChannelEnabled(config, legacyEnabled);
}
