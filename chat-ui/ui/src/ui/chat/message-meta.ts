/**
 * 消息级元数据提取（阶段 16）：助手消息 model 标签与 usage footer。
 *
 * 内核契约（取证：.cache/stage16-usage-model-forensics.md）：
 * - assistant 消息带 `model`/`provider`/`api`——是该次 run 实际调用的模型，
 *   区别于 sessions.list 行的会话配置 model。
 * - assistant 消息带 `usage`（命名多风格并存：totalTokens/total、
 *   inputTokens/input/promptTokens、outputTokens/output/completionTokens）
 *   及 `usage.cost.total`；chat.history 投影只对 assistant 保留这些字段。
 * - 合成消息会带全零 usage → 视为无 usage，不渲染 footer。
 */
import { extractModelId } from "../context-window.ts";
import { formatCost, formatTokens } from "../views/usage-metrics.ts";

export type MessageUsage = {
  totalTokens: number | null;
  costUsd: number | null;
};

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 消息实际生成模型（复合键取最后一段）；无 model 字段返回 null */
export function extractMessageModel(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  const raw = typeof m.model === "string" ? m.model.trim() : "";
  if (!raw) {
    return null;
  }
  return extractModelId(raw) || null;
}

/** 提取单条消息的 usage；全零/缺字段返回 null */
export function extractMessageUsage(message: unknown): MessageUsage | null {
  const m = message as Record<string, unknown>;
  const usage = m.usage;
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const u = usage as Record<string, unknown>;
  const total = num(u.totalTokens) ?? num(u.total);
  const input = num(u.inputTokens) ?? num(u.input) ?? num(u.promptTokens);
  const output = num(u.outputTokens) ?? num(u.output) ?? num(u.completionTokens);
  const summed =
    input != null || output != null ? (input ?? 0) + (output ?? 0) : null;
  const totalTokens = total ?? summed;
  const cost =
    u.cost && typeof u.cost === "object"
      ? num((u.cost as Record<string, unknown>).total)
      : null;

  const tokens = totalTokens != null && totalTokens > 0 ? totalTokens : null;
  const costUsd = cost != null && cost > 0 ? cost : null;
  if (tokens == null && costUsd == null) {
    return null;
  }
  return { totalTokens: tokens, costUsd };
}

/** 聚合一组消息的 usage（同组多次 API 调用的 token 求和）；全组无 usage 返回 null */
export function sumGroupUsage(messages: readonly unknown[]): MessageUsage | null {
  let tokens = 0;
  let cost = 0;
  let hasTokens = false;
  let hasCost = false;
  for (const message of messages) {
    const usage = extractMessageUsage(message);
    if (!usage) {
      continue;
    }
    if (usage.totalTokens != null) {
      tokens += usage.totalTokens;
      hasTokens = true;
    }
    if (usage.costUsd != null) {
      cost += usage.costUsd;
      hasCost = true;
    }
  }
  if (!hasTokens && !hasCost) {
    return null;
  }
  return { totalTokens: hasTokens ? tokens : null, costUsd: hasCost ? cost : null };
}

/** footer 展示文案：「12.3K tokens · $0.04」（成本 <0.01 时用 4 位小数避免 $0.00） */
export function formatUsageFooter(usage: MessageUsage): string {
  const parts: string[] = [];
  if (usage.totalTokens != null) {
    parts.push(`${formatTokens(usage.totalTokens)} tokens`);
  }
  if (usage.costUsd != null) {
    parts.push(formatCost(usage.costUsd, usage.costUsd >= 0.01 ? 2 : 4));
  }
  return parts.join(" · ");
}
