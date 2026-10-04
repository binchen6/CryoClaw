/**
 * plugin-presence.ts — 插件存在性四根统一判定（T5）
 *
 * 背景：isWecomPluginBundled 此前只查 ~/.openclaw/extensions/<id>/ 单根，而 R93
 * 「用户自装优先」分支（extension-mirror.reconcileOne）会在插件已存在于
 * ~/.openclaw/npm/projects/ 时跳过/删除镜像副本——插件实际可被内核加载，设置页
 * 却整会话误报「插件组件缺失」。本模块对齐 openclaw-config-migration 的四根
 * resolvable 判定，按顺序检查：
 *   1. bundled gateway extensions 目录（resolveGatewayPackageDir()/dist/extensions/<id>）
 *   2. 安装包内置 mirror（resolveExtensionsMirrorDir()/<id>）
 *   3. 用户 external plugin 目录（resolveUserExtensionsDir()/<id>）
 *   4. npm/projects 受管安装扫描（plugin-install-roots.scanNpmProjectPlugins，
 *      按插件清单声明的运行时 id 命中，与目录名/包名可以不同）
 * 任一根命中即视为存在。
 *
 * 纯 fs 判定，本文件不 import electron；constants 链的根解析器惰性调用且逐根
 * try/catch 吞错——非 Electron 环境（node:test）下 gateway/mirror 根解析失败
 * 自动按「该根缺席」跳过，state/npm 两根照常可测。
 *
 * 误报面：presence=true 只会抑制 UI banner（fail-open 仅限 UI），插件真实加载
 * 仍以内核扫描为准；单根读取异常按缺席处理，继续查后续根。
 */
import * as fs from "fs";
import * as path from "path";
import {
  resolveExtensionsMirrorDir,
  resolveGatewayPackageDir,
  resolveUserExtensionsDir,
  resolveUserStateDir,
} from "./constants";
import { scanNpmProjectPlugins } from "./plugin-install-roots";

/** 目录探针：判定单个候选插件目录（<root>/<id> 绝对路径）是否构成可用插件 */
export type PluginDirProbe = (dir: string) => boolean;

// 默认探针认可的入口文件候选（mirror 插件形态：源码 index.ts 或构建产物 dist/index.*）
const DEFAULT_ENTRY_FILES: readonly string[] = [
  "index.ts",
  path.join("dist", "index.js"),
  path.join("dist", "index.cjs.js"),
  path.join("dist", "index.esm.js"),
];

/** 默认探针：清单（openclaw.plugin.json）存在，且至少一个入口文件存在 */
export function defaultPluginDirProbe(dir: string): boolean {
  if (!fs.existsSync(path.join(dir, "openclaw.plugin.json"))) return false;
  return DEFAULT_ENTRY_FILES.some((entry) => fs.existsSync(path.join(dir, entry)));
}

/**
 * 清单探针：只要求 openclaw.plugin.json 存在。
 * 内核 vendored 官方扩展（feishu/qqbot 等，runtimeExtensions 编译入口）的入口
 * 布局与 mirror 插件不同，不能按默认入口候选判定。
 */
export function manifestOnlyPluginDirProbe(dir: string): boolean {
  return fs.existsSync(path.join(dir, "openclaw.plugin.json"));
}

// 前三个目录根的解析：单个根解析失败（非 Electron 环境 app 未定义、资源目录
// 不可用等）按「该根缺席」跳过，不影响其余根的判定顺序。
function resolvePluginRootDirs(pluginId: string): string[] {
  const resolvers: Array<() => string> = [
    () => path.join(resolveGatewayPackageDir(), "dist", "extensions", pluginId),
    () => path.join(resolveExtensionsMirrorDir(), pluginId),
    () => path.join(resolveUserExtensionsDir(), pluginId),
  ];
  const dirs: string[] = [];
  for (const resolve of resolvers) {
    try {
      dirs.push(resolve());
    } catch {
      // 该根在当前环境不可解析 → 跳过
    }
  }
  return dirs;
}

// 第四根：npm/projects 受管安装。命中语义是清单声明的运行时 id（见
// plugin-install-roots 头注释），不走目录探针；扫描硬失败（EPERM/EBUSY 瞬时锁）
// 按缺席处理——只影响 UI banner，下轮查询会重扫。
function isPresentInNpmProjects(pluginId: string): boolean {
  try {
    const scan = scanNpmProjectPlugins(resolveUserStateDir());
    return scan.ok && scan.plugins.has(pluginId);
  } catch {
    return false;
  }
}

/**
 * 插件在任一安装根存在即返回 true。
 * 目录根按 bundled gateway → mirror → state extensions 顺序用 probe 判定并
 * 短路；全部缺席时再查 npm/projects 受管安装根。
 */
export function isPluginPresentAnywhere(
  pluginId: string,
  probe: PluginDirProbe = defaultPluginDirProbe,
): boolean {
  for (const dir of resolvePluginRootDirs(pluginId)) {
    try {
      if (probe(dir)) return true;
    } catch {
      // 探针异常（瞬时锁等）按该根缺席处理，继续查后续根
    }
  }
  return isPresentInNpmProjects(pluginId);
}
