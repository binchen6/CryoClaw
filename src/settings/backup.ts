/**
 * Settings: 配置备份 / .openclaw 状态导入导出 / 恢复出厂。
 */
import { app, BrowserWindow, dialog, ipcMain, session } from "electron";
import * as fs from "fs";
import * as path from "path";
import { resolveUserConfigPath, resolveUserStateDir } from "../constants";
import { resolveCryoclawConfigPath } from "../cryoclaw-config";
import {
  getConfigRecoveryData,
  restoreLastKnownGoodConfigSnapshot,
  restoreUserConfigBackup,
} from "../config-backup";
import {
  buildOpenclawStateArchiveDefaultFileName,
  exportOpenclawStateToArchive,
} from "../openclaw-state-archive";
import {
  buildDiagnosticsDefaultFileName,
  exportDiagnosticsBundle,
} from "../diagnostics-export";
import {
  buildOpenclawStateExportOverwriteWarning,
  resolveOpenclawStateExportTarget,
} from "../openclaw-state-export-target";
import { assertTrustedIpcSender } from "../ipc-sender-guard";
import type { SettingsIpcOptions } from "./types";

// 弹出保存对话框（导出状态包 / 导出诊断包共用）：取消时返回 canceled。
async function pickExportSavePath(
  sender: Electron.WebContents,
  options: Electron.SaveDialogOptions,
): Promise<{ canceled: true } | { canceled: false; filePath: string }> {
  const win = BrowserWindow.fromWebContents(sender);
  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }
  return { canceled: false, filePath: result.filePath };
}

export function registerBackupIpc(opts: SettingsIpcOptions): void {
  // ── 列出配置备份与恢复元数据 ──
  ipcMain.handle("settings:list-config-backups", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:list-config-backups")) throw new Error("IPC sender not trusted");
    try {
      return { success: true, data: getConfigRecoveryData() };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // ── 导出 .openclaw 为标准 ZIP ──
  ipcMain.handle("settings:export-openclaw-state", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:export-openclaw-state")) throw new Error("IPC sender not trusted");
    try {
      const picked = await pickExportSavePath(event.sender, {
        defaultPath: buildOpenclawStateArchiveDefaultFileName(),
        filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
      });
      if (picked.canceled) {
        return { success: true, data: { canceled: true } };
      }

      const target = resolveOpenclawStateExportTarget(picked.filePath);
      if (target.overwriteExisting) {
        const warning = buildOpenclawStateExportOverwriteWarning(target.filePath);
        const warningOptions: Electron.MessageBoxOptions = {
          type: "warning",
          buttons: [warning.confirmLabel, warning.cancelLabel],
          defaultId: warning.defaultId,
          cancelId: warning.cancelId,
          noLink: true,
          message: warning.message,
          detail: warning.detail,
        };
        const win = BrowserWindow.fromWebContents(event.sender);
        const confirmation = win
          ? await dialog.showMessageBox(win, warningOptions)
          : await dialog.showMessageBox(warningOptions);
        if (confirmation.response !== 0) {
          return { success: true, data: { canceled: true } };
        }
      }

      await exportOpenclawStateToArchive(resolveUserStateDir(), target.filePath);
      return { success: true, data: { canceled: false, filePath: target.filePath } };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // ── 导出诊断包（日志 + 环境信息 + 脱敏配置摘要）──
  ipcMain.handle("settings:export-diagnostics", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:export-diagnostics")) throw new Error("IPC sender not trusted");
    try {
      const picked = await pickExportSavePath(event.sender, {
        defaultPath: buildDiagnosticsDefaultFileName(),
        filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
      });
      if (picked.canceled) {
        return { success: true, data: { canceled: true } };
      }
      // 系统保存对话框自带覆盖确认，无需二次 warning
      await exportDiagnosticsBundle(picked.filePath);
      return { success: true, data: { canceled: false, filePath: picked.filePath } };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // ── 选择 .openclaw ZIP；前端会先预检，再停 gateway，再导入 ──
  ipcMain.handle("settings:select-openclaw-state-archive", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:select-openclaw-state-archive")) throw new Error("IPC sender not trusted");
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.OpenDialogOptions = {
        properties: ["openFile"],
        filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
      };
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) {
        return { success: true, data: { canceled: true } };
      }
      return { success: true, data: { canceled: false, filePath: result.filePaths[0] } };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // ── 导入 .openclaw ZIP：受保护流程在停 gateway 前完成唯一校验，失败时不触碰 .openclaw ──
  ipcMain.handle("settings:import-openclaw-state", async (event, params) => {
    if (!assertTrustedIpcSender(event, "settings:import-openclaw-state")) throw new Error("IPC sender not trusted");
    const filePath = typeof params?.filePath === "string" ? params.filePath : "";
    try {
      if (!filePath) {
        return { success: false, message: "请选择要导入的 ZIP 数据包。" };
      }
      await opts.importOpenclawState(filePath);
      return { success: true };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // ── 从指定备份文件恢复配置 ──
  ipcMain.handle("settings:restore-config-backup", async (_event, params) => {
    if (!assertTrustedIpcSender(_event, "settings:restore-config-backup")) throw new Error("IPC sender not trusted");
    const fileName = typeof params?.fileName === "string" ? params.fileName : "";
    try {
      if (!fileName) {
        return { success: false, message: "请选择要恢复的备份文件。" };
      }
      restoreUserConfigBackup(fileName);
      return { success: true };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // ── 一键恢复最近一次可启动快照 ──
  ipcMain.handle("settings:restore-last-known-good", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:restore-last-known-good")) throw new Error("IPC sender not trusted");
    try {
      restoreLastKnownGoodConfigSnapshot();
      return { success: true };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });


  ipcMain.handle("settings:reset-config-and-relaunch", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:reset-config-and-relaunch")) throw new Error("IPC sender not trusted");
    try {
      const configPath = resolveUserConfigPath();
      if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
      }

      // 删除所有影响 detectOwnership() 判定的标记文件，确保重启后进入 Setup
      const stateDir = resolveUserStateDir();
      for (const marker of [
        resolveCryoclawConfigPath(),                                   // "cryoclaw" 归属标记
        path.join(stateDir, "oneclaw.config.json"),                   // 上一代配置（read fallback 会读，一并删除）
        path.join(stateDir, "openclaw-setup-baseline.json"),          // "legacy-cryoclaw" 标记
        path.join(stateDir, "openclaw.last-known-good.json"),         // last-known-good 快照
      ]) {
        if (fs.existsSync(marker)) {
          fs.unlinkSync(marker);
        }
      }

      // 清除 BrowserWindow 的 localStorage（分享弹窗计数器等），确保恢复出厂后状态彻底重置
      try {
        await session.defaultSession.clearStorageData({ storages: ["localstorage"] });
      } catch {
        // 清理失败不阻塞重启
      }

      app.relaunch();
      setTimeout(() => {
        // 走 app.quit() 触发 before-quit 清理链（停 gateway / auth-proxy），避免 app.exit 留下 gateway 孤儿子进程
        app.quit();
      }, 100);

      return {
        success: true,
        data: {
          configPath,
          preservedStateDir: resolveUserStateDir(),
        },
      };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

}
