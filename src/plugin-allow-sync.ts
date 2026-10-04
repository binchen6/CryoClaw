/**
 * plugins.allow 白名单同步（T2）。
 * 内核语义：plugins.allow 非空且 id 不在其中 → 即使 entries.<id>.enabled=true 也被
 * 静默禁用。历史仅 kimi-search / memory-core 两个特例做同步，通用 UI 开关与市场安装
 * 路径漏同步 → 「已启用但实际不加载」。本模块收敛全部同步逻辑：
 *   - syncPluginAllowOnEnable：单 id 启用时并入 allow（从 kimi-config 迁出，原处 re-export）
 *   - reconcilePluginsAllowWithEnabled：启动期/修复期全量对齐（allow 非空时把全部
 *     enabled !== false 的 entry id 并入）
 */
import * as log from "./logger";
import { readUserConfigForWrite, writeUserConfig } from "./provider-config";

// allow 缺失或为空数组时不动它（语义是"未启用白名单"）；反向（disable）不从 allow
// 移除：用户可能临时禁用想保留授权，删除是另一个语义。
export function syncPluginAllowOnEnable(config: any, pluginId: string): void {
  const allow = config?.plugins?.allow;
  if (!Array.isArray(allow) || allow.length === 0) return;
  if (!allow.includes(pluginId)) allow.push(pluginId);
}

/**
 * 全量对齐：allow 非空时，把 entries 中 enabled !== false 的 id 全部并入 allow。
 * 返回本次新增的 id（空数组 = 无变化，不写盘）。失败不抛——白名单同步是修复性
 * 动作，不能让调用方（启动流程/IPC）翻车。
 */
export function reconcilePluginsAllowWithEnabled(): string[] {
  try {
    const { config, baseSnapshot } = readUserConfigForWrite();
    const plugins = config?.plugins;
    const allow = plugins?.allow;
    if (!Array.isArray(allow) || allow.length === 0) return [];
    const entries = plugins?.entries;
    if (!entries || typeof entries !== "object") return [];

    const merged = new Set<string>(allow);
    const added: string[] = [];
    for (const [id, entry] of Object.entries(entries)) {
      const enabled = (entry as { enabled?: unknown } | null)?.enabled;
      if (enabled === false) continue;
      if (!merged.has(id)) {
        merged.add(id);
        added.push(id);
      }
    }
    if (added.length === 0) return [];

    plugins.allow = Array.from(merged).sort();
    writeUserConfig(config, { baseSnapshot });
    log.info(`[plugin-allow-sync] plugins.allow reconciled (+${added.length}): ${added.join(",")}`);
    return added;
  } catch (err) {
    log.warn(`[plugin-allow-sync] reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
