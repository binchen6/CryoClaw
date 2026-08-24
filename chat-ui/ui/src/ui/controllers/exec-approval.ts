export type ExecApprovalRequestPayload = {
  command: string;
  cwd?: string | null;
  host?: string | null;
  security?: string | null;
  ask?: string | null;
  agentId?: string | null;
  resolvedPath?: string | null;
  sessionKey?: string | null;
};

export type ApprovalKind = "exec" | "plugin";

export type ExecApprovalRequest = {
  id: string;
  kind: ApprovalKind;
  request: ExecApprovalRequestPayload;
  /** plugin 审批的标题（如 "Apply workspace skill proposal"）；exec 审批为 null */
  title?: string | null;
  /** plugin 审批的多行说明文本；exec 审批为 null */
  description?: string | null;
  /** 内核允许的决定集合（如 ["allow-once","deny"]）；缺省表示全部允许 */
  allowedDecisions?: string[] | null;
  createdAtMs: number;
  expiresAtMs: number;
};

export type ExecApprovalResolved = {
  id: string;
  decision?: string | null;
  resolvedBy?: string | null;
  ts?: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// 审批 payload 公共外壳校验（exec / plugin 两个解析器共用）：id + request + 时间戳。
function parseApprovalEnvelope(payload: unknown): {
  id: string;
  request: Record<string, unknown>;
  createdAtMs: number;
  expiresAtMs: number;
} | null {
  if (!isRecord(payload)) {
    return null;
  }
  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  const request = payload.request;
  if (!id || !isRecord(request)) {
    return null;
  }
  const createdAtMs = typeof payload.createdAtMs === "number" ? payload.createdAtMs : 0;
  const expiresAtMs = typeof payload.expiresAtMs === "number" ? payload.expiresAtMs : 0;
  if (!createdAtMs || !expiresAtMs) {
    return null;
  }
  return { id, request, createdAtMs, expiresAtMs };
}

export function parseExecApprovalRequested(payload: unknown): ExecApprovalRequest | null {
  const env = parseApprovalEnvelope(payload);
  if (!env) {
    return null;
  }
  const { request } = env;
  const command = typeof request.command === "string" ? request.command.trim() : "";
  if (!command) {
    return null;
  }
  return {
    id: env.id,
    kind: "exec",
    request: {
      command,
      cwd: typeof request.cwd === "string" ? request.cwd : null,
      host: typeof request.host === "string" ? request.host : null,
      security: typeof request.security === "string" ? request.security : null,
      ask: typeof request.ask === "string" ? request.ask : null,
      agentId: typeof request.agentId === "string" ? request.agentId : null,
      resolvedPath: typeof request.resolvedPath === "string" ? request.resolvedPath : null,
      sessionKey: typeof request.sessionKey === "string" ? request.sessionKey : null,
    },
    createdAtMs: env.createdAtMs,
    expiresAtMs: env.expiresAtMs,
  };
}

/**
 * 解析 plugin.approval.requested（如 skill_workshop 的 "Apply workspace skill proposal"）。
 * payload 无 command 字段，标题/说明在 request.title / request.description。
 */
export function parsePluginApprovalRequested(payload: unknown): ExecApprovalRequest | null {
  const env = parseApprovalEnvelope(payload);
  if (!env) {
    return null;
  }
  const { request } = env;
  const title = typeof request.title === "string" ? request.title.trim() : "";
  if (!title) {
    return null;
  }
  const allowedDecisions = Array.isArray(request.allowedDecisions)
    ? request.allowedDecisions.filter((d): d is string => typeof d === "string")
    : null;
  return {
    id: env.id,
    kind: "plugin",
    request: {
      command: "",
      agentId: typeof request.agentId === "string" ? request.agentId : null,
      sessionKey: typeof request.sessionKey === "string" ? request.sessionKey : null,
    },
    title,
    description: typeof request.description === "string" ? request.description : null,
    allowedDecisions: allowedDecisions && allowedDecisions.length > 0 ? allowedDecisions : null,
    createdAtMs: env.createdAtMs,
    expiresAtMs: env.expiresAtMs,
  };
}

export function parseExecApprovalResolved(payload: unknown): ExecApprovalResolved | null {
  if (!isRecord(payload)) {
    return null;
  }
  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  if (!id) {
    return null;
  }
  return {
    id,
    decision: typeof payload.decision === "string" ? payload.decision : null,
    resolvedBy: typeof payload.resolvedBy === "string" ? payload.resolvedBy : null,
    ts: typeof payload.ts === "number" ? payload.ts : null,
  };
}

export function pruneExecApprovalQueue(queue: ExecApprovalRequest[]): ExecApprovalRequest[] {
  const now = Date.now();
  return queue.filter((entry) => entry.expiresAtMs > now);
}

export function addExecApproval(
  queue: ExecApprovalRequest[],
  entry: ExecApprovalRequest,
): ExecApprovalRequest[] {
  const next = pruneExecApprovalQueue(queue).filter((item) => item.id !== entry.id);
  next.push(entry);
  return next;
}

export function removeExecApproval(
  queue: ExecApprovalRequest[],
  id: string,
): ExecApprovalRequest[] {
  return pruneExecApprovalQueue(queue).filter((entry) => entry.id !== id);
}
