import * as fs from "fs";
import * as path from "path";
import { app, clipboard, dialog, ipcMain, shell, Menu, BrowserWindow } from "electron";
// CryoClaw 面向中文用户：强制 Chromium locale 为 zh-CN，
// 使渲染层 navigator.language 返回 zh，chat-ui i18n 默认显示中文。
// 必须在 app ready 之前调用。
app.commandLine.appendSwitch("lang", "zh-CN");

// ── Chromium 无用特性收敛（R20）──
// 逐项取舍，均可注释还原：
// - Translate/OptimizationHints/MediaRouter/InterestCohort/PrivacySandboxAdTopics：
//   本地 file:// 聊天 UI 用不到翻译提示、页面预取提示、投屏与广告兴趣组。
// - disable-component-update：组件更新（Widevine 等）对本应用无意义，省后台请求。
// - disable-breakpad：崩溃转储上报未接入，关掉省进程。
// 明确不加：disable-background-networking（analytics 与 app 更新检查需要网络）、
// 不动 GPU 相关开关（CSS 动效与代码高亮渲染依赖硬件加速）。
app.commandLine.appendSwitch(
  "disable-features",
  "Translate,OptimizationHints,MediaRouter,InterestCohort,PrivacySandboxAdTopics",
);
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-breakpad");

import { GatewayProcess, closeDiagLogStream } from "./gateway-process";
import { WindowManager } from "./window";
import { TrayManager } from "./tray";
// SetupManager removed: Setup is now a Lit view inside the main window
import { registerSetupIpc } from "./setup-ipc";
import { registerSettingsIpc } from "./settings-ipc";
import { registerSkillStoreIpc } from "./skill-store";
import { registerPluginStoreIpc } from "./plugin-store";
import { registerWorkspaceIpc } from "./workspace-ipc";
import { registerGitIpc } from "./git-ipc";
import { detectGitCached } from "./git-detector";
import { isSetupComplete, resolveGatewayPort, resolveGatewayLogPath, resolveUserStateDir, resolveUserConfigPath } from "./constants";
import { resolveGatewayAuthToken } from "./gateway-auth";
import {
  getConfigRecoveryData,
  inspectUserConfigHealth,
  recordLastKnownGoodConfigSnapshot,
  restoreLastKnownGoodConfigSnapshot,
} from "./config-backup";
import { readUserConfig, writeUserConfig } from "./provider-config";
import { resolveKimiSearchApiKey, readKimiApiKey, readKimiSearchDedicatedApiKey, writeKimiApiKey, ensureMemorySearchProxyConfig, healLegacyProxyProviders } from "./kimi-config";
import { reconcileCliOnAppLaunch } from "./cli-integration";
import { reconcileExtensionsOnAppLaunch } from "./extension-mirror";
import { migrateLegacyFeishuPluginEntry } from "./feishu-config";
import { migrateBrowserProfileForCurrentGateway } from "./browser-profile-config";
import { uninstallGatewayDaemon, cleanGatewayLockFiles } from "./install-detector";
import { runQuitCleanup } from "./quit-cleanup";
import { detectOwnership, migrateFromLegacy, readCryoclawConfig, writeCryoclawConfig, appendChannelUtm } from "./cryoclaw-config";
import { startTokenRefresh, stopTokenRefresh, loadOAuthToken } from "./kimi-oauth";
import { initKernelUpdater, getKernelUpdateState, checkKernelUpdate, runKernelUpdate, runKernelRollback } from "./kernel-updater";
import { initAppUpdater, quitAndInstallAppUpdate } from "./app-updater";
import { startGatewayControlServer, stopGatewayControlServer } from "./gateway-control-server";
import { migrateOpenclawConfigForKernelUpgrade } from "./openclaw-config-migration";
import { assertTrustedIpcSender } from "./ipc-sender-guard";
import { isSafeOpenExt } from "./safe-open";
import { evaluateFileReadTarget, FILE_READ_MAX_BYTES, mimeTypeForPath } from "./file-read-base64";
import { startAuthProxy, stopAuthProxy, setProxyAccessToken, setProxySearchDedicatedKey, getProxyPort, getProxySecret } from "./kimi-auth-proxy";
import { importOpenclawStateFromArchive, validateOpenclawStateArchive } from "./openclaw-state-archive";
import { syncOpenClawStateAfterWrite } from "./openclaw-health-state";
import { createOpenclawStateImportLifecycle } from "./openclaw-state-import-lifecycle";
import { reconcileHostStateAfterOpenclawImport } from "./openclaw-state-import-host-reconcile";
import * as log from "./logger";
import * as analytics from "./analytics";
import { formatConsoleLevel } from "./console-level";

// 过滤渲染层高频日志，避免 onEvent/request 等每秒数百次的消息阻塞主进程
function isNoisyRendererConsoleMessage(message: string): boolean {
  return message.startsWith("[gateway] request sent ") || message.startsWith("[gateway] onEvent ");
}

