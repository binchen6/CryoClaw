import { app, ipcMain, dialog } from "electron";
import {importLocalSkill,isLocalSkill} from "./local-extension-import";
import {
  resolveUserStateDir,
  resolveUserBinDir,
  resolveNodeBin,
  resolveNodeExtraEnv,
  resolveClawhubEntry,
  resolveGatewayPackageDir,
  IS_WIN,
} from "./constants";
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";
import * as log from "./logger";
import { assertTrustedIpcSender } from "./ipc-sender-guard";
import { readCryoclawConfig, writeCryoclawConfig } from "./cryoclaw-config";
import { readBuildConfigClawhubRegistry } from "./build-config";

// 构建时通过 build-config.json 注入的默认 registry，未配置则回退硬编码值。
// R91 起延迟求值：build-config 在求值时会调用 Electron app 对象，而本模块的
// 纯函数（validateSkillSlug 等）需要在 node --test（无 Electron 运行时，require
// "electron" 只得到二进制路径字符串）下可导入测试；首次使用时求值并缓存，
// 生产行为不变。jsonGet 同时导出给 plugin-store 复用（ClawHub 同源 HTTP 守卫
// 只维护一份，避免两处实现漂移）。
let defaultRegistryCache: string | null = null;
function defaultRegistry(): string {
  if (defaultRegistryCache === null) {
    defaultRegistryCache = readBuildConfigClawhubRegistry() || "https://clawhub.ai";
  }
  return defaultRegistryCache;
}
const FETCH_TIMEOUT_MS = 15_000;
const SKILL_STORE_CONFIG = "skill-store.json";
// clawhub CLI stdout 上限（对齐 plugin-store MAX_BUFFER）：Node execFile 默认
// maxBuffer 仅 1MB，install 等大输出命令会被 ENOBUFS 误杀（进程非零退出）
const EXEC_MAX_BUFFER = 8 * 1024 * 1024;

// 开发模式下打印网络请求日志
const debugLog = (msg: string) => {
  if (!app.isPackaged) log.info(`[skill-store] ${msg}`);
};

// ── 类型定义 ──

export type SkillSummary = {
  slug: string;
  name: string;
  description: string;
  version: string;
  downloads: number;
  highlighted: boolean;
  updatedAt: string;
  author: string;
};

export type SkillDetail = SkillSummary & {
  changelog?: string;
  readme: string;
  author: string;
  tags: string[];
};

type ListResult = {
  skills: SkillSummary[];
  nextCursor: string | null;
};

// ── 独立配置文件读写（不污染 gateway 的 openclaw.json） ──

// 技能商店配置文件路径：~/.openclaw/skill-store.json
function skillStoreConfigPath(): string {
  return path.join(resolveUserStateDir(), SKILL_STORE_CONFIG);
}

// 读取 legacy 技能商店独立配置（兼容旧版 skill-store.json）
function readLegacySkillStoreConfig(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(skillStoreConfigPath(), "utf-8"));
  } catch {
    return {};
  }
}

// 写入 legacy 技能商店独立配置（兼容旧版 skill-store.json）
function writeLegacySkillStoreConfig(data: Record<string, any>): void {
  fs.mkdirSync(path.dirname(skillStoreConfigPath()), { recursive: true });
  fs.writeFileSync(skillStoreConfigPath(), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ── Registry URL 公开接口（供 settings-ipc 使用） ──

// 读取 registry URL（优先 cryoclaw.config.json，兼容 legacy skill-store.json）
export function readSkillStoreRegistry(): string {
  const cryoclawConfig = readCryoclawConfig();
  if (cryoclawConfig?.skillStore?.registryUrl) {
    return cryoclawConfig.skillStore.registryUrl;
  }
  const legacy = readLegacySkillStoreConfig();
  return typeof legacy?.registryUrl === "string" ? legacy.registryUrl : "";
}

// 写入 registry URL（写到 cryoclaw.config.json + legacy 文件双写）。
// scheme 守卫：registry 是技能清单 + 安装载荷的下载源，明文 http 会被中间人
// 篡改（技能内容会引导 agent 行为）——仅放行 https，http 限本机回环（本地镜像）。
// 校验放在写入咽喉点，settings:save-advanced 的 catch 会把异常转成用户可见 message。
export function writeSkillStoreRegistry(url: string): void {
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("ClawHub Registry 地址必须是合法 URL");
    }
    const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
      throw new Error("ClawHub Registry 地址必须使用 https（本地镜像可用 http://localhost）");
    }
  }
  const config = readCryoclawConfig();
  if (config) {
    if (url) {
      config.skillStore ??= {};
      config.skillStore.registryUrl = url;
    } else {
      delete config.skillStore?.registryUrl;
    }
    writeCryoclawConfig(config);
  }
  // legacy 文件双写保持兼容
  const legacyConfig = readLegacySkillStoreConfig();
  if (url) {
    legacyConfig.registryUrl = url;
  } else {
    delete legacyConfig.registryUrl;
  }
  writeLegacySkillStoreConfig(legacyConfig);
}

// ── Registry URL 解析 ──

// 读取用户自定义 registry 地址，未配置时回退官方默认值
function registryUrl(): string {
  const custom = readSkillStoreRegistry();
  if (custom.trim()) {
    // 读侧 scheme 复核（R91 三审）：写入侧已限 https/回环 http，但手改
    // cryoclaw.config.json / legacy skill-store.json 可绕过——技能清单与
    // readme 是引导 agent 行为的内容源，非回环明文 http 在读侧同样拒绝
    try {
      const parsed = new URL(custom.trim());
      const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
      if (parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopback)) {
        return custom.trim().replace(/\/+$/, "");
      }
    } catch { /* 非法 URL 回退默认源 */ }
  }
  return defaultRegistry();
}

