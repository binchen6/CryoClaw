import { app, ipcMain } from "electron";
import {
  resolveUserStateDir,
  resolveUserBinDir,
  resolveNodeBin,
  resolveNodeExtraEnv,
  resolveClawhubEntry,
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
export function jsonGet<T>(url: string): Promise<T> {
  debugLog(`GET ${url}`);
  const startMs = Date.now();
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;
    const req = mod.get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        debugLog(`GET ${url} → ${res.statusCode} (${Date.now() - startMs}ms)`);
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      let totalBytes = 0;
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
          resolve(JSON.parse(body) as T);
        } catch (err) {
          debugLog(`GET ${url} → JSON parse error: ${err}`);
          reject(err);
        }
      });
    });
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

// 获取精选技能列表（分页）
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
  const raw = await jsonGet<any>(`${base}/api/v1/skills?${params}`);
  const items = Array.isArray(raw.items) ? raw.items : Array.isArray(raw.skills) ? raw.skills : [];
  return {
    skills: items.map(mapItem),
    nextCursor: raw.nextCursor ?? null,
  };
}

// 搜索技能（不限 highlighted，搜全量）
async function searchSkills(opts: {
  q: string;
  limit?: number;
}): Promise<{ skills: SkillSummary[] }> {
  const base = registryUrl();
  const params = new URLSearchParams();
  params.set("q", opts.q);
  if (opts.limit) params.set("limit", String(opts.limit));
  const raw = await jsonGet<any>(`${base}/api/v1/search?${params}`);
  // 搜索接口返回 results 数组，兼容 items/skills 回退
  const items = Array.isArray(raw.results) ? raw.results : Array.isArray(raw.items) ? raw.items : [];
  return { skills: items.map(mapItem) };
}

// 获取技能详情
async function getSkillDetail(slug: string): Promise<SkillDetail> {
  const base = registryUrl();
  const raw = await jsonGet<any>(`${base}/api/v1/skills/${encodeURIComponent(slug)}`);
  return {
    ...mapItem(raw),
    readme: raw.readme ?? "",
    author: raw.author ?? raw.owner ?? "",
    tags: Array.isArray(raw.tagsList) ? raw.tagsList : [],
  };
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
function execClawhub(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const nodeBin = resolveNodeBin();
  const clawhubEntry = resolveClawhubEntry();
  const registry = registryUrl();
  const workdir = workspaceDir();

  // 构建完整参数：node clawhub-entry --workdir <workdir> --registry <registry> --no-input <args>
  const fullArgs = [clawhubEntry, "--workdir", workdir, "--registry", registry, "--no-input", ...args];
  debugLog(`exec: ${nodeBin} ${fullArgs.join(" ")}`);

  return new Promise((resolve, reject) => {
    // 组装 PATH，确保内嵌 node 和 clawhub wrapper 可找到
    const userBinDir = resolveUserBinDir();
    const envPath = userBinDir + path.delimiter + (process.env.PATH ?? "");

    execFile(nodeBin, fullArgs, {
      timeout: 60_000,
      env: {
        ...process.env,
        ...resolveNodeExtraEnv(),
        // 显式对齐 gateway spawn 的状态目录（R91 审查修复）：HOME 歧义时
        // clawhub 会解析到另一个 ~/.openclaw，安装/卸载落错目录
        OPENCLAW_STATE_DIR: resolveUserStateDir(),
        PATH: envPath,
      },
      windowsHide: true,
    }, (err, stdout, stderr) => {
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

// ── IPC 注册 ──

// 注册技能商店相关 IPC handler
export function registerSkillStoreIpc(): void {
  // 列表缓存（R91 性能审查）：list 是纯读 HTTP（sort+limit+cursor 键控），
  // 排序切换/重进商店 tab 不应重付网络往返；install/uninstall 主动失效
  const SKILL_LIST_CACHE_TTL_MS = 5 * 60_000;
  const skillListCache = new Map<string, { at: number; result: ListResult }>();

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
  });  ipcMain.handle("skill-store:install", async (_event, params) => {
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
    return { success: true, data: installed };
  });

  // R91：技能详情。getSkillDetail 早已存在但未暴露；slug 先走 validateSkillSlug
  // （防 flag 注入 / 路径穿越），失败直接拒绝而不是带进 URL。
  ipcMain.handle("skill-store:detail", async (event, params) => {
    if (!assertTrustedIpcSender(event, "skill-store:detail")) throw new Error("IPC sender not trusted");
    const slug = typeof params?.slug === "string" ? params.slug.trim() : "";
    const check = validateSkillSlug(slug);
    if (!check.ok) return { success: false, message: check.error };
    debugLog(`ipc detail slug=${slug}`);
    try {
      const detail = await getSkillDetail(slug);
      return { success: true, data: detail };
    } catch (err: any) {
      debugLog(`ipc detail → error: ${err?.message}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });
}
