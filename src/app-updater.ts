/**
 * app-updater.ts — App 级自动更新客户端（electron-updater + GitHub Releases）。
 *
 * 状态机纯逻辑在 app-updater-state.ts；本模块只做 Electron 事件接线：
 *   - 仅 app.isPackaged 时启用（dev 模式 supported=false，IPC 返回 { supported: false } 语义）
 *   - 启动后 ~15s 自动检查一次；此后每 12h 周期静默复查（长开场景不重启也能发现新版本）；
 *     用户设过「暂缓」且未到期时跳过自动检查（见 update-snooze.ts），手动检查不受影响
 *   - autoDownload=false：发现新版本只弹窗提示（更新日志 + 更新/暂缓），
 *     用户点「更新」后才经 downloadAppUpdate() 下载
 *   - 静默安装：换装 spawn 安装器带 /S（无任何安装器 UI，装完 --force-run
 *     自动拉起新版），autoInstallOnAppQuit=false
 *   - 每次状态变化经 deps.push 推送 webContents.send("app:update-state", snapshot)
 *
 * IPC handlers 注册在 settings/about.ts（app-update:* 通道）。
 */

import { app } from "electron";
import { autoUpdater } from "electron-updater";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as log from "./logger";
import {
  AppUpdateEvent,
  AppUpdateState,
  createInitialAppUpdateState,
  reduceAppUpdateState,
} from "./app-updater-state";
import { clearSnooze, isUpdateSnoozed, readSnooze, writeSnooze, SnoozeUntil } from "./update-snooze";
import { fetchReleaseNotesFromGitHub } from "./app-update-release-notes";

export type { AppUpdateState } from "./app-updater-state";

// 启动后延迟 15s 自动检查（避免与 gateway/窗口启动争资源）
const STARTUP_CHECK_DELAY_MS = 15 * 1000;
// 长开桌面场景的周期复查间隔（12h）：不重启也能发现新版本
const PERIODIC_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
let periodicTimer: NodeJS.Timeout | null = null;

type Deps = {
  /** 状态变化时推送渲染层（window 不存在时由调用方自行忽略） */
  push: (state: AppUpdateState) => void;
  /** quitAndInstall 前回调（供窗口管理器放行关闭流程） */
  beforeQuitAndInstall?: () => void;
};

let state: AppUpdateState = createInitialAppUpdateState(false, "");
let pushFn: ((state: AppUpdateState) => void) | null = null;
let beforeQuitAndInstall: (() => void) | null = null;
let startupTimer: NodeJS.Timeout | null = null;
/** 已下载完成的安装器文件名（update-downloaded 事件 info.path，仅文件名） */
let downloadedInstallerName: string | null = null;

function formatUpdaterError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function publish(event: AppUpdateEvent): void {
  state = reduceAppUpdateState(state, event);
  pushFn?.(snapshotState());
}

// 输出快照：合并暂缓状态（非状态机字段，每次现算保证推送/拉取一致）
function snapshotState(): AppUpdateState {
  return { ...state, snoozedUntil: readSnooze()?.until ?? null };
}

// 从 app 根目录 release-notes.json 按版本号取更新说明（缺失时返回 null，不阻断更新流程）
function readReleaseNotesForVersion(version: string): { zh?: string; en?: string } | null {
  try {
    const notesPath = path.join(app.getAppPath(), "release-notes.json");
    const entries: Array<{ version: string; notes?: { zh?: string; en?: string } }> = JSON.parse(
      fs.readFileSync(notesPath, "utf-8"),
    );
    if (!Array.isArray(entries)) return null;
    return entries.find((e) => e?.version === version)?.notes ?? null;
  } catch {
    return null;
  }
}

export function getAppUpdateState(): AppUpdateState {
  return snapshotState();
}

/** 触发一次检查；失败只记日志，error 事件负责推进状态机。 */
export function checkAppUpdate(): void {
  if (!state.supported) return;
  void autoUpdater.checkForUpdates().catch((err) => {
    log.warn(`[app-updater] 检查更新失败: ${formatUpdaterError(err)}`);
    // checkForUpdates 直接 reject 时 error 事件可能未触发，兜底推进状态机保证可重试
    publish({ type: "error", message: formatUpdaterError(err) });
  });
}