// ── HTTP 请求封装 ──

// 通用 JSON GET 请求，带超时控制。
// 响应体设大小上限（对齐 plugin-store MAX_BUFFER）：registry URL 是用户可自定义的
// 任意地址，恶意/故障源的超长或无限滴流响应会把主进程内存吃穿（Node http 的
// timeout 只是 socket 空闲超时，缓慢滴流不会触发）。
const JSON_GET_MAX_BYTES = 8 * 1024 * 1024;

// R91 起导出：plugin-store 的 market-browse 也访问 ClawHub 公开 API，复用同一份
// 超时 / 8MB 上限 / 状态码守卫实现，避免安全约束在两个文件里各自演化。
// R92：非 2xx 时错误对象附带 statusCode/bodyText——409 AMBIGUOUS_SKILL_SLUG 的
// 歧义清单就在 body 里，调用方需要读到它做自动消歧。
const jsonRequests = new Map<string, Promise<unknown>>();
/** Some mirror endpoints return an API error inside HTTP 200. Never let that win a race. */
export function assertRegistryPayload(value:unknown):void {
  const payload=value as {ResponseMetadata?:{Error?:{Message?:string}}}|null;
  if(payload?.ResponseMetadata?.Error)throw new Error(payload.ResponseMetadata.Error.Message || "Registry API error");
}
let preferredPublicRegistry: {url:string;at:number} | undefined;
/** Share concurrent reads; public ClawHub requests try the existing CN mirror after 1s. */
export function jsonGet<T>(url: string): Promise<T> {
  const pending = jsonRequests.get(url);
  if (pending) return pending as Promise<T>;
  const request = (async () => {
    const primary = jsonGetDirect<T>(url);
    const parsed = new URL(url);
    if (parsed.origin !== "https://clawhub.ai") return primary;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const mirror = new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        void jsonGetDirect<T>(`${CN_CLAWHUB_MIRROR}${parsed.pathname}${parsed.search}`).then(resolve, reject);
      }, 1000);
    });
    try {
      const winner = await Promise.any([primary.then(data=>({data,registry:parsed.origin})), mirror.then(data=>({data,registry:CN_CLAWHUB_MIRROR}))]);
      preferredPublicRegistry={url:winner.registry,at:Date.now()};
      return winner.data;
    }
    catch { return await primary; }
    finally { clearTimeout(timer); }
  })();
  jsonRequests.set(url, request);
  void request.finally(() => jsonRequests.delete(url)).catch(() => {});
  return request;
}

function jsonGetDirect<T>(url: string, redirects=0, expires=Date.now()+FETCH_TIMEOUT_MS): Promise<T> {
  debugLog(`GET ${url}`);
  const startMs = Date.now();
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if(Date.now()>=expires){reject(new Error("request timeout"));return;}
    const mod = parsed.protocol === "https:" ? https : http;
    const req = mod.get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      if(res.statusCode && [301,302,303,307,308].includes(res.statusCode) && res.headers.location){
        res.resume();
        try{
          const next=new URL(res.headers.location,url);
          if(redirects>=4 || next.username || next.password || (next.protocol!=="https:" && !(next.protocol==="http:" && ["127.0.0.1","localhost","[::1]"].includes(next.hostname))))throw Error("Invalid registry redirect");
          void jsonGetDirect<T>(next.href,redirects+1,expires).then(resolve,reject);
        }catch(error){reject(error);}
        return;
      }
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        debugLog(`GET ${url} → ${res.statusCode} (${Date.now() - startMs}ms)`);
        // 非 2xx 也读回 body（限 64KB）再 reject：409 等业务错误的信息在 body
        const errChunks: Buffer[] = [];
        let errBytes = 0;
        res.on("data", (chunk: Buffer) => {
          errBytes += chunk.length;
          if (errBytes > 64 * 1024) {
            // 错误体超 64KB：res.destroy() 不触发 end/error，必须先显式 reject
            // 再销毁——否则 Promise 永久悬挂（skill-store:list 等 IPC 死转，
            // 商店页只能重启应用）。reject 幂等，后续事件不再生效。
            const err = new Error(`HTTP ${res.statusCode}`) as Error & { statusCode?: number };
            err.statusCode = res.statusCode ?? 0;
            reject(err);
            res.destroy();
            return;
          }
          errChunks.push(chunk);
        });
        res.on("end", () => {
          const err = new Error(`HTTP ${res.statusCode}`) as Error & { statusCode?: number; bodyText?: string };
          err.statusCode = res.statusCode ?? 0;
          err.bodyText = Buffer.concat(errChunks).toString("utf-8");
          reject(err);
        });
        res.on("error", () => {
          const err = new Error(`HTTP ${res.statusCode}`) as Error & { statusCode?: number };
          err.statusCode = res.statusCode ?? 0;
          reject(err);
        });
        return;
      }
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      // 超 8MB 后 req.destroy()，在途的 socket error 事件（如 ECONNRESET）在
      // reject 已发生后再无监听器会走 uncaughtException——补一个空监听即可
      // （promise 已 settle，重入 reject 幂等无副作用）
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("response truncated")));
      res.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > JSON_GET_MAX_BYTES) {
          req.destroy();
          reject(new Error("response too large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        debugLog(`GET ${url} → ${res.statusCode} ${body.length}B (${Date.now() - startMs}ms)\n${body}`);
        try {
          const data=JSON.parse(body) as T;
          assertRegistryPayload(data);
          resolve(data);
        } catch (err) {
          debugLog(`GET ${url} → JSON parse error: ${err}`);
          reject(err);
        }
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error("request timeout")), Math.max(1,expires-Date.now()));
    req.once("close", () => clearTimeout(deadline));
    req.on("error", (err) => {
      debugLog(`GET ${url} → error: ${err.message} (${Date.now() - startMs}ms)`);
      reject(err);
    });
    req.on("timeout", () => {
      debugLog(`GET ${url} → timeout (${Date.now() - startMs}ms)`);
      req.destroy();
      reject(new Error("request timeout"));
    });
  });
}

