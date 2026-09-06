/**
 * Helper functions for tool card rendering.
 */

import { PREVIEW_MAX_CHARS, PREVIEW_MAX_LINES } from "./constants.ts";

/**
 * Format tool output content for display in the sidebar.
 * Detects JSON and wraps it in a code block with formatting.
 * opts.language：read/write/edit/apply_patch 类按文件扩展名推断出的代码语言
 * （tool-display.ts::resolveToolLanguage），作为 markdown 代码围栏语言，
 * 让 sidebar 的 code-block-enhance 能做 hljs 高亮 + 语言标签。
 * 输出里已含围栏（```）时不再包裹，防止嵌套围栏破坏渲染。
 */
export function formatToolOutputForSidebar(text: string, opts?: { language?: string }): string {
  const trimmed = text.trim();
  // Try to detect and format JSON
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return "```json\n" + JSON.stringify(parsed, null, 2) + "\n```";
    } catch {
      // Not valid JSON, return as-is
    }
  }
  const language = opts?.language?.trim();
  if (language && !text.includes("```")) {
    return "```" + language + "\n" + text + "\n```";
  }
  return text;
}

/**
 * Get a truncated preview of tool output text.
 * Truncates to first N lines or first N characters, whichever is shorter.
 */
export function getTruncatedPreview(text: string): string {
  const allLines = text.split("\n");
  const lines = allLines.slice(0, PREVIEW_MAX_LINES);
  const preview = lines.join("\n");
  if (preview.length > PREVIEW_MAX_CHARS) {
    return preview.slice(0, PREVIEW_MAX_CHARS) + "…";
  }
  return lines.length < allLines.length ? preview + "…" : preview;
}

// ── R52 T4：工具结果展现升级的纯逻辑 ──

/** 实时/最终 diff 行数统计（内核 input_delta data.diff 或 result details 解析产物） */
export type ToolDiffStat = { added: number; removed: number };

/**
 * 宽容解析 {added, removed}：仅接受非负整数对（对齐 control-ui 的 ts() 解析）。
 * 用于 input_delta 的 data.diff 与消息/卡片上回读的 diffStat 字段。
 */
export function parseDiffStat(value: unknown): ToolDiffStat | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const { added, removed } = record;
  if (
    typeof added === "number" &&
    Number.isInteger(added) &&
    added >= 0 &&
    typeof removed === "number" &&
    Number.isInteger(removed) &&
    removed >= 0
  ) {
    return { added, removed };
  }
  return undefined;
}

/**
 * 从统一 diff 文本统计 +/- 行数（result details.diff 的最终统计来源，
 * 对齐 control-ui 的 diff 解析思路；+++ 与 --- 头部行不计入）。
 * 输入源自内核已截断（≤8000 字符）的 result，规模有界，无需二次截断。
 */
export function countUnifiedDiffStat(diffText: unknown): ToolDiffStat | undefined {
  if (typeof diffText !== "string" || diffText.length === 0) {
    return undefined;
  }
  let added = 0;
  let removed = 0;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
    }
  }
  if (added === 0 && removed === 0) {
    return undefined;
  }
  return { added, removed };
}

/**
 * 失败工具卡的可见文案选择：优先内核 toolErrorSummary（result 阶段字段，
 * 内核侧 TOOL_ERROR_MAX_CHARS=400 截断），缺失时回退原始输出开头。
 */
export function resolveToolCardErrorText(card: {
  errorSummary?: string;
  error?: string;
  text?: string;
}): string | undefined {
  const summary = card.errorSummary?.trim();
  if (summary) {
    return summary;
  }
  const fallback = (card.error ?? card.text)?.trim();
  return fallback || undefined;
}
