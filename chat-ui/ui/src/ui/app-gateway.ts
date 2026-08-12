import type { OpenClawApp } from "./app.ts";
import type { ExecApprovalRequest } from "./controllers/exec-approval.ts";
import type { GatewayEventFrame, GatewayHelloOk } from "./gateway.ts";
import type { Tab } from "./navigation.ts";
import type { UiSettings } from "./storage.ts";
import type { AgentsListResult, SessionsListResult } from "./types.ts";
import { flushChatQueueForEvent, flushPendingSessionLabel, refreshChatAvatar } from "./app-chat.ts";
import {
  applySettings,
  refreshActiveTab,
  setLastActiveSessionKey,
} from "./app-settings.ts";
import { registerTickHandler, unregisterTickHandler, startTicker, stopTicker } from "./client-ticker.ts";
import { loadCronJobs } from "./controllers/cron.ts";
import { clearSessionMeterDirtyIfUsageAdvanced } from "./context-meter.ts";
import { handleAgentEvent, resetToolStream, clearFallbackNotice, type AgentEventPayload } from "./app-tool-stream.ts";
import { debugLog, isDebugEnabled } from "./debug.ts";
import { loadAgents } from "./controllers/agents.ts";
import { loadAssistantIdentity } from "./controllers/assistant-identity.ts";
import { loadChannels } from "./controllers/channels.ts";
import { loadChatHistory } from "./controllers/chat.ts";
import { handleChatEvent, type ChatEventPayload } from "./controllers/chat.ts";
import {
  addExecApproval,
  parseExecApprovalRequested,
  parsePluginApprovalRequested,
  parseExecApprovalResolved,
  removeExecApproval,
} from "./controllers/exec-approval.ts";
import {
  recordApprovalRequested,
  recordApprovalResolved,
} from "./controllers/approval-history.ts";
import { loadSessions } from "./controllers/sessions.ts";
import { applyTaskEvent, loadTasks } from "./controllers/tasks.ts";
import { loadCommands } from "./controllers/commands.ts";
import type { TaskSummary } from "./types.ts";
import { GatewayBrowserClient } from "./gateway.ts";
import { configureManagedMedia, wsUrlToHttpOrigin } from "./chat/managed-media.ts";
import { applySessionKeyTransition } from "./session-transition.ts";
import { resolveVisibleSessionSelection } from "./session-visibility.ts";
import {
  shouldFinishUsageRefreshAttempt,
  shouldRefreshSessionsForChatState,
} from "./usage-refresh.ts";

type GatewayHost = {
  settings: UiSettings;
  password: string;
  client: GatewayBrowserClient | null;
  connected: boolean;
  hello: GatewayHelloOk | null;
  lastError: string | null;
  onboarding?: boolean;
  tab: Tab;
  agentsLoading: boolean;
  agentsList: AgentsListResult | null;
  agentsError: string | null;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string | null;
  sessionKey: string;
  sessionsLoading: boolean;
  sessionsResult: SessionsListResult | null;
  sessionsError: string | null;
  sessionsFilterActive: string;
  sessionsFilterLimit: string;
  sessionsIncludeGlobal: boolean;
  sessionsIncludeUnknown: boolean;
  chatRunId: string | null;
  dirtyMeterSessions: Set<string>;
  meterTotalsBaseline: Map<string, number>;
  execApprovalQueue: ExecApprovalRequest[];
  execApprovalError: string | null;
  tasksLoading: boolean;
  tasksError: string | null;
  tasks: TaskSummary[];
  tasksStatusFilter: string;
  tasksCancellingIds: Set<string>;
};

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
  mainKey?: string;
  mainSessionKey?: string;
  scope?: string;
};

function normalizeSessionKeyForDefaults(
  value: string | undefined,
  defaults: SessionDefaultsSnapshot,
): string {
  const raw = (value ?? "").trim();
  const mainSessionKey = defaults.mainSessionKey?.trim();
  if (!mainSessionKey) {
    return raw;
  }
  if (!raw) {
    return mainSessionKey;
  }
  const mainKey = defaults.mainKey?.trim() || "main";
  const defaultAgentId = defaults.defaultAgentId?.trim();
  const isAlias =
    raw === "main" ||
    raw === mainKey ||
    (defaultAgentId &&
      (raw === `agent:${defaultAgentId}:main` || raw === `agent:${defaultAgentId}:${mainKey}`));
  return isAlias ? mainSessionKey : raw;
}

