// webbridge-pins.ts — 可自动更新的 WebBridge 钉定清单（R68 永久修复）
//
// 问题：上游把 `.../webbridge/latest/releases/<name>` 当作可反复重建的发布位——
// 实测同一文件多次重建后**字节数不变、仅 Go build ID 等 177 字节元数据变化**，
// 而 exact-hash 钉定写在 App 里，于是每次上游重建都会让「修复 WebBridge」失败，
// 直到发新版才恢复（2026-09-10 一天内发生两次）。
//
// 永久修复：把钉定表变成**可自动更新的远端清单**（本仓库 resources/webbridge-pins.json）：
//   - 修复/安装时先读本地缓存（默认 24h 新鲜期），过期则从远端刷新；
//   - 校验链：内置嵌入表 → 远端清单 → 本地缓存，任一命中即通过（仍要求精确 sha256 匹配，
//     所以是"更易维护的钉定"，而非放宽校验）；
//   - 上游再换新时，维护者只需更新清单文件（或本模块的缓存由 App 自动刷新），无需发版。
//
// 安全边界：清单来自我们自己的仓库（与 App 发布同信任级），走 https，限制体积与超时；
// JSON 结构严格校验（值必须是 64 位 hex），非法清单整体丢弃。清单不可达时回退内置表，
// 两者都不匹配则维持 fail closed。
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";
import { URL } from "url";

/** 远端清单地址（按序尝试）：jsDelivr 优先（国内可达性优于 raw）。 */
export const DEFAULT_PINS_URLS = [
  "https://cdn.jsdelivr.net/gh/binchen6/CryoClaw@main/resources/webbridge-pins.json",
  "https://raw.githubusercontent.com/binchen6/CryoClaw/main/resources/webbridge-pins.json",
];

const CACHE_FILE_NAME = "remote-pins.json";
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_PINS_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

/** 允许的清单 URL（环境变量可覆盖，逗号/空白分隔；仅 https）。 */
export function resolvePinsUrls(): string[] {
  const override = process.env.CRYOCLAW_WEBBRIDGE_PINS_URL?.trim();
  if (override) {
    const list = override.split(/[\s,]+/).filter(Boolean);
    if (list.length > 0) return list;
  }
  return DEFAULT_PINS_URLS;
}

/**
 * 严格解析清单 JSON：`{ "<filename>": "<64-hex sha256>", ... }`。
 * 任何非法条目（非 64 hex / 非字符串）都会导致整体返回 null——宁可不更新也不能
 * 让半截清单放宽校验。
 */
export function parsePinsJson(raw: string): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  // 允许包裹在 { pins: {...} } 里（便于将来加元数据字段）
  const obj = parsed as Record<string, unknown>;
  const candidate =
    typeof obj.pins === "object" && obj.pins !== null && !Array.isArray(obj.pins)
      ? (obj.pins as Record<string, unknown>)
      : obj;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (key === "version" || key === "updatedAt") continue; // 允许的元数据字段
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) return null;
    out[key] = value.toLowerCase();
  }
  return Object.keys(out).length > 0 ? out : null;
}

interface PinsCache {
  fetchedAt: number;
  pins: Record<string, string>;
}

function readCache(cachePath: string): PinsCache | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    if (typeof parsed?.fetchedAt !== "number") return null;
    if (typeof parsed?.pins !== "object" || parsed.pins === null) return null;
    return { fetchedAt: parsed.fetchedAt, pins: parsed.pins as Record<string, string> };
  } catch {
    return null;
  }
}

function writeCache(cachePath: string, cache: PinsCache): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8");
  } catch {
    // 缓存写失败不影响本次校验
  }
}

/** 小体积文本拉取（限体积/超时/重定向上限；禁止 https→http 降级）。 */
export function fetchTextSmall(initialUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    let settled = false;
    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    const request = (url: string) => {
      const proto = new URL(url).protocol;
      const transport = proto === "http:" ? http : https;
      const req = transport.get(url, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (++redirects > MAX_REDIRECTS) return fail(new Error(`Too many redirects (>${MAX_REDIRECTS})`));
          const next = new URL(res.headers.location, url).toString();
          if (proto === "https:" && new URL(next).protocol !== "https:") {
            return fail(new Error(`拒绝降级到非 https 地址: ${next}`));
          }
          return request(next);
        }
        if (status !== 200) {
          res.resume();
          return fail(new Error(`HTTP ${status} — ${url}`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_PINS_BYTES) {
            req.destroy();
            res.resume();
            return fail(new Error(`清单体积超过上限 ${MAX_PINS_BYTES}B`));
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          resolve(Buffer.concat(chunks).toString("utf-8"));
        });
        res.on("error", fail);
      });
      req.setTimeout(FETCH_TIMEOUT_MS, () => {
        req.destroy(new Error(`清单拉取超时 ${FETCH_TIMEOUT_MS}ms — ${url}`));
      });
      req.on("error", fail);
    };
    request(initialUrl);
  });
}

export interface LoadRemotePinsOptions {
  dataDir: string;
  urls?: string[];
  maxAgeMs?: number;
  /** 测试注入口：替换实际网络拉取。 */
  fetchText?: (url: string) => Promise<string>;
  /** 测试注入口：忽略新鲜缓存强制刷新。 */
  forceRefresh?: boolean;
  logger?: { info: (m: string) => void };
}

export interface RemotePinsResult {
  pins: Record<string, string> | null;
  source: string | null;
}

/**
 * 读取远端钉定清单（优先新鲜缓存；过期则按序尝试各 URL；全部失败时回退过期缓存）。
 * 永不抛错——拉不到就返回 { pins: null }，由调用方回退内置钉定表。
 */
export async function loadRemotePins(opts: LoadRemotePinsOptions): Promise<RemotePinsResult> {
  const cachePath = path.join(opts.dataDir, CACHE_FILE_NAME);
  const cached = readCache(cachePath);
  const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (cached && !opts.forceRefresh && Date.now() - cached.fetchedAt < maxAge) {
    return { pins: cached.pins, source: "cache" };
  }

  const fetchText = opts.fetchText ?? fetchTextSmall;
  for (const url of opts.urls ?? resolvePinsUrls()) {
    try {
      const raw = await fetchText(url);
      const pins = parsePinsJson(raw);
      if (pins) {
        writeCache(cachePath, { fetchedAt: Date.now(), pins });
        opts.logger?.info(`[webbridge-pins] 远端钉定清单已更新（${url}）`);
        return { pins, source: url };
      }
      opts.logger?.info(`[webbridge-pins] 清单格式非法，忽略（${url}）`);
    } catch (err) {
      opts.logger?.info(
        `[webbridge-pins] 拉取失败（${url}）: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (cached) {
    opts.logger?.info(`[webbridge-pins] 使用过期缓存清单（fetchedAt=${cached.fetchedAt}）`);
    return { pins: cached.pins, source: "stale-cache" };
  }
  return { pins: null, source: null };
}