// 日志脱敏：渲染层 console 转发可能携带含 token 的文档 URL（如 CSP 警告的 sourceId）
function sanitizeLogText(text: string): string {
  return text.replace(/([?&]token=)[^&#\s)]*/g, "$1***");
}

function attachRendererDebugHandlers(label: string, webContents: Electron.WebContents): void {
  webContents.on("console-message", (_event, level, message, lineNumber, sourceId) => {
    if (isNoisyRendererConsoleMessage(message)) {
      return;
    }
    const tag = `[renderer:${label}] console.${formatConsoleLevel(level)}`;
    const safeMessage = sanitizeLogText(message);
    const safeSource = sanitizeLogText(sourceId);
    if (level >= 2) {
      log.error(`${tag}: ${safeMessage} (${safeSource}:${lineNumber})`);
      return;
    }
    log.info(`${tag}: ${safeMessage} (${safeSource}:${lineNumber})`);
  });

  webContents.on("preload-error", (_event, path, error) => {
    log.error(`[renderer:${label}] preload-error: ${path} -> ${error.message || String(error)}`);
  });

  webContents.on("did-fail-load", (_event, code, description, validatedURL, isMainFrame) => {
    if (!isMainFrame) {
      return;
    }
    log.error(
      `[renderer:${label}] did-fail-load: code=${code}, description=${description}, url=${validatedURL}`,
    );
  });

  webContents.on("did-finish-load", () => {
    log.info(`[renderer:${label}] did-finish-load`);
  });

  webContents.on("dom-ready", () => {
    log.info(`[renderer:${label}] dom-ready`);
  });

  webContents.on("render-process-gone", (_event, details) => {
    log.error(
      `[renderer:${label}] render-process-gone: reason=${details.reason}, exitCode=${details.exitCode}`,
    );
  });
}

// ── 单实例锁（CRYOCLAW_MULTI_INSTANCE=1 时跳过，允许多 worktree 并行 dev） ──

if (!process.env.CRYOCLAW_MULTI_INSTANCE && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ── 全局错误兜底 ──

process.on("uncaughtException", (err) => {
  if ((err as NodeJS.ErrnoException).code === "EPIPE") return;
  log.error(`uncaughtException: ${err.stack || err.message}`);
});
process.on("unhandledRejection", (reason) => {
  log.error(`unhandledRejection: ${reason}`);
});

// ── 核心组件 ──

const gateway = new GatewayProcess({
  port: resolveGatewayPort(),
  token: resolveGatewayAuthToken({ persist: false }),
  onStateChange: (state) => {
    tray.updateMenu();
    // gateway 就绪后立即通知 Chat UI 重连，避免盲等指数退避
    if (state === "running") {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) {
          const port = gateway.getPort();
          w.webContents.send("gateway:ready", {
            token: gateway.getToken(),
            gatewayUrl: `ws://127.0.0.1:${port}`,
          });
        }
      }
    }
  },
});
const windowManager = new WindowManager();
const tray = new TrayManager();
// Setup view state tracked via windowManager.inSetupView (set by IPC from renderer)

// ── 显示主窗口的统一入口 ──

function showMainWindow(initialView?: "setup" | "chat"): Promise<void> {
  return windowManager.show({
    port: gateway.getPort(),
    token: gateway.getToken(),
    initialView,
  });
}

function openSettingsInMainWindow(): Promise<void> {
  return windowManager.openSettings({
    port: gateway.getPort(),
    token: gateway.getToken(),
  });
}

function openRecoverySettings(notice: string): void {
  // Navigate to settings with tab+notice in the payload so they arrive
  // through reactive state (settingsTabHint / settingsNotice) — no race
  // with the settings-view listener registration.
  windowManager.show({
    port: gateway.getPort(),
    token: gateway.getToken(),
  }).then(() => {
    windowManager.navigate({ view: "settings", settingsTab: "backup", settingsNotice: notice });
  }).catch((err) => {
    log.error(`恢复流程打开设置失败(${notice}): ${err}`);
  });
}

// ── Gateway 启动失败提示（避免静默失败） ──

type RecoveryAction = "open-settings" | "restore-last-known-good" | "dismiss";

// 统一弹出配置恢复提示，避免用户在配置损坏时无从下手。
function promptConfigRecovery(opts: {
  title: string;
  message: string;
  detail: string;
}): RecoveryAction {
  const locale = app.getLocale();
  const isZh = locale.startsWith("zh");
  const { hasLastKnownGood } = getConfigRecoveryData();

  const buttons = hasLastKnownGood
    ? [
        isZh ? "一键回退上次可用配置" : "Restore last known good",
        isZh ? "打开设置恢复" : "Open Settings",
        isZh ? "稍后处理" : "Later",
      ]
    : [isZh ? "打开设置恢复" : "Open Settings", isZh ? "稍后处理" : "Later"];

  const index = dialog.showMessageBoxSync({
    type: "error",
    title: opts.title,
    message: opts.message,
    detail: opts.detail,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true,
  });

  if (hasLastKnownGood) {
    if (index === 0) return "restore-last-known-good";
    if (index === 1) return "open-settings";
    return "dismiss";
  }
  if (index === 0) return "open-settings";
  return "dismiss";
}

// Gateway 启动失败时提示用户进入备份恢复，避免反复重启无效。
function reportGatewayStartFailure(source: string): RecoveryAction {
  const logPath = resolveGatewayLogPath();
  const title = "CryoClaw Gateway 启动失败";
  const detail =
    `来源: ${source}\n` +
    `建议先前往设置 → 备份与恢复，回退到最近可用配置。\n` +
    `诊断日志:\n${logPath}`;
  log.error(`${title} (${source})`);
  log.error(`诊断日志: ${logPath}`);
  return promptConfigRecovery({
    title,
    message: "Gateway 未能成功启动，可能是配置错误导致。",
    detail,
  });
}

// 配置 JSON 结构损坏时，直接给出恢复入口，避免误导用户重新 Setup。
function reportConfigInvalidFailure(parseError?: string): RecoveryAction {
  const recovery = getConfigRecoveryData();
  const detail =
    `配置文件: ${recovery.configPath}\n` +
    `解析错误: ${parseError ?? "unknown"}\n` +
    `建议前往设置 → 备份与恢复，回退到可用版本。`;

  log.error(`配置文件损坏，JSON 解析失败: ${parseError ?? "unknown"}`);
  return promptConfigRecovery({
    title: "CryoClaw 配置文件损坏",
    message: "检测到 openclaw.json 不是有效 JSON，Gateway 无法启动。",
    detail,
  });
}

// ── 统一启动链路：启动 Gateway → 打开主窗口 ──

interface StartMainOptions {
  openOnFailure?: boolean;
  reportFailure?: boolean;
}

const MAX_GATEWAY_START_ATTEMPTS = 3;

// 存量用户迁移：首次升级时默认开启 session-memory hook（幂等，只在 hooks.internal 未配置时写入）
function migrateSessionMemoryHook(): void {
  try {
    const config = readUserConfig();
    if (config.hooks?.internal) return;
    config.hooks ??= {};
    config.hooks.internal = {
      enabled: true,
      entries: { "session-memory": { enabled: true } },
    };
    writeUserConfig(config);
    log.info("[migrate] 已为存量用户默认开启 session-memory hook");
  } catch {
    // 迁移失败不阻塞启动
  }
}

// 禁止 openclaw gateway 自行检查 npm 更新（CryoClaw 整包打包，用户无法独立更新 gateway）
function migrateDisableGatewayUpdateCheck(): void {
  try {
    const config = readUserConfig();
    if (config.update?.checkOnStart === false) return;
    config.update ??= {};
    config.update.checkOnStart = false;
    writeUserConfig(config);
    log.info("[migrate] 已禁用 gateway 启动更新检查（update.checkOnStart=false）");
  } catch {
    // 迁移失败不阻塞启动
  }
}

// 存量用户迁移：openclaw 2026.4.x 的 dingtalk-connector 新 schema 设置 additionalProperties: false，
// 拒绝旧版本遗留的 gatewayToken / sessionTimeout 字段，会导致 gateway 启动时配置校验失败。
// 幂等删除这两个字段；失败不阻塞启动。
function migrateDeprecatedDingtalkFields(): void {
  try {
    const config = readUserConfig();
    const channels = config.channels as Record<string, unknown> | undefined;
    const dingtalk = channels?.["dingtalk-connector"];
    if (!dingtalk || typeof dingtalk !== "object") return;
    const record = dingtalk as Record<string, unknown>;
    const deprecated = ["gatewayToken", "sessionTimeout"] as const;
    const removed = deprecated.filter((k) => k in record);
    if (removed.length === 0) return;
    for (const k of removed) delete record[k];
    writeUserConfig(config);
    log.info(`[migrate] 已移除 dingtalk-connector 的 deprecated 字段: ${removed.join(", ")}`);
  } catch {
    // 迁移失败不阻塞启动
  }
}

// 存量用户迁移：openclaw 2026.4.x 移除了旧 Chrome extension relay profile。
// 旧版 Settings 写入 chrome/chrome-relay 会让 browser control 根路径返回 ProfileNotFound。
function migrateBrowserProfileConfig(): void {
  try {
    const config = readUserConfig();
    if (!migrateBrowserProfileForCurrentGateway(config)) return;
    writeUserConfig(config);
    log.info("[migrate] 已将旧 Chrome relay 浏览器配置迁移到 user profile");
  } catch {
    // 迁移失败不阻塞启动
  }
}

// 内核升级后的配置适配迁移（如移除已废弃字段）已抽到 ./openclaw-config-migration，
// 本文件启动处与 kernel-updater 换装成功后共用。

// 从配置同步 search API key 到 gateway 环境变量
// 代理模式下实际请求走代理注入 token，但插件初始化仍需 env var 存在
function syncKimiSearchEnv(): void {
  try {
    const config = readUserConfig();
    const key = resolveKimiSearchApiKey(config);
    if (key) {
      gateway.setExtraEnv({ KIMI_PLUGIN_API_KEY: key });
    } else if (getProxyPort() > 0) {
      // 代理模式：插件初始化需要 env var 存在，设占位符让插件通过检查
      // 实际请求走 proxy baseUrl，由代理注入真实 token
      gateway.setExtraEnv({ KIMI_PLUGIN_API_KEY: "proxy-managed" });
    } else {
      gateway.setExtraEnv({ KIMI_PLUGIN_API_KEY: "" });
    }
  } catch {
    // 配置读取失败不阻塞启动
  }
}

// 启动 Gateway（最多尝试 3 次，覆盖 Windows 冷启动慢导致的前两次超时）
async function ensureGatewayRunning(source: string): Promise<boolean> {
  migrateLegacyFeishuConfigForGatewayStart();
  await syncGatewayRuntimeConfigFromDisk();

  for (let attempt = 1; attempt <= MAX_GATEWAY_START_ATTEMPTS; attempt++) {
    if (attempt === 1) {
      await gateway.start();
    } else {
      log.warn(`Gateway 启动重试 ${attempt}/${MAX_GATEWAY_START_ATTEMPTS}: ${source}`);
      await gateway.restart();
    }

    if (gateway.getState() === "running") {
      // 仅在真正启动成功后刷新“最近可用快照”，保证一键回退目标可启动。
      recordLastKnownGoodConfigSnapshot();
      log.info(`Gateway 启动成功（第 ${attempt} 次尝试）: ${source}`);
      return true;
    }
  }

  return false;
}

function migrateLegacyFeishuConfigForGatewayStart(): void {
  try {
    const config = readUserConfig();
    if (!migrateLegacyFeishuPluginEntry(config)) {
      return;
    }
    writeUserConfig(config);
    log.info("[startup] migrated legacy Feishu plugin entry to channels.feishu.enabled");
  } catch (err: any) {
    log.warn(`[startup] failed to migrate legacy Feishu config: ${err?.message ?? err}`);
  }
}

// 外部 OpenClaw 接管：进 Setup 向导，Step 0 展示冲突并让用户决定
// 注意：不在此处预清理 daemon/进程，实际卸载动作在 setup:resolve-conflict 中由用户显式触发
async function handleExternalOpenclawTakeover(): Promise<void> {
  log.info("[startup] external OpenClaw detected, showing setup for user decision");
  await showMainWindow("setup");
}

async function startGatewayAndShowMain(source: string, opts: StartMainOptions = {}): Promise<boolean> {
  const openOnFailure = opts.openOnFailure ?? true;
  const reportFailure = opts.reportFailure ?? true;

  log.info(`启动链路开始: ${source}`);

  // 窗口先行：先显示 UI（渲染层进入"连接中"状态，自带重连），gateway 在后台启动。
  // 用户感知的启动时间 = max(窗口渲染, gateway 就绪)，而不是两者之和。
  // token/port 在 GatewayProcess 构造时已就绪，showMainWindow 不依赖 gateway 运行。
  // （R20）窗口创建提到扩展 reconcile 之前——reconcile 只被 gateway 启动依赖，不阻塞首屏。
  const windowPromise = showMainWindow().catch((err) => {
    log.error(`提前显示主窗口失败: ${err}`);
  });

  // 把内置 channel plugin 从 mirror reconcile 到 ~/.openclaw/extensions/。
  // 必须在 gateway 启动前 await——openclaw 首次扫描 plugin root 时要看到完整目录。
  // 函数自身吞掉所有错误，不会阻断启动。
  await reconcileExtensionsOnAppLaunch();

  const running = await ensureGatewayRunning(source);
  if (!running) {
    if (reportFailure) {
      const action = reportGatewayStartFailure(source);
      if (action === "open-settings") {
        openRecoverySettings("gateway-start-failed");
      } else if (action === "restore-last-known-good") {
        try {
          restoreLastKnownGoodConfigSnapshot();
          const recovered = await ensureGatewayRunning("recovery:last-known-good");
          if (recovered) {
            await windowPromise;
            return true;
          }
          openRecoverySettings("gateway-recovery-failed");
        } catch (err: any) {
          log.error(`回退 last-known-good 失败: ${err?.message ?? err}`);
          openRecoverySettings("gateway-recovery-exception");
        }
      }
    } else {
      log.error(`Gateway 启动失败（静默模式）: ${source}`);
    }
    if (!openOnFailure) {
      await windowPromise;
      return false;
    }
  }
  await windowPromise;
  return running;
}

// 启动前从磁盘重读运行参数；导入 .openclaw 或 Setup 完成后内存里的
// port/token/proxy/token refresh 可能已经过期。
async function syncGatewayRuntimeConfigFromDisk(): Promise<void> {
  gateway.setPort(resolveGatewayPort());
  gateway.setToken(resolveGatewayAuthToken());
  await ensureAuthProxy();
  if (loadOAuthToken()) ensureOAuthTokenRefresh();
  else stopTokenRefresh();
  syncKimiSearchEnv();
}

// 跟踪最近一次用户触发的 start/restart 游离 promise（已 .catch 包裹，必定 resolve）。
// 导入 .openclaw 前会 await 它，确保在途启动不会与清空/还原状态目录并发。
// 注意：仅 requestGatewayStart/requestGatewayRestart 喂这个变量；ensureGatewayRunning
// （启动/Setup/导入自身的启动路径）刻意不跟踪，否则导入会 await 自己的 start 而死锁。
// 那条未跟踪路径与 Settings 触发的导入在现实中不会重叠，且由 stop({ waitForStarting }) 兜底。
let inflightGatewayOp: Promise<void> = Promise.resolve();

// 手动控制 Gateway：统一入口，确保启动前同步最新 port/token。
function requestGatewayStart(source: string): void {
  if (openclawStateImportLifecycle.isImportActive()) {
    log.info(`[gateway] start ignored during .openclaw import: ${source}`);
    return;
  }
  inflightGatewayOp = (async () => {
    await syncGatewayRuntimeConfigFromDisk();
    await gateway.start();
  })().catch((err) => {
    log.error(`Gateway 启动失败(${source}): ${err}`);
  });
}

// 重启 debounce：多次快速调用只执行最后一次，避免连环重启
let restartTimer: ReturnType<typeof setTimeout> | null = null;
function cancelPendingGatewayRestart(source: string): void {
  if (!restartTimer) return;
  clearTimeout(restartTimer);
  restartTimer = null;
  log.info(`[gateway] pending restart canceled: ${source}`);
}

function requestGatewayRestart(source: string): void {
  if (openclawStateImportLifecycle.isImportActive()) {
    log.info(`[gateway] restart ignored during .openclaw import: ${source}`);
    return;
  }
  if (restartTimer) clearTimeout(restartTimer);
  log.info(`[gateway] restart requested: ${source}`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (openclawStateImportLifecycle.isImportActive()) {
      log.info(`[gateway] restart skipped during .openclaw import: ${source}`);
      return;
    }
    log.info(`[gateway] restart executing: ${source}`);
    inflightGatewayOp = (async () => {
      await syncGatewayRuntimeConfigFromDisk();
      await gateway.restart();
    })().catch((err) => {
      log.error(`Gateway 重启失败(${source}): ${err}`);
    });
  }, 800);
}

