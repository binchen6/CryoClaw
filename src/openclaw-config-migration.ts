/**
 * openclaw-config-migration.ts — 内核升级后的用户配置适配迁移
 *
 * 由 main.ts 启动时与 kernel-updater.ts 换装成功后各调用一次。
 * 迁移带版本门控：仅当当前内核版本达到规则要求时才执行删除/挪位，
 * 读不到版本时保守跳过，避免误删旧内核仍在使用的配置节点。
 * 2026.8 的挪位类迁移（planTool、memorySearch）是双向的：
 * 内核回退到 <2026.8 时按反向规则搬回旧位置，保证回退后配置仍合法。
 */

import * as fs from "fs";
import * as path from "path";
import { resolveGatewayPackageDir, resolveUserStateDir } from "./constants";
import { readUserConfig, writeUserConfig } from "./provider-config";
import * as log from "./logger";

// 规则列表，后续按需追加。
// 规则：删除 agents.defaults.llm —— openclaw 2026.7 起该节点被移除，
// 旧配置残留会让内核校验报错、gateway 无法启动。
// 规则：删除 meta.lastTouchedAt —— openclaw 2026.8 起退役（只保留
// meta.lastTouchedVersion），旧内核写出的残留会触发 strict 校验失败。
const OPENCLAW_CONFIG_MIGRATIONS: ReadonlyArray<{
  path: readonly string[];
  note: string;
  /** 触发迁移的最低内核版本（YYYY.M 数值比较） */
  since: { year: number; month: number };
}> = [
  { path: ["agents", "defaults", "llm"], note: "agents.defaults.llm（2026.7 起废弃）", since: { year: 2026, month: 7 } },
  { path: ["meta", "lastTouchedAt"], note: "meta.lastTouchedAt（2026.8 起移除）", since: { year: 2026, month: 8 } },
];

// 读取当前内核版本并解析出 YYYY.M（兼容 2026.7.1-2 这类后缀）。
// 读不到（版本文件缺失/格式异常）返回 null，调用方保守跳过迁移。
// 导出给 kimi-config 等写入方做版本相关的配置落位判断。
export function readKernelVersionParts(): { year: number; month: number } | null {
  try {
    const pkgPath = path.join(resolveGatewayPackageDir(), "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const match = /^(\d+)\.(\d+)(?:[.-]|$)/.exec(String(pkg?.version ?? ""));
    if (!match) return null;
    return { year: Number(match[1]), month: Number(match[2]) };
  } catch {
    return null;
  }
}

function versionAtLeast(version: { year: number; month: number }, since: { year: number; month: number }): boolean {
  return version.year > since.year || (version.year === since.year && version.month >= since.month);
}

// deepseek 旧模型别名 → 新名（官方 2026-07-24 弃用 deepseek-chat / deepseek-reasoner）。
// 旧名仍被 models.providers 或 agents.defaults.model 引用时，内核可能拒绝未知模型。
const DEEPSEEK_MODEL_ALIASES: Record<string, string> = {
  "deepseek-chat": "deepseek-v4-flash",
  "deepseek-reasoner": "deepseek-v4-pro",
};

/** 替换 deepseek 旧模型别名；返回是否发生任何修改。 */
function migrateDeepseekModelAliases(config: any): boolean {
  let changed = false;
  const providers = config?.models?.providers;
  if (providers && typeof providers === "object") {
    for (const prov of Object.values(providers) as any[]) {
      if (!prov || !Array.isArray(prov.models)) continue;
      for (const m of prov.models) {
        if (m && typeof m.id === "string" && DEEPSEEK_MODEL_ALIASES[m.id]) {
          m.id = DEEPSEEK_MODEL_ALIASES[m.id];
          if (typeof m.name === "string" && DEEPSEEK_MODEL_ALIASES[m.name]) m.name = DEEPSEEK_MODEL_ALIASES[m.name];
          changed = true;
        }
      }
    }
  }
  // agents.defaults.model.primary / fallbacks 里的 "deepseek/<id>" 完整引用
  const modelRefs = config?.agents?.defaults?.model;
  if (modelRefs && typeof modelRefs === "object") {
    for (const key of ["primary", "fallbacks"] as const) {
      const v = modelRefs[key];
      if (typeof v === "string") {
        const m = /^deepseek\/(.+)$/.exec(v);
        if (m && DEEPSEEK_MODEL_ALIASES[m[1]]) {
          modelRefs[key] = `deepseek/${DEEPSEEK_MODEL_ALIASES[m[1]]}`;
          changed = true;
        }
      } else if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          const item = v[i];
          if (typeof item === "string") {
            const m = /^deepseek\/(.+)$/.exec(item);
            if (m && DEEPSEEK_MODEL_ALIASES[m[1]]) {
              v[i] = `deepseek/${DEEPSEEK_MODEL_ALIASES[m[1]]}`;
              changed = true;
            }
          }
        }
      }
    }
  }
  return changed;
}

