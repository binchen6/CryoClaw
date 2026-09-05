import { contextBridge, ipcRenderer, webUtils } from "electron";

// 安全桥接 — 向渲染进程暴露有限 API
contextBridge.exposeInMainWorld("cryoclaw", {
  // Gateway 控制
  restartGateway: () => ipcRenderer.send("gateway:restart"),
  startGateway: () => ipcRenderer.send("gateway:start"),
  stopGateway: () => ipcRenderer.invoke("gateway:stop"),
  getGatewayState: () => ipcRenderer.invoke("gateway:state"),

  // 内核升级/回退
  kernelGetUpdateState: () => ipcRenderer.invoke("kernel:get-update-state"),
  kernelCheckUpdate: () => ipcRenderer.invoke("kernel:check"),
  kernelUpdate: (params?: { tag?: string }) => ipcRenderer.invoke("kernel:update", params),
  kernelRollback: () => ipcRenderer.invoke("kernel:rollback"),

  // App 自动更新（electron-updater）
  appUpdateGetState: () => ipcRenderer.invoke("app-update:get-state"),
  appUpdateCheck: () => ipcRenderer.invoke("app-update:check"),
  appUpdateDownload: () => ipcRenderer.invoke("app-update:download"),
  appUpdateQuitAndInstall: () => ipcRenderer.invoke("app-update:quit-and-install"),
  appUpdateSnooze: (opts: { days?: number; forever?: boolean }) =>
    ipcRenderer.invoke("app-update:snooze", opts),
  appUpdateClearSnooze: () => ipcRenderer.invoke("app-update:clear-snooze"),

  // Setup 相关
  verifyKey: (params: Record<string, unknown>) =>
    ipcRenderer.invoke("setup:verify-key", params),
  saveConfig: (params: Record<string, unknown>) =>
    ipcRenderer.invoke("setup:save-config", params),
  setupGetLaunchAtLogin: () => ipcRenderer.invoke("setup:get-launch-at-login"),
  completeSetup: (params?: Record<string, unknown>) => ipcRenderer.invoke("setup:complete", params),
  detectInstallation: () => ipcRenderer.invoke("setup:detect-installation"),
  resolveConflict: (params: Record<string, unknown>) =>
    ipcRenderer.invoke("setup:resolve-conflict", params),
  // 快速通道：检测/采用环境变量中已有的 provider API Key
  detectEnvKeys: () => ipcRenderer.invoke("setup:detect-env-keys"),
  adoptEnvKey: (params: Record<string, unknown>) =>
    ipcRenderer.invoke("setup:adopt-env-key", params),

  // Kimi OAuth
  kimiOAuthLogin: () => ipcRenderer.invoke("kimi-oauth:login"),
  kimiOAuthCancel: () => ipcRenderer.invoke("kimi-oauth:cancel"),
  kimiOAuthLogout: () => ipcRenderer.invoke("kimi-oauth:logout"),
  kimiOAuthStatus: () => ipcRenderer.invoke("kimi-oauth:status"),
  kimiGetUsage: () => ipcRenderer.invoke("kimi:get-usage"),

  // Settings 相关
  settingsVerifyKey: (params: Record<string, unknown>) =>
    ipcRenderer.invoke("settings:verify-key", params),
  // Kimi Code 手动 key 写 sidecar + 注入 auth proxy（config 只写 proxy-managed 占位符）
  settingsWriteKimiApiKey: (params: Record<string, unknown>) =>
    ipcRenderer.invoke("settings:write-kimi-api-key", params),
  // R4：渠道 openclaw.json 读写走内核 config.get/config.patch；主进程只保留运行态查询
  settingsGetChannelRuntimeState: () =>
    ipcRenderer.invoke("settings:get-channel-runtime-state"),
  // 启用微信渠道前守卫：把 mirror reconcile 到 external plugin 目录
  settingsEnsureWeixinPlugin: () =>
    ipcRenderer.invoke("settings:ensure-weixin-plugin"),
  settingsWeixinLoginStart: () =>
    ipcRenderer.invoke("settings:weixin-login-start"),
  settingsWeixinLoginWait: (params: Record<string, unknown>) =>
    ipcRenderer.invoke("settings:weixin-login-wait", params),
  settingsWeixinClearAccounts: () =>
    ipcRenderer.invoke("settings:weixin-clear-accounts"),
  settingsListWecomPairing: () =>
    ipcRenderer.invoke("settings:list-wecom-pairing"),
  settingsApproveWecomPairing: (params: Record<string, unknown>) =>
    ipcRenderer.invoke("settings:approve-wecom-pairing", params),
  settingsRejectWecomPairing: (params: Record<string, unknown>) =>
    ipcRenderer.invoke("settings:reject-wecom-pairing", params),
  settingsListWecomApproved: () =>
    ipcRenderer.invoke("settings:list-wecom-approved"),
  settingsAddWecomUserAllowFrom: (params: Record<string, unknown>) =>
    ipcRenderer.invoke("settings:add-wecom-user-allow-from", params),
  settingsAddWecomGroupAllowFrom: (params: Record<string, unknown>) =>
    ipcRenderer.invoke("settings:add-wecom-group-allow-from", params),
  settingsRemoveWecomApproved: (params: Record<string, unknown>) =>
    ipcRenderer.invoke("settings:remove-wecom-approved", params),
  settingsListFeishuPairing: () =>
    ipcRenderer.invoke("settings:list-feishu-pairing"),
  settingsApproveFeishuPairing: (params: Record<string, unknown>) =>
    ipcRenderer.invoke("settings:approve-feishu-pairing", params),
  settingsRejectFeishuPairing: (params: Record<string, unknown>) =>
    ipcRenderer.invoke("settings:reject-feishu-pairing", params),
  settingsListFeishuApproved: () =>
    ipcRenderer.invoke("settings:list-feishu-approved"),
  settingsAddFeishuUserAllowFrom: (params: Record<string, unknown>) =>
    ipcRenderer.invoke("settings:add-feishu-user-allow-from", params),
  settingsRemoveFeishuApproved: (params: Record<string, unknown>) =>
    ipcRenderer.invoke("settings:remove-feishu-approved", params),
  // Kimi Search 专属 key（sidecar 文件）+ memory embedding 依赖的 auth proxy
  settingsGetKimiSearchKey: () =>
    ipcRenderer.invoke("settings:get-kimi-search-key"),
  settingsWriteKimiSearchKey: (params: Record<string, unknown>) =>
    ipcRenderer.invoke("settings:write-kimi-search-key", params),
  settingsEnsureKimiProxy: () =>
    ipcRenderer.invoke("settings:ensure-kimi-proxy"),
  settingsGetAboutInfo: () => ipcRenderer.invoke("settings:get-about-info"),
  settingsGetAdvanced: () => ipcRenderer.invoke("settings:get-advanced"),
  settingsSaveAdvanced: (params: Record<string, unknown>) =>
    ipcRenderer.invoke("settings:save-advanced", params),
  settingsGetEnvInfo: () => ipcRenderer.invoke("settings:get-env-info"),
  settingsWebbridgeStatus: () => ipcRenderer.invoke("settings:webbridge-status"),
  settingsWebbridgeInstallExtensions: () =>
    ipcRenderer.invoke("settings:webbridge-install-extensions"),
  settingsWebbridgeCleanBlocklist: (browserId: string) =>
    ipcRenderer.invoke("settings:webbridge-clean-blocklist", browserId),
  settingsWebbridgePrecheck: () =>
    ipcRenderer.invoke("settings:webbridge-precheck"),
  settingsWebbridgeRepairAndEnable: () =>
    ipcRenderer.invoke("settings:webbridge-repair-and-enable"),
  settingsGetDefaultBrowserName: () =>
    ipcRenderer.invoke("settings:get-default-browser-name"),
  // 主窗左侧栏 WebBridge 修复 pill 用：返回 { visible: boolean }
  settingsWebbridgeNeedsRepair: () =>
    ipcRenderer.invoke("settings:webbridge-needs-repair"),
  // 主窗左侧栏 pill 点击时调用：清 blocklist + 写 External JSON（仅当浏览器已关闭）
  settingsWebbridgePillRepair: () =>
    ipcRenderer.invoke("settings:webbridge-pill-repair"),
  settingsGetCliStatus: () => ipcRenderer.invoke("settings:get-cli-status"),
  settingsInstallCli: () => ipcRenderer.invoke("settings:install-cli"),
  settingsUninstallCli: () => ipcRenderer.invoke("settings:uninstall-cli"),
  settingsListConfigBackups: () => ipcRenderer.invoke("settings:list-config-backups"),
  settingsExportOpenclawState: () => ipcRenderer.invoke("settings:export-openclaw-state"),
  settingsExportDiagnostics: () => ipcRenderer.invoke("settings:export-diagnostics"),
  settingsSelectOpenclawStateArchive: () => ipcRenderer.invoke("settings:select-openclaw-state-archive"),
  settingsImportOpenclawState: (params: Record<string, unknown>) =>
    ipcRenderer.invoke("settings:import-openclaw-state", params),
  settingsRestoreConfigBackup: (params: Record<string, unknown>) =>
    ipcRenderer.invoke("settings:restore-config-backup", params),
  settingsRestoreLastKnownGood: () => ipcRenderer.invoke("settings:restore-last-known-good"),
  settingsResetConfigAndRelaunch: () => ipcRenderer.invoke("settings:reset-config-and-relaunch"),
  settingsGetShareCopy: () => ipcRenderer.invoke("settings:get-share-copy"),

  // 技能商店
  skillStoreList: (params?: Record<string, unknown>) =>
    ipcRenderer.invoke("skill-store:list", params),
  skillStoreSearch: (params?: Record<string, unknown>) =>
    ipcRenderer.invoke("skill-store:search", params),
  skillStoreDetail: (params?: Record<string, unknown>) =>
    ipcRenderer.invoke("skill-store:detail", params),
  skillStoreInstall: (params?: Record<string, unknown>) =>
    ipcRenderer.invoke("skill-store:install", params),
  skillStoreUninstall: (params?: Record<string, unknown>) =>
    ipcRenderer.invoke("skill-store:uninstall", params),
  skillStoreListInstalled: () =>
    ipcRenderer.invoke("skill-store:list-installed"),

  // 插件管理页（R8）
  pluginStoreList: () =>
    ipcRenderer.invoke("plugin-store:list"),
  pluginStoreSearch: (params?: Record<string, unknown>) =>
    ipcRenderer.invoke("plugin-store:search", params),
  pluginStoreInstall: (params?: Record<string, unknown>) =>
    ipcRenderer.invoke("plugin-store:install", params),
  pluginStoreUninstall: (params?: Record<string, unknown>) =>
    ipcRenderer.invoke("plugin-store:uninstall", params),

  // 工作空间文件操作
  workspaceSetRoot: (root: string) =>
    ipcRenderer.invoke("workspace:set-root", root),
  workspaceOpenFile: (filePath: string) =>
    ipcRenderer.invoke("workspace:open-file", filePath),
  workspaceOpenFolder: (filePath: string) =>
    ipcRenderer.invoke("workspace:open-folder", filePath),
  workspaceListDir: (dirPath: string) =>
    ipcRenderer.invoke("workspace:list-dir", dirPath),
  workspaceReadFile: (filePath: string) =>
    ipcRenderer.invoke("workspace:read-file", filePath),

  // git CLI 探测（缓存结果；worktree 入口降级依据）
  gitDetect: () => ipcRenderer.invoke("git:detect"),
  // git 面板（P4）：status/diff 返回主进程已解析的结构化数据；cwd 必须在白名单根内
  gitStatus: (cwd: string) => ipcRenderer.invoke("git:status", cwd),
  gitDiff: (cwd: string, opts?: { cached?: boolean; path?: string }) =>
    ipcRenderer.invoke("git:diff", cwd, opts),
  gitStage: (cwd: string, paths: string[]) => ipcRenderer.invoke("git:stage", cwd, paths),
  gitUnstage: (cwd: string, paths: string[]) => ipcRenderer.invoke("git:unstage", cwd, paths),
  gitCommit: (cwd: string, message: string) => ipcRenderer.invoke("git:commit", cwd, message),

  onSettingsNavigate: (cb: (payload: { tab: string; notice: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { tab: string; notice: string }) => cb(payload);
    ipcRenderer.on("settings:navigate", handler);
    return () => { ipcRenderer.removeListener("settings:navigate", handler); };
  },

  // 打开外部链接（走 IPC 到主进程，sandbox 下 shell 不可用）
  openExternal: (url: string) => ipcRenderer.invoke("app:open-external", url),
  // 打开本地文件/目录
  openPath: (path: string) => ipcRenderer.invoke("app:open-path", path),
  // 在文件管理器中定位文件（不执行）
  revealPath: (path: string) => ipcRenderer.invoke("app:reveal-path", path),

  // 文件选择
  selectFiles: (options?: { filters?: Array<{ name: string; extensions: string[] }> }) =>
    ipcRenderer.invoke("dialog:select-files", options) as Promise<string[]>,
  // 读取剪贴板中的文件路径（Cmd+C / Ctrl+C 复制的文件）
  readClipboardFilePaths: () =>
    ipcRenderer.invoke("clipboard:read-file-paths") as Promise<string[]>,
  // 读取本地文件为 base64（文件附件走内核 apiAttachments；≤16MB，超限返回 { error:"too-large" }）
  readFileBase64: (path: string) => ipcRenderer.invoke("file:read-base64", path),

  // Release Notes
  getReleaseNotes: (opts?: { all?: boolean }) => ipcRenderer.invoke("app:get-release-notes", opts),
  dismissReleaseNotes: (version: string) => ipcRenderer.invoke("app:dismiss-release-notes", version),

  // Chat UI 侧边栏操作
  quit: () => ipcRenderer.send("app:quit"),
  reportSetupViewState: (active: boolean) => ipcRenderer.send("app:setup-view-state", active),
  openSettings: () => ipcRenderer.send("app:open-settings"),
  openWebUI: () => ipcRenderer.send("app:open-webui"),
  getGatewayPort: () => ipcRenderer.invoke("gateway:port"),
  // 主进程通知 gateway 已就绪，Chat UI 可立即重连（跳过盲等指数退避）
  onGatewayReady: (cb: (payload?: { token?: string | null; gatewayUrl?: string | null }) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload?: { token?: string | null; gatewayUrl?: string | null },
    ) => cb(payload);
    ipcRenderer.on("gateway:ready", listener);
    return () => ipcRenderer.removeListener("gateway:ready", listener);
  },
  // 主进程通知 webbridge precheck 状态可能已变（setup-task 后台装完扩展、settings 修复完成等）
  // chat-ui 据此重查 settings:webbridge-needs-repair，避免 pill 卡在旧结果
  onWebbridgeStateChanged: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("webbridge:state-changed", listener);
    return () => ipcRenderer.removeListener("webbridge:state-changed", listener);
  },

  onNavigate: (cb: (payload: { view: "settings" | "setup" | "chat"; settingsTab?: string | null; settingsNotice?: string | null; token?: string | null }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { view: "settings" | "setup" | "chat"; settingsTab?: string | null; settingsNotice?: string | null; token?: string | null }) => {
      cb(payload);
    };
    ipcRenderer.on("app:navigate", listener);
    return () => ipcRenderer.removeListener("app:navigate", listener);
  },
  onKernelUpdateProgress: (cb: (payload: { step: string; pct: number; msg: string; source?: "auto" | "manual"; version?: string; action?: "update" | "rollback" }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { step: string; pct: number; msg: string; source?: "auto" | "manual"; version?: string; action?: "update" | "rollback" }) => {
      cb(payload);
    };
    ipcRenderer.on("kernel:update-progress", listener);
    return () => ipcRenderer.removeListener("kernel:update-progress", listener);
  },
  // 主进程推送 App 自动更新状态快照
  onAppUpdateState: (cb: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      cb(payload);
    };
    ipcRenderer.on("app:update-state", listener);
    return () => ipcRenderer.removeListener("app:update-state", listener);
  },
});

// 拖拽文件 → 提取路径并派发给渲染进程
// dragover 必须无条件 preventDefault，否则 drop 事件不会触发
document.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.stopPropagation();
});

document.addEventListener("drop", (e) => {
  e.preventDefault();
  e.stopPropagation();
  const files = e.dataTransfer?.files;
  if (!files?.length) return;
  const paths: string[] = [];
  for (let i = 0; i < files.length; i++) {
    try {
      const p = webUtils.getPathForFile(files[i]);
      if (p) paths.push(p);
    } catch { /* 忽略无法获取路径的文件 */ }
  }
  if (paths.length > 0) {
    window.dispatchEvent(new CustomEvent("cryoclaw:file-drop", { detail: { paths } }));
  }
});
