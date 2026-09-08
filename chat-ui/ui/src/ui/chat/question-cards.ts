/**
 * question-cards.ts — 内核问答卡片（ask_user）纯逻辑（R61，可单测）。
 *
 * 内核契约（2026.9.2 gateway asar + control-ui 取证）：
 * - RPC：question.list → { questions: QuestionRecord[] }；
 *   question.resolve { id, cancel: true } | { id, answers: {[qid]: [label...]},
 *   secretStoreAllowedHosts? } → { status: "answered" | "cancelled" }。
 * - WS 事件：question.requested（payload=QuestionRecord）/ question.resolved
 *   （payload = { id, status: "answered"|"cancelled"|"expired", answers? }）。
 * - QuestionRecord：{ id, status, questions: [1..3], agentId?, sessionKey?,
 *   runId?, createdAtMs, expiresAtMs, answers? }；question 项：{ questionId
 *   (^[a-z][a-z0-9_]*$), header, question, options: [1..4]{label,description?},
 *   multiSelect?, isOther?, isSecret?, secretStore? }。
 * - control-ui 的按钮直答语义：单问题 + 非 multiSelect + 非 isSecret 才能
 *   tappable；secret 问题的提交统一为 ["stored"] + secretStoreAllowedHosts。
 *
 * 本模块做记录归一（无效记录丢弃，不让坏帧进 UI）、pending 选择（当前会话 +
 * 未过期）、resolve 参数构造与本地状态机。渲染层据此出卡（样式与过程卡一致）。
 */

export type QuestionOption = {
  label: string;
  description?: string;
};

export type QuestionItem = {
  questionId: string;
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
  isOther: boolean;
  isSecret: boolean;
  secretStoreAllowedHosts: string[] | null;
};

export type QuestionPrompt = {
  id: string;
  status: "pending" | "answered" | "cancelled" | "expired";
  questions: QuestionItem[];
  sessionKey: string | null;
  runId: string | null;
  createdAtMs: number;
  expiresAtMs: number;
};

export type QuestionResolution = {
  id: string;
  status: "answered" | "cancelled" | "expired";
};

const QUESTION_ID_RE = /^[a-z][a-z0-9_]*$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asBool(value: unknown): boolean {
  return value === true;
}

/** 归一单个 question 项（对齐内核 Sv 校验；无效返回 null） */
export function normalizeQuestionItem(raw: unknown): QuestionItem | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const questionId = asString(rec.questionId);
  const question = asString(rec.question);
  const header = typeof rec.header === "string" ? rec.header : null;
  if (!questionId || !QUESTION_ID_RE.test(questionId) || header === null || !question) {
    return null;
  }
  if (!Array.isArray(rec.options) || rec.options.length < 1 || rec.options.length > 4) {
    return null;
  }
  const options: QuestionOption[] = [];
  for (const opt of rec.options) {
    const o = asRecord(opt);
    if (!o) return null;
    const label = asString(o.label);
    if (!label) return null;
    if (o.description !== undefined && typeof o.description !== "string") return null;
    options.push(
      typeof o.description === "string"
        ? { label, description: o.description }
        : { label },
    );
  }
  if (rec.multiSelect !== undefined && typeof rec.multiSelect !== "boolean") return null;
  if (rec.isOther !== undefined && typeof rec.isOther !== "boolean") return null;
  let secretStoreAllowedHosts: string[] | null = null;
  if (rec.secretStore !== undefined) {
    const ss = asRecord(rec.secretStore);
    if (!ss) return null;
    if (asString(ss.kind) !== "secret") return null;
    if (Array.isArray(ss.allowedHosts)) {
      secretStoreAllowedHosts = ss.allowedHosts.filter((h) => typeof h === "string") as string[];
    }
  }
  return {
    questionId,
    header,
    question,
    options,
    multiSelect: asBool(rec.multiSelect),
    isOther: asBool(rec.isOther),
    isSecret: rec.secretStore !== undefined,
    secretStoreAllowedHosts,
  };
}

/** 归一完整记录（对齐内核 Tv；无效/非 pending 解析失败返回 null） */
export function normalizeQuestionRecord(raw: unknown): QuestionPrompt | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = asString(rec.id);
  const createdAtMs = typeof rec.createdAtMs === "number" && Number.isFinite(rec.createdAtMs) ? rec.createdAtMs : null;
  const expiresAtMs = typeof rec.expiresAtMs === "number" && Number.isFinite(rec.expiresAtMs) ? rec.expiresAtMs : null;
  if (!id || createdAtMs === null || expiresAtMs === null || !Array.isArray(rec.questions)) {
    return null;
  }
  if (rec.questions.length < 1 || rec.questions.length > 3) return null;
  const questions: QuestionItem[] = [];
  for (const q of rec.questions) {
    const item = normalizeQuestionItem(q);
    if (!item) return null;
    questions.push(item);
  }
  if (new Set(questions.map((q) => q.questionId)).size !== questions.length) return null;
  const status =
    rec.status === "pending" || rec.status === "answered" || rec.status === "cancelled" || rec.status === "expired"
      ? rec.status
      : null;
  if (!status) return null;
  return {
    id,
    status,
    questions,
    sessionKey: typeof rec.sessionKey === "string" ? rec.sessionKey : null,
    runId: typeof rec.runId === "string" ? rec.runId : null,
    createdAtMs,
    expiresAtMs,
  };
}

