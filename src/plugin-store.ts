/**
 * 插件管理页数据源（R8）：内核 CLI `openclaw plugins list/search/install/uninstall`。
 * R91 扩展：check-updates（dry-run）/ update / detail（inspect --json）/ market-browse
 * （ClawHub HTTP 分类浏览 + CLI 回退），以及配套的纯解析函数。
 *
 * 契约取证（openclaw 2026.7.1-2，只读）：
 *   - `plugins list --json` → { plugins: [{ id, name, version, description, format, kind,
 *     source, rootDir, origin, enabled, status }], registry: { source, diagnostics }, diagnostics }
 *   - `plugins search <query> --json --limit <n>` → { results: [{ score, package: {
 *     name, displayName, family, channel, isOfficial, latestVersion, summary, ownerHandle,
 *     stats, icon, verificationTier } }] }（ClawHub 插件市场）
 *   - `plugins install clawhub:<name> --acknowledge-clawhub-risk --force`（免交互安装/覆盖）
 *   - `plugins uninstall <id> --force`（免交互卸载）
 *   - `plugins update --dry-run --all`（R91）：stdout 为人类可读文本（无 --json，含 ANSI
 *     色码），关键行：`Would update <id>: <cur> -> <next>.` / `Would downgrade ...` /
 *     `<id> is up to date (<cur>).` / `No tracked plugins or hook packs to update.`；
 *     hook pack 行的 id 用引号包裹：`Would update hook pack "<id>": cur -> next.`
 *   - `plugins update [--all] <id> --acknowledge-install-policy-warning`（R91）：成功尾部
 *     打印 `Restart the gateway to load plugins and hooks.`；实际执行行是
 *     `Updated <id>: cur -> next.` / `Downgraded ...`。注意不传 --accept-capabilities
 *     ——能力扩大必须留给用户在 CLI 亲自决定，内核因此报错时把信息透传给用户。
 *   - `plugins inspect <id> --json`（R91）：单插件详情 JSON；stdout 可能混有非 JSON
 *     警告行，解析时取第一个 `{` 到最后一个 `}` 的子串。
 */
import { ipcMain } from "electron";
import { execFile } from "child_process";
import * as path from "path";
import * as log from "./logger";
import { assertTrustedIpcSender } from "./ipc-sender-guard";
import { resolveGatewayEntry, resolveNodeBin, resolveNodeExtraEnv, resolveUserBinDir, resolveUserStateDir } from "./constants";
import { jsonGet, readSkillStoreRegistry } from "./skill-store";

const EXEC_TIMEOUT_MS = 90_000;
const MAX_BUFFER = 8 * 1024 * 1024;
// 清单缓存（R17 立项，R91 性能审查放宽）：内核 CLI 全量加载约 15s，60s TTL
// 只覆盖快速来回切换；install/uninstall/update 均主动失效，TTL 提到 10 分钟
// 不影响正确性，重进扩展页不再重付冷启成本。
const LIST_CACHE_TTL_MS = 10 * 60_000;
let listCache: { at: number; plugins: InstalledPlugin[] } | null = null;

function invalidatePluginListCache() {
  listCache = null;
  // 市场浏览缓存同点失效：安装/卸载/更新会改变 installed 集合与推荐排除集
  marketBrowseCache = null;
}

// 市场浏览缓存（R91 性能审查）：单次浏览并发 14+ 路 HTTP（分类×关键词×family），
// 前端每次重进扩展页→市场 tab 都会重发全量请求；5 分钟 TTL + limit 键控，
// 安装/卸载/更新时经 invalidatePluginListCache 一并失效
const MARKET_BROWSE_CACHE_TTL_MS = 5 * 60_000;
let marketBrowseCache: { at: number; limit: number; items: MarketBrowseItem[] } | null = null;

export type InstalledPlugin = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  format?: string;
  kind?: string;
  source?: string;
  origin?: string;
  enabled: boolean;
  status?: string;
};

export type MarketPlugin = {
  name: string;
  displayName?: string;
  family?: string;
  channel?: string;
  isOfficial?: boolean;
  latestVersion?: string;
  summary?: string;
  ownerHandle?: string;
  downloads?: number;
  icon?: string;
  verificationTier?: string;
};

