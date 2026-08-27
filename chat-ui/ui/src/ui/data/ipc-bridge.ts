/**
 * Unified typed IPC bridge for Setup and Settings views.
 *
 * Thin wrapper around `window.cryoclaw.*` (exposed by Electron preload).
 * No abstraction beyond typing and null-safety.
 */

// ---------------------------------------------------------------------------
// Type declarations
// ---------------------------------------------------------------------------

export interface DetectionResult {
  portInUse: boolean;
  portProcess: string;
  portPid: number;
  globalInstalled: boolean;
  globalPath: string;
}

export interface VerifyResult {
  success: boolean;
  error?: string;
  message?: string;
  supportsImage?: boolean;
}

export interface SetupCompleteResult {
  success: boolean;
  error?: string;
}

export interface LaunchAtLoginState {
  supported: boolean;
  enabled: boolean;
}

export interface OAuthResult {
  accessToken?: string;
  success?: boolean;
  message?: string;
}

export interface OAuthStatus {
  loggedIn: boolean;
  accessToken?: string;
}

export interface UsageData {
  data?: {
    weekUsage?: { used: number; limit: number };
    rateLimits?: { used: number; limit: number };
    resetAt?: string | number;
  };
  weekUsage?: { used: number; limit: number };
  rateLimits?: { used: number; limit: number };
  resetAt?: string | number;
}

// R4：渠道/搜索/记忆的 openclaw.json 读写已改走内核 config.get/config.patch，
// 主进程只保留运行态查询（bundle 是否就绪、微信账号列表）。
export interface ChannelRuntimeState {
  bundled: { qqbot: boolean; dingtalk: boolean; wecom: boolean; weixin: boolean; kimiSearch: boolean };
  bundleMessages: { qqbot?: string; dingtalk?: string; wecom?: string; weixin?: string; kimiSearch?: string };
  weixinAccounts: string[];
}

export interface AdvancedConfig {
  // 浏览器模式 3 选：webbridge / openclaw / user。"chrome" 是早期分支的 alias，
  // 仍可能从老后端传上来，前端用归一化吃掉。
  browserMode?: "webbridge" | "openclaw" | "user" | "chrome";
  // 旧字段：gateway defaultProfile，向后兼容（旧 IPC 没 browserMode 时回退用）
  browserProfile: string;
  launchAtLoginSupported: boolean;
  launchAtLogin: boolean;
  clawHubRegistry: string;
  // 沙盒前置检测结果：本机 Docker 是否可用（false 时 UI 禁用沙盒选项并提示）
  dockerAvailable?: boolean;
}

export interface EnvInfo {
  configPath: string;
  gatewayPort: number;
  gatewayBind: string;
  gatewayReloadMode: string;
  kernelVersion: string;
  providerKeys: string[];
  enabledChannels: string[];
}

export interface WebbridgePrecheckData {
  ok: boolean;
  missing: { binary: boolean; skill: boolean; extension: boolean };
  defaultBrowser: { id: string; name: string } | null;
  defaultUnsupported: boolean;
}

// repair-and-enable handler 返回的非 success 错误码
export type WebbridgeRepairCode =
  | "DEFAULT_BROWSER_UNSUPPORTED"
  | "BROWSER_RUNNING"
  | "REPAIR_FAILED";

export interface WebbridgeRepairResult {
  success: boolean;
  code?: WebbridgeRepairCode;
  browserName?: string;
  message?: string;
  openedBrowser?: boolean;
  data?: unknown;
}

export interface CliStatus {
  enabled: boolean;
  installed: boolean;
}

export interface BackupEntry {
  fileName: string;
  createdAt: string;
  size: number;
}

export interface BackupData {
  hasLastKnownGood: boolean;
  lastKnownGoodUpdatedAt: string;
  backups: BackupEntry[];
}

export interface OpenclawStateExportResult {
  canceled: boolean;
  filePath?: string;
}

export interface OpenclawStateArchiveSelection {
  canceled: boolean;
  filePath?: string;
}

export interface AboutInfo {
  cryoClawVersion: string;
  openClawVersion: string;
}