/** 修正 OneClaw 历史版本写入的非法 exec mode（"approve-all" → "full"）。
 * 内核 resolveExecPolicyForMode 只接受 deny|allowlist|ask|auto|full，
 * 非法值会让内核在解析 exec 策略时抛 Unsupported exec mode。 */
function migrateExecModeApproveAll(config: any): boolean {
  const exec = config?.tools?.exec;
  if (exec && typeof exec === "object" && exec.mode === "approve-all") {
    exec.mode = "full";
    return true;
  }
  return false;
}

/** update_plan 工具开关的版本化落位（双向）。
 * ≥2026.8：正确路径是 tools.updatePlan（boolean），tools.experimental 整体被
 * strict schema 拒绝——把 experimental.planTool 的值搬过去后删除整个 experimental
 * 节点；updatePlan 缺失时补 true，用户显式 false 尊重不动。
 * <2026.8（含回退）：2026.8 写出的 tools.updatePlan 旧内核不认，搬回
 * tools.experimental.planTool；缺失时补 true。 */
function migratePlanTool(config: any, atLeast2026_8: boolean): boolean {
  if (!config || typeof config !== "object") return false;
  let changed = false;
  const tools = (config.tools ??= {});
  if (typeof tools !== "object") return false;
  if (atLeast2026_8) {
    const experimental = tools.experimental;
    if (experimental !== undefined) {
      if (experimental && typeof experimental === "object"
        && typeof experimental.planTool === "boolean" && tools.updatePlan === undefined) {
        tools.updatePlan = experimental.planTool;
      }
      delete tools.experimental;
      changed = true;
    }
    if (tools.updatePlan === undefined) {
      tools.updatePlan = true;
      changed = true;
    }
    return changed;
  }
  if (typeof tools.updatePlan === "boolean") {
    const experimental = (tools.experimental ??= {});
    if (typeof experimental === "object" && experimental.planTool === undefined) {
      experimental.planTool = tools.updatePlan;
    }
    delete tools.updatePlan;
    changed = true;
  }
  const experimental = (tools.experimental ??= {});
  if (typeof experimental !== "object") return changed;
  if (experimental.planTool === undefined) {
    experimental.planTool = true;
    changed = true;
  }
  return changed;
}

/** memorySearch 节点的版本化落位（双向）。
 * ≥2026.8：agents.defaults.memorySearch 挪到根级 memory.search（与内核
 * doctor --fix 行为对齐：同名键根级已存在时以根级为准，随后删除旧节点）。
 * <2026.8（回退）：根级 memory.search 搬回 agents.defaults.memorySearch，
 * 搬空后删除根级 memory 空壳，避免旧内核 strict 校验拒绝未知根键。 */