// ── API 响应 → 前端类型映射 ──

// 非法日期（如非日期字符串）toISOString 会抛 RangeError，打挂整个列表；非法时返回空串
function formatUpdatedAt(value: any): string {
  if (!value) return "";
  const d = new Date(value);
  return isNaN(d.getTime()) ? "" : d.toISOString();
}

// 将 API 返回的原始条目转为前端 SkillSummary
function mapItem(raw: any): SkillSummary {
  return {
    slug: raw.slug ?? "",
    name: raw.displayName ?? raw.slug ?? "",
    description: raw.summary ?? "",
    version: raw.tags?.latest ?? raw.latestVersion?.version ?? raw.version ?? "",
    downloads: raw.stats?.downloads ?? raw.downloads ?? 0,
    highlighted: true,
    updatedAt: formatUpdatedAt(raw.updatedAt),
    author: raw.author ?? raw.owner ?? "",
  };
}

// ── API 调用 ──

// 获取精选技能列表（分页）；主源网络失败回退国内镜像（browse 模拟）
async function listSkills(opts: {
  sort?: string;
  limit?: number;
  cursor?: string;
}): Promise<ListResult> {
  const base = registryUrl();
  const params = new URLSearchParams();
  params.set("highlightedOnly", "true");
  if (opts.sort) params.set("sort", opts.sort);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.cursor) params.set("cursor", opts.cursor);
  try {
    const raw = await jsonGet<any>(`${base}/api/v1/skills?${params}`);
    const items = Array.isArray(raw.items) ? raw.items : Array.isArray(raw.skills) ? raw.skills : [];
    return {
      skills: items.map(mapItem),
      nextCursor: raw.nextCursor ?? null,
    };
  } catch (err) {
    if (!isNetworkFailure(err) || opts.cursor) throw err;
    // 镜像无浏览端点：用 search 关键词聚合模拟（无分页游标，一次拉满）
    debugLog(`list 主源失败，回退国内镜像聚合: ${(err as Error).message}`);
    const wanted = Math.max(opts.limit ?? 20, 40);
    const settled = await Promise.allSettled(
      MIRROR_BROWSE_KEYWORDS.map((kw) =>
        jsonGet<any>(`${CN_CLAWHUB_MIRROR}/api/v1/search?q=${encodeURIComponent(kw)}&limit=${wanted}`)),
    );
    const bySlug = new Map<string, any>();
    let lastFailure: unknown = null;
    let failed = 0;
    for (const r of settled) {
      if (r.status !== "fulfilled") {
        failed++;
        lastFailure = r.reason;
        continue;
      }
      const items = Array.isArray(r.value.results) ? r.value.results : [];
      for (const item of items) {
        const slug = typeof item?.slug === "string" ? item.slug : "";
        if (slug && !bySlug.has(slug)) bySlug.set(slug, item);
      }
    }
    if (failed === settled.length) {
      // 镜像 7 路全灭时返回空成功会让 UI 误显示「商店空空如也」——对齐
      // plugin-store fetchMarketGroups 的全灭抛错（单路失败仍只丢自身）。
      // 全 fulfilled 但零结果是镜像真空列表，维持空成功。
      throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure));
    }
    const all = [...bySlug.values()].map(mapItem);
    // 本地排序模拟服务端 sort：downloads 降序 / updated 降序 / trending 沿用命中序
    const sorted = opts.sort === "downloads"
      ? all.sort((a, b) => b.downloads - a.downloads)
      : opts.sort === "updated"
        ? all.sort((a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""))
        : all;
    return { skills: sorted.slice(0, opts.limit ?? 20), nextCursor: null };
  }
}

// ── 国内镜像 fallback（R92）──
// 官方中国镜像（火山引擎/字节跳动支持，mirror-cn.clawhub.com 302 指向）。
// 实测 API 面是子集：/api/v1/search 与 /api/v1/skills/<slug>?owner= 可用，
// /api/v1/skills（浏览）与 packages 系列接口不可用（空 Result）——浏览 fallback
// 用 search 跑关键词聚合模拟。R93 起 plugin-store 复用同一镜像常量做市场
// 浏览/详情的末级回退（当前镜像无 packages 接口，保留探测以待镜像补齐）。
export const CN_CLAWHUB_MIRROR = "https://cn.clawhub-mirror.com";

// 镜像 browse fallback 的关键词（聚合去重后本地排序，模拟官方 trending 列表）
const MIRROR_BROWSE_KEYWORDS = ["tool", "search", "web", "agent", "code", "automation", "data"];

