/**
 * plugin-install-roots.ts — 枚举内核管理的插件安装根（R93）
 *
 * 内核（install-paths）扫描两类用户态安装根：
 *   1. `~/.openclaw/extensions/<id>/` —— 外部插件目录（extension-mirror reconcile
 *      的落点，也是 `plugins install` 早期版本的落点）
 *   2. `~/.openclaw/npm/projects/<proj>/node_modules/<pkg>/` —— ClawHub/npm 受管
 *      安装（`plugins install clawhub:<name>` 的落点），插件清单在包内
 *      `openclaw.plugin.json`，运行时 id 取其中的 `id` 字段（与包名可以不同，
 *      如 @wecom/wecom-openclaw-plugin → id "wecom-openclaw-plugin"）
 *
 * openclaw-config-migration 的 resolvable 判定此前只看 (1)，把 (2) 里已安装的
 * 插件（tavily 等）误判为"不可用"并禁用其 config 条目；extension-mirror 的
 * reconcile 也不感知 (2)，用户从市场安装的插件与镜像副本同 id 冲突（duplicate
 * plugin id 警告）。本模块给两处提供同一份 npm-project 运行时 id 集合。
 *
 * R93 审查修订：
 *   - 只读项目 package.json dependencies 声明的包 + 只认带 openclaw.plugin.json
 *     的包——node_modules 里的传递依赖（axios/debug/ms…）不是插件，basename
 *     兜底会把它们全污染进 id 集合（实测 wecom 项目一次混入 47 个假 id）。
 *   - 三态错误语义：目录不存在（ENOENT）= 合法的空集合；其他读失败（EBUSY/
 *     EPERM，杀软/索引器瞬时锁）= 硬失败，调用方（config-migration）必须放弃
 *     本轮的条目删除，绝不能把"读不到"当成"没安装"。
 */
import * as fs from "fs";
import * as path from "path";

export type NpmProjectPluginInfo = {
  /** 插件清单声明的 channels（channel plugin 非空；provider/工具插件为空） */
  channels: string[];
};

/** 三态扫描结果：ok=false 表示安装根读取硬失败（调用方不得据此删改配置） */
export type NpmProjectScan =
  | { ok: true; plugins: Map<string, NpmProjectPluginInfo> }
  | { ok: false };

// 读目录：ENOENT → null（合法不存在）；其他错误 → 抛出（由上层聚合为硬失败）
function readDirEntries(dir: string): fs.Dirent[] | null {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// 读 <pkg>/openclaw.plugin.json 的 { id, channels }。
// 三态语义（与文件头一致）：清单缺失（ENOENT）或 JSON 解析失败 → null（不是插件）；
// EPERM/EBUSY/EISDIR 等其他 I/O 错误原样抛出，由 scanNpmProjectPlugins 聚合成
// { ok:false } 硬失败——绝不能把「读不到」当成「没安装」（杀软瞬时锁场景）。
function readPluginManifest(pkgDir: string): { id: string; channels: string[] } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(pkgDir, "openclaw.plugin.json"), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; // 清单缺失 = 不是插件
    throw err;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return null; // 清单损坏 = 不是插件
  }
  const m = manifest as { id?: unknown; channels?: unknown };
  if (!m || typeof m !== "object" || typeof m.id !== "string" || !m.id.trim()) return null;
  const channels = Array.isArray(m.channels)
    ? m.channels.filter((c): c is string => typeof c === "string")
    : [];
  return { id: m.id.trim(), channels };
}

/**
 * 扫描 `~/.openclaw/npm/projects` 下受管安装的插件（运行时 id → 清单信息）。
 * 任何非 ENOENT 的读失败返回 { ok: false }。
 */
export function scanNpmProjectPlugins(stateDir: string): NpmProjectScan {
  const plugins = new Map<string, NpmProjectPluginInfo>();
  const projectsDir = path.join(stateDir, "npm", "projects");
  let projects: fs.Dirent[] | null;
  try {
    projects = readDirEntries(projectsDir);
  } catch {
    return { ok: false };
  }
  if (projects === null) return { ok: true, plugins };
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(projectsDir, project.name);
    // 项目 package.json 的 dependencies 是受管安装的根包集合（排除传递依赖）
    let depNames: string[];
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf-8")) as { dependencies?: Record<string, string> };
      depNames = pkg && typeof pkg === "object" && pkg.dependencies && typeof pkg.dependencies === "object"
        ? Object.keys(pkg.dependencies)
        : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // 半成品项目：跳过
      return { ok: false };
    }
    const nmDir = path.join(projectDir, "node_modules");
    for (const depName of depNames) {
      if (depName.startsWith(".")) continue;
      const pkgDir = depName.startsWith("@")
        ? path.join(nmDir, depName) // @scope/name 形态，目录本身就是两层
        : path.join(nmDir, depName);
      let manifest: { id: string; channels: string[] } | null = null;
      try {
        // 声明了未安装（ENOENT）在 readPluginManifest 内返回 null 走到下方 continue；
        // 此处只接 EPERM/EBUSY 等瞬时锁错误，聚合成硬失败
        manifest = readPluginManifest(pkgDir);
      } catch {
        return { ok: false };
      }
      if (!manifest) continue; // 无插件清单 = 普通依赖包（axios 等），不是插件
      plugins.set(manifest.id, { channels: manifest.channels });
    }
  }
  return { ok: true, plugins };
}

/**
 * 便捷封装：受管安装的插件运行时 id 集合（extension-mirror reconcile 用）。
 * 硬失败按空集合处理——mirror 的让位逻辑自愈（下轮启动重扫），空集合只是
 * 回到旧行为，不会造成不可逆变更。
 */
export function listNpmProjectPluginIds(stateDir: string): Set<string> {
  const scan = scanNpmProjectPlugins(stateDir);
  if (!scan.ok) return new Set();
  return new Set(scan.plugins.keys());
}