function migrateMemorySearchLocation(config: any, atLeast2026_8: boolean): boolean {
  if (!config || typeof config !== "object") return false;
  if (atLeast2026_8) {
    const defaults = config.agents?.defaults;
    const legacy = defaults?.memorySearch;
    if (!legacy || typeof legacy !== "object") return false;
    const memory = (config.memory ??= {});
    const existing = memory.search;
    memory.search = { ...legacy, ...(existing && typeof existing === "object" ? existing : {}) };
    delete defaults.memorySearch;
    return true;
  }
  const rootMemory = config.memory;
  const search = rootMemory?.search;
  if (!search || typeof search !== "object") return false;
  const defaults = ((config.agents ??= {}).defaults ??= {});
  defaults.memorySearch = defaults.memorySearch && typeof defaults.memorySearch === "object"
    ? { ...search, ...defaults.memorySearch }
    : search;
  delete rootMemory.search;
  if (Object.keys(rootMemory).length === 0) delete config.memory;
  return true;
}

/** ≥2026.8：QQ 机器人 channelHostConfig 契约禁止 allowFrom 通配符 "*"
 * （schemaAllOf: items not const "*"，仅允许哨兵 openclaw:approval-disabled
 * 或大写 ID）。旧内核默认写出的 ["*"] 会让 gateway 启动校验直接失败，
 * 且内核自身迁移在 dmPolicy="open" 时会把 "*" 加回来形成回环（内核 bug），
 * 所以这里顺带把 dmPolicy="open" 清掉回默认 pairing——该组合在 2026.8 下
 * 本来就会丢全部 DM（内核启动警告明示），清掉反而回到可用默认。
 * 覆盖 channels.qqbot 顶层与 accounts.* 两级。 */
function migrateQQBotAllowFromWildcard(config: any): boolean {
  const SENTINEL = "openclaw:approval-disabled";
  let changed = false;
  const fixEntry = (entry: any): void => {
    if (!entry || typeof entry !== "object") return;
    const allowFrom = entry.allowFrom;
    if (Array.isArray(allowFrom) && allowFrom.includes("*")) {
      const stripped = allowFrom.filter((item: any) => item !== "*");
      entry.allowFrom = stripped.length > 0 ? stripped : [SENTINEL];
      changed = true;
      if (entry.dmPolicy === "open") delete entry.dmPolicy;
    }
  };
  const qqbot = config?.channels?.qqbot;
  fixEntry(qqbot);
  const accounts = qqbot?.accounts;
  if (accounts && typeof accounts === "object") {
    for (const account of Object.values(accounts)) fixEntry(account);
  }
  return changed;
}

/** ≥2026.8：插件验证收紧——enabled 但既非内核 bundled 也未装进状态目录
 * extensions/ 的插件会让 gateway 启动时 "plugin verification failed" 拒绝就绪
 * （典型：official external plugins tavily/volcengine/xiaomi 的 capability consent）。
 * 把这类条目降级为 enabled:false（保留配置本体，用户之后在扩展商店重装即可）。
 * 只动 enabled===true 的条目；本就 disabled 的残留不阻断启动。
 *
 * 已安装但无可运行载荷（目录在、却没有 package.json 也没有 dist/）同样降级：
 * 典型是 ClawHub 安装的纯技能插件（只有 openclaw.plugin.json + skills/）。
 * 内核 2026.8.2 对这类插件每轮启动都 "Repaired missing configured plugin"，
 * 修复写入不持久 → startup 收敛检测到输入变化 → 拒绝 ready 死循环
 * （v2026.904.1 生产事故根因之二，holo-wechat-mp 案例）。 */
