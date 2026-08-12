import * as fs from "fs";
import * as path from "path";
import { resolveGatewayPackageDir } from "./constants";

export const DINGTALK_CONNECTOR_PLUGIN_ID = "dingtalk-connector";

// 统一解析钉钉插件目录。dingtalk-connector 走 channel-entry shim 留在 bundled
// 路径（gateway.asar/node_modules/openclaw/dist/extensions/dingtalk-connector）——
// Windows 下 shouldPreferNativeJiti=false 会把 extensions-mirror 外部加载路径
// 的 bundle 反复 jiti 重入，导致 DWS register() 多次新建 stream 共用同 clientId
// 被钉钉服务器互踢，回滚到 bundled 路径 + createRequire shim 才是稳态。
// 见 docs/gotchas.md 与 PR #79。
export function resolveDingtalkPluginDir(): string {
  return path.join(resolveGatewayPackageDir(), "dist", "extensions", DINGTALK_CONNECTOR_PLUGIN_ID);
}

// 检查钉钉插件是否已经随应用一起打包。
export function isDingtalkPluginBundled(): boolean {
  const pluginDir = resolveDingtalkPluginDir();
  const hasEntry =
    fs.existsSync(path.join(pluginDir, "plugin.ts")) ||
    fs.existsSync(path.join(pluginDir, "dist", "plugin.js")) ||
    fs.existsSync(path.join(pluginDir, "index.ts")) ||
    fs.existsSync(path.join(pluginDir, "dist", "index.js"));
  return hasEntry && fs.existsSync(path.join(pluginDir, "openclaw.plugin.json"));
}
