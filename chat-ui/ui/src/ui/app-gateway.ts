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
import { loadChatHistory, resetChatStreamState } from "./controllers/chat.ts";
import { consumePendingSessionReset } from "./session-pending.ts";
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
import { applySessionsChangedPatch } from "./controllers/sessions-patch.ts";
import { loadWorktrees } from "./controllers/worktrees.ts";
import { applyTaskEvent, loadTasks } from "./controllers/tasks.ts";
import { loadCommands } from "./controllers/commands.ts";
import type { TaskSummary } from "./types.ts";
import { GatewayBrowserClient } from "./gateway.ts";
import { configureManagedMedia, wsUrlToHttpOrigin } from "./chat/managed-media.ts";
import { applySessionKeyTransition } from "./session-transition.ts";
import { isToleratedHiddenSession } from "./session-jump.ts";
import {
  hasAssistantReplyAfter,
  isStreamStalled,
  liveOrphanRunId,
  markReconnectOrphanRun,
} from "./stream-recovery.ts";
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
  chatStreamStartedAt: number | null;
  chatLastActivityAt: number | null;
  chatMessages: unknown[];
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
// 终态到达时 gateway 可能还没持久化 usage，延迟窗口兼顾持久化窗口（R23：1500ms →
// 800ms 提速；usage 未落盘时 dirty 标记由后续 sessions.changed 事件兜底清除）。
const TERMINAL_SESSIONS_REFRESH_DELAY_MS = 800;
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
  // 显式跳转到的隐藏会话（已归档/被过滤）豁免 reconcile，防 tick 弹回 main
  if (isToleratedHiddenSession(host.sessionKey)) {
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

// R30 挂起流看门狗：final/aborted 帧在断连/gap 窗口丢失时 chatRunId 永不清，
// 流式气泡与 Stop 按钮永久挂起。距最后一次流式活动（delta/tool/thinking）超阈值后，
// 拉历史对齐内核真实状态：历史里出现 run 开始后落盘的 assistant 回复 → run 实际
// 已结束（终态帧丢失），清本地挂起态；否则（run 仍在跑/历史滞后）保持等下轮 tick。
const STREAM_IDLE_TIMEOUT_MS = 180_000;

function checkStalledStream(host: GatewayHost) {
  if (
    !isStreamStalled({
      chatRunId: host.chatRunId,
      lastActivityAt: host.chatLastActivityAt,
      now: Date.now(),
      idleMs: STREAM_IDLE_TIMEOUT_MS,
    })
  ) {
    return;
  }
  // 快照 run 身份：探测 await 期间若本轮 final 到达且队列冲刷出新一轮 run，
  // 恢复判定必须仍针对旧 run，否则会把新一轮的气泡/Stop 误清（审查发现）
  const probeRunId = host.chatRunId;
  const probeStartedAt = host.chatStreamStartedAt;
  void (async () => {
    // silent：探测是静默对齐，不置 chatLoading，避免流式挂起期间每 30s 闪一次「加载中」
    await loadChatHistory(host as unknown as OpenClawApp, { mergeIfStale: true, silent: true });
    if (!host.chatRunId || host.chatRunId !== probeRunId) {
      return; // 探测期间终态已清理 / 已切到新一轮 run
    }
    if (host.chatStreamStartedAt !== probeStartedAt) {
      return; // 同 id 复用防御（理论上不会发生，uuid 唯一）
    }
    if (hasAssistantReplyAfter(host.chatMessages, probeStartedAt)) {
      console.warn("[gateway] stalled stream recovered via history probe");
      resetChatStreamState(host as unknown as Parameters<typeof resetChatStreamState>[0]);
      resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
      // run 态已清：补一次队列冲刷，否则看门狗恢复后排队的消息会一直卡住
      void flushChatQueueForEvent(host as unknown as Parameters<typeof flushChatQueueForEvent>[0]);
    }
  })();
}

// R41 重连盲区补强：断连窗口内结束的 run + 重连读连续命中滞后快照（退避窗口 800/
// 1600/2400ms 耗尽）时，此前无任何后续刷新通道——回复静默缺失直到用户操作；看门狗也失效（onHello 已
// resetChatStreamState 清掉 chatRunId，isStreamStalled 恒假）。存在未收养 orphan 快照期间做有限次历史探测（
// silent，不闪加载态）；orphan 被 delta 收养或被终态清除后立即停止。
const ORPHAN_PROBE_DELAYS_MS = [2000, 4000, 8000];
let orphanProbeTimers: Array<ReturnType<typeof setTimeout>> = [];

function cancelReconnectOrphanProbe() {
  for (const t of orphanProbeTimers) {
    clearTimeout(t);
  }
  orphanProbeTimers = [];
}

function scheduleReconnectOrphanProbe(host: GatewayHost) {
  cancelReconnectOrphanProbe();
  ORPHAN_PROBE_DELAYS_MS.forEach((delay) => {
    const timer = setTimeout(() => {
      orphanProbeTimers = orphanProbeTimers.filter((x) => x !== timer);
      if (!liveOrphanRunId()) {
        return; // orphan 已被收养/清除/过期——恢复链路已接管，无需再探测。
      }
      void loadChatHistory(host as unknown as OpenClawApp, { mergeIfStale: true, silent: true });
    }, delay);
    orphanProbeTimers.push(timer);
  });
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
      if (previousClient) {
        // R30：断连前的在途 run 快照为 orphan——内核侧 run 可能仍在跑，
        // 重连后同 runId 的 delta（全量累计文本）会被收养续显（见 handleChatEvent）
        markReconnectOrphanRun(host.chatRunId);
      }
      // 统一走 resetChatStreamState 清理入口（R30：替代字段直赋，防双份清理逻辑漂移）
      resetChatStreamState(host as unknown as Parameters<typeof resetChatStreamState>[0]);
      resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
      // 重连清态后补一次队列冲刷：断连期间排队的消息不会因终态帧丢失而永久卡住
      // （首次连接时队列为空，flush 内部自查空队列直接返回）
      void flushChatQueueForEvent(host as unknown as Parameters<typeof flushChatQueueForEvent>[0]);
      // R23 重连兜底：流式中途断连会清掉本地 chatStream，气泡随之消失；
      // 握手完成后重拉持久化历史重建视图（仅重连路径，首次连接不走）。
      // R30：重连读改用 mergeIfStale——撞上内核滞后快照时保留本地视图防倒退，
      // 滞后收敛由延迟补拉（scheduleStaleHistoryRetry）接管。
      if (previousClient) {
        void loadChatHistory(host as unknown as OpenClawApp, { mergeIfStale: true });
        // R41：重连读可能连续命中滞后快照（退避窗口耗尽）→ 排有限次静默探测兜底。
        // orphan 不存在（断连前无在途 run）时 liveOrphanRunId 检查会让探测直接空转返回。
        scheduleReconnectOrphanProbe(host);
      }
      void loadAssistantIdentity(host as unknown as OpenClawApp);
      // 加载已配置模型列表（用于 per-session 模型选择器）
      void (host as unknown as OpenClawApp).loadConfiguredModels();
      void loadAgents(host as unknown as OpenClawApp);
      // 渠道元数据（cron 表单的渠道下拉依赖 channelsSnapshot.channelMeta）
      void loadChannels(host as unknown as OpenClawApp, false);
      void loadSessionsAndReconcile(host);
      void loadTasks(host as unknown as OpenClawApp);
      // worktree 徽标数据（sessions.list 行不带 worktree 字段，靠 ownerId 反推）
      void loadWorktrees(host as unknown as OpenClawApp);
      // 预取 / 命令目录（供 compose 补全）
      void loadCommands(host.client!);
      // 加载执行权限模式（聊天页三态）
      void (host as unknown as OpenClawApp).loadExecMode();
      void refreshActiveTab(host as unknown as Parameters<typeof refreshActiveTab>[0]);
      // 注册定时轮询并启动客户端定时器（"cron" 是 tick handler 标识，非视图 id，勿当死接线删）
      registerTickHandler("cron", () => loadCronJobs(host as unknown as Parameters<typeof loadCronJobs>[0]));
      registerTickHandler("sessions", () => loadSessionsAndReconcile(host));
      registerTickHandler("tasks", () => loadTasks(host as unknown as OpenClawApp));
      registerTickHandler("stream-watchdog", () => checkStalledStream(host));
      startTicker();
    },
    onClose: ({ code, reason }) => {
      console.warn(`[gateway] onClose code=${code} reason=${reason}`);
      if (host.client !== client) {
        return;
      }
      host.connected = false;
      // R41：新断连作废上轮重连的挂起探测（下一轮 onHello 会重新调度）
      cancelReconnectOrphanProbe();
      // 断开连接时注销 tick handler 并停止客户端定时器
      unregisterTickHandler("cron");
      unregisterTickHandler("sessions");
      unregisterTickHandler("tasks");
      unregisterTickHandler("stream-watchdog");
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
        // R30 软恢复：gap 耗尽不再只显示文案。丢的若是 final/aborted 帧，本地 run 态
        // 会永久挂起——socket 未断（事件仍在流、请求可用），清态 + 重拉历史对齐内核真实状态。
        // 清态前快照 orphan：run 内核侧仍在跑时后续 delta 可被收养续显（对齐重连路径）
        markReconnectOrphanRun(host.chatRunId);
        resetChatStreamState(host as unknown as Parameters<typeof resetChatStreamState>[0]);
        resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
        void loadChatHistory(host as unknown as OpenClawApp, { mergeIfStale: true });
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
    // 仅当前会话的活跃事件代表「用户正在看的对话」；后台会话（cron/渠道/
    // sub-agent）事件覆写会让重启后恢复到后台会话而非用户上次所看会话。
    if (payload?.sessionKey && payload.sessionKey === host.sessionKey) {
      setLastActiveSessionKey(
        host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
        payload.sessionKey,
      );
    }
    // 后台会话终态：不进 handleChatEvent（其首行按 sessionKey 过滤），
    // 但侧边栏排序/标题/未读需要及时刷新——对齐事件驱动刷新，
    // 不落到 30s ticker 兜底（复用既有 per-session 去重 + in-flight 合并）。
    // delta 等高频事件仍不处理（被下方 handleChatEvent 的 sessionKey 过滤），
    // 只补终态刷新，防刷爆。
    if (
      payload?.sessionKey &&
      payload.sessionKey !== host.sessionKey &&
      (payload.state === "final" || payload.state === "error" || payload.state === "aborted")
    ) {
      scheduleTerminalSessionsRefresh(host as unknown as OpenClawApp, payload.sessionKey);
      return;
    }
    // 须在 handleChatEvent 之前判定（final 会清空 chatRunId）：本事件是否属于当前活跃 run。
    // sub-agent 等 cross-run final 只刷新历史/会话列表，绝不能 resetToolStream——
    // 否则进行中主 run 的工具卡片会被瞬间清空，frozenPrefix 清零还会破坏后续 delta 切段。
    const isOwnRunEvent =
      !payload?.runId || !host.chatRunId || payload.runId === host.chatRunId;
    const state = handleChatEvent(host as unknown as OpenClawApp, payload);
    if (shouldRefreshSessionsForChatState(state)) {
      if (isOwnRunEvent) {
        resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
        // chat 终态顺手清掉 fallback 提示（其自身也有 5s 自动消失兜底）
        clearFallbackNotice(host as unknown as Parameters<typeof clearFallbackNotice>[0]);
      }
      void flushChatQueueForEvent(host as unknown as Parameters<typeof flushChatQueueForEvent>[0]);
      // R5 收敛：终态 sessions 拉取从「700ms + 1500ms 双次轮询」改为单次延迟拉取，
      // 同一 sessionKey 只保留一个挂起 timer（final 与紧随的 sessions.changed /
      // patchSession 连锁触发自动合并）；controllers/sessions.ts 的 in-flight 合并保留。
      // 其余即时更新改由 sessions.changed 事件驱动。
      const refreshKey = payload?.sessionKey ?? host.sessionKey;
      scheduleTerminalSessionsRefresh(host as unknown as OpenClawApp, refreshKey);
    }
    if (state === "final") {
      const sessionKey = payload?.sessionKey ?? host.sessionKey;
      // /new、/reset 终态：历史已被内核清空轮换，必须强制替换（绕过 mergeIfStale），
      // 否则重置后的空/短历史会被 R12 滞后兜底误判而继续显示旧对话
      const wasReset = consumePendingSessionReset(sessionKey);
      // R12：终态刷新启用滞后兜底（拉取结果落后本地视图时保留本地，防消息短暂消失）
      void loadChatHistory(
        host as unknown as OpenClawApp,
        wasReset ? undefined : { mergeIfStale: true },
      );
      // agent runtime 已写完 sessions.json，此时 patch pending label 不会被覆盖
      void flushPendingSessionLabel(host as unknown as OpenClawApp, sessionKey);
    } else if (state === "error" || state === "aborted") {
      // 重置未生效（失败/中止）：撤销标记。R30：本 run 的终态无条件补拉真实历史——
      // 中止/出错前内核可能已落盘部分回复，本地 reset 掉的文本由历史恢复（此前仅
      // pendingReset 时补拉）；mergeIfStale 防滞后短读造成视图倒退。
      // 外来 run（sub-agent/其他客户端）透传的终态不补拉，避免无谓 churn。
      const sessionKey = payload?.sessionKey ?? host.sessionKey;
      consumePendingSessionReset(sessionKey);
      if (isOwnRunEvent) {
        void loadChatHistory(host as unknown as OpenClawApp, { mergeIfStale: true });
      }
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

  // 会话被增删/打补丁时：先试事件携带的行快照本地 patch（免一次全量 sessions.list）；
  // 结构不符/未命中则回落全量重拉（对齐官方 control-ui 的事件驱动刷新，正确性优先）
  if (evt.event === "sessions.changed") {
    const app = host as unknown as OpenClawApp;
    const patched = applySessionsChangedPatch(app.sessionsResult, evt.payload);
    if (patched) {
      app.sessionsResult = patched;
      app.requestUpdate?.();
    } else {
      void loadSessions(app as any);
    }
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