function applySessionDefaults(host: GatewayHost, defaults?: SessionDefaultsSnapshot) {
  if (!defaults?.mainSessionKey) {
    return;
  }
  const resolvedSessionKey = normalizeSessionKeyForDefaults(host.sessionKey, defaults);
  const resolvedSettingsSessionKey = normalizeSessionKeyForDefaults(
    host.settings.sessionKey,
    defaults,
  );
  const resolvedLastActiveSessionKey = normalizeSessionKeyForDefaults(
    host.settings.lastActiveSessionKey,
    defaults,
  );
  const nextSessionKey = resolvedSessionKey || resolvedSettingsSessionKey || host.sessionKey;
  const nextSettings = {
    ...host.settings,
    sessionKey: resolvedSettingsSessionKey || nextSessionKey,
    lastActiveSessionKey: resolvedLastActiveSessionKey || nextSessionKey,
  };
  const shouldUpdateSettings =
    nextSettings.sessionKey !== host.settings.sessionKey ||
    nextSettings.lastActiveSessionKey !== host.settings.lastActiveSessionKey;
  if (nextSessionKey !== host.sessionKey) {
    host.sessionKey = nextSessionKey;
  }
  if (shouldUpdateSettings) {
    applySettings(host as unknown as Parameters<typeof applySettings>[0], nextSettings);
  }
}

// chat 终态 sessions 拉取（R5 收敛）：同一 sessionKey 只保留一个挂起的延迟拉取。
// 终态到达时 gateway 可能还没持久化 usage，1500ms 单次延迟兼顾持久化窗口（原 700ms
// 提前轮询的收益改由 sessions.changed 事件驱动的即时更新覆盖）。
const TERMINAL_SESSIONS_REFRESH_DELAY_MS = 1500;
const terminalSessionsRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleTerminalSessionsRefresh(host: OpenClawApp, refreshKey: string) {
  // 已有挂起拉取（final 与紧随的 error/aborted、或连续两轮终态），合并为一个 timer。
  if (terminalSessionsRefreshTimers.has(refreshKey)) {
    return;
  }
  // loadSessions() 会替换 sessionsResult；比较时要从最新快照重新取当前会话。
  const readUsageRow = () =>
    host.sessionsResult?.sessions?.find((r) => r.key === refreshKey) ?? null;
  // 同时比较 totalTokens 和 contextTokens：前者代表新 usage，后者代表本轮实际模型窗口。
  const readUsage = () => {
    const row = readUsageRow();
    return row ? `${row.totalTokens ?? ""}:${row.contextTokens ?? ""}` : null;
  };
  // 终态到达时 gateway 可能还没持久化，本值作为“旧快照”供延迟拉取后判断。
  const baseline = readUsage();
  const timer = setTimeout(() => {
    terminalSessionsRefreshTimers.delete(refreshKey);
    void (async () => {
      await loadSessions(host);
      const currentUsage = readUsage();
      // 单次兜底窗口：usage 前进或未变都结束，仅 totalTokens 真的前进时清冻结标记。
      if (shouldFinishUsageRefreshAttempt(baseline, currentUsage, true)) {
        const row = readUsageRow();
        const nextTotal = typeof row?.totalTokens === "number" ? row.totalTokens : 0;
        const prevTotal = host.meterTotalsBaseline.get(refreshKey) ?? 0;
        const nextDirty = new Set(host.dirtyMeterSessions);
        if (clearSessionMeterDirtyIfUsageAdvanced(nextDirty, refreshKey, prevTotal, nextTotal)) {
          host.dirtyMeterSessions = nextDirty;
          host.meterTotalsBaseline.delete(refreshKey);
        }
      }
    })();
  }, TERMINAL_SESSIONS_REFRESH_DELAY_MS);
  terminalSessionsRefreshTimers.set(refreshKey, timer);
}