const openclawStateImportLifecycle = createOpenclawStateImportLifecycle({
  quiesceGateway: async () => {
    cancelPendingGatewayRestart("settings:import-openclaw-state");
    await inflightGatewayOp;
  },
  validateArchive: (filePath) => validateOpenclawStateArchive(filePath, resolveUserStateDir()),
  stopGateway: () => gateway.stop({ waitForStarting: true }),
  importArchive: (filePath) => log.withFileLoggingPaused(() => importOpenclawStateFromArchive(filePath, resolveUserStateDir())),
  reconcileHostState: reconcileHostStateAfterOpenclawImport,
  syncImportedConfigState: () => syncOpenClawStateAfterWrite(resolveUserConfigPath()),
  startGateway: async () => {
    const running = await ensureGatewayRunning("settings:import-openclaw-state");
    if (!running) {
      throw new Error(".openclaw 已导入，但 Gateway 启动失败。请检查导入的配置或恢复最近可用快照。");
    }
  },
});

// 解析当前最优 token：OAuth > 手动 key
function resolveCurrentToken(): string {
  const oauthToken = loadOAuthToken();
  if (oauthToken?.access_token) return oauthToken.access_token;
  return readKimiApiKey();
}

// 从 config baseUrl 解析历史代理端口（避免不必要的 config 写入）
function parseProxyPortFromConfig(): number {
  try {
    const config = readUserConfig();
    const baseUrl = config?.models?.providers?.["kimi-coding"]?.baseUrl;
    if (typeof baseUrl === "string" && baseUrl.includes("127.0.0.1")) {
      const m = baseUrl.match(/:(\d+)\//);
      if (m) return Number.parseInt(m[1], 10);
    }
  } catch {}
  return 0;
}

// 确保 config 中 kimi-coding 指向代理（仅端口/secret 变化时写入）
function ensureProxyConfig(proxyPort: number): void {
  try {
    const config = readUserConfig();
    const provider = config?.models?.providers?.["kimi-coding"];
    if (!provider) return;

    const proxyBase = `http://127.0.0.1:${proxyPort}/${getProxySecret()}`;
    const expectedBase = `${proxyBase}/coding`;
    // memorySearch embedding 也走同一个代理
    const memorySearchChanged = ensureMemorySearchProxyConfig(config, proxyPort, getProxySecret());

    // 历史遗留的指向本地代理的 provider（如旧版 "kimi"，无/旧 secret 段）一并改写，
    // 否则这些条目每次请求被代理 401，主模型静默落入 fallback。
    // 边界：本函数在 kimi-coding 缺失时直接 return，"只有遗留条目、无受管 kimi-coding"
    // 的配置不会被治愈——但那种情况下 ensureAuthProxy 根本不会启动代理，症状是显眼的
    // 连接失败而非静默 fallback，可接受。
    const legacyHealed = healLegacyProxyProviders(config, proxyPort, getProxySecret());
    if (legacyHealed) {
      log.info(`[auth-proxy] healed legacy proxy-pointing provider(s) → 127.0.0.1:${proxyPort}/<secret>`);
    }

    // kimi-search 插件端点同步必须在 early-return 之前：setup 保存会显式删 entry.config，
    // 若 baseUrl 恰好匹配而早退，端点整场缺席（插件回退内置默认端点直连上游、绕过代理），
    // 直到下次启动 secret 轮换才自愈
    const searchEntry = config?.plugins?.entries?.["kimi-search"];
    let searchChanged = false;
    if (searchEntry && typeof searchEntry === "object") {
      searchEntry.config ??= {};
      const wantSearch = `${proxyBase}/coding/v1/search`;
      const wantFetch = `${proxyBase}/coding/v1/fetch`;
      if (searchEntry.config.search?.baseUrl !== wantSearch) {
        searchEntry.config.search = { baseUrl: wantSearch };
        searchChanged = true;
      }
      if (searchEntry.config.fetch?.baseUrl !== wantFetch) {
        searchEntry.config.fetch = { baseUrl: wantFetch };
        searchChanged = true;
      }
    }

    if (provider.baseUrl === expectedBase && provider.apiKey === "proxy-managed" && !memorySearchChanged && !searchChanged && !legacyHealed) return;

    // 首次迁移：真实 apiKey 存入 sidecar（非 OAuth 用户 + 有效 key）
    if (provider.apiKey && provider.apiKey !== "proxy-managed" && !loadOAuthToken()) {
      writeKimiApiKey(provider.apiKey);
    }

    provider.baseUrl = expectedBase;
    provider.apiKey = "proxy-managed";

    writeUserConfig(config);
    log.info(`[auth-proxy] config updated: baseUrl → 127.0.0.1:${proxyPort}/<secret>`);
  } catch (err: any) {
    log.error(`[auth-proxy] ensureProxyConfig failed: ${err.message}`);
  }
}

// 启动 Auth Proxy 并同步 config（gateway 启动前调用）
async function ensureAuthProxy(): Promise<void> {
  try {
    const config = readUserConfig();
    // 只有配置了 kimi-coding provider 才启动代理
    if (!config?.models?.providers?.["kimi-coding"]) {
      setProxyAccessToken("");
      setProxySearchDedicatedKey("");
      await stopAuthProxy();
      return;
    }

    // 设置 token
    const token = resolveCurrentToken();
    setProxyAccessToken(token);

    // 设置 Kimi Search 专属 key
    const searchKey = readKimiSearchDedicatedApiKey();
    setProxySearchDedicatedKey(searchKey || "");

    // 启动代理（优先历史端口）
    const preferredPort = parseProxyPortFromConfig();
    const actualPort = await startAuthProxy(preferredPort > 0 ? preferredPort : undefined);

    // 同步 config（仅端口变化时写入）
    ensureProxyConfig(actualPort);
  } catch (err: any) {
    log.error(`[auth-proxy] ensureAuthProxy failed: ${err.message}`);
  }
}

// 启动 OAuth token 定时刷新（幂等：内部先 stop 再 start）
function ensureOAuthTokenRefresh(): void {
  startTokenRefresh((refreshedToken) => {
    // 直接更新代理内存中的 token，不再写 config
    setProxyAccessToken(refreshedToken.access_token);
  });
}

function requestGatewayStop(source: string): void {
  gateway.stop().catch((err) => {
    log.error(`Gateway 停止失败(${source}): ${err}`);
  });
}

// ── IPC 注册 ──

ipcMain.on("gateway:restart", (event) => {
  if (!assertTrustedIpcSender(event, "gateway:restart")) return;
  requestGatewayRestart("ipc:restart");
});
ipcMain.on("gateway:start", (event) => {
  if (!assertTrustedIpcSender(event, "gateway:start")) return;
  requestGatewayStart("ipc:start");
});
ipcMain.handle("gateway:stop", async (event) => {
  if (!assertTrustedIpcSender(event, "gateway:stop")) throw new Error("IPC sender not trusted");
  try {
    await gateway.stop();
  } catch (err) {
    log.error(`Gateway 停止失败(ipc:stop): ${err}`);
    throw err;
  }
});
ipcMain.handle("gateway:state", (event) => {
  if (!assertTrustedIpcSender(event, "gateway:state")) throw new Error("IPC sender not trusted");
  return gateway.getState();
});

// ── 内核升级/回退 ──
initKernelUpdater({
  stopGateway: () => gateway.stop(),
  startGateway: () => ensureGatewayRunning("kernel-update"),
  getGatewayState: () => gateway.getState(),
  push: (payload) => windowManager.pushKernelUpdateProgress(payload),
});
ipcMain.handle("kernel:get-update-state", (event) => {
  if (!assertTrustedIpcSender(event, "kernel:get-update-state")) throw new Error("IPC sender not trusted");
  return getKernelUpdateState();
});
ipcMain.handle("kernel:check", (event) => {
  if (!assertTrustedIpcSender(event, "kernel:check")) throw new Error("IPC sender not trusted");
  return checkKernelUpdate();
});
ipcMain.handle("kernel:update", (event, params?: { tag?: string }) => {
  if (!assertTrustedIpcSender(event, "kernel:update")) throw new Error("IPC sender not trusted");
  // 与 .openclaw 导入互斥：导入进行中禁止内核换装，避免状态目录被并发改写
  if (openclawStateImportLifecycle.isImportActive()) throw new Error(".openclaw 导入进行中，请稍后重试");
  return runKernelUpdate(params?.tag);
});
ipcMain.handle("kernel:rollback", (event) => {
  if (!assertTrustedIpcSender(event, "kernel:rollback")) throw new Error("IPC sender not trusted");
  // 与 .openclaw 导入互斥：导入进行中禁止内核回滚，避免状态目录被并发改写
  if (openclawStateImportLifecycle.isImportActive()) throw new Error(".openclaw 导入进行中，请稍后重试");
  return runKernelRollback();
});
ipcMain.on("app:quit", (event) => {
  if (!assertTrustedIpcSender(event, "app:quit")) return;
  app.quit();
});
ipcMain.handle("app:open-external", (event, url: string) => {
  if (!assertTrustedIpcSender(event, "app:open-external")) return Promise.reject(new Error("IPC sender not trusted"));
  // 安全面：仅允许 http/https 协议，阻止 file://、smb://、ms-msdt: 等危险协议
  // shell.openExternal 在 Windows 上走 ShellExecuteEx，会触发任意已注册协议处理器，
  // ms-msdt: / search-ms: 等历史上多次被用于恶意攻击（如 Follina）
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      log.warn(`[security] app:open-external 拒绝非 http(s) 协议: ${parsed.protocol} ${url.slice(0, 100)}`);
      return Promise.reject(new Error("仅允许 http/https 协议"));
    }
  } catch {
    log.warn(`[security] app:open-external 拒绝非法 URL: ${String(url).slice(0, 100)}`);
    return Promise.reject(new Error("非法 URL"));
  }
  return shell.openExternal(appendChannelUtm(url));
});
ipcMain.handle("app:open-path", (event, filePath: string) => {
  if (!assertTrustedIpcSender(event, "app:open-path")) return Promise.reject(new Error("IPC sender not trusted"));
  // 安全面：白名单见 safe-open.ts；workspace 内文件由 workspace:open-file 单独处理（有 path traversal 守卫）。
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (!isSafeOpenExt(ext)) {
    log.warn(`[security] app:open-path 拒绝非白名单扩展名: .${ext || "(无)"} ${filePath.slice(0, 100)}`);
    return Promise.reject(new Error("不支持的文件类型"));
  }
  return shell.openPath(filePath);
});
// 在文件管理器中定位文件（不执行文件，无白名单限制；聊天文件卡片「在文件夹中显示」用）
ipcMain.handle("app:reveal-path", (event, filePath: string) => {
  if (!assertTrustedIpcSender(event, "app:reveal-path")) return Promise.reject(new Error("IPC sender not trusted"));
  if (typeof filePath !== "string" || !filePath.trim()) {
    return Promise.reject(new Error("非法路径"));
  }
  shell.showItemInFolder(filePath);
  return Promise.resolve();
});

