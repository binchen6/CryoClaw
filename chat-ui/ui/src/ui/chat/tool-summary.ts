/**
 * 工具调用折叠行的摘要逻辑（阶段 16 抽出为纯函数，供渲染层与单测共用）。
 * 折叠行形态：
 * - 单一工具：「⚡ Read · src/main.ts」——直接显示动作与目标（信息密度优先）
 * - 多个工具：「⚡ N tools · name1, name2 +M more」——计数 + 名单
 */
import type { ToolCard } from "../types/chat-types.ts";
import { formatToolDetail, resolveToolDisplay } from "../tool-display.ts";

export type ToolSummary = {
  /** 工具调用次数（call/result 取大者，防止成对消息重复计数） */
  totalTools: number;
  /** 工具名摘要：单工具为显示名；多工具 ≤3 个全列，否则前 2 个 + 「+N more」 */
  label: string;
  /** 单一工具时的动作详情（文件路径/命令等，来自工具参数）；无则 undefined */
  detail?: string;
  /** 是否为单一工具（渲染层据此隐藏计数、改显详情） */
  isSingle: boolean;
  /** 组内是否有失败（任一 result 带 isError），渲染层据此给摘要行加红色标记 */
  hasError: boolean;
};

export function summarizeToolCards(toolCards: readonly ToolCard[]): ToolSummary {
  const calls = toolCards.filter((c) => c.kind === "call");
  const results = toolCards.filter((c) => c.kind === "result");
  const totalTools = Math.max(calls.length, results.length) || toolCards.length;
  const names = [...new Set(toolCards.map((c) => c.name))];
  const hasError = toolCards.some((c) => c.error !== undefined);

  // 单一工具：用 tool-display 的显示名 + 参数详情（如 read → 文件路径）
  if (names.length === 1) {
    const name = names[0];
    const callWithArgs = calls.find((c) => c.name === name && c.args != null) ?? calls[0];
    const display = resolveToolDisplay({ name, args: callWithArgs?.args });
    return {
      totalTools,
      label: display.label,
      detail: formatToolDetail(display),
      isSingle: true,
      hasError,
    };
  }

  const label =
    names.length <= 3
      ? names.join(", ")
      : `${names.slice(0, 2).join(", ")} +${names.length - 2} more`;
  return { totalTools, label, isSingle: false, hasError };
}

/**
 * 解析当前正在执行（有 call 无 result）的工具名。
 * 从工具时间线末尾向前扫描：第一条含工具卡片的消息决定状态——
 * 含 result → 最近一次工具已完成（返回 null）；含 call → 该工具正在执行。
 */
export function resolveActiveToolName(toolMessages: readonly unknown[]): string | null {
  for (let i = toolMessages.length - 1; i >= 0; i--) {
    const m = toolMessages[i] as Record<string, unknown> | null | undefined;
    if (!m) {
      continue;
    }
    // 消息级 result 判定：流式时间线的 resultMessage 是 role=toolResult + 纯文本 content
    // （app-tool-stream.ts::buildToolResultMessage），历史里是 toolResult block 或顶层 toolCallId
    const role = typeof m.role === "string" ? m.role.toLowerCase() : "";
    if (
      role === "toolresult" ||
      role === "tool_result" ||
      role === "tool" ||
      typeof m.toolCallId === "string" ||
      typeof m.tool_call_id === "string"
    ) {
      return null;
    }
    const content = m.content;
    if (!Array.isArray(content)) {
      continue;
    }
    let callName: string | null = null;
    let hasResult = false;
    for (const block of content) {
      if (typeof block !== "object" || block === null) {
        continue;
      }
      const kind = (typeof (block as Record<string, unknown>).type === "string"
        ? ((block as Record<string, unknown>).type as string)
        : ""
      ).toLowerCase();
      if (kind === "toolresult" || kind === "tool_result") {
        hasResult = true;
      } else if (
        ["toolcall", "tool_call", "tooluse", "tool_use"].includes(kind) &&
        typeof (block as Record<string, unknown>).name === "string"
      ) {
        callName = (block as Record<string, unknown>).name as string;
      }
    }
    if (hasResult) {
      return null;
    }
    if (callName) {
      return callName;
    }
  }
  return null;
}
