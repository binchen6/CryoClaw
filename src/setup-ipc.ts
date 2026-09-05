import { app, BrowserWindow, ipcMain } from "electron";
import { ensureGatewayAuthTokenInConfig, resolveGatewayAuthToken } from "./gateway-auth";
import { assertTrustedIpcSender } from "./ipc-sender-guard";
import * as analytics from "./analytics";
import { getLaunchAtLoginState, setLaunchAtLoginEnabled } from "./launch-at-login";
import {
  PROVIDER_PRESETS,
  MOONSHOT_SUB_PLATFORMS,
  CUSTOM_PROVIDER_PRESETS,
  verifyProvider,
  readUserConfig,
  writeUserConfig,
} from "./provider-config";
import * as log from "./logger";
import {
  detectEnvProviderKeys,
  resolveEnvCandidate,
  buildEnvProviderConfig,
  MIN_ENV_KEY_LENGTH,
} from "./setup-env-detect";
import { installCli, uninstallCli } from "./cli-integration";
import { saveKimiSearchConfig, ensureMemorySearchProxyConfig } from "./kimi-config";
import { startAuthProxy, setProxyAccessToken, getProxyPort } from "./kimi-auth-proxy";
import {
  detectExistingInstallation,
  killPortProcess,
  uninstallGatewayDaemon,
  uninstallGlobalOpenclaw,
} from "./install-detector";
import { markSetupComplete } from "./cryoclaw-config";
import { recordSetupBaselineConfigSnapshot } from "./config-backup";
import type { WindowManager } from "./window";
import {
  applyBrowserModeConfig,
  cleanExtensionBlocklist,
  getBrowserRunningState,
  getDefaultBrowser,
  installForDefaultBrowser,
  isBrowserInstalled,
  isExtensionBlocklisted,
  killBackgroundProcesses,
} from "./browser";
import {
  installWebbridge,
  installWebbridgeSkill,
  resolveWebbridgeExtensionSpec,
  runWebbridgeSetupTask,
} from "./webbridge";
import { readWebbridgeExtensionId } from "./constants";

interface SetupIpcDeps {
  windowManager: WindowManager;
  ensureGatewayRunning: (source: string) => Promise<boolean>;
  onOAuthLoginSuccess?: () => void;
  // Setup 完成后若降级到 openclaw 模式重写 config，触发 gateway 重启
  onBrowserModeChanged?: () => void;
}

let latestSetupCompletedProps: Record<string, string> | null = null;

// 通知所有窗口：webbridge precheck 状态可能已变（用于刷新左侧栏 pill）。
// 不重启 gateway 的场景（setup-task 静默装好扩展）必须主动通知，否则 chat-ui pill 卡在旧结果。
function broadcastWebbridgeStateChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("webbridge:state-changed");
  }
}

type SetupActionResult = {
  success: boolean;
  message?: string;
};

// 统一封装 Setup 埋点：started/result 结构固定，避免每个 handler 手写重复逻辑。
async function runTrackedSetupAction<T extends SetupActionResult>(
  action: analytics.SetupAction,
  props: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  analytics.trackSetupActionStarted(action, props);
  try {
    const result = await run();
    const latencyMs = Date.now() - startedAt;
    analytics.trackSetupActionResult(action, {
      success: result.success,
      latencyMs,
      errorType: result.success ? undefined : analytics.classifyErrorType(result.message),
      props,
    });
    return result;
  } catch (err) {
    analytics.trackSetupActionResult(action, {
      success: false,
      latencyMs: Date.now() - startedAt,
      errorType: analytics.classifyErrorType(err),
      props,
    });
    throw err;
  }
}