// 文件选择对话框 — 返回文件绝对路径数组
ipcMain.handle("dialog:select-files", async (event, options?: { filters?: Electron.FileFilter[] }) => {
  if (!assertTrustedIpcSender(event, "dialog:select-files")) throw new Error("IPC sender not trusted");
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win ?? {
    // fallback: 无聚焦窗口时仍可弹出
  } as any, {
    properties: ["openFile", "multiSelections"],
    filters: options?.filters,
  });
  if (result.canceled) {
    return [];
  }
  return result.filePaths;
});

// 读取剪贴板中的文件路径（macOS: NSFilenamesPboardType, Windows: CF_HDROP）
ipcMain.handle("clipboard:read-file-paths", (event) => {
  if (!assertTrustedIpcSender(event, "clipboard:read-file-paths")) throw new Error("IPC sender not trusted");
  try {
    if (process.platform === "darwin") {
      // macOS 剪贴板文件列表是 XML plist 格式
      const buf = clipboard.readBuffer("NSFilenamesPboardType");
      if (!buf?.length) return [];
      const xml = buf.toString("utf-8");
      const paths: string[] = [];
      // 简单解析 <string>...</string> 标签提取路径
      const re = /<string>(.*?)<\/string>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(xml)) !== null) {
        if (m[1] && !m[1].includes("<")) paths.push(m[1]);
      }
      return paths;
    }
    if (process.platform === "win32") {
      const buf = clipboard.readBuffer("FileNameW");
      if (!buf?.length) return [];
      // Windows FileNameW 是 UTF-16LE 以 null 结尾的路径
      const raw = buf.toString("utf16le").replace(/\0+$/, "");
      return raw ? [raw] : [];
    }
    return [];
  } catch {
    return [];
  }
});

