/**
 * Type stubs for the chat-ui project.
 *
 * These types are used across the UI layer for gateway data shapes,
 * channel statuses, session/agent/config snapshots, and log entries.
 */

// ---------------------------------------------------------------------------
// Log types
// ---------------------------------------------------------------------------

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type LogEntry = {
  raw: string;
  level?: LogLevel | null;
  msg?: string;
  message?: string;
  time?: string | null;
  ts?: number;
  subsystem?: string | null;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

export type PresenceEntry = {
  id?: string;
  host?: string;
  ip?: string;
  mode?: string;
  version?: string;
  ts?: number;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export type GoalStatus = "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";

/** 会话目标（官方 session.goal，sessions.list 返回 display state） */
export type SessionGoal = {
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed?: number;
  tokenStart?: number;
  tokenStartFresh?: boolean;
  createdAt: number;
  updatedAt?: number;
  pausedAt?: number;
  blockedAt?: number;
  usageLimitedAt?: number;
  budgetLimitedAt?: number;
  completedAt?: number;
  lastStatusNote?: string;
  [key: string]: unknown;
};

export type GatewaySessionRow = {
  key: string;
  kind?: string;
  label?: string;
  displayName?: string;
  updatedAt?: number;
  model?: string;
  totalTokens?: number;
  contextTokens?: number;
  thinkingLevel?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
  modelProvider?: string;
  // v2026.7 sessions 管理字段（sessions.list / sessions.patch）
  pinned?: boolean;
  pinnedAt?: number;
  archived?: boolean;
  archivedAt?: number;
  unread?: boolean;
  category?: string | null;
  derivedTitle?: string;
  lastMessagePreview?: string;
  hasActiveRun?: boolean;
  activeRunIds?: string[];
  estimatedCostUsd?: number;
  goal?: SessionGoal | null;
  [key: string]: unknown;
};

export type SessionsListResult = {
  path?: string;
  sessions: GatewaySessionRow[];
};

// ---------------------------------------------------------------------------
// 执行/插件审批（exec.approval / plugin.approval）——唯一定义在 controllers/exec-approval.ts
// ---------------------------------------------------------------------------

export type {
  ExecApprovalRequest,
  ExecApprovalRequestPayload,
  ApprovalKind,
} from "./controllers/exec-approval.ts";

// ---------------------------------------------------------------------------
// 命令目录（官方 commands.list）
// ---------------------------------------------------------------------------

export type CommandEntry = {
  name: string;
  nativeName?: string;
  textAliases?: string[];
  description: string;
  category?: string;
  source?: string;
  scope?: string;
  acceptsArgs: boolean;
  args?: Array<{ name?: string; description?: string; required?: boolean; [key: string]: unknown }>;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Tasks（后台任务；v2026.7 tasks.list/get/cancel + task 事件）
// ---------------------------------------------------------------------------

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";

export type TaskRuntime = "subagent" | "cron" | "acp" | "cli";

export type TaskSummary = {
  id: string;
  taskId?: string;
  status?: TaskStatus;
  kind?: string;
  runtime?: TaskRuntime;
  title?: string;
  agentId?: string;
  sessionKey?: string;
  childSessionKey?: string;
  ownerKey?: string;
  runId?: string;
  parentTaskId?: string;
  sourceId?: string;
  createdAt?: number | string;
  updatedAt?: number | string;
  startedAt?: number | string;
  endedAt?: number | string;
  progressSummary?: string;
  terminalSummary?: string;
  error?: string;
  [key: string]: unknown;
};

export type TasksListResult = {
  tasks: TaskSummary[];
  nextCursor?: string;
};

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export type AgentsListResult = {
  defaultId?: string | null;
  agents: Array<{
    id: string;
    name?: string;
    identity?: {
      name?: string;
      emoji?: string;
      avatar?: string;
      avatarUrl?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }>;
};

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export type ChannelAccountSnapshot = {
  accountId: string;
  name?: string;
  configured?: boolean;
  running?: boolean;
  connected?: boolean | null;
  lastInboundAt?: number;
  lastError?: string;
  probe?: unknown;
  [key: string]: unknown;
};

export type ChannelUiMetaEntry = {
  id: string;
  label?: string;
  [key: string]: unknown;
};

export type ChannelsStatusSnapshot = {
  channels?: Record<string, unknown>;
  channelOrder?: string[];
  channelLabels?: Record<string, string>;
  channelMeta?: ChannelUiMetaEntry[];
  channelAccounts?: Record<string, ChannelAccountSnapshot[]>;
  [key: string]: unknown;
};

export type WhatsAppStatus = {
  configured?: boolean;
  linked?: boolean;
  running?: boolean;
  connected?: boolean;
  lastConnectedAt?: number;
  lastMessageAt?: number;
  authAgeMs?: number;
  [key: string]: unknown;
};

export type TelegramStatus = {
  configured?: boolean;
  running?: boolean;
  connected?: boolean;
  lastStartAt?: number;
  [key: string]: unknown;
};

export type DiscordStatus = {
  configured?: boolean;
  running?: boolean;
  lastStartAt?: number;
  [key: string]: unknown;
};

export type GoogleChatStatus = {
  configured?: boolean;
  running?: boolean;
  credential?: string;
  [key: string]: unknown;
};

export type SlackStatus = {
  configured?: boolean;
  running?: boolean;
  lastStartAt?: number;
  [key: string]: unknown;
};

export type SignalStatus = {
  configured?: boolean;
  running?: boolean;
  baseUrl?: string;
  [key: string]: unknown;
};

export type IMessageStatus = {
  configured?: boolean;
  running?: boolean;
  lastStartAt?: number;
  [key: string]: unknown;
};

export type NostrStatus = {
  configured?: boolean;
  running?: boolean;
  connected?: boolean;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

export type CronJob = {
  id: string;
  name?: string;
  enabled?: boolean;
  schedule: {
    kind: "at" | "every" | "cron";
    at?: string;
    everyMs?: number;
    expr?: string;
    tz?: string;
    [key: string]: unknown;
  };
  payload: {
    kind: "agentTurn" | "systemEvent";
    message?: string;
    text?: string;
    [key: string]: unknown;
  };
  delivery?: {
    mode?: string;
    channel?: string;
    to?: string;
    [key: string]: unknown;
  };
  state?: {
    nextRunAtMs?: number;
    lastRunAtMs?: number;
    lastStatus?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type CronRunLogEntry = {
  ts: number;
  jobId?: string;
  status?: string;
  sessionKey?: string;
  durationMs?: number;
  summary?: string;
  error?: string;
  [key: string]: unknown;
};

export type CronStatus = {
  enabled?: boolean;
  jobs?: number;
  nextWakeMs?: number;
  nextWakeAtMs?: number | null;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export type SkillStatusEntry = {
  id?: string;
  skillKey: string;
  name?: string;
  description?: string;
  emoji?: string;
  source: string;
  bundled?: boolean;
  enabled?: boolean;
  disabled?: boolean;
  primaryEnv?: string;
  install?: Array<{ id: string; label: string }>;
  missing?: {
    bins?: string[];
    env?: string[];
    config?: string[];
    os?: string[];
  };
  error?: string;
  [key: string]: unknown;
};

export type SkillStatusReport = {
  skills: SkillStatusEntry[];
  [key: string]: unknown;
};

