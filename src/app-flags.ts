// app-flags.ts — 远端特性开关（kill-switch）清单
//
// 动机：R86 差异更新因 GitHub Releases CDN 分段 Range 请求在弱网下不稳定
// （ERR_CONNECTION_RESET / sha512 不匹配，且失败前已付出几十 MB 流量）被客户端禁用。
// 重启差异更新后需要一把「不发版即可关停」的远程开关：清单放本仓库
// resources/app-flags.json，客户端按 jsDelivr → raw 顺序拉取，24h 缓存，
// 过期缓存兜底，全部不可达时回退内置默认。维护者改清单文件即可全局生效，
// 无需 CryoClaw 发版。
//
// 安全边界：清单来自我们自己的仓库（与 App 发布同信任级），复用
// webbridge-pins 的 fetchTextSmall（https、限体积/超时/重定向、禁止降级）。
// 校验宽松正向：只认布尔值，未知键忽略（前向兼容旧客户端），整体非法回退默认。
// 本模块永不抛错——任何失败都落到兜底，由调用方决定默认姿态。
import * as fs from "fs";
import * as path from "path";
import { fetchTextSmall } from "./webbridge-pins";

/** 远端清单地址（按序尝试）：jsDelivr 优先（国内可达性优于 raw）。 */
export const DEFAULT_FLAGS_URLS = [
  "https://cdn.jsdelivr.net/gh/binchen6/CryoClaw@main/resources/app-flags.json",
  "https://raw.githubusercontent.com/binchen6/CryoClaw/main/resources/app-flags.json",
];

const CACHE_FILE_NAME = "app-flags.json";
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

export interface AppFlags {
  /** 差异（blockmap）更新总开关。false = 客户端一律全量下载。 */
  differentialDownload: boolean;
}

/** 内置默认（清单不可达时的姿态）：差异更新启用——这正是远端开关要保护的重启决策。 */
export const BUNDLED_DEFAULT_FLAGS: AppFlags = {
  differentialDownload: true,
};

/** 允许的清单 URL（环境变量可覆盖，逗号/空白分隔；仅 https——与 pins 同源约束）。 */
export function resolveFlagsUrls(): string[] {
  const override = process.env.CRYOCLAW_APP_FLAGS_URL?.trim();
  if (override) {
    const list = override.split(/[\s,]+/).filter((u) => u.startsWith("https://"));
    if (list.length > 0) return list;
  }
  return DEFAULT_FLAGS_URLS;
}

/**
 * 宽松正向解析：`{ flags: { differentialDownload: boolean, ... } }`。
 * 已知键必须是布尔（否则整份作废——半截清单不该改变更新通道）；
 * 未知键忽略（新版清单加键时旧客户端照常工作）。缺 flags 对象 → null。
 */
export function parseFlagsJson(raw: string): AppFlags | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const flags = (parsed as Record<string, unknown>).flags;
  if (typeof flags !== "object" || flags === null || Array.isArray(flags)) return null;
  const out: AppFlags = { ...BUNDLED_DEFAULT_FLAGS };
  for (const key of Object.keys(out) as Array<keyof AppFlags>) {
    const v = (flags as Record<string, unknown>)[key];
    if (v === undefined) continue; // 未提的键沿用内置默认
    if (typeof v !== "boolean") return null;
    out[key] = v;
  }
  return out;
}

interface FlagsCache {
  fetchedAt: number;
  flags: AppFlags;
}

function readCache(cachePath: string): FlagsCache | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    if (typeof parsed?.fetchedAt !== "number") return null;
    // 缓存经同一解析器复验——磁盘内容可能被手工改过
    const flags = parseFlagsJson(JSON.stringify({ flags: parsed.flags }));
    if (!flags) return null;
    return { fetchedAt: parsed.fetchedAt, flags };
  } catch {
    return null;
  }
}

function writeCache(cachePath: string, cache: FlagsCache): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8");
  } catch {
    // 缓存写失败不影响本次结果
  }
}

// 与 webbridge-pins 同理：force 场景（刚改完清单想立即生效）把 raw 排到
// jsDelivr 前面——jsDelivr 的 CDN 缓存有小时级滞后。
function orderFlagsUrls(urls: string[], force: boolean): string[] {
  if (!force) return urls;
  const raw = urls.filter((u) => u.includes("raw.githubusercontent.com"));
  const rest = urls.filter((u) => !u.includes("raw.githubusercontent.com"));
  return [...raw, ...rest];
}

export interface LoadAppFlagsOptions {
  dataDir: string;
  urls?: string[];
  maxAgeMs?: number;
  /** 测试注入口：替换实际网络拉取。 */
  fetchText?: (url: string) => Promise<string>;
  forceRefresh?: boolean;
  logger?: { info: (m: string) => void };
}

export interface AppFlagsResult {
  flags: AppFlags;
  source: string; // "cache" | url | "stale-cache" | "bundled-default"
}

/**
 * 读取远端特性开关（优先新鲜缓存；过期或 force 则按序尝试各 URL；
 * 全部失败时回退过期缓存，再不行回退内置默认）。永不抛错。
 */
export async function loadAppFlags(opts: LoadAppFlagsOptions): Promise<AppFlagsResult> {
  const cachePath = path.join(opts.dataDir, CACHE_FILE_NAME);
  const cached = readCache(cachePath);
  const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const force = opts.forceRefresh === true;
  if (cached && !force && Date.now() - cached.fetchedAt < maxAge) {
    return { flags: cached.flags, source: "cache" };
  }

  const fetchText = opts.fetchText ?? fetchTextSmall;
  for (const url of opts.urls ?? orderFlagsUrls(resolveFlagsUrls(), force)) {
    try {
      const raw = await fetchText(url);
      const flags = parseFlagsJson(raw);
      if (flags) {
        writeCache(cachePath, { fetchedAt: Date.now(), flags });
        opts.logger?.info(`[app-flags] 远端特性开关已更新（${url}）`);
        return { flags, source: url };
      }
      opts.logger?.info(`[app-flags] 清单格式非法，忽略（${url}）`);
    } catch (err) {
      opts.logger?.info(
        `[app-flags] 拉取失败（${url}）: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (cached) {
    opts.logger?.info(`[app-flags] 使用过期缓存清单（fetchedAt=${cached.fetchedAt}）`);
    return { flags: cached.flags, source: "stale-cache" };
  }
  return { flags: { ...BUNDLED_DEFAULT_FLAGS }, source: "bundled-default" };
}
