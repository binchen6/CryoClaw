/**
 * Settings: 关于（版本信息）+ 环境信息。
 */
import { app, ipcMain } from "electron";
import { resolveGatewayPackageDir, resolveGatewayPort, resolveUserConfigPath } from "../constants";
import { readUserConfig } from "../provider-config";
import { assertTrustedIpcSender } from "../ipc-sender-guard";
import { checkAppUpdate, getAppUpdateState, quitAndInstallAppUpdate } from "../app-updater";
import * as fs from "fs";
import * as path from "path";

export function registerAboutIpc(): void {
  // 返回 CryoClaw 和 OpenClaw 版本信息
  ipcMain.handle("settings:get-about-info", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:get-about-info")) throw new Error("IPC sender not trusted");
    const cryoClawVersion = app.getVersion();
    let openClawVersion = "unknown";
    try {
      const pkgPath = path.join(resolveGatewayPackageDir(), "package.json");
      const raw = fs.readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      if (pkg.version) openClawVersion = pkg.version;
    } catch {}
    return { cryoClawVersion, openClawVersion };
  });

  // 环境信息（设置 → 环境信息 tab）：一页看懂运行环境
  ipcMain.handle("settings:get-env-info", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:get-env-info")) throw new Error("IPC sender not trusted");
    let kernelVersion = "unknown";
    try {
      const pkgPath = path.join(resolveGatewayPackageDir(), "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.version) kernelVersion = pkg.version;
    } catch {}
    const config = readUserConfig();
    const providers = (config?.models?.providers && typeof config.models.providers === "object")
      ? Object.keys(config.models.providers)
      : [];
    const enabledChannels = (config?.channels && typeof config.channels === "object")
      ? Object.entries(config.channels as Record<string, { enabled?: boolean }>)
          .filter(([, v]) => v?.enabled === true)
          .map(([k]) => k)
      : [];
    return {
      configPath: resolveUserConfigPath(),
      gatewayPort: resolveGatewayPort(),
      gatewayBind: config?.gateway?.bind ?? "loopback",
      gatewayReloadMode: config?.gateway?.reload?.mode ?? "hybrid",
      kernelVersion,
      providerKeys: providers,
      enabledChannels,
    };
  });

  // ── App 自动更新（electron-updater）──
  // dev/未打包环境下 supported=false，前端渲染「不支持」分区

  ipcMain.handle("app-update:get-state", (event) => {
    if (!assertTrustedIpcSender(event, "app-update:get-state")) throw new Error("IPC sender not trusted");
    return { success: true, data: getAppUpdateState() };
  });

  ipcMain.handle("app-update:check", (event) => {
    if (!assertTrustedIpcSender(event, "app-update:check")) throw new Error("IPC sender not trusted");
    checkAppUpdate();
    return { success: true, data: getAppUpdateState() };
  });

  ipcMain.handle("app-update:quit-and-install", (event) => {
    if (!assertTrustedIpcSender(event, "app-update:quit-and-install")) throw new Error("IPC sender not trusted");
    try {
      quitAndInstallAppUpdate();
      return { success: true };
    } catch (err: any) {
      return { success: false, message: String(err?.message ?? err) };
    }
  });
}