function reconcileSessionSelection(host: GatewayHost) {
  if (!host.sessionsResult) {
    return;
  }
  const nextSessionKey = resolveVisibleSessionSelection(
    host.sessionKey,
    host.hello,
    host.sessionsResult,
  );
  if (!nextSessionKey || nextSessionKey === host.sessionKey) {
    return;
  }
  applySessionKeyTransition(
    host as unknown as Parameters<typeof applySessionKeyTransition>[0],
    nextSessionKey,
    true,
  );
  void refreshChatAvatar(host as unknown as Parameters<typeof refreshChatAvatar>[0]);
}

async function loadSessionsAndReconcile(host: GatewayHost) {
  await loadSessions(host as unknown as OpenClawApp);
  reconcileSessionSelection(host);
}

// gap 重连状态：最多重试 3 次，指数退避 (1s, 2s, 4s)
const GAP_RECONNECT_MAX = 3;
let gapReconnectCount = 0;

// exec.approval 过期定时器：entry.id → timer id。
// resolved 事件与重连清队列时同步 clearTimeout，避免过期回调误删重连后的同名新条目。
const execApprovalExpiryTimers = new Map<string, number>();

function clearExecApprovalExpiryTimer(id: string) {
  const timerId = execApprovalExpiryTimers.get(id);
  if (timerId !== undefined) {
    window.clearTimeout(timerId);
    execApprovalExpiryTimers.delete(id);
  }
}

function clearAllExecApprovalExpiryTimers() {
  for (const timerId of execApprovalExpiryTimers.values()) {
    window.clearTimeout(timerId);
  }
  execApprovalExpiryTimers.clear();
}

// 审批条目入队 + 过期自动剔除（exec 与 plugin 审批共用）。
// 同一 id 重复 requested 时先清旧定时器，再重新计时。
function queueApprovalEntry(host: GatewayHost, entry: ExecApprovalRequest) {
  host.execApprovalQueue = addExecApproval(host.execApprovalQueue, entry);
  host.execApprovalError = null;
  const delay = Math.max(0, entry.expiresAtMs - Date.now() + 500);
  clearExecApprovalExpiryTimer(entry.id);
  const timerId = window.setTimeout(() => {
    execApprovalExpiryTimers.delete(entry.id);
    host.execApprovalQueue = removeExecApproval(host.execApprovalQueue, entry.id);
  }, delay);
  execApprovalExpiryTimers.set(entry.id, timerId);
}