// 执行内核 CLI（ELECTRON_RUN_AS_NODE + openclaw.mjs），返回 stdout
function execKernelCli(args: string[]): Promise<string> {
  const nodeBin = resolveNodeBin();
  const entry = resolveGatewayEntry();
  const envPath = resolveUserBinDir() + path.delimiter + (process.env.PATH ?? "");
  return new Promise((resolve, reject) => {
    execFile(
      nodeBin,
      [entry, ...args],
      {
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        // OPENCLAW_STATE_DIR 显式对齐 gateway spawn（R91 审查修复）：Windows 上
        // HOME/USERPROFILE 可能指向不同路径（Git Bash 会设 POSIX 形态 HOME），
        // 缺省时内核 CLI 会解析到另一个 ~/.openclaw，插件操作落错状态目录
        env: { ...process.env, ...resolveNodeExtraEnv(), OPENCLAW_STATE_DIR: resolveUserStateDir(), PATH: envPath },
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(String(stderr ?? "").trim() || err.message));
          return;
        }
        resolve(String(stdout ?? ""));
      },
    );
  });
}

// 插件 id / 包名安全面：防参数注入（-- 开头）与路径穿越
const PLUGIN_NAME_RE = /^[a-zA-Z0-9@][a-zA-Z0-9._@/-]{0,127}$/;

export function isValidPluginName(name: string): boolean {
  if (!name || name.startsWith("-") || name.includes("..")) return false;
  return PLUGIN_NAME_RE.test(name);
}

// ── R91：update 输出解析（纯函数，供 node:test 直接覆盖） ──

/** dry-run / 实际更新中单个有条目的插件（或 hook pack） */
export type PluginUpdateEntry = {
  id: string;
  currentVersion: string;
  nextVersion: string;
  action: "update" | "downgrade";
};

/** parseUpdateOutcomes 的完整结果：check-updates 与 update 两个 handler 共用 */
export type ParsedPluginUpdateOutput = {
  /** dry-run 报告有新版本的条目（Would update/Would downgrade） */
  updatable: PluginUpdateEntry[];
  /** 实际执行完成的条目（Updated/Downgraded，仅非 dry-run 出现） */
  applied: PluginUpdateEntry[];
  /** 实际执行的原始行文本（已去 ANSI），供 update handler 拼给用户的 message */
  appliedLines: string[];
  /** `xxx is up to date (yyy).` 命中的条目 id（用于区分"检查成功但无更新"与"输出不可解析"） */
  upToDateIds: string[];
  /** 出现 `No tracked plugins or hook packs to update.`（空结果，非错误） */
  sawNoTracked: boolean;
  /** 出现 `Restart the gateway`（内核提示需重启网关才能加载新插件） */
  sawRestartHint: boolean;
};

// 剥离内核 CLI stdout 里的 ANSI 转义序列（颜色码等）。CLI 无 --json 的人类可读
// 输出默认带色码，不剥掉会卡在结果行中间导致正则全部失配。
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
export function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_RE, "");
}

// 结果行三种形态。id 侧兼容 hook pack 的引号形态（`hook pack "id"`）；版本允许
// 任意非空白（semver / 预发布 / commit hash），行尾句号在捕获后单独剥除。
const WOULD_LINE_RE = /^Would (update|downgrade) (?:hook pack )?"?([^"\s:]+)"?: (\S+) -> (\S+)$/;
const APPLIED_LINE_RE = /^(Updated|Downgraded) (?:hook pack )?"?([^"\s:]+)"?: (\S+) -> (\S+)$/;
const UP_TO_DATE_LINE_RE = /^(?:hook pack )?"?([^"\s:]+)"? is up to date \(([^)]*)\)\.?$/;
const NO_TRACKED_MARK = "No tracked plugins or hook packs";
const RESTART_HINT_MARK = "Restart the gateway";

// 去掉行尾句号（版本号本身不含空白，捕获组会把 `.` 一起吃进来）
function trimTrailingDot(v: string): string {
  return v.endsWith(".") ? v.slice(0, -1) : v;
}

/**
 * 解析 `plugins update [--dry-run] [--all]` 的 stdout（纯函数，内部先剥 ANSI）。
 * check-updates 只关心 updatable；update 只关心 applied/appliedLines/sawRestartHint；
 * upToDateIds + sawNoTracked 用于区分「检查成功但无更新」与「输出完全不可识别」。
 */
