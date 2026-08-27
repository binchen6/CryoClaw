import { LitElement } from "lit";
import { customElement } from "lit/decorators.js";
import type { AppViewState } from "./app-view-state.ts";
import type { ExecApprovalRequest } from "./controllers/exec-approval.ts";
import type { SkillMessage } from "./controllers/skills.ts";
import type { SessionCompactionCheckpoint } from "./controllers/session-compaction.ts";
import type { NavigatePayload as IpcNavigatePayload } from "./data/ipc-bridge.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway.ts";
import type { Tab } from "./navigation.ts";
import type { ResolvedTheme, ThemeMode } from "./theme.ts";
import type {
  AgentsListResult,
  CronJob,
  CronRunLogEntry,
  CronStatus,
  ChannelsStatusSnapshot,
  SessionsListResult,
  SkillStatusReport,
} from "./types.ts";
import {
  editQueuedMessage as editQueuedMessageInternal,
  handleAbortChat as handleAbortChatInternal,
  handleSendChat as handleSendChatInternal,
  isSharePromptCountableInput,
  removeQueuedMessage as removeQueuedMessageInternal,
  sendQueuedMessageNow as sendQueuedMessageNowInternal,
} from "./app-chat.ts";
import { DEFAULT_CRON_FORM } from "./app-defaults.ts";
import { connectGateway as connectGatewayInternal } from "./app-gateway.ts";
import {
  deferredGatewayConnect,
  handleConnected,
  handleDisconnected,
  handleUpdated,
} from "./app-lifecycle.ts";
import { renderApp } from "./app-render.ts";
import {
  handleChatScroll as handleChatScrollInternal,
  resetChatScroll as resetChatScrollInternal,
  scheduleChatScroll as scheduleChatScrollInternal,
} from "./app-scroll.ts";
import {
  applySettings as applySettingsInternal,
  setTheme as setThemeInternal,
  onPopState as onPopStateInternal,
} from "./app-settings.ts";
import {
  resetToolStream as resetToolStreamInternal,
  type ToolStreamEntry,
  type CompactionStatus,
  type FallbackNotice,
} from "./app-tool-stream.ts";
import type { PlanStreamState } from "./plan-stream.ts";
import { resolveInjectedAssistantIdentity } from "./assistant-identity.ts";
import { loadAssistantIdentity as loadAssistantIdentityInternal } from "./controllers/assistant-identity.ts";
import { getConfigSnapshot, deriveConfiguredModels, patchConfig } from "./controllers/config.ts";
import { getCachedGatewayModelEntries } from "./controllers/models.ts";
import { extractAdvancedView, applyAdvancedSave } from "./views/settings/tab-channels.lib.ts";
import { markSessionMeterDirty } from "./context-meter.ts";
import { resolveThinkingCapabilities } from "./chat/thinking-levels.ts";
import { getLocale, t } from "./i18n.ts";
import { loadSettings, type UiSettings } from "./storage.ts";
import { type ChatAttachment, type ChatQueueItem, type ConfiguredModel, type CronFormState } from "./ui-types.ts";

declare global {
  interface Window {
    __OPENCLAW_CONTROL_UI_BASE_PATH__?: string;
  }
}

const injectedAssistantIdentity = resolveInjectedAssistantIdentity();

type ShareCopyPayload = {
  version: number;
  locales: {
    zh: {
      title: string;
      subtitle: string;
      body: string;
    };
    en: {
      title: string;
      subtitle: string;
      body: string;
    };
  };
};

type SharePromptStore = {
  sendCount: number;
  shownVersions: number[];
};

type ReleaseNotesData = {
  currentVersion: string;
  entries: Array<{ version: string; notes: { zh?: string; en?: string } }>;
  locale: string;
};

type CryoClawNavigatePayload = IpcNavigatePayload;
type GatewayReadyPayload = { token?: string | null; gatewayUrl?: string | null };

type CryoClawBridge = {
  onNavigate?: (cb: (payload: CryoClawNavigatePayload) => void) => (() => void) | void;
  onGatewayReady?: (cb: (payload?: GatewayReadyPayload) => void) => (() => void) | void;
  reportSetupViewState?: (active: boolean) => void;
  // sidebar 「连接你的常用浏览器」pill 用：纯查询当前是否需要修复
  settingsWebbridgeNeedsRepair?: () => Promise<{
    success: boolean;
    data?: {
      visible: boolean;
      defaultBrowser: { id: string; name: string } | null;
    };
    message?: string;
  }>;
  // pill 点击时主动修复（清 blocklist + 写 External JSON），需要浏览器关闭
  settingsWebbridgePillRepair?: () => Promise<{
    success: boolean;
    code?: "READY" | "ALREADY_OK" | "BROWSER_RUNNING" | "DEFAULT_BROWSER_UNSUPPORTED" | "FAILED";
    browserName?: string;
    message?: string;
    includesExtension?: boolean;
    browserRunning?: boolean;
    // 主进程已主动打开浏览器+引导页 → 前端跳过 modal（避免冗余双层提示）
    openedBrowser?: boolean;
  }>;
  // setup-task 后台装完扩展、settings 修复完成时由主进程广播——chat-ui 据此重查 needs-repair
  onWebbridgeStateChanged?: (cb: () => void) => (() => void) | void;
  getReleaseNotes?: () => Promise<ReleaseNotesData | null>;
  dismissReleaseNotes?: (version: string) => Promise<void>;
};

const SHARE_PROMPT_STORE_KEY = "openclaw.share.prompt.v1";
const SHARE_PROMPT_TRIGGER_COUNT = 5;

