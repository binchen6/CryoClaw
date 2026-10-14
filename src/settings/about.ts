/**
 * Settings: 关于（版本信息）+ 概览（环境信息重构版：运行态/资源/运行时/路径一页看懂）。
 */
import { app, ipcMain } from "electron";
import * as os from "os";
import { resolveGatewayLogPath, resolveGatewayPackageDir, resolveGatewayPort, resolveUserConfigPath, resolveUserStateDir } from "../constants";
import { readUserConfig } from "../provider-config";
import { assertTrustedIpcSender } from "../ipc-sender-guard";
import { checkAppUpdate, clearAppUpdateSnooze, downloadAppUpdate, getAppUpdateState, quitAndInstallAppUpdate, snoozeAppUpdate } from "../app-updater";
import { getKernelUpdateState } from "../kernel-updater";
import { readInstalledSkillVersions } from "../skill-store";
import type { SettingsIpcOptions } from "./types";
import * as fs from "fs";
import * as path from "path";

export function registerAboutIpc(opts: SettingsIpcOptions): void {
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

  // 概览（设置 → 概览 tab；原「环境信息」重构版）：一页看懂运行环境。
  // 响应字段只增不减，channel 名保持 settings:get-env-info 以兼容旧渲染端。
  ipcMain.handle("settings:get-env-info", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:get-env-info")) throw new Error("IPC sender not trusted");
    let kernelVersion = "unknown";
    try {
      const pkgPath = path.join(resolveGatewayPackageDir(), "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.version) kernelVersion = pkg.version;
    } catch {}
    // 概览页是只读展示：读失败（杀软瞬时锁等）按原语义降级为空配置，
    // 其余字段（kernelVersion/port 等）照常返回，不让整个查询 IPC 失败
    let config: any = {};
    try {
      config = readUserConfig();
    } catch {}
    const providers = (config?.models?.providers && typeof config.models.providers === "object")
      ? Object.keys(config.models.providers)
      : [];
    const enabledChannels = (config?.channels && typeof config.channels === "object")
      ? Object.entries(config.channels as Record<string, { enabled?: boolean }>)
          .filter(([, v]) => v?.enabled === true)
          .map(([k]) => k)
      : [];
    // 插件启用统计（config.plugins.entries 里 enabled=true 的条目；缺省 enabled 视为 true，
    // 与内核语义一致——白名单 plugins.allow 不在此展开，避免误导计数）
    const pluginEntries = (config?.plugins?.entries && typeof config.plugins.entries === "object")
      ? Object.values(config.plugins.entries as Record<string, { enabled?: boolean }>)
      : [];
    const pluginsEnabled = pluginEntries.filter((e) => e?.enabled !== false).length;
    // 已安装技能数：lockfile 为主、_meta.json 兜底（skill-store 已实现的只读口径）
    let skillsInstalled = 0;
    try {
      skillsInstalled = Object.keys(readInstalledSkillVersions()).length;
    } catch {}
    // 内核更新态：检查失败/未初始化时按 lastCheck 缓存返回，绝不抛错
    let kernelUpdate: { latest: string | null; updateAvailable: boolean; rollbackAvailable: boolean; running: boolean } | null = null;
    try {
      const ks = getKernelUpdateState();
      kernelUpdate = { latest: ks.latest, updateAvailable: ks.updateAvailable, rollbackAvailable: ks.rollbackAvailable, running: ks.running };
    } catch {}
    // 应用内存：getAppMetrics 汇总 main/renderer/GPU/utility 全部进程的 workingSet，
    // 比单看主进程 RSS 更贴近用户在任务管理器里看到的「CryoClaw 占用」
    let appBytes = 0;
    try {
      for (const metric of app.getAppMetrics()) {
        const kb = metric.memory?.workingSetSize;
        if (typeof kb === "number" && Number.isFinite(kb) && kb > 0) appBytes += kb * 1024;
      }
    } catch {}
    const systemTotal = os.totalmem();
    const cpus = os.cpus();
    const rt = opts.getGatewayRuntime?.() ?? null;
    return {
      configPath: resolveUserConfigPath(),
      gatewayPort: resolveGatewayPort(),
      gatewayBind: config?.gateway?.bind ?? "loopback",
      gatewayReloadMode: config?.gateway?.reload?.mode ?? "hybrid",
      kernelVersion,
      providerKeys: providers,
      enabledChannels,
      // ── 概览页扩展字段（旧版环境信息无） ──
      appVersion: app.getVersion(),
      packaged: app.isPackaged,
      versions: {
        electron: process.versions.electron ?? "unknown",
        chromium: process.versions.chrome ?? "unknown",
        node: process.versions.node ?? "unknown",
        platform: process.platform,
        arch: process.arch,
        osType: os.type(),
        osRelease: os.release(),
      },
      cpu: { model: cpus[0]?.model?.trim() || "unknown", cores: cpus.length },
      memory: { appBytes, systemTotal, systemUsed: systemTotal - os.freemem() },
      uptimeSec: Math.floor(process.uptime()),
      paths: {
        config: resolveUserConfigPath(),
        dataDir: resolveUserStateDir(),
        installDir: app.isPackaged ? path.dirname(app.getPath("exe")) : app.getAppPath(),
        gatewayLog: resolveGatewayLogPath(),
        kernelDir: resolveGatewayPackageDir(),
      },
      kernelUpdate,
      skillsInstalled,
      pluginsEnabled,
      pluginsTotal: pluginEntries.length,
      gatewayRuntime: rt
        ? {
            state: rt.state,
            pid: rt.pid,
            uptimeSec: rt.startedAt ? Math.max(0, Math.floor((Date.now() - rt.startedAt) / 1000)) : null,
          }
        : null,
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

  // 用户点「更新」开始下载（autoDownload=false，仅此入口触发下载）
  ipcMain.handle("app-update:download", (event) => {
    if (!assertTrustedIpcSender(event, "app-update:download")) throw new Error("IPC sender not trusted");
    try {
      downloadAppUpdate();
      return { success: true, data: getAppUpdateState() };
    } catch (err: any) {
      return { success: false, message: String(err?.message ?? err) };
    }
  });

  // 暂缓更新提示：{ days: number } | { forever: true }；非法输入拒绝
  ipcMain.handle("app-update:snooze", (event, opts: { days?: number; forever?: boolean }) => {
    if (!assertTrustedIpcSender(event, "app-update:snooze")) throw new Error("IPC sender not trusted");
    try {
      if (opts?.forever === true) {
        snoozeAppUpdate("forever");
      } else {
        const days = Number(opts?.days);
        if (!Number.isFinite(days) || days <= 0 || days > 3650) {
          return { success: false, message: "暂缓天数非法（1–3650）" };
        }
        snoozeAppUpdate(Date.now() + days * 86_400_000);
      }
      return { success: true, data: getAppUpdateState() };
    } catch (err: any) {
      return { success: false, message: String(err?.message ?? err) };
    }
  });

  ipcMain.handle("app-update:clear-snooze", (event) => {
    if (!assertTrustedIpcSender(event, "app-update:clear-snooze")) throw new Error("IPC sender not trusted");
    clearAppUpdateSnooze();
    return { success: true, data: getAppUpdateState() };
  });
}
