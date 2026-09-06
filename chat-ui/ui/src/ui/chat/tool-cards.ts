import { html, nothing } from "lit";
import type { ToolCard } from "../types/chat-types.ts";
import { icons } from "../icons.ts";
import { formatToolDetail, resolveToolDisplay, resolveToolLanguage } from "../tool-display.ts";
import { TOOL_INLINE_THRESHOLD } from "./constants.ts";
import { extractTextCached } from "./message-extract.ts";
import { isToolResultMessage } from "./message-normalizer.ts";
import {
  formatToolOutputForSidebar,
  getTruncatedPreview,
  parseDiffStat,
  resolveToolCardErrorText,
} from "./tool-helpers.ts";
import { t } from "../i18n.ts";

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

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
      // R52 T4：call 内容块上的 diffStat（app-tool-stream 注入：input_delta 实时值 /
      // result 终态值），运行中与完成态都可显示 +a/-r 徽标
      const diffStat = parseDiffStat(item.diffStat);
      cards.push({
        kind: "call",
        name: (item.name as string) ?? "tool",
        args: coerceArgs(item.arguments ?? item.args),
        ...(pending ? { pending: true } : {}),
        ...(diffStat ? { diffStat } : {}),
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
    // R52 T4：历史 block 形态也可能带 errorSummary/exitCode/diffStat（宽容读取）
    const errorSummary = asNonEmptyString(item.toolErrorSummary);
    const exitCode = asInteger(item.exitCode);
    const diffStat = parseDiffStat(item.diffStat);
    cards.push({
      kind: "result",
      name,
      text,
      ...(failed ? { error: text ?? "" } : {}),
      ...(errorSummary ? { errorSummary } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(diffStat ? { diffStat } : {}),
    });
  }

  if (isToolResultMessage(message) && !cards.some((card) => card.kind === "result")) {
    const name =
      (typeof m.toolName === "string" && m.toolName) ||
      (typeof m.tool_name === "string" && m.tool_name) ||
      "tool";
    const text = extractTextCached(message) ?? undefined;
    // 消息级 isError：流式 resultMessage（buildToolResultMessage）或历史 toolResult 消息
    const failed = m.isError === true;
    // R52 T4：流式 resultMessage 透传的 toolArgs（sidebar 语言推断/detail）与
    // toolErrorSummary/exitCode/diffStat（错误摘要、退出码徽标、最终 diff）
    const errorSummary = asNonEmptyString(m.toolErrorSummary);
    const exitCode = asInteger(m.exitCode);
    const diffStat = parseDiffStat(m.diffStat);
    cards.push({
      kind: "result",
      name,
      text,
      ...(m.toolArgs !== undefined ? { args: m.toolArgs } : {}),
      ...(failed ? { error: text ?? "" } : {}),
      ...(errorSummary ? { errorSummary } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(diffStat ? { diffStat } : {}),
    });
  }

  return cards;
}

// R52 T4：复制按钮反馈时长（与 code-block-enhance / copy-as-markdown 一致）
const COPY_FEEDBACK_MS = 1500;
const COPY_ERROR_FEEDBACK_MS = 2000;

// 内核只对 exec 类结果附 exitCode（control-ui 注册表：bash/exec/process/terminal 族）
const EXIT_CODE_TOOL_NAMES = new Set([
  "exec",
  "bash",
  "process",
  "terminal",
  "shell",
  "code_execution",
]);

// 完成/失败态工具卡的「复制输出」按钮：复用正文代码块复制交互范式
// （CryoIcons copy→check 图标态切换 + title/aria-label 反馈），
// 点击/按键都 stopPropagation，避免触发卡片整卡的 sidebar 打开。
function renderToolCardCopyButton(getText: () => string) {
  const idleLabel = t("chat.toolCopyOutput");
  const setLabel = (btn: HTMLButtonElement, label: string) => {
    btn.title = label;
    btn.setAttribute("aria-label", label);
  };
  return html`<button
    class="chat-tool-card__copy"
    type="button"
    title=${idleLabel}
    aria-label=${idleLabel}
    @click=${async (event: Event) => {
      event.stopPropagation();
      const btn = event.currentTarget as HTMLButtonElement | null;
      if (!btn || btn.dataset.busy === "1") {
        return;
      }
      btn.dataset.busy = "1";
      let ok = false;
      try {
        const text = getText();
        if (text) {
          await navigator.clipboard.writeText(text);
          ok = true;
        }
      } catch {
        ok = false;
      }
      if (!btn.isConnected) {
        return;
      }
      delete btn.dataset.busy;
      if (ok) {
        btn.dataset.copied = "1";
        setLabel(btn, t("chat.toolCopied"));
        window.setTimeout(() => {
          if (!btn.isConnected) {
            return;
          }
          delete btn.dataset.copied;
          setLabel(btn, t("chat.toolCopyOutput"));
        }, COPY_FEEDBACK_MS);
      } else {
        btn.dataset.error = "1";
        setLabel(btn, t("chat.toolCopyFailed"));
        window.setTimeout(() => {
          if (!btn.isConnected) {
            return;
          }
          delete btn.dataset.error;
          setLabel(btn, t("chat.toolCopyOutput"));
        }, COPY_ERROR_FEEDBACK_MS);
      }
    }}
    @keydown=${(event: KeyboardEvent) => event.stopPropagation()}
  >
    <span class="chat-tool-card__copy-icon chat-tool-card__copy-icon--idle" aria-hidden="true">${icons.copy}</span>
    <span class="chat-tool-card__copy-icon chat-tool-card__copy-icon--done" aria-hidden="true">${icons.check}</span>
  </button>`;
}

// 实时/最终 diff 徽标：+added 绿 / −removed 红（语义色 token）
function renderDiffStatBadge(stat: { added: number; removed: number }) {
  const aria = t("chat.toolDiffAria")
    .replace("{added}", String(stat.added))
    .replace("{removed}", String(stat.removed));
  return html`<span class="chat-tool-card__diff" role="status" aria-label=${aria}>
    <span class="chat-tool-card__diff-added" aria-hidden="true">+${stat.added}</span>
    <span class="chat-tool-card__diff-removed" aria-hidden="true">−${stat.removed}</span>
  </span>`;
}

export function renderToolCardSidebar(card: ToolCard, onOpenSidebar?: (content: string) => void) {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);

  // 三态：执行中（流式 call 无 result）/ 失败（isError）/ 完成
  const isRunning = card.pending === true;
  const isFailed = card.error !== undefined;

  // R52 T4：失败卡可见文案优先 toolErrorSummary（内核 ≤400 字符摘要）而非裸输出开头；
  // sidebar 仍展示完整原始输出。
  const visibleText = isFailed ? (resolveToolCardErrorText(card) ?? card.text) : card.text;
  const hasText = Boolean(visibleText?.trim());
  const hasRawOutput = Boolean(card.text?.trim());
  // read/write/edit/apply_patch 类按文件扩展名推断 sidebar 代码围栏语言
  const language = resolveToolLanguage(card.name, card.args);

  const canClick = Boolean(onOpenSidebar) && !isRunning;
  const handleClick = canClick
    ? () => {
        if (hasRawOutput) {
          onOpenSidebar!(formatToolOutputForSidebar(card.text!, { language }));
          return;
        }
        if (isFailed && card.errorSummary?.trim()) {
          onOpenSidebar!(formatToolOutputForSidebar(card.errorSummary, { language }));
          return;
        }
        const info = `## ${display.label}\n\n${
          detail ? `**Command:** \`${detail}\`\n\n` : ""
        }*No output — tool completed successfully.*`;
        onOpenSidebar!(info);
      }
    : undefined;

  const isShort = hasText && (visibleText?.length ?? 0) <= TOOL_INLINE_THRESHOLD;
  const showCollapsed = hasText && !isShort;
  const showInline = hasText && isShort;
  const isEmpty = !hasText;

  // R52 T4：diff 徽标（input_delta 实时值在 result 到达时被最终统计替换或清除）
  const diffBadge = card.diffStat ? renderDiffStatBadge(card.diffStat) : nothing;
  // exec 类工具退出码徽标
  const exitBadge =
    card.exitCode !== undefined && EXIT_CODE_TOOL_NAMES.has(card.name.toLowerCase())
      ? html`<span
          class="chat-tool-card__exit ${card.exitCode !== 0 ? "chat-tool-card__exit--failed" : ""}"
          title=${t("chat.toolExitCode").replace("{code}", String(card.exitCode))}
          aria-label=${t("chat.toolExitCode").replace("{code}", String(card.exitCode))}
          >exit ${card.exitCode}</span
        >`
      : nothing;
  // 复制输出按钮：完成/失败且有可复制内容（原始输出或错误摘要）时出现
  const copySource = hasRawOutput ? card.text! : (card.errorSummary?.trim() ?? "");
  const copyButton = !isRunning && copySource ? renderToolCardCopyButton(() => copySource) : nothing;

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
        <div class="chat-tool-card__meta">
          ${diffBadge}
          ${exitBadge}
          ${copyButton}
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
          ? html`<div class="chat-tool-card__preview mono">${getTruncatedPreview(visibleText!)}</div>`
          : nothing
      }
      ${showInline ? html`<div class="chat-tool-card__inline mono">${visibleText}</div>` : nothing}
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
