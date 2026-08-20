import { BrowserWindow, app, globalShortcut } from "electron";
import * as path from "path";
import * as log from "./logger";
import { buildChatUiEntryUrl } from "./chat-ui-entry-url";
import { shouldHideWindowOnClose } from "./window-close-policy";
import type { AppUpdateState } from "./app-updater-state";
import * as analytics from "./analytics";
import {
  WINDOW_WIDTH,
  WINDOW_HEIGHT,
  WINDOW_MIN_WIDTH,
  WINDOW_MIN_HEIGHT,
  resolveChatUiPath,
  resolveDevBranchTag,
} from "./constants";

interface ShowOptions {
  port: number;
  token?: string;
  onboarding?: boolean;
  initialView?: "setup" | "chat";
}

interface NavigateOptions {
  view: "settings" | "setup" | "chat";
  /** When view=settings, optionally pre-select a tab */
  settingsTab?: string;
  /** When view=settings, optionally show a notice on the target tab */
  settingsNotice?: string;
  /** Fresh gateway auth token — sent on setup→chat transition so renderer doesn't use stale token */
  token?: string;
}

function resolveMainWindowTitle(): string {
  const tag = resolveDevBranchTag();
  // 主窗口标题直接解释产品定位，方便用户在系统标题栏里理解 CryoClaw 是什么。
  return app.getLocale().startsWith("zh")
    ? `CryoClaw 一键安装OpenClaw${tag}`
    : `CryoClaw - One-click installer for OpenClaw${tag}`;
}

