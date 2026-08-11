/**
 * 计划悬浮面板状态（内核 update_plan 工具事件 → 独立于 toolStream 的计划状态）。
 *
 * 为什么不能挂在 ToolStreamEntry 上：chat 终态 / 用户发新消息时 resetToolStream 会清空
 * toolStreamById，而计划面板要求"同一会话内跨 turn 保留最后一次计划"，所以单独存。
 * 会话隔离：state 上带 sessionKey，渲染层按当前 sessionKey 匹配，切换会话时
 * session-transition.ts 也会把它清空。
 */

export const UPDATE_PLAN_TOOL_NAME = "update_plan";

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export type PlanStep = {
  step: string;
  status: PlanStepStatus;
};

export type PlanStreamState = {
  // 事件归属会话（可能缺省——无 sessionKey 的事件只会在活动 run 上被放行，见 app-tool-stream.ts）
  sessionKey?: string;
  runId: string;
  steps: PlanStep[];
  explanation: string | null;
  updatedAt: number;
  // 用户手动关闭；下一次 update_plan 事件到达时重置为 false（重新出现）
  dismissed: boolean;
};

export type PlanStreamHost = {
  planState: PlanStreamState | null;
};

export type PlanToolEvent = {
  sessionKey?: string;
  runId: string;
  phase: string;
  data: Record<string, unknown>;
};

function normalizeStatus(value: unknown): PlanStepStatus {
  return value === "in_progress" || value === "completed" ? value : "pending";
}

// 容错解析 plan 数组：跳过非对象项 / 空 step 文本 / 未知 status（归一为 pending）。
// 全部项都非法时返回 null（视为"这次事件没带计划"，不覆盖旧状态）。
export function parsePlanSteps(value: unknown): PlanStep[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const steps: PlanStep[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const text = typeof record.step === "string" ? record.step.trim() : "";
    if (!text) {
      continue;
    }
    steps.push({ step: text, status: normalizeStatus(record.status) });
  }
  return steps.length > 0 ? steps : null;
}

function extractFromRecord(record: Record<string, unknown>): { steps: PlanStep[]; explanation: string | null } | null {
  const steps = parsePlanSteps(record.plan);
  if (!steps) {
    return null;
  }
  const explanation =
    typeof record.explanation === "string" && record.explanation.trim().length > 0
      ? record.explanation
      : null;
  return { steps, explanation };
}

// 从工具事件负载里提取 {explanation?, plan:[...]}：
// - start 阶段：args 顶层就是 {explanation?, plan}
// - result 阶段：result.details 是 {status:"updated", explanation?, plan}
// - 兜底：result 可能被包成 {content:[{type:"text",text:"<json>"}]}，尝试 JSON 解析文本
export function extractPlanPayload(value: unknown): { steps: PlanStep[]; explanation: string | null } | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.details && typeof record.details === "object") {
    const fromDetails = extractFromRecord(record.details as Record<string, unknown>);
    if (fromDetails) {
      return fromDetails;
    }
  }
  const direct = extractFromRecord(record);
  if (direct) {
    return direct;
  }
  const content = record.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const text = (part as Record<string, unknown>).text;
      if (typeof text !== "string") {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object") {
          const fromText = extractFromRecord(parsed as Record<string, unknown>);
          if (fromText) {
            return fromText;
          }
        }
      } catch {
        // 非 JSON 文本，忽略
      }
    }
  }
  return null;
}

// update_plan 工具事件入口：start 用 args 即时上屏，update/result 用部分/最终 details 校正。
// 解析失败（这次事件没带完整 plan）时保留旧状态，不清空面板。
export function handlePlanToolEvent(host: PlanStreamHost, event: PlanToolEvent): void {
  const { phase, data } = event;
  let payload: { steps: PlanStep[]; explanation: string | null } | null = null;
  if (phase === "start") {
    payload = extractPlanPayload(data.args);
  } else if (phase === "update") {
    payload = extractPlanPayload(data.partialResult);
  } else if (phase === "result") {
    payload = extractPlanPayload(data.result);
  }
  if (!payload) {
    return;
  }
  host.planState = {
    sessionKey: event.sessionKey,
    runId: event.runId,
    steps: payload.steps,
    explanation: payload.explanation,
    updatedAt: Date.now(),
    dismissed: false,
  };
}

// 关闭面板：保留 steps（新对象触发 Lit 响应式），下次 update_plan 事件会把 dismissed 重置。
export function dismissPlan(host: PlanStreamHost): void {
  if (!host.planState) {
    return;
  }
  host.planState = { ...host.planState, dismissed: true };
}