// 主源网络类失败（超时/连接错误/5xx）才走镜像；4xx 是业务错误，换源无意义。
// R93 起导出：plugin-store 的市场浏览/更新检查回退用同一判定，避免两处漂移。
export function isNetworkFailure(err: unknown): boolean {
  const e = err as { statusCode?: number; message?: string };
  if (typeof e.statusCode === "number") return e.statusCode >= 500;
  const msg = String(e?.message ?? err);
  return /timeout|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network|socket/i.test(msg);
}

// 镜像 search/detail 与主源同构；detail 信封不同（{skill, latestVersion, owner, history}）
function mapMirrorDetail(raw: any): SkillDetail {
  const s = (raw && typeof raw.skill === "object" && raw.skill) ? raw.skill : raw;
  return {
    ...mapItem({ ...s, owner: raw?.owner?.handle ?? raw?.owner?.ownerHandle ?? s.owner }),
    // 镜像详情无 readme（实测），留空——UI 对空 readme 自然隐藏说明区
    readme: s.readme ?? "",
    author: raw?.owner?.handle ?? raw?.owner?.ownerHandle ?? s.owner ?? "",
    tags: Array.isArray(s.tags) ? s.tags.filter((t: unknown): t is string => typeof t === "string") : [],
  };
}

// 主源与镜像的 detail 信封同构（实测：{ skill, owner, metadata?, latestVersion? }），
// 平铺响应作兼容回退。ClawHub API 不提供 readme；安装/配置说明在 metadata.setup。
export function normalizeSkillDetail(raw: any): SkillDetail {
  const s = (raw && typeof raw.skill === "object" && raw.skill) ? raw.skill : raw;
  const ownerHandle = raw?.owner?.handle ?? raw?.owner?.ownerHandle ?? s.owner ?? "";
  return {
    ...mapItem({ ...s, owner: ownerHandle }),
    readme: s.readme ?? (typeof raw?.metadata?.setup === "string" ? raw.metadata.setup : ""),
    ...(typeof raw?.latestVersion?.changelog==="string"?{changelog:raw.latestVersion.changelog}:typeof s.changelog==="string"?{changelog:s.changelog}:{}),
    author: ownerHandle,
    tags: Array.isArray(s.tags) ? s.tags.filter((t: unknown): t is string => typeof t === "string") : [],
  };
}

// 搜索技能（不限 highlighted，搜全量）；主源网络失败回退国内镜像
async function searchSkills(opts: {
  q: string;
  limit?: number;
}): Promise<{ skills: SkillSummary[] }> {
  const params = new URLSearchParams();
  params.set("q", opts.q);
  if (opts.limit) params.set("limit", String(opts.limit));
  try {
    const raw = await jsonGet<any>(`${registryUrl()}/api/v1/search?${params}`);
    // 搜索接口返回 results 数组，兼容 items/skills 回退
    const items = Array.isArray(raw.results) ? raw.results : Array.isArray(raw.items) ? raw.items : [];
    return { skills: items.map(mapItem) };
  } catch (err) {
    if (!isNetworkFailure(err)) throw err;
    debugLog(`search 主源失败，回退国内镜像: ${(err as Error).message}`);
    const raw = await jsonGet<any>(`${CN_CLAWHUB_MIRROR}/api/v1/search?${params}`);
    const items = Array.isArray(raw.results) ? raw.results : Array.isArray(raw.items) ? raw.items : [];
    return { skills: items.map(mapItem) };
  }
}

// 409 AMBIGUOUS_SKILL_SLUG 的歧义清单解析（纯函数，单测覆盖）：
// body 形如 {"code":"AMBIGUOUS_SKILL_SLUG","matches":[{"ownerHandle":"x",...}]}
export function parseSlugMatches(bodyText: string | undefined): string[] {
  if (!bodyText) return [];
  try {
    const parsed = JSON.parse(bodyText) as { code?: unknown; matches?: unknown };
    if (parsed.code !== "AMBIGUOUS_SKILL_SLUG" || !Array.isArray(parsed.matches)) return [];
    return parsed.matches
      .map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>).ownerHandle : null))
      .filter((o): o is string => typeof o === "string" && Boolean(o.trim()));
  } catch {
    return [];
  }
}

