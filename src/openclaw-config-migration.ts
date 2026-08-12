/**
 * openclaw-config-migration.ts — 内核升级后的用户配置适配迁移
 *
 * 由 main.ts 启动时与 kernel-updater.ts 换装成功后各调用一次。
 * 迁移带版本门控：仅当当前内核版本达到规则要求时才执行删除，
 * 读不到版本时保守跳过，避免误删旧内核仍在使用的配置节点。
 */

import * as fs from "fs";
import * as path from "path";
import { resolveGatewayPackageDir } from "./constants";
import { readUserConfig, writeUserConfig } from "./provider-config";
import * as log from "./logger";

// 规则列表，后续按需追加。
// 规则：删除 agents.defaults.llm —— openclaw 2026.7 起该节点被移除，
// 旧配置残留会让内核校验报错、gateway 无法启动。
const OPENCLAW_CONFIG_MIGRATIONS: ReadonlyArray<{
  path: readonly string[];
  note: string;
  /** 触发迁移的最低内核版本（YYYY.M 数值比较） */
  since: { year: number; month: number };
}> = [
  { path: ["agents", "defaults", "llm"], note: "agents.defaults.llm（2026.7 起废弃）", since: { year: 2026, month: 7 } },
];

// 读取当前内核版本并解析出 YYYY.M（兼容 2026.7.1-2 这类后缀）。
// 读不到（版本文件缺失/格式异常）返回 null，调用方保守跳过迁移。
function readKernelVersionParts(): { year: number; month: number } | null {
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

/** 启用实验性 update_plan 工具（tools.experimental.planTool，无版本门控）。
 * 缺失（undefined）时补 true；用户显式设过 false 则尊重不动。 */
function migratePlanToolExperimental(config: any): boolean {
  if (!config || typeof config !== "object") return false;
  config.tools ??= {};
  const experimental = (config.tools.experimental ??= {});
  if (typeof experimental !== "object") return false;
  if (experimental.planTool === undefined) {
    experimental.planTool = true;
    return true;
  }
  return false;
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
    const migratedAliases = migrateDeepseekModelAliases(config);
    const migratedExecMode = migrateExecModeApproveAll(config);
    const migratedPlanTool = migratePlanToolExperimental(config);
    if (removed.length === 0 && !migratedAliases && !migratedExecMode && !migratedPlanTool) return;
    writeUserConfig(config);
    const parts: string[] = [];
    if (removed.length > 0) parts.push(`移除: ${removed.join(", ")}`);
    if (migratedAliases) parts.push("deepseek 旧模型别名已迁移到 v4 系列");
    if (migratedExecMode) parts.push("tools.exec.mode 非法值 approve-all 已修正为 full");
    if (migratedPlanTool) parts.push("已启用实验性工具 tools.experimental.planTool");
    log.info(`[migrate] 已适配新内核配置，${parts.join("；")}`);
  } catch {
    // 迁移失败不阻塞启动
  }
}
