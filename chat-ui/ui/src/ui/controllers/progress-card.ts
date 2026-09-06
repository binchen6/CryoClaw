/**
 * Progress Card（进度卡片）controller —— openclaw 2026.8.2 内核一等能力的客户端适配。
 *
 * 内核契约（取证 docs/kernel-recon/2026.8.2-chat-capabilities.md C 节 + dist/progress-card-*.js 直读）：
 * - RPC：progressCard.get {sessionKey} → {card: {sessionKey, revision, updatedAt, markdown?, steps?} | null}
 * - RPC：progressCard.put {sessionKey, markdown?, plan?, expectedRevision?}（replace-on-write；
 *   expectedRevision 仅在「清空」时合法——即 markdown/plan 归一化后均为空）。
 *   清空被内核拒绝的三种情形（返回当前卡、不广播、不清除）：
 *   无既有卡 / revision 不匹配 / 有步骤且未全部完成。
 * - 事件：progressCard.changed {sessionKey, revision:number|null}（revision 可能为 null=已清空）。
 * - 卡片模型：markdown? string ≤8192B；steps ≤50，{step, status: pending|in_progress|completed}，
 *   至多 1 个 in_progress；空卡（无 markdown 且无步骤）等价于不存在。
 *
 * 会话/连接生命周期：
 * - 会话切换：session-transition 调 resetProgressCardForSession（清态 + 重新拉取）。
 * - 断连重连：app-gateway onHello 调 loadProgressCard 重拉当前会话。
 * - 事件失效重拉：changed 只带 sessionKey+revision，按当前会话过滤；revision 与本地一致时跳过。
 * - 竞态守卫：拉取锚定发起时的 sessionKey，响应晚到时若会话已切换则丢弃（isCurrent 守卫）；
 *   在途期间再次请求刷新置脏标记，完成后补跑一轮（同 controllers/tasks.ts loadTasks 模式）。
 */
import type { GatewayBrowserClient } from "../gateway.ts";

export type ProgressCardStepStatus = "pending" | "in_progress" | "completed";

export type ProgressCardStep = {
  step: string;
  status: ProgressCardStepStatus;
};

export type ProgressCard = {
  sessionKey: string;
  revision: number;
  updatedAt?: number;
  markdown?: string;
  steps?: ProgressCardStep[];
};

export type ProgressCardState = {
  // 拉取锚定的会话（卡片归属；渲染层与事件过滤均按它对齐当前 sessionKey）
  sessionKey: string | null;
  card: ProgressCard | null;
  loading: boolean;
  dismissing: boolean;
  error: string | null;
};

export type ProgressCardHost = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  progressCard: ProgressCardState;
};

export type ProgressCardChangedPayload = {
  sessionKey?: unknown;
  revision?: unknown;
};

const MAX_STEPS = 50; // 内核上限（plan ≤50）

export function emptyProgressCardState(sessionKey: string | null): ProgressCardState {
  return { sessionKey, card: null, loading: false, dismissing: false, error: null };
}

function normalizeStepStatus(value: unknown): ProgressCardStepStatus {
  return value === "in_progress" || value === "completed" ? value : "pending";
}

/**
 * 容错解析 progressCard.get 返回的 card：内核已保证 schema，但客户端防御性归一——
 * 跳过非法步骤项、未知 status 归 pending、超上限截断、多于 1 个 in_progress 时保留首个、
 * 其余降级 pending（渲染层不再假设内核不变量）。空卡返回 null（等价不存在）。
 */