// 获取技能详情（R92：多作者 slug 消歧 + 镜像 fallback）。
// ClawHub 的 slug 不全局唯一：同名技能挂在不同作者下时 detail 返回
// 409 AMBIGUOUS_SKILL_SLUG，需带 ?owner=<ownerHandle> 消歧。列表条目自带
// author 的场景由前端直传 owner；否则从 409 body 的 matches 里取第一个重试。
async function getSkillDetail(slug: string, owner?: string): Promise<SkillDetail> {
  const base = registryUrl();
  const fetchDetail = async (ownerParam?: string): Promise<SkillDetail> => {
    const qs = ownerParam ? `?owner=${encodeURIComponent(ownerParam)}` : "";
    const raw = await jsonGet<any>(`${base}/api/v1/skills/${encodeURIComponent(slug)}${qs}`);
    return normalizeSkillDetail(raw);
  };
  try {
    return await fetchDetail(owner);
  } catch (err) {
    const e = err as { statusCode?: number; bodyText?: string };
    if (e.statusCode === 409) {
      const candidates = owner ? [owner] : [];
      const matches = parseSlugMatches(e.bodyText);
      for (const m of matches) if (!candidates.includes(m)) candidates.push(m);
      for (const candidate of candidates) {
        try {
          return await fetchDetail(candidate);
        } catch { /* 试下一个候选 */ }
      }
      throw new Error(`技能「${slug}」存在多个同名版本，未能确定作者（候选：${(matches.length ? matches : candidates).join(", ")}）`);
    }
    if (isNetworkFailure(err)) {
      debugLog(`detail 主源失败，回退国内镜像: ${(err as Error).message}`);
      // 镜像详情信封不同且无 readme；owner 缺省时同样先试 409 消歧
      const qs = owner ? `?owner=${encodeURIComponent(owner)}` : "";
      try {
        const raw = await jsonGet<any>(`${CN_CLAWHUB_MIRROR}/api/v1/skills/${encodeURIComponent(slug)}${qs}`);
        return normalizeSkillDetail(raw);
      } catch (err2) {
        const e2 = err2 as { statusCode?: number; bodyText?: string };
        if (e2.statusCode === 409) {
          for (const candidate of parseSlugMatches(e2.bodyText)) {
            try {
              const raw = await jsonGet<any>(`${CN_CLAWHUB_MIRROR}/api/v1/skills/${encodeURIComponent(slug)}?owner=${encodeURIComponent(candidate)}`);
              return normalizeSkillDetail(raw);
            } catch { /* 试下一个候选 */ }
          }
        }
        throw err2;
      }
    }
    throw err;
  }
}

// ── clawhub CLI 调用 ──

// workspace 目录：~/.openclaw/workspace
function workspaceDir(): string {
  return path.join(resolveUserStateDir(), "workspace");
}

// 技能安装根目录：~/.openclaw/workspace/skills/
function skillsBaseDir(): string {
  return path.join(workspaceDir(), "skills");
}

// 执行 clawhub CLI 命令，返回 stdout
export function createAnonymousClawhubConfig(stateDir:string,registry:string):{configPath:string;cleanup:()=>void} {
  const tmp=path.join(stateDir,"tmp");fs.mkdirSync(tmp,{recursive:true});
  const base=fs.realpathSync(tmp),directory=fs.mkdtempSync(path.join(base,"clawhub-public-"));
  const configPath=path.join(directory,"config.json");
  fs.writeFileSync(configPath,JSON.stringify({registry}),{mode:0o600});
  return {configPath,cleanup:()=>{const relative=path.relative(base,path.resolve(directory));if(!relative || relative.startsWith("..") || path.isAbsolute(relative))throw Error("Invalid temporary registry configuration path");fs.rmSync(directory,{recursive:true,force:true});}};
}

function execClawhub(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const nodeBin = resolveNodeBin();
  const clawhubEntry = resolveClawhubEntry();
  const configured = registryUrl();
  const registry = configured === "https://clawhub.ai" && preferredPublicRegistry && Date.now()-preferredPublicRegistry.at < 10*60_000 ? preferredPublicRegistry.url : configured;
  // The CLI otherwise forwards its saved token to any --registry target.
  const anonymous=registry!==configured?createAnonymousClawhubConfig(resolveUserStateDir(),registry):undefined;
  const workdir = workspaceDir();

  // 构建完整参数：node clawhub-entry --workdir <workdir> --registry <registry> --no-input <args>
  // --no-deprecation（R93）：Electron 43 已知 bug（electron#47390）——asar 内 stat
  // 转换用了已弃用的 fs.Stats 构造器，ELECTRON_RUN_AS_NODE 子进程会刷 DEP0180 警告；
  // clawhub 是 vendored 依赖，其弃用告警不可行动，直接静音。
  const fullArgs = ["--no-deprecation", clawhubEntry, "--workdir", workdir, "--registry", registry, "--no-input", ...args];
  debugLog(`exec: ${nodeBin} ${fullArgs.join(" ")}`);

  return new Promise((resolve, reject) => {
    // 组装 PATH，确保内嵌 node 和 clawhub wrapper 可找到
    const userBinDir = resolveUserBinDir();
    const envPath = userBinDir + path.delimiter + (process.env.PATH ?? "");

    execFile(nodeBin, fullArgs, {
      timeout: 60_000,
      maxBuffer: EXEC_MAX_BUFFER,
      env: {
        ...process.env,
        ...resolveNodeExtraEnv(),
        ...(anonymous?{CLAWHUB_CONFIG_PATH:anonymous.configPath}:{}),
        // 显式对齐 gateway spawn 的状态目录（R91 审查修复）：HOME 歧义时
        // clawhub 会解析到另一个 ~/.openclaw，安装/卸载落错目录
        OPENCLAW_STATE_DIR: resolveUserStateDir(),
        PATH: envPath,
      },
      windowsHide: true,
    }, (err, stdout, stderr) => {
      try{anonymous?.cleanup();}catch{log.warn("[skill-store] Temporary public registry configuration cleanup failed");}
      const out = typeof stdout === "string" ? stdout : "";
      const errOut = typeof stderr === "string" ? stderr : "";
      debugLog(`exec result: exit=${err ? (err as any).code ?? "error" : 0} stdout=${out.length}B stderr=${errOut.length}B`);
      if (errOut.trim()) debugLog(`exec stderr: ${errOut.trim()}`);
      if (err) {
        reject(new Error(errOut.trim() || err.message));
        return;
      }
      resolve({ stdout: out, stderr: errOut });
    });
  });
}