export function connectGateway(host: GatewayHost) {
  console.info("[gateway] connectGateway start");
  host.lastError = null;
  host.hello = null;
  host.connected = false;
  host.execApprovalQueue = [];
  host.execApprovalError = null;
  clearAllExecApprovalExpiryTimers();

  const previousClient = host.client;
  // 托管图片（/api/chat/media/...）：配置网关 HTTP origin 与兜底 token，
  // oc-managed-img 组件据此做 Bearer fetch → blob URL 渲染
  configureManagedMedia({
    httpOrigin: wsUrlToHttpOrigin(host.settings.gatewayUrl),
    sharedToken: host.settings.token.trim() ? host.settings.token : undefined,
  });
  const client = new GatewayBrowserClient({
    url: host.settings.gatewayUrl,
    token: host.settings.token.trim() ? host.settings.token : undefined,
    password: host.password.trim() ? host.password : undefined,
    clientName: "openclaw-control-ui",
    mode: "webchat",
    onHello: (hello) => {
      console.info("[gateway] onHello", hello.type, hello.protocol);
      if (host.client !== client) {
        return;
      }
      host.connected = true;
      host.lastError = null;
      // 连接成功，重置 gap 重连计数
      gapReconnectCount = 0;
      host.hello = hello;
      applySnapshot(host, hello);
      // Reset orphaned chat run state from before disconnect.
      // Any in-flight run's final event was lost during the disconnect window.
      host.chatRunId = null;
      (host as unknown as { chatStream: string | null }).chatStream = null;
      (host as unknown as { chatPendingStreamText: string | null }).chatPendingStreamText = null;
      (host as unknown as { chatStreamStartedAt: number | null }).chatStreamStartedAt = null;
      resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
      void loadAssistantIdentity(host as unknown as OpenClawApp);
      // 加载已配置模型列表（用于 per-session 模型选择器）
      void (host as unknown as OpenClawApp).loadConfiguredModels();
      void loadAgents(host as unknown as OpenClawApp);
      // 渠道元数据（cron 表单的渠道下拉依赖 channelsSnapshot.channelMeta）
      void loadChannels(host as unknown as OpenClawApp, false);
      void loadSessionsAndReconcile(host);
      void loadTasks(host as unknown as OpenClawApp);
      // 预取 / 命令目录（供 compose 补全）
      void loadCommands(host.client!);
      // 加载执行权限模式（聊天页三态）
      void (host as unknown as OpenClawApp).loadExecMode();
      void refreshActiveTab(host as unknown as Parameters<typeof refreshActiveTab>[0]);
      // 注册定时轮询并启动客户端定时器
      registerTickHandler("cron", () => loadCronJobs(host as unknown as Parameters<typeof loadCronJobs>[0]));
      registerTickHandler("sessions", () => loadSessionsAndReconcile(host));
      registerTickHandler("tasks", () => loadTasks(host as unknown as OpenClawApp));
      startTicker();
    },
    onClose: ({ code, reason }) => {
      console.warn(`[gateway] onClose code=${code} reason=${reason}`);
      if (host.client !== client) {
        return;
      }
      host.connected = false;
      // 断开连接时注销 tick handler 并停止客户端定时器
      unregisterTickHandler("cron");
      unregisterTickHandler("sessions");
      unregisterTickHandler("tasks");
      stopTicker();
      // Code 1012 = Service Restart (expected during config saves, don't show as error)
      if (code !== 1012) {
        host.lastError = `disconnected (${code}): ${reason || "no reason"}`;
      }
    },
    onEvent: (evt) => {
      if (host.client !== client) {
        return;
      }
      handleGatewayEvent(host, evt);
    },
    onGap: ({ expected, received }) => {
      if (host.client !== client) {
        return;
      }
      // 序列号跳跃 → 带退避的自动重连，最多 3 次
      if (gapReconnectCount >= GAP_RECONNECT_MAX) {
        console.warn(`[gateway] onGap expected=${expected} received=${received}, max retries reached`);
        host.lastError = `event gap detected (expected seq ${expected}, got ${received}); please refresh`;
        gapReconnectCount = 0;
        return;
      }
      const delay = 1000 * 2 ** gapReconnectCount;
      gapReconnectCount++;
      console.warn(`[gateway] onGap expected=${expected} received=${received}, retry ${gapReconnectCount}/${GAP_RECONNECT_MAX} in ${delay}ms`);
      setTimeout(() => {
        if (host.client === client) {
          connectGateway(host);
        }
      }, delay);
    },
  });
  host.client = client;
  previousClient?.stop();
  client.start();
}

export function handleGatewayEvent(host: GatewayHost, evt: GatewayEventFrame) {
  try {
    handleGatewayEventUnsafe(host, evt);
  } catch (err) {
    console.error("[gateway] handleGatewayEvent error:", evt.event, err);
  }
}