/** 归一 resolution 事件载荷（无效返回 null） */
export function normalizeQuestionResolution(raw: unknown): QuestionResolution | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = asString(rec.id);
  if (!id) return null;
  if (rec.status === "answered" || rec.status === "cancelled" || rec.status === "expired") {
    return { id, status: rec.status };
  }
  return null;
}

/**
 * 当前会话可见的 pending 问题（渲染入参）：sessionKey 匹配（缺 sessionKey 的
 * 全局问题任何会话都可见）且未过期。过期条目由 pruneExpiredQuestions 清理。
 */
export function selectPendingQuestions(
  prompts: QuestionPrompt[] | null | undefined,
  sessionKey: string,
  now: number = Date.now(),
): QuestionPrompt[] {
  if (!Array.isArray(prompts)) return [];
  return prompts.filter(
    (p) =>
      p.status === "pending" &&
      p.expiresAtMs > now &&
      (p.sessionKey === null || p.sessionKey === sessionKey),
  );
}

/** requested 事件 upsert：同 id 已终态则忽略（对齐 control-ui），否则替换 */
export function upsertQuestion(
  prompts: QuestionPrompt[],
  record: QuestionPrompt,
): QuestionPrompt[] {
  const existing = prompts.find((p) => p.id === record.id);
  if (existing && existing.status !== "pending") {
    return prompts;
  }
  const idx = prompts.findIndex((p) => p.id === record.id);
  if (idx < 0) return [...prompts, record];
  const next = [...prompts];
  next[idx] = record;
  return next;
}

/** resolved 事件落地：更新状态；id 不存在时忽略（重连 list 对齐兜底） */
export function applyQuestionResolution(
  prompts: QuestionPrompt[],
  resolution: QuestionResolution,
): QuestionPrompt[] {
  const idx = prompts.findIndex((p) => p.id === resolution.id);
  if (idx < 0) return prompts;
  const next = [...prompts];
  next[idx] = { ...next[idx], status: resolution.status };
  return next;
}

/** question.list 全量对齐：服务端终态覆盖一切；服务端 pending 只填补缺失/覆盖本地 pending */
export function reconcileQuestionsFromList(
  prompts: QuestionPrompt[],
  serverRecords: QuestionPrompt[],
): QuestionPrompt[] {
  const byId = new Map(prompts.map((p) => [p.id, p]));
  for (const rec of serverRecords) {
    const local = byId.get(rec.id);
    if (!local) {
      byId.set(rec.id, rec);
    } else if (rec.status !== "pending") {
      byId.set(rec.id, rec); // 服务端终态收敛本地任何状态
    } else if (local.status === "pending") {
      byId.set(rec.id, rec); // 都 pending：以服务端为准（expiresAt 等刷新）
    }
    // 服务端 pending vs 本地终态：保持本地（resolved 事件即将到达，防闪烁回退）
  }
  return [...byId.values()];
}

/** tick 过期清理：pending 且 expiresAtMs 已过 → 标记 expired（本地终态，等待 resolved/list 收敛） */
export function pruneExpiredQuestions(prompts: QuestionPrompt[], now: number = Date.now()): QuestionPrompt[] {
  let changed = false;
  const next = prompts.map((p) => {
    if (p.status === "pending" && p.expiresAtMs <= now) {
      changed = true;
      return { ...p, status: "expired" as const };
    }
    return p;
  });
  return changed ? next : prompts;
}

export type ResolveParams =
  | { id: string; cancel: true }
  | { id: string; answers: Record<string, string[]>; secretStoreAllowedHosts?: string[] };

/**
 * 构造 question.resolve 参数（对齐内核/官方 control-ui 语义）：
 * - answers 为 null → 取消（cancel: true）；
 * - secret 问题提交统一 ["stored"]（值不落 WS 明文）+ secretStore.allowedHosts；
 * - 常规问题 answers = { [questionId]: [选中 label...] }。
 */
export function buildResolveParams(
  prompt: QuestionPrompt,
  answers: Record<string, string[]> | null,
): ResolveParams {
  if (answers === null) {
    return { id: prompt.id, cancel: true };
  }
  const secretItems = prompt.questions.filter((q) => q.isSecret);
  const normalized: Record<string, string[]> = { ...answers };
  for (const q of secretItems) {
    normalized[q.questionId] = ["stored"];
  }
  const hosts = secretItems[0]?.secretStoreAllowedHosts ?? undefined;
  return hosts !== undefined
    ? { id: prompt.id, answers: normalized, secretStoreAllowedHosts: hosts }
    : { id: prompt.id, answers: normalized };
}

/** 单问题按钮直答判定（对齐内核 question-gateway-runtime 的 tappable 语义） */
export function isTappableQuestion(prompt: QuestionPrompt): boolean {
  return (
    prompt.questions.length === 1 &&
    !prompt.questions[0].multiSelect &&
    !prompt.questions[0].isSecret
  );
}