// 安全面：slug 必须是合法的技能标识符，不接受 -- 开头的 flag 或路径分隔符
// 防止参数注入（如 --registry=...）与路径穿越（如 ../foo）
// R91 起导出：skill-store:detail handler 复用，且作为纯校验函数供 node:test 覆盖
const SKILL_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
export function validateSkillSlug(slug: string): { ok: true } | { ok: false; error: string } {
  if (!slug) return { ok: false, error: "slug 不能为空" };
  if (slug.startsWith("-")) return { ok: false, error: "slug 不能以 - 开头" };
  if (!SKILL_SLUG_RE.test(slug)) return { ok: false, error: "slug 格式非法" };
  return { ok: true };
}

// 通过 clawhub CLI 安装技能
async function installSkill(slug: string): Promise<{ success: boolean; message?: string }> {
  const check = validateSkillSlug(slug);
  if (!check.ok) return { success: false, message: check.error };
  try {
    await execClawhub(["install", slug]);
    return { success: true };
  } catch (err: any) {
    return { success: false, message: err?.message ?? String(err) };
  }
}

// 根据名称或 slug 解析实际安装目录名
function resolveInstalledSlug(nameOrSlug: string): string {
  const installed = listInstalledSkills();
  // 直接匹配目录名
  if (installed.includes(nameOrSlug)) return nameOrSlug;
  // 从 SKILL.md 读取 name 字段反查（支持 frontmatter `name:` 和 Markdown `# title`）
  const base = skillsBaseDir();
  const needle = nameOrSlug.toLowerCase();
  for (const dir of installed) {
    try {
      const md = fs.readFileSync(path.join(base, dir, "SKILL.md"), "utf-8");
      // frontmatter: name: xxx
      const fm = md.match(/^name:\s*["']?(.+?)["']?\s*$/m);
      if (fm && fm[1].trim().toLowerCase() === needle) return dir;
      // Markdown heading: # xxx
      const h1 = md.match(/^#\s+(.+)/m);
      if (h1 && h1[1].trim().toLowerCase() === needle) return dir;
    } catch { /* skip */ }
  }
  return nameOrSlug;
}

// 通过 clawhub CLI 卸载技能
async function uninstallSkill(slug: string): Promise<{ success: boolean; message?: string }> {
  const check = validateSkillSlug(slug);
  if (!check.ok) return { success: false, message: check.error };
  try {
    const resolved = resolveInstalledSlug(slug);
    // resolve 可能返回 workspace/skills/ 下 agent 可写的目录名（反查 SKILL.md），
    // 该名字未经白名单校验——复核一次，防止 "--flag" 形态目录注入 clawhub 参数
    const resolvedCheck = validateSkillSlug(resolved);
    if (!resolvedCheck.ok) return { success: false, message: resolvedCheck.error };
    if(isLocalSkill(skillsBaseDir(),resolved)){
      const base=fs.realpathSync(skillsBaseDir());
      const target=fs.realpathSync(path.join(base,resolved));
      const relative=path.relative(base,target);
      if(relative.startsWith("..") || path.isAbsolute(relative) || !relative)throw Error("Invalid local skill directory");
      fs.rmSync(target,{recursive:true});
      return {success:true};
    }
    debugLog(`uninstall: "${slug}" → resolved="${resolved}"`);
    await execClawhub(["uninstall", "--yes", resolved]);
    return { success: true };
  } catch (err: any) {
    return { success: false, message: err?.message ?? String(err) };
  }
}

// 列出本地已安装的技能 slug（直接读目录，不依赖 CLI）
function listInstalledSkills(): string[] {
  const base = skillsBaseDir();
  if (!fs.existsSync(base)) return [];
  try {
    return fs.readdirSync(base).filter((name) => {
      const dir = path.join(base, name);
      // 边界守卫：条目必须仍在技能根目录内
      const rel = path.relative(base, dir);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
      return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, "SKILL.md"));
    });
  } catch {
    return [];
  }
}

// ── 技能更新（检查 + 升级）──

/** Local details never depend on marketplace availability. Reject directory escapes. */
export function readLocalSkillDetail(slug: string, roots = [skillsBaseDir(), path.join(resolveUserStateDir(), "skills"), path.join(app.getAppPath(), "builtin-skills"), path.join(resolveGatewayPackageDir(), "skills")]): SkillDetail | null {
  if (!validateSkillSlug(slug).ok) return null;
  for (const root of roots) {
    try {
      const base = fs.realpathSync(root);
      const file = fs.realpathSync(path.join(base, slug, "SKILL.md"));
      const relative = path.relative(base, file);
      if (relative.startsWith("..") || path.isAbsolute(relative) || fs.statSync(file).size > 512 * 1024) continue;
      const readme = fs.readFileSync(file, "utf8");
      const field = (key: string) => readme.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, "m"))?.[1]?.trim() ?? "";
      return { slug, name: field("name") || slug, description: field("description"), version: readInstalledSkillVersions(root)[slug] ?? "", downloads: 0, highlighted: false, updatedAt: fs.statSync(file).mtime.toISOString(), author: "", tags: [], readme };
    } catch { /* Try the next local skill root. */ }
  }
  return null;
}