/** 用户点「更新」后开始下载；仅 available 态可用（autoDownload=false）。 */
export function downloadAppUpdate(): void {
  if (!state.supported || state.status !== "available") {
    throw new Error("当前没有可下载的更新");
  }
  log.info(`[app-updater] 用户确认下载更新 ${state.version}`);
  void autoUpdater.downloadUpdate().catch((err) => {
    log.warn(`[app-updater] 下载更新失败: ${formatUpdaterError(err)}`);
    publish({ type: "error", message: formatUpdaterError(err) });
  });
}

/** 设置更新提示暂缓（until: epoch ms 或 "forever"），并推送最新快照。 */
export function snoozeAppUpdate(until: SnoozeUntil): void {
  writeSnooze(until);
  log.info(`[app-updater] 更新提示暂缓: ${until === "forever" ? "永久" : `至 ${new Date(until).toISOString()}`}`);
  pushFn?.(snapshotState());
}

/** 清除暂缓（设置页可手动恢复自动检查）。 */
export function clearAppUpdateSnooze(): void {
  clearSnooze();
  log.info("[app-updater] 更新提示暂缓已清除");
  pushFn?.(snapshotState());
}

/**
 * 已下载安装器的完整路径。
 * electron-updater 的 Windows 缓存目录为 %LOCALAPPDATA%\<updaterCacheDirName>\pending\
 * （updaterCacheDirName 由 app-update.yml 指定，本项目为 cryoclaw-updater）。
 */
function getPendingInstallerPath(): string | null {
  if (!downloadedInstallerName || process.platform !== "win32") return null;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;
  const installerPath = path.join(
    localAppData,
    "cryoclaw-updater",
    "pending",
    path.basename(downloadedInstallerName),
  );
  return fs.existsSync(installerPath) ? installerPath : null;
}

/** 用户点「重启以更新」；仅 downloaded 态可用。 */
// 重入保护：spawn 安装器到 app.quit() 真正退出之间存在时间窗（beforeQuitAndInstall/
// quit-cleanup），期间 state.status 仍是 downloaded，重复触发会并发两个静默安装器
// 互相踩踏文件（后起实例可能以退出码 2 静默退出，见 gotcha #53）。
let installInFlight = false;

