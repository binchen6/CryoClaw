// R1 渲染层双保险（纯逻辑模块，无 DOM 依赖，可单测）。
//
// 终态帧在断连/gap 窗口丢失时，app 层的恢复链路（预对齐/看门狗/orphan 探测）
// 会清掉本地流式态，但存在清态尚未跑到的窗口：历史已含本轮回复（静默 mergeIfStale
// 对齐落盘），chatStream 气泡仍在渲染——同一段文本双份上屏。
// 此处按内容判定：历史末条 assistant 消息文本与流式文本归一化后相同 → 跳过流式气泡，
// 让历史成为唯一渲染源。与 app 层清态互不依赖，双保险。
import { extractText } from "./message-extract.ts";

function normalizeForComparison(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 流式气泡文本是否已被历史末条 assistant 消息覆盖（重复）。
 * 只认全等（归一化后）：流式文本是历史的严格前缀说明仍在续流，不得抑制。
 */
export function isStreamTextDuplicatedInHistory(
  messages: unknown[],
  streamText: string | null,
): boolean {
  const normalizedStream = streamText == null ? "" : normalizeForComparison(streamText);
  if (!normalizedStream) {
    return false;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Record<string, unknown> | undefined;
    if (message?.role !== "assistant") {
      continue;
    }
    const text = extractText(messages[i]);
    if (text == null) {
      continue;
    }
    return normalizeForComparison(text) === normalizedStream;
  }
  return false;
}