export function parseUpdateOutcomes(rawStdout: string): ParsedPluginUpdateOutput {
  const clean = stripAnsiCodes(String(rawStdout ?? ""));
  const result: ParsedPluginUpdateOutput = {
    updatable: [],
    applied: [],
    appliedLines: [],
    upToDateIds: [],
    sawNoTracked: clean.includes(NO_TRACKED_MARK),
    sawRestartHint: clean.includes(RESTART_HINT_MARK),
  };
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let m = WOULD_LINE_RE.exec(line);
    if (m) {
      result.updatable.push({ id: m[2], currentVersion: m[3], nextVersion: trimTrailingDot(m[4]), action: m[1] as "update" | "downgrade" });
      continue;
    }
    m = APPLIED_LINE_RE.exec(line);
    if (m) {
      // `Updated`/`Downgraded` 归一到与 dry-run 相同的 action 词形（update/downgrade），
      // 两个 handler 消费同一形状，前端也无需区分两种枚举
      const action: "update" | "downgrade" = m[1].toLowerCase() === "updated" ? "update" : "downgrade";
      result.applied.push({ id: m[2], currentVersion: m[3], nextVersion: trimTrailingDot(m[4]), action });
      result.appliedLines.push(line);
      continue;
    }
    m = UP_TO_DATE_LINE_RE.exec(line);
    if (m) result.upToDateIds.push(m[1]);
  }
  return result;
}

/**
 * 从可能混有警告行 / ANSI 色码的 stdout 中提取 JSON 载荷（纯函数）：
 * 取第一个 `{` 到最后一个 `}` 的子串再 JSON.parse。`plugins inspect --json`
 * 会在 JSON 前打印非 JSON 警告，直接 JSON.parse 整段会失败。
 * 找不到 JSON 边界或解析失败时抛错（由 handler catch 转成 success:false）。
 */
