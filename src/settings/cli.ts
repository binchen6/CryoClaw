/**
 * Settings: openclaw CLI 集成（状态 / 安装 / 卸载）。
 */
import { ipcMain } from "electron";
import { installCli, uninstallCli, getCliStatus } from "../cli-integration";
import { assertTrustedIpcSender } from "../ipc-sender-guard";
import * as analytics from "../analytics";

export function registerCliIpc(): void {
  // ── 读取 CLI 状态（enabled=用户偏好，installed=当前/旧版 wrapper 足迹） ──
  ipcMain.handle("settings:get-cli-status", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:get-cli-status")) throw new Error("IPC sender not trusted");
    try {
      return {
        success: true,
        data: getCliStatus(),
      };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // ── 安装 CLI（老用户迁移入口，默认不阻断其它设置流程） ──
  // 原始 error message 含绝对路径，只上报分类枚举给分析侧。
  ipcMain.handle("settings:install-cli", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:install-cli")) throw new Error("IPC sender not trusted");
    const result = await installCli();
    if (result.success) {
      analytics.track("cli_installed", { method: "settings" });
    } else {
      analytics.track("cli_install_failed", {
        method: "settings",
        error_type: analytics.classifyErrorType(result.message),
      });
    }
    return result;
  });

  // ── 卸载 CLI（移除 wrapper + PATH 注入块） ──
  ipcMain.handle("settings:uninstall-cli", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:uninstall-cli")) throw new Error("IPC sender not trusted");
    const result = await uninstallCli();
    if (result.success) {
      analytics.track("cli_uninstalled", { method: "settings" });
    } else {
      analytics.track("cli_uninstall_failed", {
        method: "settings",
        error_type: analytics.classifyErrorType(result.message),
      });
    }
    return result;
  });

}
