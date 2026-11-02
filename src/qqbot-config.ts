import * as path from "path";

export const QQBOT_PLUGIN_ID = "openclaw-qqbot";
export const QQBOT_CHANNEL_ID = "qqbot";

/** Replace plugin identity without changing channel credentials or access policy. */
export function migrateQqbotPluginId(config: any): boolean {
  const plugins = config?.plugins;
  let changed = false;
  const channel = config?.channels?.qqbot;
  if (channel && typeof channel === "object") {
    for (const account of [channel, ...Object.values(channel.accounts ?? {})] as any[]) {
      if (account && typeof account === "object" && account.upgradeMode !== "doc") {
        account.upgradeMode = "doc";
        changed = true;
      }
    }
  }
  if (!plugins || typeof plugins !== "object") return changed;
  for (const key of ["entries", "installs"] as const) {
    const map = plugins[key];
    if (!map || typeof map !== "object" || !Object.hasOwn(map, "qqbot")) continue;
    map[QQBOT_PLUGIN_ID] = { ...map.qqbot, ...map[QQBOT_PLUGIN_ID] };
    delete map.qqbot;
    changed = true;
  }
  for (const key of ["allow", "deny"] as const) {
    if (!Array.isArray(plugins[key]) || !plugins[key].includes("qqbot")) continue;
    plugins[key] = [...new Set(plugins[key].map((id: unknown) => id === "qqbot" ? QQBOT_PLUGIN_ID : id))];
    changed = true;
  }
  return changed;
}

// The pinned Tencent plugin lives in the physical gateway, alongside its dependencies.
export function resolveQqbotPluginDir(): string {
  const { resolveGatewayPackageDir } = require("./constants") as typeof import("./constants");
  return path.join(resolveGatewayPackageDir(), "dist", "extensions", QQBOT_PLUGIN_ID);
}

// 检查 QQ Bot 插件是否可用（四根判定，见 plugin-presence.ts）。vendored 形态
// 入口布局与 mirror 插件不同，探针保持旧语义：只要求 openclaw.plugin.json。
export function isQqbotPluginBundled(): boolean {
  const { isPluginPresentAnywhere, manifestOnlyPluginDirProbe } = require("./plugin-presence") as typeof import("./plugin-presence");
  return isPluginPresentAnywhere(QQBOT_PLUGIN_ID, manifestOnlyPluginDirProbe);
}