// 数字段版本比较（1.10.0 > 1.9.9）：a<b → -1，相等 → 0，a>b → 1
function compareSkillVersions(a: string, b: string): number {
  const pa = a.split(".").map((s) => parseInt(s, 10) || 0);
  const pb = b.split(".").map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// 读取已安装技能的版本表：clawhub lockfile 优先（安装器权威记录），
// 缺失条目回退各技能目录的 _meta.json（手工拷贝进目录的技能也有版本痕迹）。
export function readInstalledSkillVersions(base?: string): Record<string, string> {
  const root = base ?? skillsBaseDir();
  const out: Record<string, string> = {};
  try {
    const localLock=path.join(root,".clawhub","lock.json");
    const lock = JSON.parse(fs.readFileSync(fs.existsSync(localLock)?localLock:path.join(path.dirname(root),".clawhub","lock.json"), "utf-8"));
    const skills = lock?.skills;
    if (skills && typeof skills === "object") {
      for (const [slug, entry] of Object.entries(skills as Record<string, unknown>)) {
        const v = (entry as any)?.version;
        if (typeof v === "string" && v.trim()) out[slug] = v.trim();
      }
    }
  } catch {
    // lockfile 缺失/损坏不阻断——回退逐目录 _meta.json
  }
  // 回退/补充：目录内 _meta.json
  try {
    if (fs.existsSync(root)) {
      for (const name of fs.readdirSync(root)) {
        if (name in out || name.startsWith(".")) continue;
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(root, name, "_meta.json"), "utf-8"));
          const v = typeof meta?.version === "string" ? meta.version.trim() : "";
          if (v) out[name] = v;
        } catch { /* 单条目损坏跳过 */ }
      }
    }
  } catch { /* 目录不可读 → 空表 */ }
  return out;
}

export interface SkillUpdateEntry {
  slug: string;
  current: string | null;
  latest: string;
}

// 只检查市场追踪且版本已知的技能；并发 4，逐条记录检查失败。
export async function checkSkillUpdates(onlySlug?: string, failures: string[] = []): Promise<SkillUpdateEntry[]> {
  const installed = listInstalledSkills().filter(slug => (!onlySlug || slug === onlySlug) && !isLocalSkill(skillsBaseDir(),slug));
  if (installed.length === 0) return [];
  const versions = readInstalledSkillVersions();
  const updates: SkillUpdateEntry[] = [];
  const CONCURRENCY = 4;
  for (let i = 0; i < installed.length; i += CONCURRENCY) {
    const batch = installed.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (slug) => {
        if (!versions[slug]) return null;
        try {
          const detail = await getSkillDetail(slug);
          const latest = detail.version?.trim() ?? "";
          if (!latest) return null;
          const current = versions[slug] ?? null;
          // A manually copied skill with no version is not evidence of an update.
          if (!current || compareSkillVersions(latest, current) <= 0) return null;
          return { slug, current, latest } satisfies SkillUpdateEntry;
        } catch {
          failures.push(slug);
          return null; // 单条查询失败（下架/网络抖动）跳过
        }
      }),
    );
    for (const r of results) if (r) updates.push(r);
  }
  return updates;
}

export interface SkillUpdateResult {
  success: boolean;
  updated: string[];
  failed: { slug: string; message: string }[];
}