function maskToken(token: string): string {
  if (token.length <= 8) {
    return "***";
  }
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

export class WindowManager {
  private win: BrowserWindow | null = null;
  private allowAppQuit = false;
  private crashRecoveryTimestamps: number[] = [];
  private memoryMonitorTimer: NodeJS.Timeout | null = null;
  inSetupView = false;
  /** True from initial setup launch until setup:complete succeeds. Unlike
   *  inSetupView (tracks which view is currently displayed), this flag
   *  persists across view transitions so the close-policy always forces
   *  quit and openSettings is blocked until setup finishes. */
  setupPending = false;

  // 显示主窗口（加载 Chat UI）
  async show(opts: ShowOptions): Promise<void> {
    if (this.win && !this.win.isDestroyed()) {
      log.info(`复用主窗口: id=${this.win.id}`);
      this.win.show();
      this.win.focus();
      return;
    }

    log.info(
      `创建主窗口: port=${opts.port} onboarding=${Boolean(opts.onboarding)} token=${opts.token ? maskToken(opts.token) : "none"}`,
    );

    const title = resolveMainWindowTitle();
    const isMac = process.platform === "darwin";
    this.win = new BrowserWindow({
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      minWidth: WINDOW_MIN_WIDTH,
      minHeight: WINDOW_MIN_HEIGHT,
      show: false,
      title,
      // Windows/Linux 任务栏与标题栏图标（macOS 用 Dock 图标，无需设置）
      icon: isMac ? undefined : path.join(app.getAppPath(), "assets", "icon.png"),
      autoHideMenuBar: true,
      titleBarStyle: "hidden",
      trafficLightPosition: isMac ? { x: 14, y: 16 } : undefined,
      titleBarOverlay: isMac
        ? undefined
        : { color: "#00000000", symbolColor: "#666666", height: 32 },
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "preload.js"),
      },
    });
    this.win.on("page-title-updated", (event) => {
      event.preventDefault();
      this.win?.setTitle(title);
    });
    // 主窗口隐藏菜单栏（File/Edit/View...）
    this.win.setMenuBarVisibility(false);
    this.win.removeMenu();

    // DevTools 快捷键: F12 / Cmd+Shift+I / Ctrl+Shift+I
    // 安全面：生产环境关闭 DevTools 快捷键，避免渲染层被攻击后用 DevTools 探查 IPC / preload。
    // 开发环境（!app.isPackaged）保持开启，方便调试。
    this.win.webContents.on("before-input-event", (_event, input) => {
      if (app.isPackaged) return;
      if (
        input.key === "F12" ||
        (input.control && input.shift && input.key.toLowerCase() === "i") ||
        (input.meta && input.shift && input.key.toLowerCase() === "i")
      ) {
        this.win?.webContents.toggleDevTools();
      }
    });
    // 生产环境启动后立即关闭 DevTools（防止外部通过 --remote-debugging-port 等方式打开）
    if (app.isPackaged) {
      this.win.webContents.on("devtools-opened", () => {
        this.win?.webContents.closeDevTools();
      });
    }

    // 渲染进程崩溃 / 无响应监控（R20：崩溃自动恢复 + 防崩循环熔断）
    this.win.webContents.on("render-process-gone", (_e, details) => {
      log.error(`render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`);
      // clean-exit 属正常生命周期，不恢复；其余（crashed/oom/killed/launch-failed…）
      // 自动 reload 自愈。60s 滑窗内最多恢复 3 次，防崩溃-重载死循环。
      if (details.reason === "clean-exit") return;
      const now = Date.now();
      this.crashRecoveryTimestamps = this.crashRecoveryTimestamps.filter((t) => now - t < 60_000);
      if (this.crashRecoveryTimestamps.length >= 3) {
        log.error("渲染进程 60s 内崩溃超 3 次，停止自动恢复（等待用户介入）");
        return;
      }
      this.crashRecoveryTimestamps.push(now);
      const win = this.win;
      if (!win || win.isDestroyed()) return;
      log.warn(`渲染进程异常退出（${details.reason}），自动重新加载`);
      win.webContents.reload();
    });
    this.win.webContents.on("did-start-loading", () => {
      log.info("WebContents 开始加载");
    });
    this.win.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame) {
        return;
      }
      log.error(`WebContents 主帧加载失败: code=${code} description=${description} url=${url}`);
    });
    this.win.webContents.on("did-finish-load", () => {
      log.info("WebContents 加载完成");
    });
    this.win.webContents.on("dom-ready", () => {
      log.info("WebContents DOM 就绪");
    });
    this.win.webContents.on("did-stop-loading", () => {
      log.info("WebContents 停止加载");
    });
    this.win.on("unresponsive", () => {
      log.warn("窗口无响应");
    });
    this.startMemoryMonitor();

    // 关闭 → Setup 未完成/退出流程放行关闭；普通场景隐藏到托盘
    this.win.on("close", (e) => {
      if (!shouldHideWindowOnClose({ allowAppQuit: this.allowAppQuit, setupPending: this.setupPending })) {
        if (this.setupPending) {
          // Setup 未完成时关闭 = 退出应用（即使当前显示的不是 setup 视图）
          analytics.trackSetupAbandoned({ trigger: "window_close" });
          app.quit();
        }
        return;
      }
      e.preventDefault();
      this.win?.hide();
    });
    // 窗口真正销毁后重置状态，避免退出标记泄漏到后续窗口生命周期
    this.win.on("closed", () => {
      this.win = null;
      this.allowAppQuit = false;
      if (this.memoryMonitorTimer) {
        clearInterval(this.memoryMonitorTimer);
        this.memoryMonitorTimer = null;
      }
    });

    // 首屏 Setup 必须在首个 URL 里直接生效，避免 renderer 先画 chat 再被纠正。
    if (opts.initialView === "setup") {
      this.inSetupView = true;
      this.setupPending = true;
    }

    // 首次加载直接带上 gateway 参数，避免双次 loadFile 触发两套 renderer 初始化。
    const chatUiIndex = resolveChatUiPath();
    const chatUiEntryUrl = buildChatUiEntryUrl(chatUiIndex, opts);
    // 日志脱敏：entry URL 的 ?token= 等 query 不落盘（app.log 可能被用户外发分享）
    const chatUiEntryUrlForLog = (() => {
      try {
        const u = new URL(chatUiEntryUrl);
        u.search = "";
        u.hash = "";
        return u.href;
      } catch {
        return chatUiEntryUrl.split(/[?#]/, 1)[0];
      }
    })();
    log.info(`准备加载 Chat UI: ${chatUiEntryUrlForLog}`);
    // ready-to-show：等渲染进程完成首帧绘制再显示，避免白屏闪烁；
    // 若该事件未触发（异常路径）由 showOnce 兜底。
    let shown = false;
    const showOnce = () => {
      if (shown || !this.win || this.win.isDestroyed()) return;
      shown = true;
      this.win.show();
    };
    this.win.once("ready-to-show", showOnce);
    try {
      await this.win.loadURL(chatUiEntryUrl);
    } catch (err) {
      log.error(`Chat UI 加载失败: url=${chatUiEntryUrlForLog} err=${err}`);
      await this.loadChatUiErrorPage();
      showOnce();
      return;
    }

    showOnce();
    if (process.env.ONECLAW_DEBUG || process.env.OPENCLAW_DEBUG) {
      this.win.webContents.openDevTools();
    }
    log.info("主窗口显示");
  }

  // 渲染进程软内存监控（R20）：每 60s 采样 app.getAppMetrics()，渲染进程工作集
  // 超阈值记 warn。不做硬上限——--max-old-space-size 会在长会话/大渲染时直接
  // OOM 崩页，自愈交给 render-process-gone 的自动 reload。
  private startMemoryMonitor(): void {
    if (this.memoryMonitorTimer) {
      clearInterval(this.memoryMonitorTimer);
    }
    const RENDERER_MEMORY_WARN_MB = 1536;
    this.memoryMonitorTimer = setInterval(() => {
      const win = this.win;
      if (!win || win.isDestroyed()) return;
      try {
        const pid = win.webContents.getOSProcessId();
        const metric = app.getAppMetrics().find((m) => m.pid === pid);
        const mb = metric ? metric.memory.workingSetSize / 1024 : 0;
        if (mb > RENDERER_MEMORY_WARN_MB) {
          log.warn(`渲染进程内存偏高: ${mb.toFixed(0)}MB（阈值 ${RENDERER_MEMORY_WARN_MB}MB）`);
        }
      } catch {
        // 采样失败忽略
      }
    }, 60_000);
    // 不阻止进程退出
    this.memoryMonitorTimer.unref();
  }

  // 显示主窗口并切换到内嵌设置页
  async openSettings(opts: ShowOptions): Promise<void> {
    // Setup 未完成时禁止打开 Settings，强制回到 Setup 视图
    if (this.setupPending) {
      log.info("openSettings 被阻止: setup 尚未完成，强制导航到 setup");
      await this.show(opts);
      if (this.win && !this.win.isDestroyed()) {
        this.win.show();
        this.win.focus();
        this.navigate({ view: "setup" });
      }
      return;
    }
    await this.show(opts);
    if (!this.win || this.win.isDestroyed()) {
      return;
    }

    this.win.show();
    this.win.focus();
    this.navigate({ view: "settings" });
  }

  // 标记应用进入退出流程（例如手动退出/更新安装）
  prepareForAppQuit(): void {
    this.allowAppQuit = true;
  }

  // 向渲染层广播内核升级进度（若窗口存在）。
  pushKernelUpdateProgress(payload: { step: string; pct: number; msg: string }): void {
    if (!this.win || this.win.isDestroyed()) {
      return;
    }
    this.win.webContents.send("kernel:update-progress", payload);
  }

  // 向渲染层广播 App 自动更新状态快照（若窗口存在）。
  pushAppUpdateState(state: AppUpdateState): void {
    if (!this.win || this.win.isDestroyed()) {
      return;
    }
    this.win.webContents.send("app:update-state", state);
  }

  // 销毁窗口（应用退出前调用）
  destroy(): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.removeAllListeners("close");
    this.win.close();
    this.win = null;
  }

  // 通知渲染进程执行应用内导航
  navigate(payload: NavigateOptions): void {
    if (!this.win || this.win.isDestroyed()) {
      return;
    }
    this.win.webContents.send("app:navigate", payload);
  }

  // 通知渲染进程 Settings 视图内导航（tab 切换 + notice）
  sendSettingsNavigate(payload: { tab: string; notice?: string }): void {
    if (!this.win || this.win.isDestroyed()) {
      return;
    }
    this.win.webContents.send("settings:navigate", payload);
  }

  // Chat UI 加载失败时的错误页
  private async loadChatUiErrorPage(): Promise<void> {
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CryoClaw - Error</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0b1020;
      color: #e6ebff;
    }
    .card {
      width: min(680px, calc(100vw - 40px));
      border-radius: 14px;
      background: #111938;
      border: 1px solid #2a366f;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
      padding: 22px 20px;
    }
    h1 { margin: 0 0 10px; font-size: 20px; }
    p { margin: 0 0 10px; line-height: 1.5; color: #c8d2ff; }
    button {
      border: 0;
      border-radius: 8px;
      padding: 10px 14px;
      font-weight: 600;
      cursor: pointer;
      color: #fff;
      background: #0ea5e9;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>Chat UI not available</h1>
    <p>CryoClaw Chat UI 未能加载。请尝试重新启动应用。</p>
    <button id="retryBtn" type="button">Retry</button>
  </main>
  <script>
    document.getElementById("retryBtn")?.addEventListener("click", () => {
      window.location.reload();
    });
  </script>
</body>
</html>`;

    await this.win!.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  }
}
