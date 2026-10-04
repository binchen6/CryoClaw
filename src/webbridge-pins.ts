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
//
// T8 schema v2：`pins[filename]` 接受 `string | string[]`——上游会**原地反复重建**
// latest 产物，单哈希钉定在重建窗口期必然过期。多哈希让清单同时保留最近几代产物
// （写入侧 scripts/refresh-webbridge-pins.mjs 保留最近 5 枚），任意一枚命中即通过，
// 仍是精确 sha256 比对（fail closed 不放宽）。读取侧向后兼容 v1 单串形态。
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
    // 注释声明「仅 https」：env 覆盖来自用户环境，可能夹带 http/其他 scheme，
    // 不过滤会被当作降级通道劫持 pins 清单
    const list = override.split(/[\s,]+/).filter((u) => u.startsWith("https://"));
    if (list.length > 0) return list;
  }
  return DEFAULT_PINS_URLS;
}

/**
 * 严格解析清单 JSON（T8 schema v2）：
 *   `{ "<filename>": "<64-hex>" | ["<64-hex>", ...], ... }`
 * v1 单串值读作单元素数组（向后兼容）；数组值逐项校验、去重、上限 MAX_PINS_PER_FILE。
 * 任何非法条目（非 64 hex / 非字符串或字符串数组 / 空数组 / 超上限）都会导致整体
 * 返回 null——宁可不更新也不能让半截清单放宽校验。
 */
export function parsePinsJson(raw: string): PinValues | null {
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
  const out: PinValues = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (key === "version" || key === "updatedAt" || key === "note") continue; // 允许的元数据字段
    const list = normalizePinValue(value);
    if (!list) return null;
    out[key] = list;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** 每枚文件名的哈希上限（写入侧保留最近 5 枚；读取侧同限，防清单被塞爆）。 */
export const MAX_PINS_PER_FILE = 5;

const PIN_HEX_RE = /^[0-9a-f]{64}$/i;

/** 归一化后的钉定表：filename → 小写 64-hex 数组（v1 单串读作单元素数组）。 */
export type PinValues = Record<string, string[]>;

/** 严格归一化单个钉定值：非法（含空数组/超上限/非 hex 项）返回 null。 */
function normalizePinValue(value: unknown): string[] | null {
  const toHex = (v: unknown): string | null =>
    typeof v === "string" && PIN_HEX_RE.test(v) ? v.toLowerCase() : null;
  if (typeof value === "string") {
    const h = toHex(value);
    return h ? [h] : null;
  }
  if (Array.isArray(value)) {
    if (value.length === 0 || value.length > MAX_PINS_PER_FILE) return null;
    const out: string[] = [];
    for (const item of value) {
      const h = toHex(item);
      if (!h) return null;
      if (!out.includes(h)) out.push(h);
    }
    return out;
  }
  return null;
}

/**
 * 宽容归一化（校验侧用，webbridge.ts verify 路径）：任意钉定条目 → 小写 hex 数组。
 * 非法/缺失返回空数组——由调用方按「无远端钉定」继续 fail-closed 判定。
 */
export function pinValuesOf(value: unknown): string[] {
  return normalizePinValue(value) ?? [];
}

interface PinsCache {
  fetchedAt: number;
  pins: PinValues;
}

function readCache(cachePath: string): PinsCache | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    if (typeof parsed?.fetchedAt !== "number") return null;
    if (typeof parsed?.pins !== "object" || parsed.pins === null) return null;
    // v1 缓存（值为单串）读时归一化成数组；任一条目非法 → 整份缓存作废重拉。
    const pins: PinValues = {};
    for (const [key, value] of Object.entries(parsed.pins as Record<string, unknown>)) {
      const list = normalizePinValue(value);
      if (!list) return null;
      pins[key] = list;
    }
    return { fetchedAt: parsed.fetchedAt, pins };
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
  /** 忽略新鲜缓存强制刷新（T8「刷新钉定」IPC 与更新管线用）。 */
  forceRefresh?: boolean;
  /** forceRefresh 的别名（语义相同；两者任一为 true 即强制）。 */
  force?: boolean;
  logger?: { info: (m: string) => void };
}

export interface RemotePinsResult {
  pins: PinValues | null;
  source: string | null;
}

// 强制刷新时把 raw.githubusercontent 排到 jsDelivr 前面：jsDelivr 的 CDN 缓存
// 有小时级滞后，而 force 场景（上游刚重建 latest / 用户点了「刷新钉定」）恰恰
// 最需要拿到最新清单——打到 jsDelivr 缓存等于没刷新。非强制路径维持
// jsDelivr 优先（国内可达性优于 raw）。
function orderPinsUrls(urls: string[], force: boolean): string[] {
  if (!force) return urls;
  const raw = urls.filter((u) => u.includes("raw.githubusercontent.com"));
  const rest = urls.filter((u) => !u.includes("raw.githubusercontent.com"));
  return [...raw, ...rest];
}

/**
 * 读取远端钉定清单（优先新鲜缓存；过期或 force 则按序尝试各 URL；全部失败时回退过期缓存）。
 * 永不抛错——拉不到就返回 { pins: null }，由调用方回退内置钉定表。
 */
export async function loadRemotePins(opts: LoadRemotePinsOptions): Promise<RemotePinsResult> {
  const cachePath = path.join(opts.dataDir, CACHE_FILE_NAME);
  const cached = readCache(cachePath);
  const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const force = opts.force === true || opts.forceRefresh === true;
  if (cached && !force && Date.now() - cached.fetchedAt < maxAge) {
    return { pins: cached.pins, source: "cache" };
  }

  const fetchText = opts.fetchText ?? fetchTextSmall;
  for (const url of opts.urls ?? orderPinsUrls(resolvePinsUrls(), force)) {
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