// 读取本地文件为 base64（聊天文件附件走内核 apiAttachments 用）。
// 参数/大小判定在纯函数 evaluateFileReadTarget（src/file-read-base64.ts，可单测）：
// 仅接受已存在的绝对路径普通文件，≤16MB；超限返回 { error:"too-large", size }
// （不 throw，chat-ui 据此降级为旧版文本前缀行为），其余非法入参 reject。
// 安全决策（记录在案）：这是向渲染层暴露的任意绝对路径读取原语（≤16MB/次），
// 前提是 assertTrustedIpcSender 只放行 file:// 主界面 frame；渲染层 XSS 可借此
// 读本地文件，属已接受风险（用户自选文件场景需要），后续可加 picker 路径白名单收紧。
ipcMain.handle("file:read-base64", async (event, filePath: string) => {
  if (!assertTrustedIpcSender(event, "file:read-base64")) return Promise.reject(new Error("IPC sender not trusted"));
  let stat: { isFile: boolean; size: number } | null = null;
  try {
    const s = await fs.promises.stat(filePath);
    stat = { isFile: s.isFile(), size: s.size };
  } catch {
    stat = null;
  }
  const verdict = evaluateFileReadTarget(filePath, stat);
  if (!verdict.ok) {
    if (verdict.error === "too-large") {
      return { error: "too-large", size: verdict.size };
    }
    log.warn(`[security] file:read-base64 拒绝: ${verdict.error} ${String(filePath).slice(0, 100)}`);
    return Promise.reject(new Error(verdict.error));
  }
  const buf = await fs.promises.readFile(filePath);
  // TOCTOU 兜底：stat 与 readFile 之间文件可能被替换/增大，读后复核大小
  if (buf.length > FILE_READ_MAX_BYTES) {
    return { error: "too-large", size: buf.length };
  }
  return { base64: buf.toString("base64"), size: buf.length, mimeType: mimeTypeForPath(filePath) };
});