export function normalizeProgressCard(value: unknown): ProgressCard | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const sessionKey = typeof record.sessionKey === "string" ? record.sessionKey : "";
  const revision = typeof record.revision === "number" && Number.isInteger(record.revision)
    ? record.revision
    : null;
  if (!sessionKey || revision === null || revision < 1) {
    return null;
  }
  const markdown =
    typeof record.markdown === "string" && record.markdown.trim() ? record.markdown : undefined;
  let steps: ProgressCardStep[] | undefined;
  if (Array.isArray(record.steps)) {
    const parsed: ProgressCardStep[] = [];
    let inProgressSeen = false;
    for (const entry of record.steps) {
      if (parsed.length >= MAX_STEPS) {
        break;
      }
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const stepRecord = entry as Record<string, unknown>;
      const text = typeof stepRecord.step === "string" ? stepRecord.step.trim() : "";
      if (!text) {
        continue;
      }
      let status = normalizeStepStatus(stepRecord.status);
      if (status === "in_progress") {
        if (inProgressSeen) {
          status = "pending";
        } else {
          inProgressSeen = true;
        }
      }
      parsed.push({ step: text, status });
    }
    if (parsed.length > 0) {
      steps = parsed;
    }
  }
  if (!markdown && !steps) {
    return null;
  }
  const updatedAt =
    typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
      ? record.updatedAt
      : undefined;
  return { sessionKey, revision, ...(updatedAt ? { updatedAt } : {}), ...(markdown ? { markdown } : {}), ...(steps ? { steps } : {}) };
}

export type ProgressCardStats = {
  total: number;
  done: number;
  allDone: boolean;
  current: ProgressCardStep | null;
};

export function progressCardStats(card: ProgressCard): ProgressCardStats {
  const steps = card.steps ?? [];
  const total = steps.length;
  const done = steps.filter((step) => step.status === "completed").length;
  return {
    total,
    done,
    allDone: total > 0 && done === total,
    current: steps.find((step) => step.status === "in_progress") ?? null,
  };
}

/**
 * dismiss 可用性，镜像内核清空放行条件（dist/progress-card-B2ysEcjM.js writeSessionProgressCard）：
 * 无步骤 或 全部 completed。其余情形（含在途步骤）内核会拒绝清空并返回当前卡。
 */
export function canDismissProgressCard(card: ProgressCard): boolean {
  const steps = card.steps ?? [];
  return steps.length === 0 || steps.every((step) => step.status === "completed");
}

/**
 * progressCard.changed 事件是否命中当前会话且需要重拉。
 * 事件只带 {sessionKey, revision}：跨会话事件直接忽略；revision 与本地卡一致（或同为空）
 * 说明本地已是最新，跳过以免事件回声造成无谓拉取。
 */
export function progressCardChangedNeedsReload(
  payload: ProgressCardChangedPayload | undefined,
  currentSessionKey: string,
  currentCard: ProgressCard | null,
): boolean {
  if (!payload || typeof payload.sessionKey !== "string" || !payload.sessionKey) {
    return false;
  }
  if (payload.sessionKey !== currentSessionKey) {
    return false;
  }
  const revision = typeof payload.revision === "number" ? payload.revision : null;
  if (revision === null) {
    return currentCard !== null; // 清空广播：本地还有卡才需要重拉确认
  }
  return currentCard?.revision !== revision;
}

// 在途拉取期间再次请求刷新（changed 事件/会话切换）时置脏，完成后补跑一轮：
// 否则晚到的旧响应会覆盖更新状态（同 loadTasks 的 tasksRefreshPending 模式）。
const progressCardRefreshPending = new WeakMap<ProgressCardHost, string>();
const progressCardDismissToken = new WeakMap<ProgressCardHost, symbol>();

