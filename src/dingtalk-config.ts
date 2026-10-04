import * as fs from "fs";
import * as path from "path";
import { resolveGatewayPackageDir } from "./constants";
import { isPluginPresentAnywhere, type PluginDirProbe } from "./plugin-presence";

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

// dingtalk-connector 走 channel-entry shim，入口形态特殊（plugin.ts /
// dist/plugin.js）：在默认入口候选基础上追加这两个变体。
const dingtalkPluginDirProbe: PluginDirProbe = (dir) => {
  if (!fs.existsSync(path.join(dir, "openclaw.plugin.json"))) return false;
  return (
    fs.existsSync(path.join(dir, "plugin.ts")) ||
    fs.existsSync(path.join(dir, "dist", "plugin.js")) ||
    fs.existsSync(path.join(dir, "index.ts")) ||
    fs.existsSync(path.join(dir, "dist", "index.js")) ||
    fs.existsSync(path.join(dir, "dist", "index.cjs.js")) ||
    fs.existsSync(path.join(dir, "dist", "index.esm.js"))
  );
};

// 检查钉钉插件是否可用（四根判定，见 plugin-presence.ts）。bundled gateway
// dist/extensions 仍是第一判定根（稳态加载路径），其余三根兜底覆盖
// mirror/用户目录/市场自装形态，避免单根缺席误报「组件缺失」。
export function isDingtalkPluginBundled(): boolean {
  return isPluginPresentAnywhere(DINGTALK_CONNECTOR_PLUGIN_ID, dingtalkPluginDirProbe);
}