// ── Release Notes：读取打包的 changelog 并按版本过滤 ──

// 版本号数值化比较（YYYY.MMDD.N 格式不适合字符串比较）
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((s) => parseInt(s, 10) || 0);
  const pb = b.split(".").map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

ipcMain.handle("app:get-release-notes", (event, opts?: { all?: boolean }) => {
  if (!assertTrustedIpcSender(event, "app:get-release-notes")) throw new Error("IPC sender not trusted");
  // all=true：设置-关于页「查看更新日志」重看入口，返回全部条目且不触碰 lastShown 标记
  const showAll = opts?.all === true;
  try {
    const notesPath = path.join(app.getAppPath(), "release-notes.json");
    const raw = fs.readFileSync(notesPath, "utf-8");
    const allEntries: Array<{ version: string; notes: { zh?: string; en?: string } }> = JSON.parse(raw);
    if (!Array.isArray(allEntries)) return null;

    const currentVersion = app.getVersion();

    if (showAll) {
      const entries = allEntries
        .filter((entry) => entry?.version && compareVersions(entry.version, currentVersion) <= 0)
        .sort((a, b) => compareVersions(b.version, a.version));
      return { currentVersion, entries, locale: app.getLocale() };
    }

    const config = readCryoclawConfig();
    const lastShown = config?.lastShownReleaseNotesVersion;

    // 首次安装不弹更新日志，静默标记当前版本
    if (!lastShown) {
      if (config) {
        config.lastShownReleaseNotesVersion = currentVersion;
        writeCryoclawConfig(config);
      }
      return { currentVersion, entries: [], locale: app.getLocale() };
    }

    // 过滤出 lastShown < version <= currentVersion 的条目
    const entries = allEntries.filter((entry) => {
      if (!entry?.version) return false;
      if (lastShown && compareVersions(entry.version, lastShown) <= 0) return false;
      if (compareVersions(entry.version, currentVersion) > 0) return false;
      return true;
    });

    // 按版本降序排列（最新在前）
    entries.sort((a, b) => compareVersions(b.version, a.version));

    return {
      currentVersion,
      entries,
      locale: app.getLocale(),
    };
  } catch (err: any) {
    log.error(`读取 release-notes.json 失败: ${err?.message ?? err}`);
    return null;
  }
});

