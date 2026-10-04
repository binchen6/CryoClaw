import * as path from "path";
import { resolveGatewayPackageDir } from "./constants";
import { isPluginPresentAnywhere, manifestOnlyPluginDirProbe } from "./plugin-presence";

export const QQBOT_PLUGIN_ID = "qqbot";

// 统一解析 QQ Bot 插件目录。openclaw 自 2026.4.5 起将 @openclaw/qqbot 作为内置
// extension vendor 在自身 dist/extensions/ 下，CryoClaw 不再单独 ship 也不需要
// reconcile 到 ~/.openclaw/extensions/。
export function resolveQqbotPluginDir(): string {
  return path.join(resolveGatewayPackageDir(), "dist", "extensions", QQBOT_PLUGIN_ID);
}

// 检查 QQ Bot 插件是否可用（四根判定，见 plugin-presence.ts）。vendored 形态
// 入口布局与 mirror 插件不同，探针保持旧语义：只要求 openclaw.plugin.json。
export function isQqbotPluginBundled(): boolean {
  return isPluginPresentAnywhere(QQBOT_PLUGIN_ID, manifestOnlyPluginDirProbe);
}
