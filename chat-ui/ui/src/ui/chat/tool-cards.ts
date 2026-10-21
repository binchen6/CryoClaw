import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { ToolCard } from "../types/chat-types.ts";
import { icons } from "../icons.ts";
import { formatToolDetail, resolveToolDisplay, resolveToolLanguage } from "../tool-display.ts";
import { TOOL_INLINE_THRESHOLD } from "./constants.ts";
import { extractTextCached } from "./message-extract.ts";
import { isToolResultMessage } from "./message-normalizer.ts";
import { toSanitizedMarkdownHtml } from "../markdown.ts";
import { linkifyPaths } from "./path-linker.ts";
import { chatTextEnhanceRef } from "./code-block-enhance.ts";
import {
  formatToolOutputForSidebar,
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

// 按消息引用缓存抽取结果（对齐 extractTextCached 模式）：工具密集 run 期间
// chatToolMessages 每 80ms tick 重摊平，未变化的消息对象重复抽取是纯浪费。
// 返回数组视为只读（所有调用方只遍历），缓存安全。
const toolCardsCache = new WeakMap<object, ToolCard[]>();

export function extractToolCards(message: unknown): ToolCard[] {
  if (!message || typeof message !== "object") {
    return extractToolCardsUncached(message);
  }
  const obj = message as object;
  const cached = toolCardsCache.get(obj);
  if (cached) {
    return cached;
  }
  const cards = extractToolCardsUncached(message);
  toolCardsCache.set(obj, cards);
  return cards;
}

function extractToolCardsUncached(message: unknown): ToolCard[] {
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
      // R83：result 载荷并入 call 块（app-tool-stream 流式 / oc-chat-history 历史合并，
      // 字段形态与 toolResult block 对齐）——一张卡同时携带输入（args）与输出（text）。
      // 空字符串也是有效输出（完成态），不能因 falsy 丢失
      const text = typeof item.text === "string" ? item.text : undefined;
      const failed = item.isError === true && text !== undefined;
      const errorSummary = asNonEmptyString(item.toolErrorSummary);
      const exitCode = asInteger(item.exitCode);
      cards.push({
        kind: "call",
        name: (item.name as string) ?? "tool",
        args: coerceArgs(item.arguments ?? item.args),
        ...(pending ? { pending: true } : {}),
        ...(diffStat ? { diffStat } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(failed ? { error: text } : {}),
        ...(errorSummary ? { errorSummary } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
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

  // A merged call already contains its result. A toolResult envelope must not
  // manufacture a second, nameless "Tool / completed" card for the same payload.
  if (isToolResultMessage(message) && cards.length === 0) {
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

// ── sessions_spawn 子会话引用卡 ──

export type SpawnSessionRef = {
  sessionKey: string;
  label?: string;
  sessionUrl?: string;
};

// 从 sessions_spawn 结果文本（JSON）中解析子会话引用。内核 accepted 结果形态：
// { details: { status: "accepted", runId, childSessionKey, sessionUrl?, label? } }
// （宽容解析：details 缺省时兜底顶层字段；非 JSON / 无 childSessionKey → null）
export function extractSpawnSessionRef(card: ToolCard): SpawnSessionRef | null {
  if (card.name !== "sessions_spawn" || !card.text) {
    return null;
  }
  const trimmed = card.text.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const root = parsed as Record<string, unknown>;
  const details =
    root.details && typeof root.details === "object"
      ? (root.details as Record<string, unknown>)
      : root;
  const childSessionKey = asNonEmptyString(details.childSessionKey);
  if (!childSessionKey) {
    return null;
  }
  return {
    sessionKey: childSessionKey,
    label: asNonEmptyString(details.label),
    sessionUrl: asNonEmptyString(details.sessionUrl),
  };
}

// 消息内子会话引用块：点击经线程级 .chat-subsession-link 委托跳转子会话
function renderSpawnSessionRef(ref: SpawnSessionRef) {
  return html`
    <div class="chat-tool-card__subsession">
      <span class="chat-tool-card__subsession-label">${t("chat.subagent.spawned")}</span>
      <a
        class="chat-subsession-link"
        data-session-key=${ref.sessionKey}
        title=${ref.sessionKey}
        tabindex="0"
        role="button"
      >${icons.externalLink}<span>${ref.label?.trim() || ref.sessionKey}</span></a>
    </div>
  `;
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

// ── R83 合并卡：输入参数与输出的完整展示 ──

// 卡内直接渲染输出的字符上限：超出部分截断 + 「查看完整输出」走 sidebar。
// 卡片本体在折叠 <details> 的懒渲染 body 里，展开才解析一次，上限保住展开帧。
const TOOL_OUTPUT_RENDER_CAP = 8_000;
const TOOL_ARGS_RENDER_CAP = 4_000;

// 有信息量的参数键数量（值非空才算）——0 个时输入块无意义（如 read 只带 path
// 且已在 detail 行展示过时仍可能有 1 个，此时由调用方决定是否显示）
function countMeaningfulArgs(args: unknown): number {
  if (!args || typeof args !== "object") {
    return 0;
  }
  return Object.values(args as Record<string, unknown>).filter(
    (v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0),
  ).length;
}

// args 是字符串时先尝试 parse：合法 JSON 对象/数组统一 pretty-print（2 空格），
// 弱类型工具参数（内核透传的 JSON 字符串）不再以单行紧凑形态塞进参数块——
// 单行无断点内容会把卡片撑出阅读列，展开成多行才有可换行位置。
function prettyPrintJsonString(raw: string): string | null {
  const trimmed = raw.trim();
  if (
    !(
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    )
  ) {
    return null;
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

// 纯格式化函数，无副作用；导出供 node 测试直接锁定 pretty-print/截断行为。
export function formatToolArgsJson(args: unknown): string | null {
  if (args === undefined || args === null) {
    return null;
  }
  let pretty: string;
  if (typeof args === "string") {
    pretty = prettyPrintJsonString(args) ?? args;
  } else {
    try {
      pretty = JSON.stringify(args, null, 2);
    } catch {
      return null;
    }
  }
  const trimmed = pretty.trim();
  if (!trimmed || trimmed === "{}") {
    return null;
  }
  // 超长截断保留 pretty-print 的换行（截断点可能落在行中，以 … 明示未完整展示）
  return trimmed.length > TOOL_ARGS_RENDER_CAP
    ? `${trimmed.slice(0, TOOL_ARGS_RENDER_CAP)}…`
    : trimmed;
}

// 纯 JSON 输出包成代码围栏再走 markdown（否则 JSON 被折成零散段落）；
// 已知语言（read/write/edit 按文件扩展名推断、exec → bash 等）的多行输出
// 同样围栏化——卡内即时获得 hljs 语法高亮，不必点开 sidebar。
// 围栏长度动态取「内容中最长反引号串 + 1」（min 3），内容自带 ``` 不会截断围栏。
function codeFenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) {
    longest = Math.max(longest, m[0].length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

function toolOutputToMarkdown(text: string, language?: string): string {
  const t = text.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      JSON.parse(t);
      const fence = codeFenceFor(t);
      return `${fence}json\n${t}\n${fence}`;
    } catch {
      // 非合法 JSON 按普通文本渲染
    }
  }
  if (language && t.includes("\n")) {
    const fence = codeFenceFor(t);
    return `${fence}${language}\n${t}\n${fence}`;
  }
  return text;
}

function renderToolCardArgsBlock(card: ToolCard, detail: string | undefined) {
  const argsJson = formatToolArgsJson(card.args);
  if (!argsJson) {
    return nothing;
  }
  // detail 行已展示主参数（路径/命令）时，仅当还有其余参数才展开完整输入，
  // 避免单参数工具在 detail 行与输入块间重复展示同一内容
  const meaningful = countMeaningfulArgs(card.args);
  if (detail && meaningful <= 1) {
    return nothing;
  }
  return html`
    <details
      class="chat-tool-card__args"
      @click=${(event: Event) => event.stopPropagation()}
      @keydown=${(event: KeyboardEvent) => event.stopPropagation()}
    >
      <summary>${t("chat.toolArgs")}</summary>
      <pre class="chat-tool-card__args-body mono">${argsJson}</pre>
    </details>
  `;
}

// 长输出卡内渲染（截断 + 查看完整输出入口）；短输出走 inline，空输出不渲染
function renderToolCardOutputBody(
  card: ToolCard,
  onOpenSidebar: ((content: string) => void) | undefined,
  language: string | undefined,
) {
  const raw = card.text;
  if (!raw?.trim()) {
    return nothing;
  }
  if (raw.length <= TOOL_INLINE_THRESHOLD) {
    return html`<div class="chat-tool-card__inline mono">${raw}</div>`;
  }
  const capped = raw.length > TOOL_OUTPUT_RENDER_CAP;
  const slice = capped ? raw.slice(0, TOOL_OUTPUT_RENDER_CAP) : raw;
  // 行数元信息：长输出给用户规模预期（「共 N 行」），截断时与完整输出入口并列
  const lineCount = raw.trim().split("\n").length;
  return html`
    <div
      class="chat-tool-card__output chat-text"
      ${chatTextEnhanceRef}
      @click=${(event: Event) => event.stopPropagation()}
    >${unsafeHTML(linkifyPaths(toSanitizedMarkdownHtml(toolOutputToMarkdown(slice, language))))}</div>
    ${lineCount > 20 || capped
      ? html`<div class="chat-tool-card__output-meta">
          <span>${t("chat.toolOutputLines").replace("{n}", String(lineCount))}</span>
          ${capped
            ? html`<button
                class="chat-tool-card__more"
                type="button"
                @click=${(event: Event) => {
                  event.stopPropagation();
                  onOpenSidebar?.(formatToolOutputForSidebar(raw, { language }));
                }}
              >${t("chat.toolOpenFull")}</button>`
            : nothing}
        </div>`
      : nothing}
  `;
}

// 卡内「交互归控件自己」的后代：折叠 summary、链接、按钮、表单控件。
// 这些位置的事件冒泡到整卡时不得再触发「打开输出 sidebar」（参数展开时误弹回归）。
const CARD_NESTED_CONTROL_SELECTOR = "details, summary, a, button, input, select, textarea";

// 卡内嵌套控件判定（纯函数，便于 node 单测）。cardRoot 排除两种情况：
// 1. 卡片根节点自身——它带 role=button，整卡点击仍应打开 sidebar；
// 2. 卡片外层的工具折叠组 <details>——它是卡片祖先，closest 会命中，
//    但不是卡内控件，不能误吞整卡点击。
export function isNestedToolCardControl(target: unknown, cardRoot?: unknown): boolean {
  if (!target || typeof target !== "object" || target === cardRoot) {
    return false;
  }
  const el = target as { closest?: (selector: string) => unknown };
  if (typeof el.closest !== "function") {
    return false;
  }
  let found: unknown;
  try {
    found = el.closest(CARD_NESTED_CONTROL_SELECTOR);
  } catch {
    return false;
  }
  if (!found || found === cardRoot) {
    return false;
  }
  const root = cardRoot as { contains?: (node: unknown) => boolean } | undefined;
  return typeof root?.contains === "function" ? root.contains(found) : true;
}

export function renderToolCardSidebar(card: ToolCard, onOpenSidebar?: (content: string) => void) {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);

  // 三态：执行中（流式 call 无 result）/ 失败（isError）/ 完成
  const isRunning = card.pending === true;
  const isFailed = card.error !== undefined;

  // R52 T4：失败卡可见文案优先 toolErrorSummary（内核 ≤400 字符摘要）而非裸输出开头；
  // sidebar 仍展示完整原始输出。
  const hasRawOutput = Boolean(card.text?.trim());
  // read/write/edit/apply_patch 类按文件扩展名推断 sidebar 代码围栏语言
  const language = resolveToolLanguage(card.name, card.args);
  // sessions_spawn accepted 结果 → 消息内子会话引用块（点击跳转，线程级委托）
  const spawnRef = extractSpawnSessionRef(card);

  const canClick = Boolean(onOpenSidebar) && !isRunning;
  const handleClick = canClick
    ? (event?: Event) => {
        // 卡内嵌套控件（参数折叠 summary、输出区代码块复制/链接按钮等）自己处理
        // 交互，冒泡到整卡不再打开输出 sidebar（CDP 复测 bug：展开输入参数误弹 sidebar）
        if (event && isNestedToolCardControl(event.target, event.currentTarget)) {
          return;
        }
        // 子会话引用链接走线程级委托跳转会话，不触发整卡 sidebar 打开
        if (
          event &&
          (event.target as HTMLElement | null)?.closest?.(".chat-subsession-link")
        ) {
          return;
        }
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

  const isEmpty = !hasRawOutput;

  // R52 T4：diff 徽标（input_delta 实时值在 result 到达时被最终统计替换或清除）
  const diffBadge = card.diffStat ? renderDiffStatBadge(card.diffStat) : nothing;
  // exec 类工具退出码徽标
  const exitBadge =
    card.exitCode !== undefined && EXIT_CODE_TOOL_NAMES.has(card.name.toLowerCase())
      ? html`<span
          class="chat-tool-card__exit ${card.exitCode !== 0 ?"chat-tool-card__exit--failed" : ""}"
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
              // summary/按钮/链接上的 Enter/Space 归控件自己（原生展开/复制/跳转），
              // 不能变成整卡「打开 sidebar」——键盘复现路径
              if (isNestedToolCardControl(e.target, e.currentTarget)) {
                return;
              }
              e.preventDefault();
              handleClick?.(e);
            }
          : nothing
      }
    >
      <div class="chat-tool-card__header">
        <div class="chat-tool-card__title" title=${display.name}>
          <span class="chat-tool-card__icon">${icons[display.icon]}</span>
          <span class="chat-tool-card__label" title=${display.label}>${display.label}</span>
          ${display.source
            ? html`<span class="chat-tool-card__source">${display.source}</span>`
            : nothing}
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
                : html`<span class="chat-tool-card__status chat-tool-card__status--done">
                    ${icons.check}<span class="chat-tool-card__status-done-label">${t("chat.toolCompleted")}</span>
                  </span>`
          }
        </div>
      </div>
      ${detail ? html`<div class="chat-tool-card__detail" title=${detail}>${detail}</div>` : nothing}
      ${!isRunning && spawnRef ? renderSpawnSessionRef(spawnRef) : nothing}
      ${
        isRunning
          ? html`
              <div class="chat-tool-card__status-text muted">${t("chat.toolRunning")}</div>
            `
          : isFailed
            ? html`
                <div class="chat-tool-card__status-text chat-tool-card__status-text--failed">${
                  resolveToolCardErrorText(card) ?? t("chat.toolFailed")
                }</div>
              `
            : isEmpty
              ? html`
                  <div class="chat-tool-card__status-text muted">${t("chat.toolCompleted")}</div>
                `
              : nothing
      }
      ${renderToolCardArgsBlock(card, detail)}
      ${!isRunning ? renderToolCardOutputBody(card, onOpenSidebar, language) : nothing}
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