ipcMain.handle("app:dismiss-release-notes", (_e, version: string) => {
  if (!assertTrustedIpcSender(_e, "app:dismiss-release-notes")) throw new Error("IPC sender not trusted");
  // 参数校验：version 必须是非空字符串
  if (typeof version !== "string" || !version.trim()) return;
  try {
    // 配置不存在时直接跳过，避免用空对象覆盖已有字段
    const config = readCryoclawConfig();
    if (!config) return;
    config.lastShownReleaseNotesVersion = version;
    writeCryoclawConfig(config);
  } catch (err: any) {
    log.error(`写入 lastShownReleaseNotesVersion 失败: ${err?.message ?? err}`);
  }
});

// Chat UI 侧边栏 IPC
ipcMain.on("app:open-settings", (event) => {
  if (!assertTrustedIpcSender(event, "app:open-settings")) return;
  openSettingsInMainWindow().catch((err) => {
    log.error(`app:open-settings 打开主窗口设置失败: ${err}`);
  });
});
ipcMain.on("app:open-webui", (event) => {
  if (!assertTrustedIpcSender(event, "app:open-webui")) return;
  const port = gateway.getPort();
  const token = gateway.getToken().trim();
  // UI 端只从 URL fragment (#token=) 读取 token，不从 query param (?token=) 读取
  const fragment = token ? `#token=${encodeURIComponent(token)}` : "";
  shell.openExternal(`http://127.0.0.1:${port}/${fragment}`);
});
ipcMain.handle("gateway:port", (event) => {
  if (!assertTrustedIpcSender(event, "gateway:port")) throw new Error("IPC sender not trusted");
  return gateway.getPort();
});

registerSetupIpc({
  windowManager,
  ensureGatewayRunning,
  onOAuthLoginSuccess: ensureOAuthTokenRefresh,
  onBrowserModeChanged: () => requestGatewayRestart("setup:webbridge-fallback"),
});
registerSettingsIpc({
  requestGatewayRestart: () => requestGatewayRestart("settings:kimi-search"),
  getGatewayToken: () => gateway.getToken(),
  importOpenclawState: (filePath) => openclawStateImportLifecycle.importOpenclawState(filePath),
});
registerSkillStoreIpc();
registerPluginStoreIpc();
registerWorkspaceIpc();
registerGitIpc();
// 启动即探测 git 并缓存（worktree 入口降级依据），渲染层经 git:detect 取结果
void detectGitCached();

// ── 退出 ──

async function quit(): Promise<void> {
  stopTokenRefresh();
  await stopAuthProxy();
  await stopGatewayControlServer();
  analytics.track("app_closed");
  await analytics.shutdown();
  windowManager.destroy();
  await gateway.stop();
  tray.destroy();
  app.quit();
}

// Setup 完成逻辑已内联到 setup-ipc.ts 的 setup:complete handler 中

// 渲染进程通知 Setup 视图进入/退出状态
ipcMain.on("app:setup-view-state", (_event, active: boolean) => {
  if (!assertTrustedIpcSender(_event, "app:setup-view-state")) return;
  windowManager.inSetupView = active;
});

// ── macOS Dock 可见性：始终保留 Dock 图标 ──
// 红灯关闭走 hide-to-tray，若同时 hide Dock，用户会误以为 App 已退出（feedback #1060）。
// 保留 Dock 让用户随时点击恢复窗口；后台常驻仍由 Tray 维持。

function updateDockVisibility(): void {
  if (process.platform !== "darwin" || !app.dock) return;
  app.dock.show();
}

let hasAppFocus = false;

// 仅在“失焦 -> 聚焦”状态跃迁时上报一次，避免窗口切换导致重复埋点。
function syncAppFocusState(trigger: string): void {
  const focused = BrowserWindow.getAllWindows().some(
    (w) => !w.isDestroyed() && w.isFocused(),
  );
  if (focused === hasAppFocus) {
    return;
  }
  hasAppFocus = focused;
  if (focused) {
    analytics.track("app_focused", { trigger });
  }
}

// ── 应用就绪 ──