// 升级技能：clawhub update <slug>。串行执行（clawhub 对 skills 目录
// 有锁语义，并发 install 会相互踩踏）；单个失败不中断后续。
async function updateSkills(slugs: string[]): Promise<SkillUpdateResult> {
  const updated: string[] = [];
  const failed: { slug: string; message: string }[] = [];
  for (const slug of slugs) {
    if(isLocalSkill(skillsBaseDir(),slug)){failed.push({slug,message:"本地技能不支持更新 / Local skills do not support updates"});continue;}
    const check = validateSkillSlug(slug);
    if (!check.ok) {
      failed.push({ slug, message: check.error });
      continue;
    }
    try {
      await execClawhub(["update", slug]);
      updated.push(slug);
    } catch (err) {
      failed.push({ slug, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { success: failed.length === 0, updated, failed };
}

// ── IPC 注册 ──

// 列表缓存（R91 性能审查）：list 是纯读 HTTP（sort+limit+cursor 键控），
// 排序切换/重进商店 tab 不应重付网络往返；install/uninstall 主动失效。
const SKILL_LIST_CACHE_TTL_MS = 5 * 60_000;
const skillListCache = new Map<string, { at: number; result: ListResult }>();

// 注册技能商店相关 IPC handler
export function registerSkillStoreIpc(): void {
  ipcMain.handle("skill-store:import-local", async event => {
    if(!assertTrustedIpcSender(event,"skill-store:import-local"))throw Error("IPC sender not trusted");
    try{
      const picked=await dialog.showOpenDialog({title:"导入本地技能 / Import local skill",properties:["openDirectory"]});
      if(picked.canceled || !picked.filePaths[0])return {success:true,canceled:true};
      const slug=importLocalSkill(picked.filePaths[0],skillsBaseDir());
      skillListCache.clear();return {success:true,data:{slug}};
    }catch(error){return {success:false,message:error instanceof Error?error.message:String(error)};}
  });
  ipcMain.handle("skill-store:list", async (_event, params) => {
    if (!assertTrustedIpcSender(_event, "skill-store:list")) throw new Error("IPC sender not trusted");
    debugLog(`ipc list sort=${params?.sort} limit=${params?.limit} cursor=${params?.cursor ?? "none"}`);
    const cacheKey = JSON.stringify([params?.sort ?? "", params?.limit ?? "", params?.cursor ?? ""]);
    const cached = skillListCache.get(cacheKey);
    if (cached && Date.now() - cached.at < SKILL_LIST_CACHE_TTL_MS) {
      debugLog(`ipc list → cache hit (${cached.result.skills?.length ?? 0} skills)`);
      return { success: true, data: cached.result };
    }
    try {
      const result = await listSkills({
        sort: params?.sort,
        limit: params?.limit,
        cursor: params?.cursor,
      });
      skillListCache.set(cacheKey, { at: Date.now(), result });
      debugLog(`ipc list → ${result.skills?.length ?? 0} skills`);
      return { success: true, data: result };
    } catch (err: any) {
      debugLog(`ipc list → error: ${err?.message}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });

  ipcMain.handle("skill-store:search", async (_event, params) => {
    if (!assertTrustedIpcSender(_event, "skill-store:search")) throw new Error("IPC sender not trusted");
    debugLog(`ipc search q="${params?.q}" limit=${params?.limit}`);
    try {
      const result = await searchSkills({
        q: params?.q ?? "",
        limit: params?.limit,
      });
      debugLog(`ipc search → ${result.skills?.length ?? 0} skills`);
      return { success: true, data: result };
    } catch (err: any) {
      debugLog(`ipc search → error: ${err?.message}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });
  ipcMain.handle("skill-store:install", async (_event, params) => {
    if (!assertTrustedIpcSender(_event, "skill-store:install")) throw new Error("IPC sender not trusted");
    debugLog(`ipc install slug=${params?.slug}`);
    const result = await installSkill(params?.slug ?? "");
    if (result.success) skillListCache.clear();
    debugLog(`ipc install → ${result.success ? "ok" : result.message}`);
    return result;
  });

  ipcMain.handle("skill-store:uninstall", async (_event, params) => {
    if (!assertTrustedIpcSender(_event, "skill-store:uninstall")) throw new Error("IPC sender not trusted");
    debugLog(`ipc uninstall slug=${params?.slug}`);
    const result = await uninstallSkill(params?.slug ?? "");
    if (result.success) skillListCache.clear();
    debugLog(`ipc uninstall → ${result.success ? "ok" : result.message}`);
    return result;
  });

  ipcMain.handle("skill-store:list-installed", async (event) => {
    if (!assertTrustedIpcSender(event, "skill-store:list-installed")) throw new Error("IPC sender not trusted");
    const installed = listInstalledSkills();
    debugLog(`ipc list-installed → [${installed.join(", ")}]`);
    return { success: true, data: installed, local: installed.filter(slug=>isLocalSkill(skillsBaseDir(),slug)) };
  });

  // 检查已安装技能的更新（registry 最新版 vs 本地 lockfile/_meta 版本）
  ipcMain.handle("skill-store:check-updates", async (event, params) => {
    if (!assertTrustedIpcSender(event, "skill-store:check-updates")) throw new Error("IPC sender not trusted");
    try {
      const slug = typeof params?.slug === "string" ? params.slug : undefined;
      if (slug && !validateSkillSlug(slug).ok) return { success: false, message: "invalid skill slug" };
      const failed: string[] = [];
      const updates = await checkSkillUpdates(slug, failed);
      debugLog(`ipc check-updates → ${updates.length} 项可更新`);
      return { success: failed.length === 0, message: failed.length ? `检查失败 / Check failed: ${failed.join(", ")}` : undefined, data: { updates, failed, checkedAt: new Date().toISOString() } };
    } catch (err: any) {
      debugLog(`ipc check-updates → error: ${err?.message}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });

  // 升级技能：params.slugs 缺省 = 全部可更新项；指定则按名单升级（逐项校验 slug）
  ipcMain.handle("skill-store:update", async (event, params) => {
    if (!assertTrustedIpcSender(event, "skill-store:update")) throw new Error("IPC sender not trusted");
    try {
      let slugs: string[];
      if (Array.isArray(params?.slugs) && params.slugs.length > 0) {
        slugs = params.slugs.filter((x: unknown): x is string => typeof x === "string");
      } else {
        slugs = (await checkSkillUpdates()).map((u) => u.slug);
      }
      if (slugs.length === 0) {
        return { success: true, data: { updated: [], failed: [] } };
      }
      const result = await updateSkills(slugs);
      if (result.updated.length > 0) skillListCache.clear();
      debugLog(`ipc update → updated=[${result.updated.join(",")}] failed=${result.failed.length}`);
      return { success: result.success, data: result };
    } catch (err: any) {
      debugLog(`ipc update → error: ${err?.message}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });

  // R91：技能详情。getSkillDetail 早已存在但未暴露；slug 先走 validateSkillSlug
  // （防 flag 注入 / 路径穿越），失败直接拒绝而不是带进 URL。
  ipcMain.handle("skill-store:detail", async (event, params) => {
    if (!assertTrustedIpcSender(event, "skill-store:detail")) throw new Error("IPC sender not trusted");
    const slug = typeof params?.slug === "string" ? params.slug.trim() : "";
    const check = validateSkillSlug(slug);
    if (!check.ok) return { success: false, message: check.error };
    // owner 可选：列表条目自带的作者 handle，直传可省一次 409 往返
    const owner = typeof params?.owner === "string" && params.owner.trim() ? params.owner.trim() : undefined;
    debugLog(`ipc detail slug=${slug} owner=${owner ?? "none"}`);
    try {
      if (params?.local) {
        const local = readLocalSkillDetail(slug);
        if (!local) return { success: false, message: "未找到本地 SKILL.md / Local SKILL.md not found" };
        return { success: true, data: local };
      }
      const detail = await getSkillDetail(slug, owner);
      return { success: true, data: detail };
    } catch (err: any) {
      debugLog(`ipc detail → error: ${err?.message}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });
}