export function extractJsonPayload(text: string): unknown {
  const clean = stripAnsiCodes(String(text ?? ""));
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("输出中未找到 JSON 载荷");
  }
  try {
    return JSON.parse(clean.slice(start, end + 1));
  } catch (err) {
    throw new Error(`JSON 载荷解析失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── R91：市场分类浏览（ClawHub HTTP API + CLI 回退） ──

/**
 * 分类 → 代表关键词映射。ClawHub 包接口没有分类字段，浏览页只能靠关键词搜索
 * 聚合出分类视图；导出为常量供测试钉住契约（分类集合与每类关键词数）。
 */
export const PLUGIN_MARKET_CATEGORY_KEYWORDS: Record<string, string[]> = {
  channel: ["channel", "connector"],
  provider: ["provider", "model"],
  tool: ["tool", "automation"],
  memory: ["memory", "knowledge"],
  search: ["search", "web"],
  voice: ["voice", "speech"],
  security: ["security", "auth"],
};

/** 带打分与更新时间的市场条目（ClawHub 搜索响应的 entry.score / package.updatedAt） */
export type ScoredMarketPlugin = MarketPlugin & {
  score?: number;
  updatedAt?: string;
};

/** market-browse 的单条结果：市场条目 + 命中的分类列表 */
export type MarketBrowseItem = ScoredMarketPlugin & { categories: string[] };

/**
 * 合并多路（多关键词 × 多 family）搜索结果为一份去重列表（纯函数）：
 * - 按 name 去重，同名保留 score 更高者的字段（不同查询词命中同一包分数不同）；
 * - categories 取该条目命中的全部分类（按首次出现顺序，同类去重）；
 * - 按 score 降序、name 升序排序，保证输出稳定可测。
 */
export function mergeMarketResults(
  groups: Array<{ category: string; items: ScoredMarketPlugin[] }>,
): MarketBrowseItem[] {
  const byName = new Map<string, MarketBrowseItem>();
  for (const group of groups) {
    for (const item of group.items) {
      if (!item.name) continue;
      const existing = byName.get(item.name);
      if (!existing) {
        byName.set(item.name, { ...item, categories: [group.category] });
        continue;
      }
      if (!existing.categories.includes(group.category)) {
        existing.categories.push(group.category);
      }
      // 后到的同名条目分数更高时覆盖字段（categories 已并入，不丢）
      const incomingScore = item.score ?? Number.NEGATIVE_INFINITY;
      const existingScore = existing.score ?? Number.NEGATIVE_INFINITY;
      if (incomingScore > existingScore) {
        byName.set(item.name, { ...item, categories: existing.categories });
      }
    }
  }
  return Array.from(byName.values()).sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0) || a.name.localeCompare(b.name),
  );
}

// ClawHub 搜索响应条目（CLI 与 HTTP API 同构：{ score, package }）→ 内部条目。
// score 必须保留：market-browse 去重时「保留 score 更高者」依赖它。
function mapClawhubEntry(entry: Record<string, unknown>): ScoredMarketPlugin | null {
  const raw = entry.package as Record<string, unknown> | undefined;
  if (!raw || typeof raw.name !== "string" || !raw.name) return null;
  return {
    name: raw.name,
    ...(typeof raw.displayName === "string" ? { displayName: raw.displayName } : {}),
    ...(typeof raw.family === "string" ? { family: raw.family } : {}),
    ...(typeof raw.channel === "string" ? { channel: raw.channel } : {}),
    ...(raw.isOfficial === true ? { isOfficial: true } : {}),
    ...(typeof raw.latestVersion === "string" ? { latestVersion: raw.latestVersion } : {}),
    ...(typeof raw.summary === "string" ? { summary: raw.summary } : {}),
    ...(typeof raw.ownerHandle === "string" ? { ownerHandle: raw.ownerHandle } : {}),
    ...(typeof raw.stats === "object" && raw.stats !== null && typeof (raw.stats as Record<string, unknown>).downloads === "number"
      ? { downloads: (raw.stats as Record<string, unknown>).downloads as number }
      : {}),
    ...(typeof raw.icon === "string" ? { icon: raw.icon } : {}),
    ...(typeof raw.verificationTier === "string" ? { verificationTier: raw.verificationTier } : {}),
    ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
    ...(typeof entry.score === "number" ? { score: entry.score } : {}),
  };
}

// 搜索响应（{ results: [...] }）→ 条目数组；results 缺失/非数组按空处理
function mapSearchResponse(parsed: unknown): ScoredMarketPlugin[] {
  const results = (parsed as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  return results
    .map((entry) => mapClawhubEntry(entry as Record<string, unknown>))
    .filter((p): p is ScoredMarketPlugin => p !== null);
}

// ClawHub 公开 API 基址：与技能商店共用同一个 registry 设置（用户可配本地镜像，
// 同一 ClawHub 后端），未配置回退官方域名。
const DEFAULT_CLAWHUB_API_BASE = "https://clawhub.ai";
function marketApiBase(): string {
  const custom = readSkillStoreRegistry().trim();
  if (custom) {
    // 读侧 scheme 复核（R91 三审）：写入咽喉点（writeSkillStoreRegistry）已限
    // https/回环 http，但用户手改 sidecar 文件可绕过——registry 是市场清单的
    // 下载源（内容会引导 agent 行为），非回环 http 在读侧同样拒绝并回退官方源
    try {
      const parsed = new URL(custom);
      const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
      if (parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopback)) {
        return custom.replace(/\/+$/, "");
      }
    } catch { /* 非法 URL 同样回退默认源 */ }
  }
  return DEFAULT_CLAWHUB_API_BASE;
}

// market-browse 的 limit 边界：默认 20、上限 30（与 ClawHub 分页上限对齐，
// 14 组关键词 × 2 family 并发下放大 limit 会把请求量与内存放大到不可接受）
const MARKET_BROWSE_DEFAULT_LIMIT = 20;
const MARKET_BROWSE_MAX_LIMIT = 30;
// HTTP 全灭时 CLI 回退的关键词数：内核 CLI 单次加载约 15s，串行 3 个已是
// 浏览页可容忍的延迟上限，再多不如直接报错让用户重试
const MARKET_FALLBACK_KEYWORDS = 3;

// 按分类聚合市场条目：对每个分类的每个关键词 × 每个 family（code-plugin /
// bundle-plugin）发一次 HTTP 搜索。任一请求失败只丢弃自身（浏览页宁可少一类
// 也不能整页报错）；全部失败由调用方回退 CLI。
async function fetchMarketGroups(limit: number): Promise<Array<{ category: string; items: ScoredMarketPlugin[] }>> {
  const families = ["code-plugin", "bundle-plugin"];
  const requests: Array<{ category: string; keyword: string; family: string }> = [];
  for (const [category, keywords] of Object.entries(PLUGIN_MARKET_CATEGORY_KEYWORDS)) {
    for (const keyword of keywords) {
      for (const family of families) {
        requests.push({ category, keyword, family });
      }
    }
  }
  const settled = await Promise.allSettled(
    requests.map(async (req) => {
      const url =
        `${marketApiBase()}/api/v1/packages/search?q=${encodeURIComponent(req.keyword)}` +
        `&family=${req.family}&limit=${limit}`;
      return { category: req.category, items: mapSearchResponse(await jsonGet<unknown>(url)) };
    }),
  );
  const groups: Array<{ category: string; items: ScoredMarketPlugin[] }> = [];
  let anyFailure: unknown = null;
  for (const r of settled) {
    if (r.status === "fulfilled") groups.push(r.value);
    else anyFailure = r.reason;
  }
  if (groups.length === 0 && anyFailure) {
    // 单个失败不抛（调用方无法区分部分失败）；全灭时抛出最后一个错误供日志定位
    throw anyFailure instanceof Error ? anyFailure : new Error(String(anyFailure));
  }
  return groups;
}

// market-browse 主体：HTTP 聚合；HTTP 全灭时回退内核 CLI 搜索前 3 个关键词
// （CLI 搜索不带 family 维度，结果同样映射进分类聚合）。
// HTTP 段加总截止（R91 实测）：断网时 28 路请求各自 15s 超时 + CLI 回退挂到
// 90s 会把浏览页 spinner 拖到 80s+——竞速截止让 UI 尽快进入可重试的失败态
const MARKET_BROWSE_HTTP_DEADLINE_MS = 30_000;

async function browsePluginMarket(limit: number): Promise<MarketBrowseItem[]> {
  let groups: Array<{ category: string; items: ScoredMarketPlugin[] }>;
  try {
    groups = await Promise.race([
      fetchMarketGroups(limit),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("market browse http deadline exceeded")), MARKET_BROWSE_HTTP_DEADLINE_MS)),
    ]);
  } catch (err) {
    log.info(`[plugin-store] market-browse http failed, falling back to cli: ${err instanceof Error ? err.message : String(err)}`);
    const keywordList: Array<{ category: string; keyword: string }> = [];
    for (const [category, keywords] of Object.entries(PLUGIN_MARKET_CATEGORY_KEYWORDS)) {
      for (const keyword of keywords) keywordList.push({ category, keyword });
    }
    const settled = await Promise.allSettled(
      keywordList.slice(0, MARKET_FALLBACK_KEYWORDS).map(async ({ category, keyword }) => ({
        category,
        items: mapSearchResponse(JSON.parse(await execKernelCli(["plugins", "search", keyword, "--json", "--limit", String(limit)]))),
      })),
    );
    groups = settled.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ category: string; items: ScoredMarketPlugin[] }>).value);
    if (groups.length === 0) {
      throw new Error("plugin market browse failed (http and cli fallback)");
    }
  }
  return mergeMarketResults(groups);
}

async function listInstalledPlugins(): Promise<InstalledPlugin[]> {
  if (listCache && Date.now() - listCache.at < LIST_CACHE_TTL_MS) {
    return listCache.plugins;
  }
  const out = await execKernelCli(["plugins", "list", "--json"]);
  const parsed = JSON.parse(out) as { plugins?: unknown };
  if (!Array.isArray(parsed.plugins)) return [];
  const plugins = parsed.plugins.map((raw) => {
    const p = raw as Record<string, unknown>;
    return {
      id: typeof p.id === "string" ? p.id : "",
      name: typeof p.name === "string" ? p.name : (typeof p.id === "string" ? p.id : ""),
      ...(typeof p.version === "string" ? { version: p.version } : {}),
      ...(typeof p.description === "string" ? { description: p.description } : {}),
      ...(typeof p.format === "string" ? { format: p.format } : {}),
      ...(typeof p.kind === "string" ? { kind: p.kind } : {}),
      ...(typeof p.source === "string" ? { source: p.source } : {}),
      ...(typeof p.origin === "string" ? { origin: p.origin } : {}),
      enabled: p.enabled === true,
      ...(typeof p.status === "string" ? { status: p.status } : {}),
    };
  }).filter((p) => p.id);
  listCache = { at: Date.now(), plugins };
  return plugins;
}

async function searchMarketPlugins(query: string, limit: number): Promise<ScoredMarketPlugin[]> {
  const out = await execKernelCli(["plugins", "search", query, "--json", "--limit", String(limit)]);
  // R91：改走 mapSearchResponse（保留 score/updatedAt），与 market-browse 的
  // HTTP 路径共用一份字段映射，避免两处实现对 ClawHub 字段集各自漂移
  return mapSearchResponse(JSON.parse(out));
}

// 注册插件管理页 IPC handler
export function registerPluginStoreIpc(): void {
  ipcMain.handle("plugin-store:list", async (event) => {
    if (!assertTrustedIpcSender(event, "plugin-store:list")) throw new Error("IPC sender not trusted");
    try {
      const plugins = await listInstalledPlugins();
      return { success: true, data: plugins };
    } catch (err: any) {
      log.info(`[plugin-store] list failed: ${err?.message ?? err}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });

  ipcMain.handle("plugin-store:search", async (event, params) => {
    if (!assertTrustedIpcSender(event, "plugin-store:search")) throw new Error("IPC sender not trusted");
    const query = typeof params?.q === "string" ? params.q.trim() : "";
    // 与 install/uninstall 的 isValidPluginName 同源防护：`-` 开头的 query 会被
    // CLI 解析为 flag（execFile 无 shell，无命令注入，但行为可被携改）
    if (!query || query.startsWith("-") || query.includes("..")) {
      return { success: false, message: "invalid query" };
    }
    const limit = typeof params?.limit === "number" && params.limit > 0 ? Math.min(params.limit, 20) : 20;
    try {
      const results = await searchMarketPlugins(query, limit);
      return { success: true, data: results };
    } catch (err: any) {
      log.info(`[plugin-store] search failed: ${err?.message ?? err}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });

  ipcMain.handle("plugin-store:install", async (event, params) => {
    if (!assertTrustedIpcSender(event, "plugin-store:install")) throw new Error("IPC sender not trusted");
    const name = typeof params?.name === "string" ? params.name.trim() : "";
    if (!isValidPluginName(name)) return { success: false, message: "invalid plugin name" };
    try {
      const stdout = await execKernelCli(["plugins", "install", `clawhub:${name}`, "--acknowledge-clawhub-risk", "--force"]);
      invalidatePluginListCache();
      // R17：安装可能覆盖运行时 id 相同的既有插件（manifest id 与包名不同时静默覆盖）——
      // 从 stdout 探测并透出警告，避免“安装成功但官方插件被顶替”静默发生。
      let warning: string | undefined;
      if (stdout.includes("differs from npm package name") || stdout.includes("Removed previous plugin install")) {
        warning = "Plugin runtime id collided with an already-installed plugin; the previous install was replaced.";
      }
      return { success: true, ...(warning ? { warning } : {}) };
    } catch (err: any) {
      log.info(`[plugin-store] install ${name} failed: ${err?.message ?? err}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });

  ipcMain.handle("plugin-store:uninstall", async (event, params) => {
    if (!assertTrustedIpcSender(event, "plugin-store:uninstall")) throw new Error("IPC sender not trusted");
    const id = typeof params?.id === "string" ? params.id.trim() : "";
    if (!isValidPluginName(id)) return { success: false, message: "invalid plugin id" };
    try {
      await execKernelCli(["plugins", "uninstall", id, "--force"]);
      invalidatePluginListCache();
      return { success: true };
    } catch (err: any) {
      log.info(`[plugin-store] uninstall ${id} failed: ${err?.message ?? err}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });

  // R91：检查插件更新（dry-run，不落盘）。stdout 为人类可读文本，靠
  // parseUpdateOutcomes 解析；无可识别行且非 "No tracked" 视为解析失败而不是
  // 空结果（否则内核报错会被静默当成"全部最新"误导用户）。
  ipcMain.handle("plugin-store:check-updates", async (event) => {
    if (!assertTrustedIpcSender(event, "plugin-store:check-updates")) throw new Error("IPC sender not trusted");
    try {
      const stdout = await execKernelCli(["plugins", "update", "--dry-run", "--all"]);
      const parsed = parseUpdateOutcomes(stdout);
      if (!parsed.sawNoTracked && parsed.updatable.length === 0 && parsed.upToDateIds.length === 0) {
        const snippet = stripAnsiCodes(stdout).trim().slice(0, 200);
        return { success: false, message: `无法解析 plugins update --dry-run 输出：${snippet || "(empty)"}` };
      }
      // 只返回有更新的条目；"No tracked" / 全部 up to date 都落成空数组
      return { success: true, data: { updatable: parsed.updatable, checkedAt: Date.now() } };
    } catch (err: any) {
      log.info(`[plugin-store] check-updates failed: ${err?.message ?? err}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });

  // R91：执行更新。id 省略/为空 → --all；否则单插件更新。成功后失效 listCache
  // （与 install/uninstall 同步：list 页的版本号来自缓存）。不传
  // --accept-capabilities：能力扩大留给用户在 CLI 决定，内核报错时信息透传。
  ipcMain.handle("plugin-store:update", async (event, params) => {
    if (!assertTrustedIpcSender(event, "plugin-store:update")) throw new Error("IPC sender not trusted");
    const id = typeof params?.id === "string" ? params.id.trim() : "";
    if (id && !isValidPluginName(id)) return { success: false, message: "invalid plugin id" };
    const args = id
      ? ["plugins", "update", id, "--acknowledge-install-policy-warning"]
      : ["plugins", "update", "--all", "--acknowledge-install-policy-warning"];
    try {
      const stdout = await execKernelCli(args);
      invalidatePluginListCache();
      const parsed = parseUpdateOutcomes(stdout);
      return {
        success: true,
        data: {
          needsRestart: parsed.sawRestartHint,
          message: parsed.appliedLines.join("；"),
        },
      };
    } catch (err: any) {
      log.info(`[plugin-store] update ${id || "--all"} failed: ${err?.message ?? err}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });

  // R91：插件详情（inspect --json）。stdout 可能混有非 JSON 警告行，extractJsonPayload
  // 负责取 {..} 子串；解析失败按普通错误透传。
  ipcMain.handle("plugin-store:detail", async (event, params) => {
    if (!assertTrustedIpcSender(event, "plugin-store:detail")) throw new Error("IPC sender not trusted");
    const id = typeof params?.id === "string" ? params.id.trim() : "";
    if (!isValidPluginName(id)) return { success: false, message: "invalid plugin id" };
    try {
      const stdout = await execKernelCli(["plugins", "inspect", id, "--json"]);
      return { success: true, data: extractJsonPayload(stdout) };
    } catch (err: any) {
      log.info(`[plugin-store] detail ${id} failed: ${err?.message ?? err}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });

  // R91：市场分类浏览。多关键词 × 多 family 并发 HTTP 聚合（单请求失败跳过），
  // HTTP 全灭时回退内核 CLI 搜前 3 个关键词；仍全灭才报错。
  ipcMain.handle("plugin-store:market-browse", async (event, params) => {
    if (!assertTrustedIpcSender(event, "plugin-store:market-browse")) throw new Error("IPC sender not trusted");
    const limit = typeof params?.limit === "number" && params.limit > 0
      ? Math.min(Math.floor(params.limit), MARKET_BROWSE_MAX_LIMIT)
      : MARKET_BROWSE_DEFAULT_LIMIT;
    if (marketBrowseCache && marketBrowseCache.limit === limit
        && Date.now() - marketBrowseCache.at < MARKET_BROWSE_CACHE_TTL_MS) {
      return { success: true, data: { items: marketBrowseCache.items, fetchedAt: marketBrowseCache.at } };
    }
    try {
      const items = await browsePluginMarket(limit);
      marketBrowseCache = { at: Date.now(), limit, items };
      return { success: true, data: { items, fetchedAt: Date.now() } };
    } catch (err: any) {
      log.info(`[plugin-store] market-browse failed: ${err?.message ?? err}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });

  // 市场包详情（R92）：ClawHub /api/v1/packages/<name> → { package, owner } 信封。
  // 包名含 @scope（如 @openclaw/brave-plugin），必须整体 encodeURIComponent。
  ipcMain.handle("plugin-store:market-detail", async (event, params) => {
    if (!assertTrustedIpcSender(event, "plugin-store:market-detail")) throw new Error("IPC sender not trusted");
    const name = typeof params?.name === "string" ? params.name.trim() : "";
    if (!isValidPluginName(name)) return { success: false, message: "invalid package name" };
    try {
      const raw = await jsonGet<unknown>(`${marketApiBase()}/api/v1/packages/${encodeURIComponent(name)}`);
      // 信封 { package, owner } 宽松校验：package 缺失视为未找到
      const env = raw as { package?: unknown; owner?: unknown };
      if (!env || typeof env !== "object" || !env.package || typeof env.package !== "object") {
        return { success: false, message: "package not found" };
      }
      return { success: true, data: env };
    } catch (err: any) {
      log.info(`[plugin-store] market-detail ${name} failed: ${err?.message ?? err}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });
}