function migrateUnavailablePluginEntries(config: any): string[] {
  const entries = config?.plugins?.entries;
  if (!entries || typeof entries !== "object") return [];
  const listDirs = (dir: string): Set<string> => {
    try {
      return new Set(
        fs.readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name),
      );
    } catch {
      return new Set();
    }
  };
  // 目录内存在 package.json 或 dist/ 视为有可运行载荷
  const hasRunnablePayload = (dir: string): boolean => {
    try {
      if (fs.existsSync(path.join(dir, "package.json"))) return true;
      return fs.statSync(path.join(dir, "dist")).isDirectory();
    } catch {
      return false;
    }
  };
  const bundled = listDirs(path.join(resolveGatewayPackageDir(), "dist", "extensions"));
  const stateExtDir = path.join(resolveUserStateDir(), "extensions");
  const installed = listDirs(stateExtDir);
  // bundled 由内核发行物保证格式，不做载荷判定；状态目录里的才查
  const resolvable = (id: string): boolean =>
    bundled.has(id) || (installed.has(id) && hasRunnablePayload(path.join(stateExtDir, id)));
  const disabled: string[] = [];
  for (const [id, entry] of Object.entries(entries)) {
    const e = entry as any;
    if (!e || e.enabled !== true) continue;
    if (resolvable(id)) continue;
    e.enabled = false;
    disabled.push(id);
  }
  // plugins.slots.* 引用不可解析插件同样 fail-closed（plugin not found），一并摘除
  const slots = config.plugins?.slots;
  if (slots && typeof slots === "object") {
    for (const [slot, pluginId] of Object.entries(slots)) {
      if (typeof pluginId === "string" && !resolvable(pluginId)) {
        delete slots[slot];
        if (!disabled.includes(pluginId)) disabled.push(pluginId);
      }
    }
  }
  return disabled;
}

export function migrateOpenclawConfigForKernelUpgrade(): void {
  try {
    const version = readKernelVersionParts();
    if (!version) return; // 版本不可读：保守跳过
    const config = readUserConfig();
    const removed: string[] = [];
    for (const rule of OPENCLAW_CONFIG_MIGRATIONS) {
      if (!versionAtLeast(version, rule.since)) continue;
      let node: any = config;
      for (let i = 0; i < rule.path.length - 1; i++) {
        node = node?.[rule.path[i]];
        if (node === null || typeof node !== "object") break;
      }
      if (node !== null && typeof node === "object") {
        const key = rule.path[rule.path.length - 1];
        if (key in node) {
          delete node[key];
          removed.push(rule.note);
        }
      }
    }
    const atLeast2026_8 = versionAtLeast(version, { year: 2026, month: 8 });
    const migratedAliases = migrateDeepseekModelAliases(config);
    const migratedExecMode = migrateExecModeApproveAll(config);
    const migratedPlanTool = migratePlanTool(config, atLeast2026_8);
    const migratedMemorySearch = migrateMemorySearchLocation(config, atLeast2026_8);
    const migratedQQBot = atLeast2026_8 ? migrateQQBotAllowFromWildcard(config) : false;
    const disabledPlugins = atLeast2026_8 ? migrateUnavailablePluginEntries(config) : [];
    if (removed.length === 0 && !migratedAliases && !migratedExecMode && !migratedPlanTool && !migratedMemorySearch && !migratedQQBot && disabledPlugins.length === 0) return;
    writeUserConfig(config);
    const parts: string[] = [];
    if (removed.length > 0) parts.push(`移除: ${removed.join(", ")}`);
    if (migratedAliases) parts.push("deepseek 旧模型别名已迁移到 v4 系列");
    if (migratedExecMode) parts.push("tools.exec.mode 非法值 approve-all 已修正为 full");
    if (migratedPlanTool) parts.push(atLeast2026_8 ? "planTool 开关已落位 tools.updatePlan" : "planTool 开关已落位 tools.experimental.planTool");
    if (migratedMemorySearch) parts.push(atLeast2026_8 ? "memorySearch 已迁移到根级 memory.search" : "memory.search 已回迁至 agents.defaults.memorySearch");
    if (migratedQQBot) parts.push("channels.qqbot.allowFrom 通配符 * 已按 2026.8 契约清除");
    if (disabledPlugins.length > 0) parts.push(`不可用（未安装或无可运行载荷）的启用插件已降级为禁用: ${disabledPlugins.join(", ")}`);
    log.info(`[migrate] 已适配新内核配置，${parts.join("；")}`);
  } catch {
    // 迁移失败不阻塞启动
  }
}
