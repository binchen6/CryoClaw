/**
 * 插件管理页（R8）纯函数：已安装插件/市场包的展示层映射与操作校验。
 * 数据源契约见主进程 src/plugin-store.ts 头注。
 */

export type InstalledPluginView = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  kind?: string;
  origin?: string;
  enabled: boolean;
  status?: string;
};

export type MarketPluginView = {
  name: string;
  displayName?: string;
  family?: string;
  channel?: string;
  isOfficial?: boolean;
  latestVersion?: string;
  summary?: string;
  ownerHandle?: string;
  downloads?: number;
  verificationTier?: string;
};

/** 与主进程一致的包名安全面（防参数注入/路径穿越） */
const PLUGIN_NAME_RE = /^[a-zA-Z0-9@][a-zA-Z0-9._@/-]{0,127}$/;

export function isValidPluginName(name: string): boolean {
  if (!name || name.startsWith("-") || name.includes("..")) return false;
  return PLUGIN_NAME_RE.test(name);
}

/** 已安装插件条目归一化（防御内核字段缺失/类型异常） */
export function mapInstalledPlugin(raw: unknown): InstalledPluginView | null {
  const p = raw as Record<string, unknown> | null | undefined;
  if (!p || typeof p !== "object") return null;
  const id = typeof p.id === "string" ? p.id.trim() : "";
  if (!id) return null;
  return {
    id,
    name: typeof p.name === "string" && p.name.trim() ? p.name : id,
    ...(typeof p.version === "string" && p.version.trim() ? { version: p.version } : {}),
    ...(typeof p.description === "string" && p.description.trim() ? { description: p.description } : {}),
    ...(typeof p.kind === "string" && p.kind.trim() ? { kind: p.kind } : {}),
    ...(typeof p.origin === "string" && p.origin.trim() ? { origin: p.origin } : {}),
    enabled: p.enabled === true,
    ...(typeof p.status === "string" && p.status.trim() ? { status: p.status } : {}),
  };
}

/** ClawHub 市场搜索结果条目归一化 */
export function mapMarketPlugin(raw: unknown): MarketPluginView | null {
  const p = raw as Record<string, unknown> | null | undefined;
  if (!p || typeof p !== "object") return null;
  const name = typeof p.name === "string" ? p.name.trim() : "";
  if (!name) return null;
  return {
    name,
    ...(typeof p.displayName === "string" && p.displayName.trim() ? { displayName: p.displayName } : {}),
    ...(typeof p.family === "string" && p.family.trim() ? { family: p.family } : {}),
    ...(typeof p.channel === "string" && p.channel.trim() ? { channel: p.channel } : {}),
    ...(p.isOfficial === true ? { isOfficial: true } : {}),
    ...(typeof p.latestVersion === "string" && p.latestVersion.trim() ? { latestVersion: p.latestVersion } : {}),
    ...(typeof p.summary === "string" && p.summary.trim() ? { summary: p.summary } : {}),
    ...(typeof p.ownerHandle === "string" && p.ownerHandle.trim() ? { ownerHandle: p.ownerHandle } : {}),
    ...(typeof p.downloads === "number" && Number.isFinite(p.downloads) ? { downloads: p.downloads } : {}),
    ...(typeof p.verificationTier === "string" && p.verificationTier.trim() ? { verificationTier: p.verificationTier } : {}),
  };
}

/** 市场结果按 下载量降序 / 官方优先 展示排序 */
export function sortMarketPlugins(items: MarketPluginView[]): MarketPluginView[] {
  return [...items].sort((a, b) => {
    if (a.isOfficial !== b.isOfficial) return a.isOfficial ? -1 : 1;
    return (b.downloads ?? 0) - (a.downloads ?? 0);
  });
}

/** 已安装插件按 官方渠道已知顺序分组：channel/kind 优先展示，其余按 id 排序 */
export function sortInstalledPlugins(items: InstalledPluginView[]): InstalledPluginView[] {
  return [...items].sort((a, b) => {
    const ka = a.kind ?? "";
    const kb = b.kind ?? "";
    if (ka !== kb) return ka.localeCompare(kb);
    return a.id.localeCompare(b.id);
  });
}