function handleGatewayEventUnsafe(host: GatewayHost, evt: GatewayEventFrame) {
  // 调试钩子：在 DevTools 里 `localStorage.setItem("cryoclaw.debug","gateway")` + 刷新即可看到。
  // 默认 cached === false，整段 if 是常量折叠后的死代码，对生产无开销。
  if (isDebugEnabled("gateway")) {
    debugLog("gateway", `evt:${evt.event}`, evt.payload);
  }

  if (evt.event === "agent") {
    if (host.onboarding) {
      return;
    }
    handleAgentEvent(
      host as unknown as Parameters<typeof handleAgentEvent>[0],
      evt.payload as AgentEventPayload | undefined,
    );
    return;
  }

  if (evt.event === "chat") {
    const payload = evt.payload as ChatEventPayload | undefined;
    if (payload?.sessionKey) {
      setLastActiveSessionKey(
        host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
        payload.sessionKey,
      );
    }
    const state = handleChatEvent(host as unknown as OpenClawApp, payload);
    if (shouldRefreshSessionsForChatState(state)) {
      resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
      // chat 终态顺手清掉 fallback 提示（其自身也有 5s 自动消失兜底）
      clearFallbackNotice(host as unknown as Parameters<typeof clearFallbackNotice>[0]);
      void flushChatQueueForEvent(host as unknown as Parameters<typeof flushChatQueueForEvent>[0]);
      // R5 收敛：终态 sessions 拉取从「700ms + 1500ms 双次轮询」改为单次延迟拉取，
      // 同一 sessionKey 只保留一个挂起 timer（final 与紧随的 sessions.changed /
      // patchSession 连锁触发自动合并）；controllers/sessions.ts 的 in-flight 合并保留。
      // 其余即时更新改由 sessions.changed 事件驱动。
      const refreshKey = payload?.sessionKey ?? host.sessionKey;
      scheduleTerminalSessionsRefresh(host as unknown as OpenClawApp, refreshKey);
    }
    if (state === "final") {
      // R12：终态刷新启用滞后兜底（拉取结果落后本地视图时保留本地，防消息短暂消失）
      void loadChatHistory(host as unknown as OpenClawApp, { mergeIfStale: true });
      // agent runtime 已写完 sessions.json，此时 patch pending label 不会被覆盖
      const sessionKey = payload?.sessionKey ?? host.sessionKey;
      void flushPendingSessionLabel(host as unknown as OpenClawApp, sessionKey);
    }
    return;
  }

  if (evt.event === "exec.approval.requested") {
    recordApprovalRequested("exec", evt.payload);
    const entry = parseExecApprovalRequested(evt.payload);
    if (entry) {
      queueApprovalEntry(host, entry);
    }
    return;
  }

  if (evt.event === "exec.approval.resolved") {
    recordApprovalResolved("exec", evt.payload);
    const resolved = parseExecApprovalResolved(evt.payload);
    if (resolved) {
      clearExecApprovalExpiryTimer(resolved.id);
      host.execApprovalQueue = removeExecApproval(host.execApprovalQueue, resolved.id);
    }
    return;
  }

  // 插件审批（如 skill_workshop 的 "Apply workspace skill proposal"）：
  // 既留存到审批历史（设置 → 审批），也进聊天审批弹条（内核超时仅 70s，仅留历史必然超时）
  if (evt.event === "plugin.approval.requested") {
    recordApprovalRequested("plugin", evt.payload);
    const entry = parsePluginApprovalRequested(evt.payload);
    if (entry) {
      queueApprovalEntry(host, entry);
    }
    (host as unknown as OpenClawApp).requestUpdate?.();
    return;
  }

  if (evt.event === "plugin.approval.resolved") {
    recordApprovalResolved("plugin", evt.payload);
    const resolved = parseExecApprovalResolved(evt.payload);
    if (resolved) {
      clearExecApprovalExpiryTimer(resolved.id);
      host.execApprovalQueue = removeExecApproval(host.execApprovalQueue, resolved.id);
    }
    (host as unknown as OpenClawApp).requestUpdate?.();
    return;
  }

  // 会话被增删/打补丁时：刷新侧边栏会话列表（会话管理已合并进侧边栏，
  // 归档/置顶/未读变化都需要重拉 sessions.list 才能反映）
  if (evt.event === "sessions.changed") {
    const app = host as unknown as OpenClawApp;
    void loadSessions(app as any);
    return;
  }

  // 后台任务实时事件（v2026.7）：upserted / deleted / restored
  if (evt.event === "task") {
    const app = host as unknown as OpenClawApp;
    const payload = evt.payload as { action?: string; taskId?: string; task?: TaskSummary } | undefined;
    const next = applyTaskEvent(app.tasks, payload);
    if (next) {
      app.tasks = next;
    } else {
      // restored / 未知 action → 全量重拉，避免本地状态与内核漂移
      void loadTasks(app as any);
    }
    // 任务视图打开时总是刷新（事件可能是 filtered 之外的），否则本地 upsert 已足够
    if ((app.settings.cryoclawView ?? "chat") === "tasks") {
      void loadTasks(app as any);
    }
    app.requestUpdate?.();
    return;
  }
}

export function applySnapshot(host: GatewayHost, hello: GatewayHelloOk) {
  const snapshot = hello.snapshot as
    | {
        sessionDefaults?: SessionDefaultsSnapshot;
      }
    | undefined;
  if (snapshot?.sessionDefaults) {
    applySessionDefaults(host, snapshot.sessionDefaults);
  }
}