export async function loadProgressCard(host: ProgressCardHost): Promise<void> {
  if (!host.client || !host.connected) {
    return;
  }
  const key = host.sessionKey;
  if (!key.trim()) {
    return;
  }
  if (host.progressCard.loading) {
    progressCardRefreshPending.set(host, key);
    return;
  }
  host.progressCard = { ...host.progressCard, sessionKey: key, loading: true, error: null };
  let stale = false;
  try {
    const res = await host.client.request<{ card?: unknown }>("progressCard.get", {
      sessionKey: key,
    });
    if (host.sessionKey !== key) {
      stale = true; // 会话已切换：丢弃晚到响应，防止跨会话串卡
      return;
    }
    host.progressCard = {
      ...host.progressCard,
      card: normalizeProgressCard(res?.card),
      loading: false,
      error: null,
    };
  } catch (err) {
    if (host.sessionKey !== key) {
      stale = true;
      return;
    }
    host.progressCard = { ...host.progressCard, loading: false, error: "refresh_failed" };
  } finally {
    // stale 拉取不消费脏标记：新会话的重拉已由 resetProgressCardForSession 负责，
    // 这里再补跑只会叠加冗余请求。
    const pendingSessionKey = progressCardRefreshPending.get(host);
    const refreshPending = !stale && pendingSessionKey === key;
    if (pendingSessionKey === key) {
      progressCardRefreshPending.delete(host);
    }
    if (refreshPending) {
      host.progressCard = { ...host.progressCard, loading: false };
      void loadProgressCard(host);
    }
  }
}

/** progressCard.changed 事件入口：失效重拉（过滤逻辑见 progressCardChangedNeedsReload） */
export function handleProgressCardChanged(
  host: ProgressCardHost,
  payload: ProgressCardChangedPayload | undefined,
): void {
  if (!progressCardChangedNeedsReload(payload, host.sessionKey, host.progressCard.card)) {
    return;
  }
  void loadProgressCard(host);
}

/**
 * 会话切换入口：清空上一会话卡片并拉取新会话卡片。
 * 渲染层另有 sessionKey 匹配兜底（卡片归属与当前会话不符时不渲染）。
 */
export function resetProgressCardForSession(host: ProgressCardHost, sessionKey: string): void {
  progressCardRefreshPending.delete(host);
  progressCardDismissToken.delete(host);
  host.progressCard = emptyProgressCardState(sessionKey);
  if (host.client && host.connected) {
    void loadProgressCard(host);
  }
}

/**
 * dismiss（清空卡）：内核要求清空必须带 expectedRevision 乐观锁。
 * 拿不到 revision（从未成功拉取/状态残留）时先 get 再 put。
 * 内核拒绝清空（未全部完成 / revision 失配）时返回当前卡——用返回值校正本地状态，
 * 不视为错误。返回 true 表示卡已清空。
 */
export async function dismissProgressCard(host: ProgressCardHost): Promise<boolean> {
  if (!host.client || !host.connected || host.progressCard.dismissing) {
    return false;
  }
  const sessionKey = host.sessionKey;
  if (!sessionKey.trim()) {
    return false;
  }

  // Lock before a possible get: otherwise two quick clicks without a cached card can race
  // through the fetch and issue duplicate optimistic clears.
  const token = Symbol("progress-card-dismiss");
  progressCardDismissToken.set(host, token);
  host.progressCard = { ...host.progressCard, dismissing: true, error: null };
  try {
    let card = host.progressCard.card;
    if (!card) {
      await loadProgressCard(host);
      if (host.sessionKey !== sessionKey || progressCardDismissToken.get(host) !== token) {
        return false;
      }
      card = host.progressCard.card;
    }
    if (!card || card.sessionKey !== sessionKey) {
      return false;
    }

    const res = await host.client.request<{ card?: unknown }>("progressCard.put", {
      sessionKey,
      expectedRevision: card.revision,
    });
    if (host.sessionKey !== sessionKey || progressCardDismissToken.get(host) !== token) {
      return false; // Session changed: never write a result into the new session state.
    }
    const next = normalizeProgressCard(res?.card);
    host.progressCard = { ...host.progressCard, card: next, dismissing: false, error: null };
    return next === null;
  } catch {
    if (host.sessionKey === sessionKey && progressCardDismissToken.get(host) === token) {
      host.progressCard = { ...host.progressCard, dismissing: false, error: "dismiss_failed" };
    }
    return false;
  } finally {
    if (progressCardDismissToken.get(host) === token) {
      progressCardDismissToken.delete(host);
      if (host.sessionKey === sessionKey && host.progressCard.dismissing) {
        host.progressCard = { ...host.progressCard, dismissing: false };
      }
    }
  }
}