app.whenReady().then(async () => {
  log.info("app ready");

  // 所有窗口的 show/hide/closed 事件统一驱动 Dock 可见性
  app.on("browser-window-created", (_e, win) => {
    win.on("show", updateDockVisibility);
    win.on("hide", updateDockVisibility);
    win.on("closed", updateDockVisibility);
  });
  app.on("browser-window-focus", () => {
    syncAppFocusState("browser-window-focus");
  });
  app.on("browser-window-blur", () => {
    // blur 与 focus 可能连续触发，延迟到当前事件循环末尾再判定全局焦点。
    setTimeout(() => syncAppFocusState("browser-window-blur"), 0);
  });
  // macOS: 最小化应用菜单，保留 Cmd+, 打开设置
  // Windows: 隐藏菜单栏，避免标题栏下方出现菜单条
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          {
            label: "Settings…",
            accelerator: "CommandOrControl+,",
            click: () => {
              openSettingsInMainWindow().catch((err) => {
                log.error(`Cmd+, 打开主窗口设置失败: ${err}`);
              });
            },
          },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "windowMenu" },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }
  analytics.init();
  analytics.track("app_launched");

  // App 自动更新（electron-updater + GitHub Releases）：仅打包环境启用，
  // 内部 15s 延迟静默检查，不阻塞首屏窗口
  initAppUpdater({
    push: (s) => {
      windowManager.pushAppUpdateState(s);
      // downloaded 态时托盘菜单挂「重启以更新」入口（状态复位后自动消失）
      tray.setAppUpdateReady(s.status === "downloaded");
    },
    beforeQuitAndInstall: () => windowManager.prepareForAppQuit(),
  });
  tray.create({
    windowManager,
    gateway,
    onRestartGateway: () => requestGatewayRestart("tray:restart"),
    onStartGateway: () => requestGatewayStart("tray:start"),
    onStopGateway: () => requestGatewayStop("tray:stop"),
    onOpenSettings: () => {
      openSettingsInMainWindow().catch((err) => {
        log.error(`托盘设置打开失败: ${err}`);
      });
    },
    onRestartAndUpdate: () => {
      try {
        quitAndInstallAppUpdate();
      } catch (err: any) {
        log.warn(`托盘「重启以更新」触发失败: ${err?.message ?? err}`);
      }
    },
    onQuit: quit,
  });

  // 内核更新启动静默检查（30s 延迟，错开 App 更新的 15s 首查）：
  // 仅填充 lastCheck 版本缓存，设置-关于页打开时经 kernel:get-update-state 反映；
  // 失败只记 warn，不打扰用户
  const kernelStartupCheckTimer = setTimeout(() => {
    checkKernelUpdate().catch((err: any) => {
      log.warn(`[kernel-updater] 启动静默检查失败: ${err?.message ?? err}`);
    });
  }, 30 * 1000);
  kernelStartupCheckTimer.unref?.();

  // 内核升级后的配置适配（如移除已废弃字段），须在配置健康检查与 gateway 启动前完成。
  migrateOpenclawConfigForKernelUpgrade();

  // Gateway 本地控制服务：CLI wrapper 把 `openclaw gateway restart/status` 转发到这里，
  // 走与内核升级同款的托管停启路径（内核原生 daemon 模型在 asar 内嵌部署下不可用）。
  // 服务本身不依赖 gateway 已运行（status/restart 读实时状态），失败不阻塞启动。
  void startGatewayControlServer({
    getStatus: () => {
      const startedAt = gateway.getStartedAt();
      return {
        running: gateway.getState() === "running",
        pid: gateway.getPid(),
        port: gateway.getPort(),
        uptimeMs: startedAt ? Date.now() - startedAt : null,
      };
    },
    restart: async () => {
      await gateway.stop();
      const ok = await ensureGatewayRunning("gateway-control:restart");
      if (!ok) throw new Error("Gateway 重启后未通过健康检查");
    },
  }).then((port) => {
    if (port === null) {
      log.warn("[gateway-control] 控制服务未能启动，CLI gateway 命令不可用");
    }
  });

  const configHealth = inspectUserConfigHealth();
  if (configHealth.exists && !configHealth.validJson) {
    const action = reportConfigInvalidFailure(configHealth.parseError);
    if (action === "restore-last-known-good") {
      try {
        restoreLastKnownGoodConfigSnapshot();
        await startGatewayAndShowMain("startup:restore-last-known-good");
        return;
      } catch (err: any) {
        log.error(`启动前恢复 last-known-good 失败: ${err?.message ?? err}`);
        openRecoverySettings("gateway-recovery-failed");
        return;
      }
    }
    if (action === "open-settings") {
      openRecoverySettings("config-invalid-json");
      return;
    }
    return;
  }

  // 四态归属判定
  const ownership = detectOwnership();
  log.info(`[startup] config ownership: ${ownership}`);

  switch (ownership) {
    case "cryoclaw": {
      // 状态 1：正常启动
      // 窗口创建与同步配置迁移并行（R20）：迁移是纯本地 JSON 改写，不读窗口；
      // 窗口渲染不读 openclaw.json。startGatewayAndShowMain 内的 showMainWindow 会复用此窗口。
      const earlyWindow = showMainWindow().catch((err) => {
        log.error(`启动提前开窗失败: ${err}`);
      });
      migrateSessionMemoryHook();
      migrateDisableGatewayUpdateCheck();
      migrateDeprecatedDingtalkFields();
      migrateBrowserProfileConfig();
      void reconcileCliOnAppLaunch().catch((err) => {
        log.error(`[migrate] CLI launch reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      await startGatewayAndShowMain("app:startup");
      await earlyWindow;
      break;
    }

    case "legacy-cryoclaw": {
      // 状态 2：老用户升级 → 自动迁移（窗口与迁移并行，同上）
      log.info("[startup] legacy CryoClaw detected, migrating...");
      const earlyWindow = showMainWindow().catch((err) => {
        log.error(`启动提前开窗失败: ${err}`);
      });
      migrateFromLegacy();
      migrateSessionMemoryHook();
      migrateDisableGatewayUpdateCheck();
      migrateDeprecatedDingtalkFields();
      migrateBrowserProfileConfig();
      void reconcileCliOnAppLaunch().catch((err) => {
        log.error(`[migrate] CLI launch reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      await startGatewayAndShowMain("app:startup:legacy-migrate");
      await earlyWindow;
      break;
    }

    case "external-openclaw":
      // 状态 3：外部 OpenClaw → 接管流程
      log.info("[startup] external OpenClaw config detected, starting takeover...");
      await handleExternalOpenclawTakeover();
      break;

    case "fresh":
      // 状态 4：全新安装 → 主窗口显示 Setup 视图
      await showMainWindow("setup");
      break;
  }
});

// ── 二次启动 → 聚焦已有窗口 ──

app.on("second-instance", () => {
  showMainWindow().catch((err) => {
    log.error(`second-instance 打开主窗口失败: ${err}`);
  });
});

app.on("web-contents-created", (_event, webContents) => {
  if (webContents.getType() !== "window") {
    return;
  }
  attachRendererDebugHandlers(`id=${webContents.id}`, webContents);
});

// ── macOS: 点击 Dock 图标时恢复窗口 ──

app.on("activate", () => {
  showMainWindow().catch((err) => {
    log.error(`activate 打开主窗口失败: ${err}`);
  });
});

// ── 托盘应用：所有窗口关闭不退出 ──

app.on("window-all-closed", () => {
  // 不退出 — 后台保持运行
});

// ── 退出前清理 ──

app.on("before-quit", () => {
  // 先放行窗口关闭，避免 close handler 拦截 WM_CLOSE 导致 NSIS 安装器报"无法关闭"
  windowManager.prepareForAppQuit();
  windowManager.destroy();
  stopAuthProxy();
  stopGatewayControlServer().catch(() => {});
  gateway.stop().catch(() => {});
  // 清理临时缓存（gateway 已停，内核临时目录安全可删；用户配置/会话历史在
  // ~/.openclaw 下不在清理范围）。同步执行保证退出前完成；内部全 try/catch。
  try {
    cleanGatewayLockFiles();
    runQuitCleanup();
  } catch {}
  // diagLog 已改 WriteStream 异步缓冲，退出前 flush 落盘（带超时，不阻塞退出）
  closeDiagLogStream().catch(() => {});
});