// setup:save-config 与 setup:adopt-env-key 共用的落盘逻辑：
// 写 provider fragment + primary model + 一批 baseline 默认值（行为与 R4 手动路径完全一致）。
// 成功落盘后缓存埋点上下文（latestSetupCompletedProps），失败抛出由调用方转 { success:false }。
function persistSetupProviderConfig(params: {
  providerKey: string;
  providerConfig: Record<string, unknown>;
  primaryModel: string;
  kimiCode: boolean;
  // buildSetupCompletedProps 用的原始表单字段（provider/modelID/baseURL/subPlatform）
  trackedSource: {
    provider: string;
    modelID: string;
    baseURL?: string;
    subPlatform?: string;
  };
}): void {
  const { providerKey, providerConfig, primaryModel, kimiCode } = params;
  // 读取现有配置
  const config = readUserConfig();

  // 初始化嵌套结构
  config.models ??= {};
  config.models.providers ??= {};
  config.agents ??= {};
  config.agents.defaults ??= {};
  config.agents.defaults.model ??= {};
  // 长对话压缩保护：保留最近轮次原文、审计摘要质量、守住关键标识符
  config.agents.defaults.compaction ??= {};
  config.agents.defaults.compaction.mode = "safeguard";

  config.models.providers[providerKey] = providerConfig;
  config.agents.defaults.model.primary = primaryModel;

  // kimi-code 联动：启用搜索插件 + 记忆搜索 embedding（真实 key 已由前端写 sidecar）
  if (kimiCode) {
    saveKimiSearchConfig(config, { enabled: true });
    ensureMemorySearchProxyConfig(config, getProxyPort());
  }

  // 统一 gateway 鉴权配置：local 模式 + 持久化 token（单一真相源）
  config.gateway ??= {};
  config.gateway.mode = "local";
  ensureGatewayAuthTokenInConfig(config);

  // 默认使用 kimi-webbridge 模式：browser 插件关闭 + skill 默认启用
  // Setup 完成后台会下载二进制 + 装浏览器扩展；下载失败会降级到 openclaw 模式
  Object.assign(config, applyBrowserModeConfig(config, "webbridge"));

  // 显式禁用 iMessage 频道（openclaw 默认启用，会因 macOS 权限拒绝产生大量错误日志）
  config.channels ??= {};
  config.channels.imessage ??= {};
  config.channels.imessage.enabled = false;

  // 禁止 gateway 自行检查 npm 更新（CryoClaw 整包打包，用户无法独立更新 gateway）
  config.update ??= {};
  config.update.checkOnStart = false;

  // 开箱即用：显式启用全部工具（openclaw 2026.3.2 起默认 messaging，只有消息类工具）
  config.tools ??= {};
  config.tools.profile = "full";

  // 启用实验性 update_plan 工具（任务拆解/进度跟踪）
  config.tools.experimental ??= {};
  config.tools.experimental.planTool = true;

  // Step 2 不写 wizard，避免生成 schema 未识别字段。
  // Setup 完成标记仅在 Step 3（Gateway 成功启动）后写入 wizard.lastRunAt。
  delete config.wizard;

  writeUserConfig(config);
  // 配置落盘成功后再缓存埋点上下文，避免失败时污染事件参数。
  latestSetupCompletedProps = buildSetupCompletedProps(params.trackedSource, config);
}

