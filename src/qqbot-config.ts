import * as fs from "fs";
import * as path from "path";
import { resolveGatewayPackageDir } from "./constants";

export const QQBOT_PLUGIN_ID = "qqbot";

// 统一解析 QQ Bot 插件目录。openclaw 自 2026.4.5 起将 @openclaw/qqbot 作为内置
// extension vendor 在自身 dist/extensions/ 下，CryoClaw 不再单独 ship 也不需要
// reconcile 到 ~/.openclaw/extensions/。
export function resolveQqbotPluginDir(): string {
  return path.join(resolveGatewayPackageDir(), "dist", "extensions", QQBOT_PLUGIN_ID);
}

// 检查 QQ Bot 插件是否已经随应用一起打包。
export function isQqbotPluginBundled(): boolean {
  const pluginDir = resolveQqbotPluginDir();
  return fs.existsSync(path.join(pluginDir, "openclaw.plugin.json"));
}