function resolveOnboardingMode(): boolean {
  if (!window.location.search) {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("onboarding");
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

@customElement("openclaw-app")
export class OpenClawApp extends LitElement {
  static properties = {
    settings: { state: true },
    password: { state: true },
    tab: { state: true },
    onboarding: { state: true },
    connected: { state: true },
    theme: { state: true },
    themeResolved: { state: true },
    hello: { state: true },
    lastError: { state: true },
    assistantName: { state: true },
    assistantAvatar: { state: true },
    assistantAgentId: { state: true },
    sessionKey: { state: true },
    chatLoading: { state: true },
    chatSending: { state: true },
    chatMessage: { state: true },
    chatMessages: { state: true },
    chatVisibleMessageCount: { state: true },
    chatToolMessages: { state: true },
    chatStream: { state: true },
    chatStreamStartedAt: { state: true },
    chatRunId: { state: true },
    planState: { state: true },
    compactionStatus: { state: true },
    fallbackNotice: { state: true },
    compactionCheckpoints: { state: true },
    compactionCheckpointsKey: { state: true },
    compactionCheckpointsLoading: { state: true },
    compactionCheckpointsError: { state: true },
    compactionBusyCheckpointId: { state: true },
    chatAvatarUrl: { state: true },
    chatThinkingLevel: { state: true },
    chatQueue: { state: true },
    chatAttachments: { state: true },
    configuredModels: { state: true },
    currentModel: { state: true },
    dirtyMeterSessions: { state: true },
    thinkingLevel: { state: true },
    thinkingLevels: { state: true },
    isBinaryThinking: { state: true },
    chatManualRefreshInFlight: { state: true },
    sidebarOpen: { state: true },
    sidebarContent: { state: true },
    sidebarError: { state: true },
    splitRatio: { state: true },
    execApprovalQueue: { state: true },
    execApprovalBusy: { state: true },
    execApprovalError: { state: true },
    pendingGatewayUrl: { state: true },
    showRestartGatewayDialog: { state: true },
    applySessionKey: { state: true },
    channelsLoading: { state: true },
    channelsSnapshot: { state: true },
    channelsError: { state: true },
    channelsLastSuccess: { state: true },
    agentsLoading: { state: true },
    agentsList: { state: true },
    agentsError: { state: true },
    agentsSelectedId: { state: true },
    sessionsLoading: { state: true },
    sessionsResult: { state: true },
    sessionsError: { state: true },
    sessionsFilterActive: { state: true },
    sessionsFilterLimit: { state: true },
    sessionsIncludeGlobal: { state: true },
    sessionsIncludeUnknown: { state: true },
    cronLoading: { state: true },
    cronJobs: { state: true },
    cronStatus: { state: true },
    cronError: { state: true },
    cronForm: { state: true },
    cronRunsJobId: { state: true },
    cronRuns: { state: true },
    cronBusy: { state: true },
    sessionsIncludeArchived: { state: true },
    sidebarSessionSearch: { state: true },
    tasksLoading: { state: true },
    tasksError: { state: true },
    tasks: { state: true },
    tasksStatusFilter: { state: true },
    tasksCancellingIds: { state: true },
    execMode: { state: true },
    skillsLoading: { state: true },
    skillsReport: { state: true },
    skillsError: { state: true },
    skillsFilter: { state: true },
    skillEdits: { state: true },
    skillsBusyKey: { state: true },
    skillMessages: { state: true },
    chatUserNearBottom: { state: true },
    chatNewMessagesBelow: { state: true },
    sharePromptVisible: { state: true },
    sharePromptCopied: { state: true },
    sharePromptCopyError: { state: true },
    sharePromptTitle: { state: true },
    sharePromptSubtitle: { state: true },
    sharePromptText: { state: true },
    sharePromptVersion: { state: true },
    settingsTabHint: { state: true },
    settingsNotice: { state: true },
    showReleaseNotesModal: { state: true },
    releaseNotesData: { state: true },
    webbridgeRepairVisible: { state: true },
    webbridgeRepairBrowserName: { state: true },
    webbridgeRepairChecking: { state: true },
    webbridgePillModal: { state: true },
  };

  // 兼容 class field 的 define 语义：回灌实例字段到 Lit accessor，恢复响应式更新。
  constructor() {
    super();
    this.rebindReactiveFieldsForLit();
    this.restoreSharePromptStore();
  }

  // 将实例自有字段删除并通过 setter 重新赋值，避免覆盖原型上的响应式访问器。
  private rebindReactiveFieldsForLit() {
    const propertyDefs = (this.constructor as typeof OpenClawApp).properties ?? {};
    const keys = Object.keys(propertyDefs);
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(this, key)) {
        continue;
      }
      const value = (this as unknown as Record<string, unknown>)[key];
      delete (this as unknown as Record<string, unknown>)[key];
      (this as unknown as Record<string, unknown>)[key] = value;
    }
  }

  settings: UiSettings = loadSettings();
  password = "";
  tab: Tab = "chat";
  onboarding = resolveOnboardingMode();
  connected = false;
  theme: ThemeMode = this.settings.theme ?? "light";
  themeResolved: ResolvedTheme = "light";
  hello: GatewayHelloOk | null = null;
  lastError: string | null = null;
  private toolStreamSyncTimer: number | null = null;
  private sidebarCloseTimer: number | null = null;

  assistantName = injectedAssistantIdentity.name;
  assistantAvatar = injectedAssistantIdentity.avatar;
  assistantAgentId = injectedAssistantIdentity.agentId ?? null;

  sessionKey = this.settings.sessionKey;
  chatLoading = false;
  chatSending = false;
  chatMessage = "";
  chatMessages: unknown[] = [];
  chatVisibleMessageCount = 0;
  chatToolMessages: unknown[] = [];
  chatStream: string | null = null;
  chatStreamStartedAt: number | null = null;
  // 最后一次流式活动时间戳（挂起流看门狗锚点）。刻意非响应式：delta 高频更新，
  // 不值得触发 Lit 重渲染；看门狗只读它。
  chatLastActivityAt: number | null = null;
  chatHistoryHydrationFrame: number | null = null;
  chatPendingStreamText: string | null = null;
  chatStreamFrame: number | null = null;
  chatStreamFrozenPrefix: string = "";
  evictedLeadingSegments: Array<{ text: string; ts: number }> = [];
  chatRunId: string | null = null;
  // 计划悬浮面板状态（update_plan 工具事件驱动，独立于 toolStream，跨 turn 保留）
  planState: PlanStreamState | null = null;
  compactionStatus: CompactionStatus | null = null;
  // 模型 fallback 提示（lifecycle 事件驱动，5s 自动消失；chat 终态清理）
  fallbackNotice: FallbackNotice | null = null;
  fallbackClearTimer: number | null = null;
  // 会话 rewind/fork（回放点/分支）面板状态
  compactionCheckpoints: SessionCompactionCheckpoint[] = [];
  // checkpoints 归属的 sessionKey（异步加载结果可能晚于会话切换返回）
  compactionCheckpointsKey: string | null = null;
  compactionCheckpointsLoading = false;
  compactionCheckpointsError: string | null = null;
  compactionBusyCheckpointId: string | null = null;
  chatAvatarUrl: string | null = null;
  chatThinkingLevel: string | null = null;
  chatQueue: ChatQueueItem[] = [];
  chatAttachments: ChatAttachment[] = [];
  configuredModels: ConfiguredModel[] = [];
  currentModel: string | null = null;
  dirtyMeterSessions: Set<string> = new Set();
  meterTotalsBaseline: Map<string, number> = new Map();
  thinkingLevel: string = "off";
  thinkingLevels: string[] = [];
  isBinaryThinking: boolean = false;
  // 会话列表刷新后按活动会话行的内核 thinkingLevels 重算档位（controllers/sessions.ts 回调）
  onSessionsLoaded = () => this.updateThinkingCapabilities();
  chatManualRefreshInFlight = false;
  // Sidebar state for tool output viewing
  sidebarOpen = false;
  sidebarContent: string | null = null;
  sidebarError: string | null = null;
  splitRatio = this.settings.splitRatio;

  execApprovalQueue: ExecApprovalRequest[] = [];
  execApprovalBusy = false;
  execApprovalError: string | null = null;
  pendingGatewayUrl: string | null = null;
  showRestartGatewayDialog = false;

  applySessionKey = this.settings.lastActiveSessionKey;

  channelsLoading = false;
  channelsSnapshot: ChannelsStatusSnapshot | null = null;
  channelsError: string | null = null;
  channelsLastSuccess: number | null = null;

  agentsLoading = false;
  agentsList: AgentsListResult | null = null;
  agentsError: string | null = null;
  agentsSelectedId: string | null = null;

  sessionsLoading = false;
  sessionsResult: SessionsListResult | null = null;
  sessionsError: string | null = null;
  sessionsFilterActive = "";
  sessionsFilterLimit = "120";
  sessionsIncludeGlobal = true;
  sessionsIncludeUnknown = false;

  cronLoading = false;
  cronJobs: CronJob[] = [];
  cronStatus: CronStatus | null = null;
  cronError: string | null = null;
  cronForm: CronFormState = { ...DEFAULT_CRON_FORM };
  cronRunsJobId: string | null = null;
  cronRuns: CronRunLogEntry[] = [];
  cronBusy = false;

  // 侧边栏会话列表管理状态（会话管理页已合并进侧边栏会话列表）：
  // includeArchived 控制 sessions.list 是否归档会话一起返回；search 为客户端过滤词
  sessionsIncludeArchived = false;
  sidebarSessionSearch = "";

  // 后台任务实时视图（v2026.7 tasks.list / tasks.cancel / task 事件）
  tasksLoading = false;
  tasksError: string | null = null;
  tasks: import("./types.js").TaskSummary[] = [];
  tasksStatusFilter: import("./types.js").TaskStatus | "all" = "all";
  tasksCancellingIds = new Set<string>();

  // 执行权限模式（官方 tools.exec.mode 合法值：deny / allowlist / ask / auto / full；
  // 三态 UI 用其中 ask / auto / full——"approve-all" 不是内核合法值，写入会触发
  // 内核 resolveExecPolicyForMode 抛 Unsupported exec mode）
  execMode: "ask" | "auto" | "full" = "ask";

  skillsLoading = false;
  skillsReport: SkillStatusReport | null = null;
  skillsError: string | null = null;
  skillsFilter = "";
  skillEdits: Record<string, string> = {};
  skillsBusyKey: string | null = null;
  skillMessages: Record<string, SkillMessage> = {};

  client: GatewayBrowserClient | null = null;
  private chatScrollFrame: number | null = null;
  private chatScrollTimeout: number | null = null;
  private chatHasAutoScrolled = false;
  chatUserNearBottom = true;
  chatNewMessagesBelow = false;
  sharePromptVisible = false;
  sharePromptCopied = false;
  sharePromptCopyError: string | null = null;
  sharePromptTitle = t("sharePrompt.title");
  sharePromptSubtitle = t("sharePrompt.subtitle");
  sharePromptText = "";
  sharePromptVersion: number | null = null;
  settingsTabHint: string | null = null;
  settingsNotice: string | null = null;
  showReleaseNotesModal = false;
  releaseNotesData: ReleaseNotesData | null = null;
  // 当前是 webbridge 模式 + 浏览器扩展未启用 → 主窗左侧栏显示「连接你的常用浏览器」pill
  // 用户点 pill → 重跑 needs-repair；扩展已启用则 pill 消失，否则保持
  // checking 期间图标换成转圈 loader
  webbridgeRepairVisible = false;
  webbridgeRepairBrowserName: string | null = null;
  webbridgeRepairChecking = false;
  // Pill 修复反馈 modal —— null 隐藏；4 种 kind 决定标题/正文
  // includesExtension: ready 场景下区分「修复了扩展（提示去启用）」vs「仅装 binary/skill（不提示）」
  // browserRunning:    ready+includesExtension 场景下决定文案是「请重启」（在跑）还是「请打开」（已关）
  //                    Chrome 跑着的时候不会主动读新写入的 External JSON，必须重启才会触发"启用扩展"弹窗
  webbridgePillModal: {
    kind: "ready" | "browser-running" | "unsupported" | "failed" | "success";
    browserName?: string;
    message?: string;
    includesExtension?: boolean;
    browserRunning?: boolean;
  } | null = null;
  private sharePromptSendCount = 0;
  private sharePromptShownVersions = new Set<number>();
  private sharePromptCheckInFlight = false;
  private toolStreamById = new Map<string, ToolStreamEntry>();
  private toolStreamOrder: string[] = [];
  basePath = "";
  private popStateHandler = () =>
    onPopStateInternal(this as unknown as Parameters<typeof onPopStateInternal>[0]);
  private themeMedia: MediaQueryList | null = null;
  private themeMediaHandler: ((event: MediaQueryListEvent) => void) | null = null;
  private appNavigateCleanup: (() => void) | null = null;
  private gatewayReadyCleanup: (() => void) | null = null;
  private webbridgeStateCleanup: (() => void) | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    handleConnected(this as unknown as Parameters<typeof handleConnected>[0]);
    this.bindAppNavigation();
    this.bindGatewayReady();
    this.bindWebbridgeStateChanged();
    this.bindWebbridgeRepairPoll();
    this.fetchReleaseNotes();
  }

  // 首屏拉取更新日志，有未展示的条目时弹出 modal。
  private fetchReleaseNotes() {
    const bridge = this.getCryoClawBridge();
    void bridge?.getReleaseNotes?.().then((data) => {
      if (data && Array.isArray(data.entries) && data.entries.length > 0) {
        this.releaseNotesData = data;
        this.showReleaseNotesModal = true;
      }
    }).catch(() => {});
  }

  disconnectedCallback() {
    this.appNavigateCleanup?.();
    this.appNavigateCleanup = null;
    this.gatewayReadyCleanup?.();
    this.gatewayReadyCleanup = null;
    this.webbridgeStateCleanup?.();
    this.webbridgeStateCleanup = null;
    handleDisconnected(this as unknown as Parameters<typeof handleDisconnected>[0]);
    super.disconnectedCallback();
  }

  protected updated(changed: Map<PropertyKey, unknown>) {
    handleUpdated(this as unknown as Parameters<typeof handleUpdated>[0], changed);
    // 从 loadChatHistory 同步 session 级别的 thinkingLevel
    if (changed.has("chatThinkingLevel")) {
      this.thinkingLevel = this.chatThinkingLevel ?? "off";
    }
    // 切换会话时按该会话行的内核 thinkingLevels 刷新档位（不触发循环：
    // updateThinkingCapabilities 只写 thinkingLevels/isBinaryThinking，不会再改这两个 watched 字段）
    if (changed.has("sessionKey") || changed.has("chatThinkingLevel")) {
      this.updateThinkingCapabilities();
    }
  }

  connect() {
    connectGatewayInternal(this as unknown as Parameters<typeof connectGatewayInternal>[0]);
  }

  handleChatScroll(event: Event) {
    handleChatScrollInternal(
      this as unknown as Parameters<typeof handleChatScrollInternal>[0],
      event,
    );
  }

  resetToolStream() {
    resetToolStreamInternal(this as unknown as Parameters<typeof resetToolStreamInternal>[0]);
  }

  resetChatScroll() {
    resetChatScrollInternal(this as unknown as Parameters<typeof resetChatScrollInternal>[0]);
  }

  scrollToBottom(opts?: { smooth?: boolean }) {
    resetChatScrollInternal(this as unknown as Parameters<typeof resetChatScrollInternal>[0]);
    scheduleChatScrollInternal(
      this as unknown as Parameters<typeof scheduleChatScrollInternal>[0],
      true,
      Boolean(opts?.smooth),
    );
  }

  async loadAssistantIdentity() {
    await loadAssistantIdentityInternal(this);
  }

  applySettings(next: UiSettings) {
    applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], next);
  }

  // 统一读取 preload 暴露的 bridge，避免在多个方法里重复类型断言。
  private getCryoClawBridge(): CryoClawBridge | undefined {
    return (window as unknown as { cryoclaw?: CryoClawBridge }).cryoclaw;
  }

  // 查 settings:webbridge-needs-repair → 控制左侧栏 pill 可见性 + 默认浏览器名（hover 用）
  // 触发时机：
  //   1) app 启动（bindWebbridgeRepairPoll 调一次）
  //   2) gateway:ready（gateway 重启时即时刷新；见 bindGatewayReady）
  //   3) webbridge:state-changed（setup-task 装完扩展、settings 修复完成时由主进程广播）
  //   4) 用户点击 pill（onWebbridgeRepairClick；扩展启用是外部行为，CryoClaw 拿不到事件，点一次查一次）
  private async runWebbridgeRepairTick() {
    const bridge = this.getCryoClawBridge();
    if (!bridge?.settingsWebbridgeNeedsRepair) return;
    try {
      const r = await bridge.settingsWebbridgeNeedsRepair();
      const data = r?.success ? r?.data : undefined;
      const visible = !!data?.visible;
      const browserName = data?.defaultBrowser?.name ?? null;
      if (visible !== this.webbridgeRepairVisible) {
        this.webbridgeRepairVisible = visible;
      }
      if (browserName !== this.webbridgeRepairBrowserName) {
        this.webbridgeRepairBrowserName = browserName;
      }
    } catch {
      // 静默失败：不打扰用户
    }
  }

  // pill 点击 → checking=true 显示转圈 → 跑主动修复 → 根据 code 给反馈 → 重查 needs-repair
  // 修复路径：浏览器关 → 自动清 blocklist + 写 External JSON → alert 提示打开浏览器看启用提示
  // 浏览器在跑 → alert 提示用户先关浏览器
  async onWebbridgeRepairClick() {
    if (this.webbridgeRepairChecking) return;
    this.webbridgeRepairChecking = true;
    try {
      const bridge = this.getCryoClawBridge();
      if (bridge?.settingsWebbridgePillRepair) {
        const r = await bridge.settingsWebbridgePillRepair();
        const browserName = r?.browserName ?? this.webbridgeRepairBrowserName ?? "Chrome";
        if (r?.success && r.code === "READY") {
          // 主进程已经主动打开浏览器+引导页 → 不弹 modal，避免和浏览器里的引导页冗余
          if (r.openedBrowser === true) {
            // pill 仍由 needs-repair tick 控制——用户在浏览器启用扩展后下次 tick 自动消失
          } else {
            this.webbridgePillModal = {
              kind: "ready",
              browserName,
              includesExtension: r.includesExtension === true,
              browserRunning: r.browserRunning === true,
            };
          }
        } else if (r?.success && r.code === "ALREADY_OK") {
          // 三组件都 OK 且用户已在浏览器点过「启用扩展」——给一个明确的成功反馈
          // pill 会被随后的 tick 隐藏；这条 modal 是用户的"修复确认信号"
          this.webbridgePillModal = { kind: "success", browserName };
        } else if (r?.code === "BROWSER_RUNNING") {
          this.webbridgePillModal = { kind: "browser-running", browserName };
        } else if (r?.code === "DEFAULT_BROWSER_UNSUPPORTED") {
          this.webbridgePillModal = { kind: "unsupported" };
        } else {
          this.webbridgePillModal = { kind: "failed", message: r?.message };
        }
      }
      // 修复后重查一次 needs-repair——若扩展真启用了 pill 自然消失
      await this.runWebbridgeRepairTick();
    } catch {
      // IPC 拒绝/异常：静默（checking 标志由 finally 复位，无状态残留）
    } finally {
      this.webbridgeRepairChecking = false;
    }
  }

  private bindWebbridgeRepairPoll() {
    void this.runWebbridgeRepairTick();
  }

  // 主进程通知 webbridge precheck 状态可能已变（setup 后台 task 装完扩展，或 settings 修复完成）
  // 不重启 gateway 的场景下专用——避免 pill 卡在 app 启动那次 tick 的旧结果
  private bindWebbridgeStateChanged() {
    if (this.webbridgeStateCleanup) return;
    const bridge = this.getCryoClawBridge();
    if (bridge?.onWebbridgeStateChanged) {
      const unsubscribe = bridge.onWebbridgeStateChanged(() => {
        void this.runWebbridgeRepairTick();
      });
      this.webbridgeStateCleanup = typeof unsubscribe === "function" ? unsubscribe : null;
    }
  }

  // 主进程通知 gateway 已就绪，立即重连（跳过指数退避盲等）
  // 同时触发 webbridge precheck 重查——修复并启用会重启 gateway，借此事件即时刷新 pill
  private bindGatewayReady() {
    if (this.gatewayReadyCleanup) return;
    const bridge = this.getCryoClawBridge();
    if (bridge?.onGatewayReady) {
      const unsubscribe = bridge.onGatewayReady((payload) => {
        // Import can replace openclaw.json before the gateway restarts; refresh
        // connection settings from the main-process payload before reconnecting.
        const token = typeof payload?.token === "string" ? payload.token.trim() : "";
        const gatewayUrl = typeof payload?.gatewayUrl === "string" ? payload.gatewayUrl.trim() : "";
        const nextSettings = { ...this.settings };
        let settingsChanged = false;
        if (token && token !== this.settings.token) {
          nextSettings.token = token;
          settingsChanged = true;
        }
        if (gatewayUrl && gatewayUrl !== this.settings.gatewayUrl) {
          nextSettings.gatewayUrl = gatewayUrl;
          settingsChanged = true;
        }

        if (settingsChanged) {
          this.applySettings(nextSettings);
          this.connect();
        } else if (!this.connected && this.client) {
          this.client.reconnectNow();
        }
        void this.runWebbridgeRepairTick();
      });
      this.gatewayReadyCleanup = typeof unsubscribe === "function" ? unsubscribe : null;
    }
  }

  private bindAppNavigation() {
    if (this.appNavigateCleanup) {
      return;
    }
    const bridge = this.getCryoClawBridge();
    if (!bridge?.onNavigate) {
      return;
    }
    const unsubscribe = bridge.onNavigate((payload) => {
      // Any view transition away from setup must clear inSetupView on main process
      if (payload?.view !== "setup") {
        bridge.reportSetupViewState?.(false);
      }

      if (payload?.view === "setup") {
        bridge.reportSetupViewState?.(true);
        this.applySettings({
          ...this.settings,
          cryoclawView: "setup",
        });
        return;
      }
      if (payload?.view === "chat") {
        const wasSetup = this.settings.cryoclawView === "setup";
        // Setup→Chat 转换时，主进程注入最新 gateway token 避免使用旧 token
        const updates: Record<string, unknown> = { cryoclawView: "chat" };
        if (payload.token) {
          updates.token = payload.token;
        }
        this.applySettings({
          ...this.settings,
          ...updates,
        });
        // Transitioning from setup → chat: gateway wasn't connected yet, start now.
        if (wasSetup) {
          deferredGatewayConnect(this as unknown as Parameters<typeof deferredGatewayConnect>[0]);
        }
        return;
      }
      if (payload?.view === "settings") {
        // 外部触发打开设置时，优先使用 payload 指定的 tab（如恢复流程 → backup）。
        this.settingsTabHint = payload.settingsTab ?? null;
        this.settingsNotice = payload.settingsNotice ?? null;
        this.applySettings({
          ...this.settings,
          cryoclawView: "settings",
          navCollapsed: false,
        });
      }
    });
    this.appNavigateCleanup = typeof unsubscribe === "function" ? unsubscribe : null;
  }

  setTheme(next: ThemeMode, context?: Parameters<typeof setThemeInternal>[2]) {
    setThemeInternal(this as unknown as Parameters<typeof setThemeInternal>[0], next, context);
  }

  async handleAbortChat() {
    await handleAbortChatInternal(this as unknown as Parameters<typeof handleAbortChatInternal>[0]);
  }

  removeQueuedMessage(id: string) {
    removeQueuedMessageInternal(
      this as unknown as Parameters<typeof removeQueuedMessageInternal>[0],
      id,
    );
  }

  editQueuedMessage(id: string, newText: string) {
    editQueuedMessageInternal(
      this as unknown as Parameters<typeof editQueuedMessageInternal>[0],
      id,
      newText,
    );
  }

  async sendQueuedMessageNow(id: string) {
    await sendQueuedMessageNowInternal(
      this as unknown as Parameters<typeof sendQueuedMessageNowInternal>[0],
      id,
    );
  }

  // 从内核 config 快照加载已配置的模型列表（R4：替代 settings:get-configured-models IPC）
  async loadConfiguredModels() {
    if (!this.client || !this.connected) {
      return;
    }
    try {
      const snap = await getConfigSnapshot(this.client);
      this.configuredModels = snap ? deriveConfiguredModels(snap.config) : [];
      // 没有手动选择时，默认选中 isDefault 的模型
      if (!this.currentModel && this.configuredModels.length > 0) {
        const defaultModel = this.configuredModels.find((m) => m.isDefault);
        this.currentModel = defaultModel?.key ?? this.configuredModels[0].key;
      }
      this.updateThinkingCapabilities();
    } catch {
      this.configuredModels = [];
    }
  }

  // 切换当前 session 的模型（通过 sessions.patch RPC）
  async handleModelChange(modelKey: string) {
    this.currentModel = modelKey;
    if (!this.client || !this.connected) {
      return;
    }
    // 切完模型先冻结 context meter；下一轮 usage 落库（totalTokens 单调推进）后由
    // app-gateway 的 usage 刷新清除。重新赋值以触发 Lit reactive 更新。
    const sessionKey = this.sessionKey;
    const currentTotal = this.sessionsResult?.sessions?.find(
      (r) => r.key === sessionKey,
    )?.totalTokens ?? 0;
    const nextDirty = new Set(this.dirtyMeterSessions);
    markSessionMeterDirty(nextDirty, sessionKey);
    this.dirtyMeterSessions = nextDirty;
    this.meterTotalsBaseline.set(sessionKey, currentTotal);
    try {
      await this.client.request("sessions.patch", {
        key: sessionKey,
        model: modelKey,
      });
    } catch (err) {
      this.lastError = String(err);
    }
    this.updateThinkingCapabilities();
  }

  // 重置模型选择为默认值（新建 session 时调用）
  resetModelToDefault() {
    if (this.configuredModels.length > 0) {
      const defaultModel = this.configuredModels.find((m) => m.isDefault);
      this.currentModel = defaultModel?.key ?? this.configuredModels[0].key;
    } else {
      this.currentModel = null;
    }
    this.thinkingLevel = "off";
    this.updateThinkingCapabilities();
  }

  // 从 models.list 目录缓存查当前模型的 compat（supportedReasoningEfforts 精确回退数据源）
  private currentModelCatalogCompat(): Record<string, unknown> | undefined {
    const key = this.currentModel;
    if (!key) return undefined;
    const slash = key.indexOf("/");
    if (slash <= 0) return undefined;
    const providerKey = key.slice(0, slash);
    const modelId = key.slice(slash + 1);
    return getCachedGatewayModelEntries()?.[providerKey]?.find((e) => e.id === modelId)?.compat;
  }

  // 根据当前模型计算支持的思考级别（内核会话行 thinkingLevels 优先，本地 provider 回退兜底）
  updateThinkingCapabilities() {
    const model = this.configuredModels.find(m => m.key === this.currentModel);
    const sessionRow = this.sessionsResult?.sessions?.find((r) => r.key === this.sessionKey);
    const caps = resolveThinkingCapabilities({
      provider: model?.provider,
      modelKey: this.currentModel,
      sessionThinkingLevels: sessionRow?.thinkingLevels,
      sessionThinkingDefault: sessionRow?.thinkingDefault,
      catalogCompat: this.currentModelCatalogCompat(),
    });
    this.thinkingLevels = caps.levels;
    this.isBinaryThinking = caps.isBinary;
    if (this.thinkingLevel !== "off" && !this.thinkingLevels.includes(this.thinkingLevel)) {
      this.thinkingLevel = "off";
      this.patchSessionThinkingLevel("off");
    }
  }

  // 解析智能默认思考级别（内核 thinkingDefault 优先）
  resolveDefaultThinkLevel(): string {
    const model = this.configuredModels.find(m => m.key === this.currentModel);
    const sessionRow = this.sessionsResult?.sessions?.find((r) => r.key === this.sessionKey);
    return resolveThinkingCapabilities({
      provider: model?.provider,
      modelKey: this.currentModel,
      sessionThinkingLevels: sessionRow?.thinkingLevels,
      sessionThinkingDefault: sessionRow?.thinkingDefault,
      catalogCompat: this.currentModelCatalogCompat(),
    }).defaultLevel;
  }

  // 切换思考开关
  async handleThinkingToggle() {
    const next = this.thinkingLevel === "off" ? this.resolveDefaultThinkLevel() : "off";
    this.thinkingLevel = next;
    await this.patchSessionThinkingLevel(next);
  }

  // 选择具体思考级别
  async handleThinkingLevelChange(level: string) {
    this.thinkingLevel = level;
    await this.patchSessionThinkingLevel(level);
  }

  // 通过 sessions.patch RPC 持久化
  private async patchSessionThinkingLevel(level: string) {
    if (!this.client || !this.connected) return;
    try {
      await this.client.request("sessions.patch", {
        key: this.sessionKey,
        thinkingLevel: level,
      });
    } catch (err) {
      this.lastError = String(err);
    }
  }

  // 恢复分享弹窗状态（累计发送次数 + 已展示版本集合）。
  private restoreSharePromptStore() {
    try {
      const raw = localStorage.getItem(SHARE_PROMPT_STORE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as Partial<SharePromptStore>;
      const sendCount = Number(parsed.sendCount);
      this.sharePromptSendCount = Number.isFinite(sendCount) && sendCount > 0
        ? Math.floor(sendCount)
        : 0;
      const versions = Array.isArray(parsed.shownVersions)
        ? parsed.shownVersions
          .map((version) => Number(version))
          .filter((version) => Number.isInteger(version) && version >= 0)
        : [];
      this.sharePromptShownVersions = new Set(versions);
    } catch {
      this.sharePromptSendCount = 0;
      this.sharePromptShownVersions = new Set();
    }
  }

  // 持久化分享弹窗状态，确保“每版本只弹一次”跨重启生效。
  private persistSharePromptStore() {
    try {
      const payload: SharePromptStore = {
        sendCount: this.sharePromptSendCount,
        shownVersions: Array.from(this.sharePromptShownVersions),
      };
      localStorage.setItem(SHARE_PROMPT_STORE_KEY, JSON.stringify(payload));
    } catch {
      // ignore storage write failures
    }
  }

  // 规范化服务端文案结构，缺语言时做互相回退。
  private normalizeShareCopyPayload(input: unknown): ShareCopyPayload | null {
    const data = input && typeof input === "object" ? (input as Record<string, unknown>) : null;
    if (!data) {
      return null;
    }
    const version = Number(data.version);
    if (!Number.isInteger(version) || version < 0) {
      return null;
    }
    const locales =
      data.locales && typeof data.locales === "object"
        ? (data.locales as Record<string, unknown>)
        : null;
    if (!locales) {
      return null;
    }
    const zhRaw =
      locales.zh && typeof locales.zh === "object"
        ? (locales.zh as Record<string, unknown>)
        : null;
    const enRaw =
      locales.en && typeof locales.en === "object"
        ? (locales.en as Record<string, unknown>)
        : null;
    if (!zhRaw || !enRaw) {
      return null;
    }
    const zhTitle = String(zhRaw.title ?? "").replace(/\r\n/g, "\n").trim();
    const zhSubtitle = String(zhRaw.subtitle ?? "").replace(/\r\n/g, "\n").trim();
    const zhBody = String(zhRaw.body ?? "").replace(/\r\n/g, "\n").trim();
    const enTitle = String(enRaw.title ?? "").replace(/\r\n/g, "\n").trim();
    const enSubtitle = String(enRaw.subtitle ?? "").replace(/\r\n/g, "\n").trim();
    const enBody = String(enRaw.body ?? "").replace(/\r\n/g, "\n").trim();
    if (!zhTitle || !zhSubtitle || !zhBody || !enTitle || !enSubtitle || !enBody) {
      return null;
    }
    return {
      version,
      locales: {
        zh: {
          title: zhTitle,
          subtitle: zhSubtitle,
          body: zhBody,
        },
        en: {
          title: enTitle,
          subtitle: enSubtitle,
          body: enBody,
        },
      },
    };
  }

  // 从主进程拉取最新分享文案（主进程负责远端拉取与本地兜底）。
  private async fetchShareCopyPayload(): Promise<ShareCopyPayload | null> {
    const bridge = (window as unknown as {
      cryoclaw?: { settingsGetShareCopy?: () => Promise<unknown> };
    }).cryoclaw;
    if (!bridge?.settingsGetShareCopy) {
      return null;
    }
    try {
      const result = await bridge.settingsGetShareCopy() as {
        success?: unknown;
        data?: unknown;
      };
      if (!result || result.success !== true) {
        return null;
      }
      return this.normalizeShareCopyPayload(result.data);
    } catch {
      return null;
    }
  }

  // 按当前客户端语言选择展示文案。
  private resolveSharePromptText(payload: ShareCopyPayload): string {
    return getLocale() === "zh" ? payload.locales.zh.body : payload.locales.en.body;
  }

  // 按当前客户端语言选择标题。
  private resolveSharePromptTitle(payload: ShareCopyPayload): string {
    return getLocale() === "zh" ? payload.locales.zh.title : payload.locales.en.title;
  }

  // 按当前客户端语言选择副标题。
  private resolveSharePromptSubtitle(payload: ShareCopyPayload): string {
    return getLocale() === "zh" ? payload.locales.zh.subtitle : payload.locales.en.subtitle;
  }

  // 达到阈值后尝试弹窗；同一版本只展示一次。
  private async maybeShowSharePrompt() {
    if (this.sharePromptCheckInFlight || this.sharePromptVisible) {
      return;
    }
    if (this.sharePromptSendCount < SHARE_PROMPT_TRIGGER_COUNT) {
      return;
    }
    this.sharePromptCheckInFlight = true;
    try {
      const payload = await this.fetchShareCopyPayload();
      if (!payload || this.sharePromptShownVersions.has(payload.version)) {
        return;
      }
      this.sharePromptTitle = this.resolveSharePromptTitle(payload);
      this.sharePromptSubtitle = this.resolveSharePromptSubtitle(payload);
      this.sharePromptText = this.resolveSharePromptText(payload);
      this.sharePromptVersion = payload.version;
      this.sharePromptCopied = false;
      this.sharePromptCopyError = null;
      this.sharePromptVisible = true;

      // 首次展示即标记已展示，避免同版本重复打扰。
      this.sharePromptShownVersions.add(payload.version);
      this.persistSharePromptStore();
    } finally {
      this.sharePromptCheckInFlight = false;
    }
  }

  // 记录一次有效用户输入，并检查是否需要触发分享弹窗。
  private recordSharePromptInput() {
    this.sharePromptSendCount += 1;
    this.persistSharePromptStore();
    void this.maybeShowSharePrompt();
  }

  async handleSendChat(
    messageOverride?: string,
    opts?: Parameters<typeof handleSendChatInternal>[2],
  ) {
    const inputText = String(messageOverride ?? this.chatMessage ?? "").trim();
    const accepted = await handleSendChatInternal(
      this as unknown as Parameters<typeof handleSendChatInternal>[0],
      messageOverride,
      opts,
    );
    if (accepted && isSharePromptCountableInput(inputText)) {
      this.recordSharePromptInput();
    }
  }

  dismissSharePrompt() {
    this.sharePromptVisible = false;
    this.sharePromptCopied = false;
    this.sharePromptCopyError = null;
    this.sharePromptVersion = null;
  }

  // 关闭更新日志弹窗，并记录当前版本为已展示。
  dismissReleaseNotes() {
    this.showReleaseNotesModal = false;
    const version = this.releaseNotesData?.currentVersion;
    if (version) {
      const bridge = this.getCryoClawBridge();
      void bridge?.dismissReleaseNotes?.(version).catch(() => {});
    }
  }

  async handleSharePromptCopy() {
    const text = this.sharePromptText.trim();
    this.sharePromptCopyError = null;
    if (!text) {
      this.sharePromptCopyError = t("sharePrompt.copyFailed");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      this.dismissSharePrompt();
      return;
    } catch {
      // Clipboard API failed; fall back to execCommand.
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    } finally {
      document.body.removeChild(textarea);
    }
    if (copied) {
      this.dismissSharePrompt();
    } else {
      this.sharePromptCopyError = t("sharePrompt.copyFailed");
    }
  }


  async loadExecMode() {
    try {
      // R4：execMode 改从内核 config 快照读取（settings:get-advanced 已缩减，
      // 不再返回 openclaw.json 侧字段）
      const snap = this.client ? await getConfigSnapshot(this.client) : null;
      this.execMode = extractAdvancedView(snap?.config ?? null).execMode;
    } catch {
      // 读取失败保持默认 ask
    }
  }

  async setExecMode(mode: "ask" | "auto" | "full") {
    this.execMode = mode;
    try {
      // R4：写 tools.exec.mode 走内核 config.patch
      if (this.client) {
        await patchConfig(this.client, (draft) => {
          applyAdvancedSave(draft, { execMode: mode });
        });
      }
    } catch {
      // 保存失败不阻塞 UI（设置页可重试）
    }
  }

  async handleExecApprovalDecision(decision: "allow-once" | "allow-always" | "deny", id?: string) {
    // 多条审批并存时按 id 决议对应条目；未传 id（或已过期被剔除）回退到队首
    const active = id
      ? (this.execApprovalQueue.find((entry) => entry.id === id) ?? this.execApprovalQueue[0])
      : this.execApprovalQueue[0];
    if (!active || !this.client || this.execApprovalBusy) {
      return;
    }
    this.execApprovalBusy = true;
    this.execApprovalError = null;
    try {
      // exec / plugin 审批共用队列，按条目 kind 走各自的 resolve 方法
      await this.client.request(`${active.kind}.approval.resolve`, {
        id: active.id,
        decision,
      });
      this.execApprovalQueue = this.execApprovalQueue.filter((entry) => entry.id !== active.id);
    } catch (err) {
      this.execApprovalError = `Exec approval failed: ${String(err)}`;
    } finally {
      this.execApprovalBusy = false;
    }
  }

  handleGatewayUrlConfirm() {
    const nextGatewayUrl = this.pendingGatewayUrl;
    if (!nextGatewayUrl) {
      return;
    }
    this.pendingGatewayUrl = null;
    applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], {
      ...this.settings,
      gatewayUrl: nextGatewayUrl,
    });
    this.connect();
  }

  handleGatewayUrlCancel() {
    this.pendingGatewayUrl = null;
  }

  // Sidebar handlers for tool output viewing
  handleOpenSidebar(content: string) {
    if (this.sidebarCloseTimer != null) {
      window.clearTimeout(this.sidebarCloseTimer);
      this.sidebarCloseTimer = null;
    }
    this.sidebarContent = content;
    this.sidebarError = null;
    this.sidebarOpen = true;
  }

  handleCloseSidebar() {
    this.sidebarOpen = false;
    // Clear content after transition
    if (this.sidebarCloseTimer != null) {
      window.clearTimeout(this.sidebarCloseTimer);
    }
    this.sidebarCloseTimer = window.setTimeout(() => {
      if (this.sidebarOpen) {
        return;
      }
      this.sidebarContent = null;
      this.sidebarError = null;
      this.sidebarCloseTimer = null;
    }, 200);
  }

  handleSplitRatioChange(ratio: number) {
    const newRatio = Math.max(0.4, Math.min(0.7, ratio));
    this.splitRatio = newRatio;
    this.applySettings({ ...this.settings, splitRatio: newRatio });
  }

  render() {
    return renderApp(this as unknown as AppViewState);
  }
}