// 注册 Setup 相关 IPC
export function registerSetupIpc(deps: SetupIpcDeps): void {
  const { windowManager, ensureGatewayRunning } = deps;

  // ── 环境检测：检查已有 OpenClaw 安装 ──
  ipcMain.handle("setup:detect-installation", async (event) => {
    if (!assertTrustedIpcSender(event, "setup:detect-installation")) throw new Error("IPC sender not trusted");
    try {
      const result = await detectExistingInstallation();
      return { success: true, data: result };
    } catch (err: any) {
      log.error(`[setup] 环境检测失败: ${err?.message ?? err}`);
      return { success: true, data: { portInUse: false, portProcess: "", portPid: 0, globalInstalled: false, globalPath: "" } };
    }
  });

  // ── 冲突处理：卸载旧版 ──
  ipcMain.handle("setup:resolve-conflict", async (_event, params: { action: "uninstall"; pid?: number }) => {
    if (!assertTrustedIpcSender(_event, "setup:resolve-conflict")) throw new Error("IPC sender not trusted");
    if (params.action !== "uninstall") {
      return { success: false, message: `不支持的操作: ${params.action}` };
    }
    const { pid } = params;
    try {
      // 顺序：① 卸载系统守护进程 + 清理锁文件（停止 launchd/schtasks 的自动重启）
      //       ② 杀掉残留进程（守护进程卸载后不会再被拉起）
      //       ③ 卸载 npm 全局包
      await uninstallGatewayDaemon();
      // 安全面：pid 必须来自 detect-installation 探测到的 gateway 端口占用进程，
      // 不能接受渲染进程任意指定的 PID（防止杀任意系统进程造成本地 DoS）。
      // 这里用 detectExistingInstallation 重新探测当前端口占用，校验 pid 一致。
      if (pid && pid > 0) {
        const DEFAULT_PORT = 18789;
        const detected = await detectExistingInstallation(DEFAULT_PORT);
        if (detected.portPid !== pid) {
          log.warn(`[setup] 拒绝杀 PID ${pid}：当前 gateway 端口占用进程为 PID ${detected.portPid}`);
        } else {
          await killPortProcess(pid);
        }
      }
      await uninstallGlobalOpenclaw();
      // 保留 ~/.openclaw/：聊天记录、项目数据都在里面
      log.info("[setup] 旧版 OpenClaw 卸载完成");
      return { success: true };
    } catch (err: any) {
      log.error(`[setup] 冲突处理失败: ${err?.message ?? err}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });

  // ── 读取系统开机启动状态（Setup Step 3 开关回填） ──
  ipcMain.handle("setup:get-launch-at-login", async (event) => {
    if (!assertTrustedIpcSender(event, "setup:get-launch-at-login")) throw new Error("IPC sender not trusted");
    try {
      return {
        success: true,
        data: getLaunchAtLoginState(app),
      };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // ── Kimi OAuth ──
  ipcMain.handle("kimi-oauth:login", async (event) => {
    if (!assertTrustedIpcSender(event, "kimi-oauth:login")) throw new Error("IPC sender not trusted");
    const { kimiOAuthLogin } = await import("./kimi-oauth");
    const result = await kimiOAuthLogin();
    // 轮询成功后将窗口拉回前台，避免用户停留在浏览器找不到程序
    if (result.success) {
      deps.onOAuthLoginSuccess?.();
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    }
    return result;
  });

  ipcMain.handle("kimi-oauth:cancel", async (event) => {
    if (!assertTrustedIpcSender(event, "kimi-oauth:cancel")) throw new Error("IPC sender not trusted");
    const { kimiOAuthCancel } = await import("./kimi-oauth");
    kimiOAuthCancel();
  });

  ipcMain.handle("kimi-oauth:logout", async (event) => {
    if (!assertTrustedIpcSender(event, "kimi-oauth:logout")) throw new Error("IPC sender not trusted");
    const { kimiOAuthLogout } = await import("./kimi-oauth");
    kimiOAuthLogout();
  });

  ipcMain.handle("kimi-oauth:status", async (event) => {
    if (!assertTrustedIpcSender(event, "kimi-oauth:status")) throw new Error("IPC sender not trusted");
    const { getOAuthStatus } = await import("./kimi-oauth");
    return getOAuthStatus();
  });

  // ── 验证 API Key ──
  ipcMain.handle("setup:verify-key", async (_event, params) => {
    if (!assertTrustedIpcSender(_event, "setup:verify-key")) throw new Error("IPC sender not trusted");
    const provider = typeof params?.provider === "string" ? params.provider : "";
    // kimi-code 验证前：确保 proxy 已启动并持有最新 token
    if (params?.subPlatform === "kimi-code" && params?.apiKey) {
      if (getProxyPort() <= 0) {
        await startAuthProxy();
      }
      setProxyAccessToken(params.apiKey);
    }
    return runTrackedSetupAction("verify_key", { provider }, async () =>
      verifyProvider({ ...params, proxyPort: getProxyPort() }));
  });

  // ── 保存配置到 ~/.openclaw/openclaw.json ──
  // R4：provider fragment 由前端用共享纯函数构造（与 Settings → 服务商新增同一份逻辑），
  // 主进程不再拼装 provider 配置；kimi-code 的真实 key 也已由前端写 sidecar，
  // 这里只负责落盘 + baseline 默认值 + kimi-code 联动（搜索插件 / memory embedding）。
  ipcMain.handle("setup:save-config", async (_event, params) => {
    if (!assertTrustedIpcSender(_event, "setup:save-config")) throw new Error("IPC sender not trusted");
    const providerKey = typeof params?.providerKey === "string" ? params.providerKey.trim() : "";
    const providerConfig =
      params?.providerConfig && typeof params.providerConfig === "object" && !Array.isArray(params.providerConfig)
        ? params.providerConfig
        : null;
    const primaryModel = typeof params?.primaryModel === "string" ? params.primaryModel.trim() : "";
    const kimiCode = params?.kimiCode === true;
    const trackedProps = {
      provider: params?.provider,
      model: params?.modelID,
      sub_platform: params?.subPlatform || undefined,
      custom_preset: params?.customPreset || undefined,
    };
    return runTrackedSetupAction("save_config", trackedProps, async () => {
      if (!providerKey || !providerConfig || !primaryModel) {
        return { success: false, message: "缺少 provider 配置参数。" };
      }
      try {
        persistSetupProviderConfig({ providerKey, providerConfig, primaryModel, kimiCode, trackedSource: params });
        return { success: true };
      } catch (err: any) {
        return { success: false, message: err.message || String(err) };
      }
    });
  });

  // ── 快速通道：检测环境变量中已有的 provider API Key ──
  // 只返回掩码列表（providerKey/envVar/maskedKey），明文 key 不出主进程。
  ipcMain.handle("setup:detect-env-keys", async (event) => {
    if (!assertTrustedIpcSender(event, "setup:detect-env-keys")) throw new Error("IPC sender not trusted");
    try {
      return { success: true, data: detectEnvProviderKeys(process.env) };
    } catch (err: any) {
      log.error(`[setup] 环境变量 key 检测失败: ${err?.message ?? err}`);
      return { success: true, data: [] };
    }
  });

  // ── 快速通道：采用环境变量 key（验证 → 落盘，复用 save-config 的共享落盘逻辑） ──
  // 渲染层只传 { providerKey, envVar }；明文 key 由主进程自己从 process.env 读。
  ipcMain.handle("setup:adopt-env-key", async (_event, params) => {
    if (!assertTrustedIpcSender(_event, "setup:adopt-env-key")) throw new Error("IPC sender not trusted");
    const providerKey = typeof params?.providerKey === "string" ? params.providerKey.trim() : "";
    const envVar = typeof params?.envVar === "string" ? params.envVar.trim() : "";
    // 安全面：(providerKey, envVar) 必须是 ENV_KEY_CANDIDATES 表内组合，
    // 防渲染层任意指定环境变量名偷值。
    const candidate = resolveEnvCandidate(providerKey, envVar);
    const trackedProps = {
      provider: candidate?.verifyProvider ?? providerKey,
      model: candidate?.defaultModel,
      via: "env_quickstart",
    };
    const result = await runTrackedSetupAction("save_config", trackedProps, async () => {
      if (!candidate) {
        return { success: false, message: "未知的 provider/环境变量组合。" };
      }
      const apiKey = (process.env[envVar] ?? "").trim();
      if (apiKey.length < MIN_ENV_KEY_LENGTH) {
        return { success: false, message: `环境变量 ${envVar} 不存在或值无效。` };
      }
      // 真实验证（与手动配置同一条 verifyProvider 链路）
      const verify = await verifyProvider({
        provider: candidate.verifyProvider,
        apiKey,
        subPlatform: candidate.verifySubPlatform,
        customPreset: candidate.verifyCustomPreset,
        modelID: candidate.defaultModel,
        proxyPort: getProxyPort(),
      });
      if (!verify.success) {
        // 验证失败不落盘
        return { success: false, message: verify.message ?? "验证失败" };
      }
      try {
        const providerConfig = buildEnvProviderConfig(candidate, apiKey, verify.supportsImage);
        persistSetupProviderConfig({
          providerKey: candidate.providerKey,
          providerConfig,
          primaryModel: `${candidate.providerKey}/${candidate.defaultModel}`,
          kimiCode: false,
          trackedSource: {
            provider: candidate.verifyProvider,
            modelID: candidate.defaultModel,
            baseURL: candidate.baseUrl,
            subPlatform: candidate.verifySubPlatform,
          },
        });
        return { success: true };
      } catch (err: any) {
        return { success: false, message: err.message || String(err) };
      }
    });
    return result.success
      ? { ok: true, providerKey, model: candidate?.defaultModel }
      : { ok: false, providerKey, error: result.message };
  });

  // ── Setup 完成：启动 Gateway → 标记完成 → 导航到 Chat ──
  ipcMain.handle("setup:complete", async (_event, params?: { installCli?: boolean; launchAtLogin?: boolean; sessionMemory?: boolean; enableWebbridge?: boolean }) => {
    if (!assertTrustedIpcSender(_event, "setup:complete")) throw new Error("IPC sender not trusted");
    const launchAtLogin = typeof params?.launchAtLogin === "boolean" ? params.launchAtLogin : undefined;
    const sessionMemory = params?.sessionMemory !== false;
    // enableWebbridge 显式 false 才禁用——missing/undefined 都按"启用"处理（兼容老前端）
    const enableWebbridge = params?.enableWebbridge !== false;
    return runTrackedSetupAction("complete", { launch_at_login: launchAtLogin, session_memory: sessionMemory, enable_webbridge: enableWebbridge }, async () => {
      if (typeof launchAtLogin === "boolean") {
        setLaunchAtLoginEnabled(app, launchAtLogin);
      }

      // 写入 session-memory hook 配置
      try {
        const config = readUserConfig();
        config.hooks ??= {};
        config.hooks.internal = {
          enabled: true,
          entries: {
            ...config.hooks.internal?.entries,
            "session-memory": { enabled: sessionMemory },
          },
        };
        writeUserConfig(config);
      } catch (err: any) {
        log.error(`[setup] 写入 hooks 配置失败: ${err?.message ?? err}`);
      }

      // 用户在 Setup 末关闭了 WebBridge toggle → 直接写 openclaw 模式，不跑 webbridge 后台任务
      if (!enableWebbridge) {
        try {
          const config = readUserConfig();
          Object.assign(config, applyBrowserModeConfig(config, "openclaw"));
          writeUserConfig(config);
          log.info("[setup] 用户禁用 WebBridge → 已写入 openclaw 模式");
        } catch (err: any) {
          log.error(`[setup] 写入 openclaw 模式失败: ${err?.message ?? err}`);
        }
      }

      // Inline completion: start gateway → mark complete → navigate to chat
      const running = await ensureGatewayRunning("setup:complete");
      if (!running) {
        return {
          success: false,
          message: "Gateway 启动超时或失败，请稍后重试。",
        };
      }

      try {
        // gateway schema 兼容：保留 wizard.lastRunAt
        const config = readUserConfig();
        config.wizard ??= {};
        config.wizard.lastRunAt = new Date().toISOString();
        delete config.wizard.pendingAt;
        writeUserConfig(config);

        // 写入 cryoclaw.config.json 归属标记
        markSetupComplete();
      } catch (err: any) {
        log.error(`[setup] 写入 setup 完成标记失败: ${err?.message ?? err}`);
        return { success: false, message: err?.message ?? String(err) };
      }

      // 导航到 Chat 视图，携带最新 gateway token 避免 renderer 使用旧 token
      windowManager.inSetupView = false;
      windowManager.setupPending = false;
      windowManager.navigate({ view: "chat", token: resolveGatewayAuthToken() });
      recordSetupBaselineConfigSnapshot();

      analytics.track("setup_completed", latestSetupCompletedProps ?? {});

      // CLI 开关显式持久化：开启则安装，关闭则清理，失败都不阻塞 Setup。
      // 原始 error message 含绝对路径，只上报分类枚举给分析侧。
      if (params?.installCli !== false) {
        const cliResult = await installCli();
        if (cliResult.success) {
          analytics.track("cli_installed", { method: "setup_wizard" });
        } else {
          log.error(`[setup] CLI install failed: ${cliResult.message}`);
          analytics.track("cli_install_failed", {
            method: "setup_wizard",
            error_type: analytics.classifyErrorType(cliResult.message),
          });
        }
      } else {
        const cliResult = await uninstallCli();
        if (!cliResult.success) {
          log.error(`[setup] CLI uninstall failed: ${cliResult.message}`);
          analytics.track("cli_uninstall_failed", {
            method: "setup_wizard",
            error_type: analytics.classifyErrorType(cliResult.message),
          });
        }
      }

      // 用户在 Setup 末关闭 WebBridge toggle → 不跑后台 task，直接 return
      if (!enableWebbridge) {
        return { success: true };
      }

      // 后台静默 task：下载 webbridge 二进制 + 装浏览器扩展。
      // fire-and-forget——Setup 已结束，主窗已打开，不阻塞用户。
      // 下载失败时会降级到 openclaw 模式并通过 onBrowserModeChanged 触发 gateway 重启；
      // 失败状态由主窗左侧栏的"WebBridge 插件需要修复"提示通知用户。
      runWebbridgeSetupTask({
        installer: () => installWebbridge(),
        // Pre-step：用户之前从 chrome://extensions UI 删过扩展时，extId 会落到
        // Preferences.extensions.external_uninstalls 黑名单，之后写 External Extensions JSON
        // Chrome 启动会"读 JSON → 查黑名单 → 命中 → 静默跳过安装"，导致 setup 看起来全部成功
        // 但扩展永远装不上。这里在装扩展前做一次"清黑名单或延后"：
        //   - 浏览器没在跑       → 清黑名单 + 装扩展（best effort）
        //   - 浏览器在 background → 杀进程 + 清黑名单 + 装扩展
        //   - 浏览器在 foreground → 跳过本次安装，保持 webbridge 模式让侧边栏 pill 接管提示
        //                          （绝不 throw 走 openclaw 降级——那会导致 pill 完全不显示）
        installExtensions: async (extId) => {
          // 单一默认浏览器策略：只对系统默认浏览器（Chrome/Edge）操作。
          // 默认非 Chrome/Edge → 返回 [] → setup-task 严格语义降级 openclaw 模式。
          const def = await getDefaultBrowser();
          if (!def) {
            log.info(
              "[setup] 系统默认浏览器不是 Chrome 或 Edge，跳过 webbridge 扩展安装（将降级到 openclaw 模式）",
            );
            return [];
          }
          const target = def.target;
          if (
            isBrowserInstalled(target) &&
            (await isExtensionBlocklisted(target, extId))
          ) {
            const state = await getBrowserRunningState(target);
            if (state === "foreground") {
              // 不 throw：保持 webbridge 模式，pill 显示「连接你的常用浏览器」
              // 用户后续从 Settings → 高级 → 修复并启用，那条路径会要求关浏览器再清 blocklist + 装扩展
              log.info(
                `[setup] ${target.name} 正在运行且扩展在 external_uninstalls 黑名单——跳过本次扩展安装，保持 webbridge 模式让侧边栏 pill 接管提示`,
              );
              return [
                {
                  browserId: target.id,
                  browserName: target.name,
                  result: "skipped",
                },
              ];
            }
            // background-only：Win Edge 经典坑——窗口已关但后台扩展进程还在。
            // 强杀让 External Extensions JSON 在用户下次打开时被冷读取。
            if (state === "background-only") {
              const k = await killBackgroundProcesses(target);
              log.info(
                `[setup] ${target.name} background-only 进程清理: killed=${k.killed}${
                  k.error ? ` error=${k.error}` : ""
                }`,
              );
            }
            const r = await cleanExtensionBlocklist(target, extId);
            log.info(`[setup] ${target.name} blocklist cleanup: ${r}`);
          }
          const spec = resolveWebbridgeExtensionSpec();
          if (!spec) {
            log.error(
              "[setup] 无法解析 WebBridge ExtensionSpec（build-config 或 CRX 缺失），跳过扩展安装",
            );
            return [];
          }
          return installForDefaultBrowser(spec);
        },
        readConfig: readUserConfig,
        writeConfig: writeUserConfig,
        applyMode: applyBrowserModeConfig,
        extensionId: readWebbridgeExtensionId(),
        onConfigRewritten: () => deps.onBrowserModeChanged?.(),
        installSkill: (bp) => installWebbridgeSkill(bp),
        logger: {
          info: (msg) => log.info(msg),
          error: (msg) => log.error(msg),
        },
      })
        .then((summary) => {
          analytics.track("webbridge_setup_task", {
            outcome: summary.outcome,
            webbridge_installed: summary.webbridgeInstalled,
            has_error: Boolean(summary.error),
          });
          // 失败 → setup task 内部已 fallback openclaw；用户后续通过侧边栏 pill modal 看到修复入口
          if (summary.outcome !== "webbridge-ready") {
            log.info(`[setup] webbridge 安装失败，已降级 openclaw：${summary.error ?? "未知原因"}`);
          }
          // 成功路径不会触发 gateway 重启 → 主动广播一次让 chat-ui pill 重查 precheck
          // （不然 pill 卡在 app 启动那次 tick 的旧结果上：装扩展前=true，装好后没人通知刷新）
          broadcastWebbridgeStateChanged();
        })
        .catch((err) => {
          log.error(
            `[setup] webbridge background task 意外异常: ${err?.message ?? err}`,
          );
          broadcastWebbridgeStateChanged();
        });

      return { success: true };
    });
  });
}

// 归一化 URL：去尾斜杠并小写主机名，用于预设匹配。
function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  try {
    const u = new URL(trimmed);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

// 所有内置预设的 baseUrl 集合（归一化后）。基于模块常量在首次使用时构建。
let presetBaseUrlSet: Set<string> | null = null;
function knownPresetBaseUrls(): Set<string> {
  if (presetBaseUrlSet) return presetBaseUrlSet;
  const urls = [
    ...Object.values(PROVIDER_PRESETS).map((p) => p.baseUrl),
    ...Object.values(MOONSHOT_SUB_PLATFORMS).map((p) => p.baseUrl),
    ...Object.values(CUSTOM_PROVIDER_PRESETS).map((p) => p.baseUrl),
  ];
  presetBaseUrlSet = new Set(urls.map(normalizeBaseUrl));
  return presetBaseUrlSet;
}

// 将 setup 表单参数转换为 setup_completed 事件需要的属性字段。
// 原始 base_url 可能包含内网主机、租户路径或凭证，只上报 preset/custom 粗分类。
function buildSetupCompletedProps(params: {
  provider: string;
  modelID: string;
  baseURL?: string;
  subPlatform?: string;
}, config?: any): Record<string, string> {
  const { provider, modelID, baseURL, subPlatform } = params;

  const sub = subPlatform ? MOONSHOT_SUB_PLATFORMS[subPlatform] : undefined;
  const effectiveKey = sub?.providerKey ?? provider;
  const configBaseUrl = config?.models?.providers?.[effectiveKey]?.baseUrl;
  const rawBaseUrl =
    typeof configBaseUrl === "string"
      ? configBaseUrl
      : (sub?.baseUrl ?? PROVIDER_PRESETS[provider]?.baseUrl ?? baseURL ?? "");

  const baseUrlKind = knownPresetBaseUrls().has(normalizeBaseUrl(rawBaseUrl)) ? "preset" : "custom";

  return {
    provider,
    model: modelID,
    base_url_kind: baseUrlKind,
  };
}