// 内核（openclaw runtime）升级状态；available=false 表示当前环境不支持升级
export interface KernelUpdateState {
  available: boolean;
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  rollbackAvailable: boolean;
  running: boolean;
  checkError?: string | null;
}

export type KernelUpdateResult =
  | { ok: true; action: "update" | "rollback"; from: string; to: string }
  | { ok: false; error: string };

export interface KernelUpdateProgress {
  step: string;
  pct: number;
  msg: string;
}

// App 自动更新（electron-updater）状态；supported=false 表示 dev/未打包环境不支持
export type AppUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "not-available"
  | "error";

export interface AppUpdateProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export interface AppUpdateState {
  supported: boolean;
  status: AppUpdateStatus;
  currentVersion: string;
  version: string | null;
  releaseNotes: { zh?: string; en?: string } | null;
  progress: AppUpdateProgress | null;
  error: string | null;
}

export interface NavigatePayload {
  view: "settings" | "setup" | "chat";
  settingsTab?: string | null;
  settingsNotice?: string | null;
  token?: string | null;
}

export type GatewayState = "running" | "starting" | "stopping" | "stopped";

export interface PairingRequest {
  code: string;
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface ApprovedEntry {
  kind: string;
  id: string;
  name: string;
}

export interface WeixinQrResult {
  qrDataUrl: string;
  qrcode: string;
  message?: string;
}

export interface WeixinLoginWaitResult {
  connected: boolean;
  status?: "waiting" | "scaned" | "confirmed" | "expired";
  message?: string;
  accountId?: string;
}

// ---------------------------------------------------------------------------
// Window augmentation — extend the global cryoclaw type with Setup/Settings methods
// ---------------------------------------------------------------------------

// Extended bridge methods added by Setup/Settings Lit views.
// These augment the base `cryoclaw` declaration in app-render.ts via interface merging.
interface CryoClawBridgeExtended {
      // Setup
      detectInstallation?: () => Promise<any>;
      resolveConflict?: (params: Record<string, unknown>) => Promise<any>;
      verifyKey?: (params: Record<string, unknown>) => Promise<any>;
      saveConfig?: (params: Record<string, unknown>) => Promise<any>;
      completeSetup?: (params?: Record<string, unknown>) => Promise<any>;
      setupGetLaunchAtLogin?: () => Promise<any>;
      // Kimi OAuth
      kimiOAuthLogin?: () => Promise<any>;
      kimiOAuthCancel?: () => Promise<any>;
      kimiOAuthLogout?: () => Promise<any>;
      kimiOAuthStatus?: () => Promise<any>;
      kimiGetUsage?: () => Promise<any>;
      // Settings: Provider
      settingsVerifyKey?: (params: Record<string, unknown>) => Promise<any>;
      settingsWriteKimiApiKey?: (params: Record<string, unknown>) => Promise<any>;
      // Settings: Channels — 运行态 + pairing（R4 后 openclaw.json 读写走 config.patch）
      settingsGetChannelRuntimeState?: () => Promise<any>;
      settingsListFeishuPairing?: () => Promise<any>;
      settingsListFeishuApproved?: () => Promise<any>;
      settingsApproveFeishuPairing?: (params: Record<string, unknown>) => Promise<any>;
      settingsRejectFeishuPairing?: (params: Record<string, unknown>) => Promise<any>;
      settingsRemoveFeishuApproved?: (params: Record<string, unknown>) => Promise<any>;
      // Settings: Channels — WeCom pairing
      settingsListWecomPairing?: () => Promise<any>;
      settingsListWecomApproved?: () => Promise<any>;
      settingsApproveWecomPairing?: (params: Record<string, unknown>) => Promise<any>;
      settingsRejectWecomPairing?: (params: Record<string, unknown>) => Promise<any>;
      settingsRemoveWecomApproved?: (params: Record<string, unknown>) => Promise<any>;
      // Settings: Channels — Weixin
      settingsEnsureWeixinPlugin?: () => Promise<any>;
      settingsWeixinLoginStart?: () => Promise<any>;
      settingsWeixinLoginWait?: (params: Record<string, unknown>) => Promise<any>;
      settingsWeixinClearAccounts?: () => Promise<any>;
      // Settings: Search / Memory — sidecar key + proxy（openclaw.json 部分走 config.patch）
      settingsGetKimiSearchKey?: () => Promise<any>;
      settingsWriteKimiSearchKey?: (params: Record<string, unknown>) => Promise<any>;
      settingsEnsureKimiProxy?: () => Promise<any>;
      // Settings: Advanced / CLI
      settingsGetAdvanced?: () => Promise<any>;
      settingsSaveAdvanced?: (params: Record<string, unknown>) => Promise<any>;
  settingsGetEnvInfo?: () => Promise<EnvInfo>;
      settingsGetCliStatus?: () => Promise<any>;
      settingsInstallCli?: () => Promise<any>;
      settingsUninstallCli?: () => Promise<any>;
      // Settings: WebBridge
      settingsWebbridgePrecheck?: () => Promise<any>;
      settingsWebbridgeRepairAndEnable?: () => Promise<any>;
      settingsGetDefaultBrowserName?: () => Promise<any>;
      // Settings: Backup
      settingsListConfigBackups?: () => Promise<any>;
      settingsExportOpenclawState?: () => Promise<any>;
      settingsExportDiagnostics?: () => Promise<any>;
      settingsSelectOpenclawStateArchive?: () => Promise<any>;
      settingsImportOpenclawState?: (params: Record<string, unknown>) => Promise<any>;
      settingsRestoreConfigBackup?: (params: Record<string, unknown>) => Promise<any>;
      settingsRestoreLastKnownGood?: () => Promise<any>;
      settingsResetConfigAndRelaunch?: () => Promise<any>;
      // Settings: About
      settingsGetAboutInfo?: () => Promise<any>;
      // Gateway
      getGatewayState?: () => Promise<any>;
      restartGateway?: () => void;
      startGateway?: () => void;
      stopGateway?: () => Promise<any>;
      getGatewayPort?: () => Promise<number>;
      // Kernel updater
      kernelGetUpdateState?: () => Promise<any>;
      kernelCheckUpdate?: () => Promise<any>;
      kernelUpdate?: (params?: { tag?: string }) => Promise<any>;
      kernelRollback?: () => Promise<any>;
      onKernelUpdateProgress?: (cb: (payload: any) => void) => () => void;
      // App 自动更新
      appUpdateGetState?: () => Promise<any>;
      appUpdateCheck?: () => Promise<any>;
      appUpdateQuitAndInstall?: () => Promise<any>;
      onAppUpdateState?: (cb: (payload: any) => void) => () => void;
      // Release Notes（all=true 返回全部条目，供「查看更新日志」重看）
      getReleaseNotes?: (opts?: { all?: boolean }) => Promise<any>;
      // Navigation
      onNavigate?: (cb: (payload: any) => void) => () => void;
      onSettingsNavigate?: (cb: (payload: any) => void) => () => void;
      openSettings?: () => void;
      // System
      openExternal?: (url: string) => Promise<any>;
      openPath?: (path: string) => Promise<any>;
      revealPath?: (path: string) => Promise<any>;
      // 聊天文件附件：读本地文件为 base64（≤16MB，超限返回 { error:"too-large", size }）
      readFileBase64?: (path: string) => Promise<any>;
      quit?: () => void;
      reportSetupViewState?: (active: boolean) => void;
}

function oc(): Required<CryoClawBridgeExtended> {
  return window.cryoclaw as unknown as Required<CryoClawBridgeExtended>;
}

/**
 * Unwrap IPC responses that follow the `{ success, data }` convention
 * used by settings-ipc.ts handlers.
 * - Getters: `{ success: true, data: T }` → returns `T`
 * - On failure: `{ success: false, message: string }` → throws Error
 */
function unwrapData<T>(result: any): T {
  if (result && typeof result === "object" && "success" in result) {
    if (!result.success) {
      throw new Error(result.message ?? "IPC call failed");
    }
    return result.data as T;
  }
  // Already unwrapped (some handlers return raw values)
  return result as T;
}

/**
 * Unwrap IPC responses for mutators that return `{ success: true }` or
 * `{ success: false, message }` with no data payload.
 */
function unwrapVoid(result: any): void {
  if (result && typeof result === "object" && "success" in result && !result.success) {
    throw new Error(result.message ?? "IPC call failed");
  }
}

// ---------------------------------------------------------------------------
// Setup IPC (6)
// ---------------------------------------------------------------------------

export async function detectInstallation(): Promise<DetectionResult> {
  return unwrapData<DetectionResult>(await oc().detectInstallation());
}

export async function resolveConflict(params: { action: string; pid?: number }): Promise<void> {
  return unwrapVoid(await oc().resolveConflict(params));
}

export async function verifyKey(params: Record<string, unknown>): Promise<VerifyResult> {
  return oc().verifyKey(params) as Promise<VerifyResult>;
}

export async function saveConfig(params: Record<string, unknown>): Promise<void> {
  return unwrapVoid(await oc().saveConfig(params));
}

export async function completeSetup(params?: Record<string, unknown>): Promise<SetupCompleteResult> {
  const result = await oc().completeSetup(params);
  if (result && typeof result === "object" && "success" in result && !result.success) {
    throw new Error(result.message ?? "Setup completion failed");
  }
  return result as SetupCompleteResult;
}

export async function setupGetLaunchAtLogin(): Promise<LaunchAtLoginState> {
  return unwrapData<LaunchAtLoginState>(await oc().setupGetLaunchAtLogin());
}

// ---------------------------------------------------------------------------
// Kimi OAuth (5)
// ---------------------------------------------------------------------------

export function kimiOAuthLogin(): Promise<OAuthResult> {
  return oc().kimiOAuthLogin() as Promise<OAuthResult>;
}

export function kimiOAuthCancel(): Promise<void> {
  return oc().kimiOAuthCancel() as Promise<void>;
}

export function kimiOAuthLogout(): Promise<void> {
  return oc().kimiOAuthLogout() as Promise<void>;
}

export function kimiOAuthStatus(): Promise<OAuthStatus> {
  return oc().kimiOAuthStatus() as Promise<OAuthStatus>;
}

export function kimiGetUsage(): Promise<UsageData> {
  return oc().kimiGetUsage() as Promise<UsageData>;
}

// ---------------------------------------------------------------------------
// Settings: Provider (2)
// ---------------------------------------------------------------------------

export function settingsVerifyKey(params: Record<string, unknown>): Promise<VerifyResult> {
  return oc().settingsVerifyKey(params) as Promise<VerifyResult>;
}

/** Kimi Code 手动 key 写 sidecar + 注入 auth proxy；返回 { proxyPort } */
export async function settingsWriteKimiApiKey(params: { apiKey: string }): Promise<{ proxyPort: number }> {
  return unwrapData<{ proxyPort: number }>(await oc().settingsWriteKimiApiKey(params));
}

// ---------------------------------------------------------------------------
// Settings: Channels — 运行态 + Feishu pairing（R4 后配置读写走 config.patch）
// ---------------------------------------------------------------------------

export async function settingsGetChannelRuntimeState(): Promise<ChannelRuntimeState> {
  return unwrapData<ChannelRuntimeState>(await oc().settingsGetChannelRuntimeState());
}

export async function settingsListFeishuPairing(): Promise<PairingRequest[]> {
  const result = unwrapData<{ requests: PairingRequest[] }>(await oc().settingsListFeishuPairing());
  return result.requests ?? [];
}

export async function settingsListFeishuApproved(): Promise<ApprovedEntry[]> {
  const result = unwrapData<{ entries: ApprovedEntry[] }>(await oc().settingsListFeishuApproved());
  return result.entries ?? [];
}

export async function settingsApproveFeishuPairing(params: { code: string; id: string; name: string }): Promise<void> {
  unwrapVoid(await oc().settingsApproveFeishuPairing(params));
}

export async function settingsRejectFeishuPairing(params: { code: string; id: string; name: string }): Promise<void> {
  unwrapVoid(await oc().settingsRejectFeishuPairing(params));
}

export async function settingsRemoveFeishuApproved(params: { kind: string; id: string }): Promise<void> {
  unwrapVoid(await oc().settingsRemoveFeishuApproved(params));
}

// ---------------------------------------------------------------------------
// Settings: Channels — WeCom pairing (5)
// ---------------------------------------------------------------------------

export async function settingsListWecomPairing(): Promise<PairingRequest[]> {
  const result = unwrapData<{ requests: PairingRequest[] }>(await oc().settingsListWecomPairing());
  return result.requests ?? [];
}

export async function settingsListWecomApproved(): Promise<ApprovedEntry[]> {
  const result = unwrapData<{ entries: ApprovedEntry[] }>(await oc().settingsListWecomApproved());
  return result.entries ?? [];
}

export async function settingsApproveWecomPairing(params: { code: string; id: string; name: string }): Promise<void> {
  unwrapVoid(await oc().settingsApproveWecomPairing(params));
}

export async function settingsRejectWecomPairing(params: { code: string; id: string; name: string }): Promise<void> {
  unwrapVoid(await oc().settingsRejectWecomPairing(params));
}

export async function settingsRemoveWecomApproved(params: { kind: string; id: string }): Promise<void> {
  unwrapVoid(await oc().settingsRemoveWecomApproved(params));
}

// ---------------------------------------------------------------------------
// Settings: Channels — Weixin (4)
// ---------------------------------------------------------------------------

/** 启用微信渠道前的守卫：把 mirror reconcile 到 external plugin 目录 */
export async function settingsEnsureWeixinPlugin(): Promise<{ ok: boolean; message?: string }> {
  return unwrapData<{ ok: boolean; message?: string }>(await oc().settingsEnsureWeixinPlugin());
}

export async function settingsWeixinLoginStart(): Promise<WeixinQrResult> {
  return unwrapData<WeixinQrResult>(await oc().settingsWeixinLoginStart());
}

export async function settingsWeixinLoginWait(params: { qrcode: string }): Promise<WeixinLoginWaitResult> {
  return unwrapData<WeixinLoginWaitResult>(await oc().settingsWeixinLoginWait(params));
}

export function settingsWeixinClearAccounts(): Promise<void> {
  return oc().settingsWeixinClearAccounts() as Promise<void>;
}

// ---------------------------------------------------------------------------
// Settings: Search / Memory — sidecar key + auth proxy（openclaw.json 部分走 config.patch）
// ---------------------------------------------------------------------------

/** Kimi Search 专属 key 存 sidecar 文件，不从 openclaw.json 读 */
export async function settingsGetKimiSearchKey(): Promise<{ apiKey: string }> {
  return unwrapData<{ apiKey: string }>(await oc().settingsGetKimiSearchKey());
}

/** 写 sidecar 专属 key（空字符串清除）并注入 auth proxy */
export async function settingsWriteKimiSearchKey(params: { apiKey: string }): Promise<void> {
  unwrapVoid(await oc().settingsWriteKimiSearchKey(params));
}

/** 确保 auth proxy 运行（memory embedding 依赖），返回 { proxyPort } */
export async function settingsEnsureKimiProxy(): Promise<{ proxyPort: number }> {
  return unwrapData<{ proxyPort: number }>(await oc().settingsEnsureKimiProxy());
}

// ---------------------------------------------------------------------------
// Settings: Advanced / CLI (5)
// ---------------------------------------------------------------------------

export async function settingsGetAdvanced(): Promise<AdvancedConfig> {
  return unwrapData<AdvancedConfig>(await oc().settingsGetAdvanced());
}

export async function settingsGetEnvInfo(): Promise<EnvInfo> {
  return oc().settingsGetEnvInfo() as Promise<EnvInfo>;
}

export async function settingsSaveAdvanced(params: Record<string, unknown>): Promise<void> {
  unwrapVoid(await oc().settingsSaveAdvanced(params));
}

export async function settingsGetCliStatus(): Promise<CliStatus> {
  return unwrapData<CliStatus>(await oc().settingsGetCliStatus());
}

export async function settingsInstallCli(): Promise<void> {
  unwrapVoid(await oc().settingsInstallCli());
}

export async function settingsUninstallCli(): Promise<void> {
  unwrapVoid(await oc().settingsUninstallCli());
}

// ---------------------------------------------------------------------------
// Settings: WebBridge (3)
// ---------------------------------------------------------------------------

// 切换到 webbridge 模式前的 precheck（read-only）。返回缺失项 + 默认浏览器信息。
export async function settingsWebbridgePrecheck(): Promise<WebbridgePrecheckData> {
  return unwrapData<WebbridgePrecheckData>(
    await oc().settingsWebbridgePrecheck(),
  );
}

// 修复（按 precheck 选择性安装）+ 写 config + 重启 gateway。失败时不抛异常，返回结构化 code。
export async function settingsWebbridgeRepairAndEnable(): Promise<WebbridgeRepairResult> {
  const result = (await oc().settingsWebbridgeRepairAndEnable()) as WebbridgeRepairResult;
  return result ?? { success: false, message: "no response" };
}

// 系统默认浏览器；非 Chrome/Edge 时 data 为 null
export async function settingsGetDefaultBrowserName(): Promise<{ id: string; name: string } | null> {
  return unwrapData<{ id: string; name: string } | null>(
    await oc().settingsGetDefaultBrowserName(),
  );
}

// ---------------------------------------------------------------------------
// Settings: Backup (4)
// ---------------------------------------------------------------------------

export async function settingsListConfigBackups(): Promise<BackupData> {
  return unwrapData<BackupData>(await oc().settingsListConfigBackups());
}

export async function settingsExportOpenclawState(): Promise<OpenclawStateExportResult> {
  return unwrapData<OpenclawStateExportResult>(await oc().settingsExportOpenclawState());
}

// 诊断包导出（日志 + 环境信息 + 脱敏配置摘要），结果形状与 openclawState 导出一致
export async function settingsExportDiagnostics(): Promise<OpenclawStateExportResult> {
  return unwrapData<OpenclawStateExportResult>(await oc().settingsExportDiagnostics());
}

export async function settingsSelectOpenclawStateArchive(): Promise<OpenclawStateArchiveSelection> {
  return unwrapData<OpenclawStateArchiveSelection>(await oc().settingsSelectOpenclawStateArchive());
}

export async function settingsImportOpenclawState(params: { filePath: string }): Promise<void> {
  unwrapVoid(await oc().settingsImportOpenclawState(params));
}

export async function settingsRestoreConfigBackup(params: { fileName: string }): Promise<void> {
  unwrapVoid(await oc().settingsRestoreConfigBackup(params));
}

export async function settingsRestoreLastKnownGood(): Promise<void> {
  unwrapVoid(await oc().settingsRestoreLastKnownGood());
}

export async function settingsResetConfigAndRelaunch(): Promise<void> {
  unwrapVoid(await oc().settingsResetConfigAndRelaunch());
}

// ---------------------------------------------------------------------------
// Settings: About (1)
// ---------------------------------------------------------------------------

export async function settingsGetAboutInfo(): Promise<AboutInfo> {
  return unwrapData<AboutInfo>(await oc().settingsGetAboutInfo());
}

// ---------------------------------------------------------------------------
// Gateway control (4)
// ---------------------------------------------------------------------------

export function getGatewayState(): Promise<GatewayState> {
  return oc().getGatewayState() as Promise<GatewayState>;
}

export function restartGateway(): void {
  oc().restartGateway();
}

export function startGateway(): void {
  oc().startGateway();
}

export function stopGateway(): Promise<void> {
  return oc().stopGateway() as Promise<void>;
}

export function getGatewayPort(): Promise<number> {
  return oc().getGatewayPort() as Promise<number>;
}

// ---------------------------------------------------------------------------
// Kernel updater (5) — 主进程直接返回原始值，不走 { success, data } 包装
// ---------------------------------------------------------------------------

export function kernelGetUpdateState(): Promise<KernelUpdateState> {
  return oc().kernelGetUpdateState() as Promise<KernelUpdateState>;
}

export function kernelCheckUpdate(): Promise<KernelUpdateState> {
  return oc().kernelCheckUpdate() as Promise<KernelUpdateState>;
}

export function kernelUpdate(params?: { tag?: string }): Promise<KernelUpdateResult> {
  return oc().kernelUpdate(params) as Promise<KernelUpdateResult>;
}

export function kernelRollback(): Promise<KernelUpdateResult> {
  return oc().kernelRollback() as Promise<KernelUpdateResult>;
}

export function onKernelUpdateProgress(cb: (p: KernelUpdateProgress) => void): () => void {
  return oc().onKernelUpdateProgress(cb);
}

// ---------------------------------------------------------------------------
// App updater (4) — electron-updater 应用级更新；返回 { success, data } 包装
// ---------------------------------------------------------------------------

export async function appUpdateGetState(): Promise<AppUpdateState> {
  return unwrapData<AppUpdateState>(await oc().appUpdateGetState());
}

export async function appUpdateCheck(): Promise<AppUpdateState> {
  return unwrapData<AppUpdateState>(await oc().appUpdateCheck());
}

export async function appUpdateQuitAndInstall(): Promise<void> {
  unwrapVoid(await oc().appUpdateQuitAndInstall());
}

export function onAppUpdateState(cb: (s: AppUpdateState) => void): () => void {
  return oc().onAppUpdateState?.(cb) ?? (() => {});
}

// Release Notes（设置-关于页「查看更新日志」重看入口；all=true 返回全部条目，
// 主进程该通道返回裸对象/null，unwrapData 原样透传）
export interface ReleaseNotesData {
  currentVersion: string;
  entries: Array<{ version: string; notes: { zh?: string; en?: string } }>;
  locale: string;
}

export async function getReleaseNotes(opts?: { all?: boolean }): Promise<ReleaseNotesData | null> {
  return unwrapData<ReleaseNotesData | null>(await oc().getReleaseNotes(opts));
}

// ---------------------------------------------------------------------------
// Navigation / Events (3)
// ---------------------------------------------------------------------------

export function onNavigate(cb: (payload: NavigatePayload) => void): () => void {
  return oc().onNavigate(cb);
}

export function onSettingsNavigate(cb: (payload: { tab: string; notice: string }) => void): () => void {
  return oc().onSettingsNavigate(cb);
}

export function openSettings(): void {
  oc().openSettings();
}

// ---------------------------------------------------------------------------
// System (3)
// ---------------------------------------------------------------------------

export function openExternal(url: string): Promise<void> {
  return oc().openExternal(url) as Promise<void>;
}

export function openPath(path: string): Promise<void> {
  return oc().openPath(path) as Promise<void>;
}

export function revealPath(path: string): Promise<void> {
  return oc().revealPath(path) as Promise<void>;
}

// ---------------------------------------------------------------------------
// 聊天文件附件（file:read-base64）
// ---------------------------------------------------------------------------

export interface FileBase64Payload {
  base64: string;
  size: number;
  mimeType: string;
}

// 主进程返回：成功 → { base64, size, mimeType }；超限 → { error:"too-large", size }；
// 其余非法路径/不存在直接 reject（调用方 catch 降级）
export type ReadFileBase64Response = FileBase64Payload | { error: string; size?: number };

export async function readFileBase64(path: string): Promise<ReadFileBase64Response> {
  const bridge = oc();
  if (typeof bridge.readFileBase64 !== "function") {
    throw new Error("readFileBase64 unavailable");
  }
  return (await bridge.readFileBase64(path)) as ReadFileBase64Response;
}

export function quit(): void {
  oc().quit();
}

// ---------------------------------------------------------------------------
// Setup view state reporting (for window close policy)
// ---------------------------------------------------------------------------

export function reportSetupViewState(active: boolean): void {
  oc().reportSetupViewState(active);
}
