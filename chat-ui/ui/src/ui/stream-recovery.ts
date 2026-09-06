/**
 * 流式中断恢复 —— 纯逻辑模块（无 DOM/网络依赖，可单测）。
 *
 * 覆盖三类中断场景（取证见 R30）：
 * 1. 重连续跑恢复：WS 断连重连后 onHello 会清空本地 run 态，但内核侧的 run
 *    可能仍在跑。断连前快照 chatRunId 为 orphan；重连后收到同 runId 的 delta
 *    （全量累计文本，天然可续）时重新收养为当前 run，流式续显 + Stop 恢复可用。
 * 2. 挂起流看门狗：final/aborted 帧在断连/gap 窗口丢失时，chatRunId 永不清、
 *    流式气泡与 Stop 永久挂起。以「最后一次流式活动」为锚做空闲判定，超时后
 *    由调用方拉历史对齐内核真实状态。
 * 3. 滞后读恢复判定：历史里出现 run 开始后落盘的 assistant 回复 → run 实际
 *    已结束（终态帧丢失），可安全清掉本地挂起态。
 */

// ── 重连 orphan run 快照 ──

// orphan 快照有效期：超过后不再收养（内核侧 run 大概率已终结/帧已永久丢失）
const ORPHAN_RUN_TTL_MS = 120_000;
const DEFAULT_ORPHAN_SESSION = "__default__";

type OrphanRunSnapshot = {
  runId: string;
  markedAt: number;
};

// Keep orphan snapshots session-scoped. A single global run id could let a late
// frame from session A be adopted by session B after a fast session switch.
const orphanRuns = new Map<string, OrphanRunSnapshot>();

function resolveOrphanArgs(
  sessionKeyOrNow?: string | number,
  now = Date.now(),
): { sessionKey: string; now: number } {
  if (typeof sessionKeyOrNow === "number") {
    return { sessionKey: DEFAULT_ORPHAN_SESSION, now: sessionKeyOrNow };
  }
  return {
    sessionKey: sessionKeyOrNow?.trim() || DEFAULT_ORPHAN_SESSION,
    now,
  };
}

/** 断连清态前快照在途 runId（仅重连路径调用） */
export function markReconnectOrphanRun(
  runId: string | null | undefined,
  sessionKeyOrNow?: string | number,
  now = Date.now(),
) {
  const args = resolveOrphanArgs(sessionKeyOrNow, now);
  const trimmed = runId?.trim();
  if (!trimmed) {
    orphanRuns.delete(args.sessionKey);
    return;
  }
  orphanRuns.set(args.sessionKey, { runId: trimmed, markedAt: args.now });
}

/** 当前可收养的 orphan runId（过期自动清除） */
export function liveOrphanRunId(sessionKeyOrNow?: string | number, now = Date.now()): string | null {
  const args = resolveOrphanArgs(sessionKeyOrNow, now);
  const snapshot = orphanRuns.get(args.sessionKey);
  if (!snapshot) {
    return null;
  }
  if (args.now - snapshot.markedAt > ORPHAN_RUN_TTL_MS) {
    orphanRuns.delete(args.sessionKey);
    return null;
  }
  return snapshot.runId;
}

/** run 终结 / 用户发起新 run / 切换会话时清除 orphan 快照 */
export function clearReconnectOrphanRun(runId?: string, sessionKey?: string) {
  if (sessionKey !== undefined) {
    const key = sessionKey.trim() || DEFAULT_ORPHAN_SESSION;
    const current = orphanRuns.get(key);
    if (runId === undefined || current?.runId === runId) {
      orphanRuns.delete(key);
    }
    return;
  }
  for (const [key, current] of orphanRuns) {
    if (runId === undefined || current.runId === runId) {
      orphanRuns.delete(key);
    }
  }
}

// ── 挂起流看门狗 ──

export type StreamIdleProbe = {
  chatRunId: string | null;
  /** 最后一次流式活动（delta 接受 / tool 事件 / thinking 事件）时间戳 */
  lastActivityAt: number | null;
  now: number;
  idleMs: number;
};

/**
 * 空闲超时判定：有活跃 run 且距最后一次流式活动超过 idleMs → 需要拉历史探测。
 * lastActivityAt 缺失（旧状态/刚启动）按不超时处理，宁可等下一次 tick。
 */
export function isStreamStalled(probe: StreamIdleProbe): boolean {
  if (!probe.chatRunId) {
    return false;
  }
  if (probe.lastActivityAt == null || !Number.isFinite(probe.lastActivityAt)) {
    return false;
  }
  return probe.now - probe.lastActivityAt > probe.idleMs;
}

// ── 滞后读恢复判定 ──

/**
 * 历史消息里是否存在 run 开始之后落盘的 assistant 回复。
 * 是 → run 的终态帧虽丢，但结果已持久化，可清本地挂起态（看门狗恢复）。
 * 缺 timestamp 的条目无法判定，跳过继续向前扫（避免末尾一条缺时间戳时恒不清挂起态）。
 */
export function hasAssistantReplyAfter(messages: unknown[], runStartedAt: number | null): boolean {
  if (runStartedAt == null || !Number.isFinite(runStartedAt)) {
    return false;
  }
  // 1s 容差：内核落盘时间戳与本地 run 起始计时之间可能有微小偏差
  const threshold = runStartedAt - 1000;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown>;
    if (m?.role !== "assistant") {
      continue;
    }
    // 本地注入的合成错误卡不算内核落盘结果
    if (m.cryoclawError === true) {
      continue;
    }
    const ts = typeof m.timestamp === "number" ? m.timestamp : Number.NaN;
    // 缺 timestamp 的条目无法判定——跳过继续向前扫（此前直接 return 导致
    // 末尾一条缺时间戳时看门狗恒不清挂起态）；时间戳早于阈值的旧回复同样跳过
    if (Number.isFinite(ts) && ts >= threshold) {
      return true;
    }
  }
  return false;
}
