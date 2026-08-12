/**
 * goal-display.ts — 会话目标展示的纯函数（格式逻辑与官方内核 session-goal 对齐）。
 * 数据来自 sessions.list 返回的 row.goal（display state）。
 */
import type { GoalStatus, SessionGoal } from "../types.ts";

export type GoalDisplayKind = "active" | "paused" | "complete" | "blocked" | "warn";

/** 状态 → 语义色分组（active=主题红、complete=绿、blocked/budget=琥珀、usage=红、paused=灰） */
export function goalStatusKind(status: GoalStatus): GoalDisplayKind {
  switch (status) {
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "complete":
      return "complete";
    case "blocked":
    case "budget_limited":
      return "blocked";
    case "usage_limited":
      return "warn";
  }
}

/** 状态 → i18n key（文案统一走 i18n） */
export function goalStatusKey(status: GoalStatus): string {
  switch (status) {
    case "active":
      return "goal.status.active";
    case "paused":
      return "goal.status.paused";
    case "blocked":
      return "goal.status.blocked";
    case "usage_limited":
      return "goal.status.usageLimited";
    case "budget_limited":
      return "goal.status.budgetLimited";
    case "complete":
      return "goal.status.complete";
  }
}

/** 目标计时：active 从 createdAt 起，其余从对应状态时间戳起 */
export function goalElapsedMs(goal: SessionGoal, now = Date.now()): number {
  const start = (() => {
    switch (goal.status) {
      case "active":
        return goal.createdAt;
      case "paused":
        return goal.pausedAt ?? goal.updatedAt ?? goal.createdAt;
      case "blocked":
        return goal.blockedAt ?? goal.updatedAt ?? goal.createdAt;
      case "usage_limited":
        return goal.usageLimitedAt ?? goal.updatedAt ?? goal.createdAt;
      case "budget_limited":
        return goal.budgetLimitedAt ?? goal.updatedAt ?? goal.createdAt;
      case "complete":
        return goal.completedAt ?? goal.updatedAt ?? goal.createdAt;
    }
  })();
  const startMs = typeof start === "number" && Number.isFinite(start) ? start : goal.createdAt;
  return Math.max(0, now - startMs);
}

/** 计时格式：<60s 显示秒，<60m 显示 m，否则 h/m */
export function formatGoalDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) {
    return `${totalSec}s`;
  }
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    return `${totalMin}m`;
  }
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/** 大数缩写（1.2k / 1.5m） */
export function formatGoalCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }
  if (value < 1_000) {
    return String(Math.round(value));
  }
  if (value < 1_000_000) {
    const k = value / 1_000;
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  const m = value / 1_000_000;
  return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10}m`;
}

/** token 用量展示文本："1.2k/8k" 或 "1.2k used" */
export function goalTokensLabel(goal: SessionGoal): string | null {
  const used = typeof goal.tokensUsed === "number" ? goal.tokensUsed : 0;
  if (typeof goal.tokenBudget === "number" && goal.tokenBudget > 0) {
    return `${formatGoalCount(used)}/${formatGoalCount(goal.tokenBudget)}`;
  }
  return used > 0 ? `${formatGoalCount(used)} used` : null;
}

/** token 用量百分比（0-100），无预算返回 null */
export function goalTokenPercent(goal: SessionGoal): number | null {
  if (typeof goal.tokenBudget !== "number" || goal.tokenBudget <= 0) {
    return null;
  }
  const used = typeof goal.tokensUsed === "number" ? goal.tokensUsed : 0;
  return Math.min(100, Math.max(0, Math.round((used / goal.tokenBudget) * 100)));
}

/** 横幅/胶囊共用的辅助文本：状态 + 用量 */
export function goalSummaryText(goal: SessionGoal, now = Date.now()): string {
  const tokens = goalTokensLabel(goal);
  const duration = formatGoalDuration(goalElapsedMs(goal, now));
  return tokens ? `${duration} · ${tokens}` : duration;
}
