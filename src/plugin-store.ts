/**
 * 插件管理页数据源（R8）：内核 CLI `openclaw plugins list/search/install/uninstall`。
 *
 * 契约取证（openclaw 2026.7.1-2，只读）：
 *   - `plugins list --json` → { plugins: [{ id, name, version, description, format, kind,
 *     source, rootDir, origin, enabled, status }], registry: { source, diagnostics }, diagnostics }
 *   - `plugins search <query> --json --limit <n>` → { results: [{ score, package: {
 *     name, displayName, family, channel, isOfficial, latestVersion, summary, ownerHandle,
 *     stats, icon, verificationTier } }] }（ClawHub 插件市场）
 *   - `plugins install clawhub:<name> --acknowledge-clawhub-risk --force`（免交互安装/覆盖）
 *   - `plugins uninstall <id> --force`（免交互卸载）
 */
import { ipcMain } from "electron";
import { execFile } from "child_process";
import * as path from "path";
import * as log from "./logger";
import { assertTrustedIpcSender } from "./ipc-sender-guard";
import { resolveGatewayEntry, resolveNodeBin, resolveNodeExtraEnv, resolveUserBinDir } from "./constants";

const EXEC_TIMEOUT_MS = 90_000;
const MAX_BUFFER = 8 * 1024 * 1024;
// 清单缓存（R17 性能）：内核 CLI 全量加载约 15s，缓存 60s 避免重复进入设置页重付；
// install/uninstall 后主动失效。
const LIST_CACHE_TTL_MS = 60_000;
let listCache: { at: number; plugins: InstalledPlugin[] } | null = null;

function invalidatePluginListCache() {
  listCache = null;
}

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
        env: { ...process.env, ...resolveNodeExtraEnv(), PATH: envPath },
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

async function searchMarketPlugins(query: string, limit: number): Promise<MarketPlugin[]> {
  const out = await execKernelCli(["plugins", "search", query, "--json", "--limit", String(limit)]);
  const parsed = JSON.parse(out) as { results?: unknown };
  if (!Array.isArray(parsed.results)) return [];
  return parsed.results.map((entry) => {
    const raw = (entry as Record<string, unknown>).package as Record<string, unknown> | undefined;
    if (!raw) return null;
    return {
      name: typeof raw.name === "string" ? raw.name : "",
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
    };
  }).filter((p): p is MarketPlugin => Boolean(p && p.name));
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
}