export function quitAndInstallAppUpdate(): void {
  if (installInFlight) {
    log.warn("[app-updater] 更新安装已在进行中，忽略重复触发");
    return;
  }
  if (!state.supported || state.status !== "downloaded") {
    throw new Error("当前没有已下载完成的更新");
  }
  installInFlight = true;
  log.info("[app-updater] 用户确认重启安装更新");

  // 自实现换装 spawn，而非 autoUpdater.quitAndInstall()：
  // 实测发现 electron-updater 内部 spawn 的 NSIS 安装器在真实 app 上下文中
  // 会于 ~37s 后静默死亡（uninstall/copy 阶段之前），而手动 spawn
  // （detached + stdio:ignore + unref）同参数同 exe 换装全部成功。
  // /S 真静默（R63：此前无 /S 会弹安装器向导要求用户点击）：
  // customInit 杀进程、customInstallMode 复用安装模式在 /S 下照常执行，
  // --force-run 装完自动拉起新版（installSection.nsh：ONE_CLICK + isForceRun），
  // 全程零 UI；appRunning/appCannotBeClosed 弹窗均带 /SD 旗标，静默不阻塞。
  const installerPath = getPendingInstallerPath();
  if (installerPath) {
    log.info(`[app-updater] 启动静默安装器: ${installerPath}`);
    try {
      const child = spawn(installerPath, ["/S", "--updated", "--force-run"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      beforeQuitAndInstall?.();
      app.quit();
      return;
    } catch (err) {
      log.warn(`[app-updater] 自启动安装器失败，回退 quitAndInstall: ${formatUpdaterError(err)}`);
    }
  } else {
    log.warn("[app-updater] 未找到 pending 安装器，回退 quitAndInstall");
  }
  beforeQuitAndInstall?.();
  // isSilent=true：静默换装（无安装器窗口）；forceRunAfter=true 装完自动拉起新版
  autoUpdater.quitAndInstall(true, true);
}

export function initAppUpdater(deps: Deps): void {
  pushFn = deps.push;
  beforeQuitAndInstall = deps.beforeQuitAndInstall ?? null;
  state = createInitialAppUpdateState(app.isPackaged, app.getVersion());

  if (!app.isPackaged) {
    log.info("[app-updater] dev/未打包环境，App 自动更新不可用");
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // 不使用 web installer（静默 NSIS 换装），消除 electron-updater 启动警告
  autoUpdater.disableWebInstaller = true;
  // 内部日志转发到 app.log
  autoUpdater.logger = {
    info: (msg) => log.info(`[app-updater] ${msg}`),
    warn: (msg) => log.warn(`[app-updater] ${msg}`),
    error: (msg) => log.error(`[app-updater] ${msg}`),
    debug: (msg) => log.debug(`[app-updater] ${msg}`),
  };

  autoUpdater.on("checking-for-update", () => {
    log.info("[app-updater] 正在检查更新...");
    publish({ type: "checking" });
  });
  autoUpdater.on("update-available", (info) => {
    log.info(`[app-updater] 发现新版本 ${info.version}`);
    // 本地 release-notes.json 是当前安装版内置的，查不到新版本条目；
    // 先用本地结果（同版本重装等场景命中），缺失时异步拉 GitHub Release 正文补齐
    const localNotes = readReleaseNotesForVersion(info.version);
    publish({ type: "available", version: info.version, releaseNotes: localNotes });
    if (!localNotes) {
      void fetchReleaseNotesFromGitHub(info.version).then((notes) => {
        // 仅当仍停留在该版本的 available 态才补发（避免覆盖 downloading/downloaded）
        if (notes && state.status === "available" && state.version === info.version) {
          publish({ type: "available", version: info.version, releaseNotes: notes });
        }
      });
    }
  });
  autoUpdater.on("update-not-available", (info) => {
    log.info(`[app-updater] 已是最新版本 ${info.version}`);
    publish({ type: "not-available" });
  });
  autoUpdater.on("download-progress", (p) => {
    publish({
      type: "progress",
      percent: p.percent,
      bytesPerSecond: p.bytesPerSecond,
      transferred: p.transferred,
      total: p.total,
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    log.info(`[app-updater] 更新 ${info.version} 下载完成，等待用户重启安装`);
    downloadedInstallerName = info.path ?? null;
    publish({ type: "downloaded" });
  });
  autoUpdater.on("error", (err) => {
    log.error(`[app-updater] 更新失败: ${formatUpdaterError(err)}`);
    publish({ type: "error", message: formatUpdaterError(err) });
  });

  // 启动后自动检查一次；暂缓期内跳过（手动检查不受影响）。
  // 失败由 error 事件 + catch 记日志，不弹窗打扰用户
  startupTimer = setTimeout(() => {
    if (isUpdateSnoozed()) {
      log.info("[app-updater] 更新提示暂缓中，跳过启动自动检查");
      return;
    }
    checkAppUpdate();
  }, STARTUP_CHECK_DELAY_MS);
  startupTimer.unref?.();

  // 长开桌面场景的周期复查：每 12h 静默检查一次，确保不重启也能发现新版本。
  // 活跃流程（checking/downloading/downloaded）不打断；暂缓期内跳过。
  periodicTimer = setInterval(() => {
    if (state.status === "checking" || state.status === "downloading" || state.status === "downloaded") {
      return;
    }
    if (isUpdateSnoozed()) {
      log.info("[app-updater] 更新提示暂缓中，跳过周期自动检查");
      return;
    }
    log.info("[app-updater] 周期自动检查更新（12h）");
    checkAppUpdate();
  }, PERIODIC_CHECK_INTERVAL_MS);
  periodicTimer.unref?.();
}
