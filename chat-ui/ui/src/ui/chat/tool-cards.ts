import { html, nothing } from "lit";
import type { ToolCard } from "../types/chat-types.ts";
import { icons } from "../icons.ts";
import { formatToolDetail, resolveToolDisplay } from "../tool-display.ts";
import { TOOL_INLINE_THRESHOLD } from "./constants.ts";
import { extractTextCached } from "./message-extract.ts";
import { isToolResultMessage } from "./message-normalizer.ts";
import { formatToolOutputForSidebar, getTruncatedPreview } from "./tool-helpers.ts";
import { t } from "../i18n.ts";

export function extractToolCards(message: unknown): ToolCard[] {
  const m = message as Record<string, unknown>;
  const content = normalizeContent(m.content);
  const cards: ToolCard[] = [];
  // 流式 callMessage 的进行中标记（app-tool-stream.ts::buildToolCallMessage）
  const pending = m.pending === true;

  for (const item of content) {
    const kind = (typeof item.type === "string" ? item.type : "").toLowerCase();
    const isToolCall =
      ["toolcall", "tool_call", "tooluse", "tool_use"].includes(kind) ||
      (typeof item.name === "string" && item.arguments != null);
    if (isToolCall) {
      cards.push({
        kind: "call",
        name: (item.name as string) ?? "tool",
        args: coerceArgs(item.arguments ?? item.args),
        ...(pending ? { pending: true } : {}),
      });
    }
  }

  for (const item of content) {
    const kind = (typeof item.type === "string" ? item.type : "").toLowerCase();
    if (kind !== "toolresult" && kind !== "tool_result") {
      continue;
    }
    const text = extractToolText(item);
    const name = typeof item.name === "string" ? item.name : "tool";
    // 历史 toolResult block 可能自带 isError（宽容解析：仅严格 true 计失败）
    const failed = item.isError === true;
    cards.push({ kind: "result", name, text, ...(failed ? { error: text ?? "" } : {}) });
  }

  if (isToolResultMessage(message) && !cards.some((card) => card.kind === "result")) {
    const name =
      (typeof m.toolName === "string" && m.toolName) ||
      (typeof m.tool_name === "string" && m.tool_name) ||
      "tool";
    const text = extractTextCached(message) ?? undefined;
    // 消息级 isError：流式 resultMessage（buildToolResultMessage）或历史 toolResult 消息
    const failed = m.isError === true;
    cards.push({ kind: "result", name, text, ...(failed ? { error: text ?? "" } : {}) });
  }

  return cards;
}

export function renderToolCardSidebar(card: ToolCard, onOpenSidebar?: (content: string) => void) {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  const hasText = Boolean(card.text?.trim());

  // 三态：执行中（流式 call 无 result）/ 失败（isError）/ 完成
  const isRunning = card.pending === true;
  const isFailed = card.error !== undefined;

  const canClick = Boolean(onOpenSidebar) && !isRunning;
  const handleClick = canClick
    ? () => {
        if (hasText) {
          onOpenSidebar!(formatToolOutputForSidebar(card.text!));
          return;
        }
        const info = `## ${display.label}\n\n${
          detail ? `**Command:** \`${detail}\`\n\n` : ""
        }*No output — tool completed successfully.*`;
        onOpenSidebar!(info);
      }
    : undefined;

  const isShort = hasText && (card.text?.length ?? 0) <= TOOL_INLINE_THRESHOLD;
  const showCollapsed = hasText && !isShort;
  const showInline = hasText && isShort;
  const isEmpty = !hasText;

  const cardClass = [
    "chat-tool-card",
    canClick ? "chat-tool-card--clickable" : "",
    isRunning ? "chat-tool-card--running" : "",
    isFailed ? "chat-tool-card--failed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return html`
    <div
      class=${cardClass}
      @click=${handleClick}
      role=${canClick ? "button" : nothing}
      tabindex=${canClick ? "0" : nothing}
      @keydown=${
        canClick
          ? (e: KeyboardEvent) => {
              if (e.key !== "Enter" && e.key !== " ") {
                return;
              }
              e.preventDefault();
              handleClick?.();
            }
          : nothing
      }
    >
      <div class="chat-tool-card__header">
        <div class="chat-tool-card__title">
          <span class="chat-tool-card__icon">${icons[display.icon]}</span>
          <span>${display.label}</span>
        </div>
        ${
          isRunning
            ? html`<span class="chat-tool-card__status chat-tool-card__status--running" aria-label=${t("chat.toolRunning")}>
                <span class="chat-tool-card__spinner" aria-hidden="true"></span>
              </span>`
            : isFailed
              ? html`<span class="chat-tool-card__status chat-tool-card__status--failed">${icons.x}</span>`
              : canClick
                ? html`<span class="chat-tool-card__action">${hasText ? t("chat.toolView") : ""} ${icons.check}</span>`
                : isEmpty
                  ? html`<span class="chat-tool-card__status">${icons.check}</span>`
                  : nothing
        }
      </div>
      ${detail ? html`<div class="chat-tool-card__detail">${detail}</div>` : nothing}
      ${
        isRunning
          ? html`
              <div class="chat-tool-card__status-text muted">${t("chat.toolRunning")}</div>
            `
          : isFailed
            ? html`
                <div class="chat-tool-card__status-text chat-tool-card__status-text--failed">${t("chat.toolFailed")}</div>
              `
            : isEmpty
              ? html`
                  <div class="chat-tool-card__status-text muted">${t("chat.toolCompleted")}</div>
                `
              : nothing
      }
      ${
        showCollapsed
          ? html`<div class="chat-tool-card__preview mono">${getTruncatedPreview(card.text!)}</div>`
          : nothing
      }
      ${showInline ? html`<div class="chat-tool-card__inline mono">${card.text}</div>` : nothing}
    </div>
  `;
}

function normalizeContent(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(Boolean) as Array<Record<string, unknown>>;
}

function coerceArgs(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractToolText(item: Record<string, unknown>): string | undefined {
  if (typeof item.text === "string") {
    return item.text;
  }
  if (typeof item.content === "string") {
    return item.content;
  }
  return undefined;
}
