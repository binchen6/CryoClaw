import { Tray, Menu, app, nativeImage, nativeTheme } from "electron";
import * as path from "path";
import { execSync } from "child_process";
import { GatewayProcess, GatewayState } from "./gateway-process";
import { WindowManager } from "./window";
import * as log from "./logger";

// Dev 模式诊断信息（启动时计算一次）
const devInfo = (() => {
  if (app.isPackaged) return null;
  const startedAt = new Date();
  let branch = "unknown";
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: app.getAppPath(),
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
  } catch {}
  return { branch, startedAt };
})();

interface TrayOptions {
  windowManager: WindowManager;
  gateway: GatewayProcess;
  onRestartGateway: () => void;
  onStartGateway: () => void;
  onStopGateway: () => void;
  onOpenSettings: () => void;
  /** App 更新已下载待装时的「重启以更新」入口 */
  onRestartAndUpdate: () => void;
  onQuit: () => void;
}

// 托盘菜单国际化
type TrayStrings = {
  stateRunning: string;
  stateStarting: string;
  stateStopping: string;
  stateStopped: string;
  openDashboard: string;
  restartToUpdate: string;
  restartGateway: string;
  startGateway: string;
  stopGateway: string;
  settings: string;
  quit: string;
};

const I18N: Record<string, TrayStrings> = {
  en: {
    stateRunning: "Gateway: Running",
    stateStarting: "Gateway: Starting…",
    stateStopping: "Gateway: Stopping…",
    stateStopped: "Gateway: Stopped",
    openDashboard: "Open Dashboard",
    restartToUpdate: "Restart to Update",
    restartGateway: "Restart Gateway",
    startGateway: "Start Gateway",
    stopGateway: "Stop Gateway",
    settings: "Settings",
    quit: "Quit CryoClaw",
  },
  zh: {
    stateRunning: "Gateway: 运行中",
    stateStarting: "Gateway: 启动中…",
    stateStopping: "Gateway: 停止中…",
    stateStopped: "Gateway: 已停止",
    openDashboard: "打开 CryoClaw",
    restartToUpdate: "重启以更新",
    restartGateway: "重启 Gateway",
    startGateway: "启动 Gateway",
    stopGateway: "停止 Gateway",
    settings: "设置",
    quit: "退出 CryoClaw",
  },
};

// 根据系统语言选择文案
function getTrayStrings(): TrayStrings {
  const locale = app.getLocale();
  return locale.startsWith("zh") ? I18N.zh : I18N.en;
}

// 状态标签映射
function getStateLabel(state: GatewayState): string {
  const s = getTrayStrings();
  const map: Record<GatewayState, string> = {
    running: s.stateRunning,
    starting: s.stateStarting,
    stopping: s.stateStopping,
    stopped: s.stateStopped,
  };
  return map[state];
}

export class TrayManager {
  private tray: Tray | null = null;
  private opts: TrayOptions | null = null;
  /** App 更新是否已下载待装（downloaded 态时托盘菜单挂「重启以更新」） */
  private appUpdateReady = false;

  // App 更新状态变化时由 main 推送；变化时重建托盘菜单
  setAppUpdateReady(ready: boolean): void {
    if (this.appUpdateReady === ready) return;
    this.appUpdateReady = ready;
    this.updateMenu();
  }

  // 创建托盘图标
  create(opts: TrayOptions): void {
    this.opts = opts;

    // macOS: Template 图标自动适配暗色模式（由 upstream CritterIconRenderer 生成）
    // Windows: 黑色剪影在深色任务栏几乎不可见，按系统主题选浅/深色变体
    const iconPath = path.join(app.getAppPath(), "assets", this.resolveTrayIconName());

    let icon: Electron.NativeImage;
    try {
      icon = nativeImage.createFromPath(iconPath);
      if (process.platform === "darwin") icon.setTemplateImage(true);
    } catch {
      icon = nativeImage.createEmpty();
    }

    this.tray = new Tray(icon);
    this.tray.setToolTip("CryoClaw");

    // Windows: 系统主题切换时同步更换托盘图标变体
    if (process.platform === "win32") {
      nativeTheme.on("updated", () => this.applyWindowsTrayIcon());
    }

    // 点击托盘图标 → 打开主窗口
    this.tray.on("click", () => {
      opts.windowManager
        .show({ port: opts.gateway.getPort(), token: opts.gateway.getToken() })
        .catch((err) => log.error(`托盘点击打开主窗口失败: ${err}`));
    });

    this.updateMenu();
  }

  // 托盘图标文件名：macOS 用 Template；Windows 深色任务栏用浅色剪影，浅色任务栏用深色剪影
  private resolveTrayIconName(): string {
    if (process.platform === "darwin") return "tray-iconTemplate@2x.png";
    return nativeTheme.shouldUseDarkColors ? "tray-icon-light@2x.png" : "tray-icon@2x.png";
  }

  // Windows 主题变化后重设托盘图标
  private applyWindowsTrayIcon(): void {
    if (!this.tray) return;
    try {
      const iconPath = path.join(app.getAppPath(), "assets", this.resolveTrayIconName());
      this.tray.setImage(nativeImage.createFromPath(iconPath));
    } catch {}
  }

  // 刷新托盘菜单（Gateway 状态变化时调用）
  updateMenu(): void {
    if (!this.tray || !this.opts) return;

    const { windowManager, gateway, onRestartGateway, onStartGateway, onStopGateway, onOpenSettings, onRestartAndUpdate, onQuit } = this.opts;
    const t = getTrayStrings();
    const state = gateway.getState();
    const inTransition = state === "starting" || state === "stopping";
    const showStart = state === "stopped" || state === "stopping";
    const showStop = state === "running" || state === "starting";

    // Dev 模式：菜单顶部显示分支名和启动时间
    const devItems: Electron.MenuItemConstructorOptions[] = devInfo
      ? [
          { label: `🌿 ${devInfo.branch}`, enabled: false },
          { label: `⏱ ${devInfo.startedAt.toLocaleTimeString()}`, enabled: false },
          { type: "separator" },
        ]
      : [];

    const menu = Menu.buildFromTemplate([
      ...devItems,
      {
        label: t.openDashboard,
        click: () =>
          windowManager
            .show({ port: gateway.getPort(), token: gateway.getToken() })
            .catch((err) => log.error(`托盘菜单打开主窗口失败: ${err}`)),
      },
      { type: "separator" },
      // App 更新已下载待装：置顶重启入口（状态复位后该项消失）
      ...(this.appUpdateReady
        ? [
            { label: t.restartToUpdate, click: onRestartAndUpdate },
            { type: "separator" as const },
          ]
        : []),
      { label: getStateLabel(state), enabled: false },
      { label: t.restartGateway, enabled: !inTransition, click: onRestartGateway },
      ...(showStart ? [{ label: t.startGateway, enabled: state === "stopped", click: onStartGateway }] : []),
      ...(showStop ? [{ label: t.stopGateway, enabled: state === "running", click: onStopGateway }] : []),
      { type: "separator" },
      { label: t.settings, click: onOpenSettings },
      { type: "separator" },
      { label: t.quit, click: onQuit },
    ]);

    this.tray.setContextMenu(menu);
  }

  // 更新托盘 tooltip（用于显示下载进度等临时状态）
  setTooltip(text: string): void {
    this.tray?.setToolTip(text);
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
