import { html, nothing, render } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { AssistantIdentity } from "../assistant-identity.ts";
import { icons } from "../icons.ts";
import type { MessageGroup, ToolCard } from "../types/chat-types.ts";
import { toSanitizedMarkdownHtml } from "../markdown.ts";
import { detectTextDirection } from "../text-direction.ts";
import { renderCopyAsMarkdownButton } from "./copy-as-markdown.ts";
import {
  extractTextCached,
  extractThinkingCached,
  formatReasoningMarkdown,
} from "./message-extract.ts";
import { isToolResultMessage, normalizeRoleForGrouping } from "./message-normalizer.ts";
import { extractMessageModel, formatUsageFooter, sumGroupUsage } from "./message-meta.ts";
import type { FileChange } from "./file-changes.ts";
import { linkifyPaths } from "./path-linker.ts";
import { renderMediaMarkers } from "./media-enhance.ts";
import { chatTextEnhanceRef } from "./code-block-enhance.ts";
import { extractToolCards, renderToolCardSidebar } from "./tool-cards.ts";
import { summarizeToolCards } from "./tool-summary.ts";
import { t } from "../i18n.ts";
import "../components/managed-image.ts";

// JSON 自动检测最大字符数，防止大 JSON 导致渲染卡顿
const MAX_JSON_AUTOPARSE_CHARS = 20_000;

// 检测文本是否为 JSON 对象或数组
function detectJson(text: string): { parsed: unknown; pretty: string } | null {
  const t = text.trim();
  if (t.length > MAX_JSON_AUTOPARSE_CHARS) {
    return null;
  }
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      const parsed = JSON.parse(t);
      return { parsed, pretty: JSON.stringify(parsed, null, 2) };
    } catch {
      return null;
    }
  }
  return null;
}

// 生成 JSON 折叠摘要标签
function jsonSummaryLabel(parsed: unknown): string {
  if (Array.isArray(parsed)) {
    return `Array (${parsed.length} item${parsed.length === 1 ? "" : "s"})`;
  }
  if (parsed && typeof parsed === "object") {
    const keys = Object.keys(parsed as Record<string, unknown>);
    if (keys.length <= 4) {
      return `{ ${keys.join(", ")} }`;
    }
    return `Object (${keys.length} keys)`;
  }
  return "JSON";
}

type ImageBlock = {
  url: string;
  alt?: string;
};

function extractImages(message: unknown): ImageBlock[] {
  const m = message as Record<string, unknown>;
  const content = m.content;
  const images: ImageBlock[] = [];

  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block !== "object" || block === null) {
        continue;
      }
      const b = block as Record<string, unknown>;

      if (b.type === "image") {
        // Handle source object format (from sendChatMessage)
        const source = b.source as Record<string, unknown> | undefined;
        if (source?.type === "base64" && typeof source.data === "string") {
          const data = source.data;
          const mediaType = (source.media_type as string) || "image/png";
          // If data is already a data URL, use it directly
          const url = data.startsWith("data:") ? data : `data:${mediaType};base64,${data}`;
          images.push({ url });
        } else if (typeof b.url === "string") {
          images.push({ url: b.url, alt: typeof b.alt === "string" ? b.alt : undefined });
        }
      } else if (b.type === "image_url") {
        // OpenAI format
        const imageUrl = b.image_url as Record<string, unknown> | undefined;
        if (typeof imageUrl?.url === "string") {
          images.push({ url: imageUrl.url });
        }
      }
    }
  }

  return images;
}

export function renderReadingIndicatorGroup(
  assistant?: AssistantIdentity,
  activeToolName?: string | null,
) {
  // 阶段感知提示：工具执行中显示工具名（mono），否则显示「思考中」
  const label = activeToolName
    ? t("chat.phaseTool").replace("{name}", activeToolName)
    : t("chat.phaseThinking");
  return html`
    <div class="chat-group assistant">
      ${renderAvatar("assistant", assistant)}
      <div class="chat-group-messages">
        <div class="chat-bubble chat-reading-indicator" role="status" aria-live="polite">
          <span class="chat-reading-indicator__dots" aria-hidden="true">
            <span></span><span></span><span></span>
          </span>
          <span class="chat-reading-indicator__label">${label}</span>
        </div>
      </div>
    </div>
  `;
}

export function renderStreamingGroup(
  text: string,
  startedAt: number,
  onOpenSidebar?: (content: string) => void,
  assistant?: AssistantIdentity,
) {
  const timestamp = new Date(startedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const name = assistant?.name ?? "Assistant";

  return html`
    <div class="chat-group assistant">
      ${renderAvatar("assistant", assistant)}
      <div class="chat-group-messages">
        ${renderGroupedMessage(
          {
            role: "assistant",
            content: [{ type: "text", text }],
            timestamp: startedAt,
          },
          { isStreaming: true, showReasoning: false },
          onOpenSidebar,
        )}
        <div class="chat-streaming-status" role="status" aria-live="polite">
          <span class="chat-streaming-status__dot" aria-hidden="true"></span>
          <span>${t("chat.streaming")}</span>
        </div>
        <div class="chat-group-footer">
          <span class="chat-sender-name">${name}</span>
          <span class="chat-group-timestamp">${timestamp}</span>
        </div>
      </div>
    </div>
  `;
}

export function renderMessageGroup(
  group: MessageGroup,
  opts: {
    onOpenSidebar?: (content: string) => void;
    showReasoning: boolean;
    assistantName?: string;
    assistantAvatar?: string | null;
    isHydrating?: boolean;
    fileChanges?: FileChange[];
  },
) {
  const normalizedRole = normalizeRoleForGrouping(group.role);
  const assistantName = opts.assistantName ?? "Assistant";
  const who =
    normalizedRole === "user"
      ? "You"
      : normalizedRole === "assistant"
        ? assistantName
        : normalizedRole;
  const roleClass =
    normalizedRole === "user" ? "user" : normalizedRole === "assistant" ? "assistant" : "other";
  const timestamp = new Date(group.timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  // 助手组：模型标签 + usage footer（内核消息级 model/usage 字段，取证见 message-meta.ts 头注）
  let assistantModel: string | null = null;
  let assistantUsageText: string | null = null;
  if (normalizedRole === "assistant") {
    for (let i = group.messages.length - 1; i >= 0; i--) {
      assistantModel = extractMessageModel(group.messages[i].message);
      if (assistantModel) {
        break;
      }
    }
    const usage = sumGroupUsage(group.messages.map((item) => item.message));
    assistantUsageText = usage ? formatUsageFooter(usage) : null;
  }

  return html`
    <div class="chat-group ${roleClass}">
      ${renderAvatar(group.role, {
        name: assistantName,
        avatar: opts.assistantAvatar ?? null,
      })}
      <div class="chat-group-messages">
        ${group.messages.map((item, index) =>
          renderGroupedMessage(
            item.message,
            {
              isStreaming: group.isStreaming && index === group.messages.length - 1,
              showReasoning: opts.showReasoning,
              isHydrating: opts.isHydrating,
            },
            opts.onOpenSidebar,
          ),
        )}
        ${opts.fileChanges?.length ? renderFileChanges(opts.fileChanges) : nothing}
        <div class="chat-group-footer">
          <span class="chat-sender-name">${who}</span>
          ${assistantModel ? html`<span class="chat-group-model">${assistantModel}</span>` : nothing}
          ${assistantUsageText
            ? html`<span class="chat-group-usage">${assistantUsageText}</span>`
            : nothing}
          <span class="chat-group-timestamp">${timestamp}</span>
        </div>
      </div>
    </div>
  `;
}

function renderAvatar(role: string, assistant?: Pick<AssistantIdentity, "name" | "avatar">) {
  const normalized = normalizeRoleForGrouping(role);
  const assistantName = assistant?.name?.trim() || "Assistant";
  const assistantAvatar = assistant?.avatar?.trim() || "";
  const initial =
    normalized === "user"
      ? "U"
      : normalized === "assistant"
        ? assistantName.charAt(0).toUpperCase() || "A"
        : normalized === "tool"
          ? "⚙"
          : "?";
  const className =
    normalized === "user"
      ? "user"
      : normalized === "assistant"
        ? "assistant"
        : normalized === "tool"
          ? "tool"
          : "other";

  if (assistantAvatar && normalized === "assistant") {
    if (isAvatarUrl(assistantAvatar)) {
      return html`<img
        class="chat-avatar ${className}"
        src="${assistantAvatar}"
        alt="${assistantName}"
      />`;
    }
    return html`<div class="chat-avatar ${className}">${assistantAvatar}</div>`;
  }

  return html`<div class="chat-avatar ${className}">${initial}</div>`;
}

function isAvatarUrl(value: string): boolean {
  return (
    /^https?:\/\//i.test(value) || /^data:image\//i.test(value) || value.startsWith("/") // Relative paths from avatar endpoint
  );
}

function renderMessageImages(images: ImageBlock[]) {
  if (images.length === 0) {
    return nothing;
  }

  // oc-managed-img：托管媒体（/api/chat/media/...）内部走 Bearer fetch → blob URL，
  // data:/http(s) 直链直接渲染；点击查看大图由组件自行处理
  return html`
    <div class="chat-message-images">
      ${images.map(
        (img) => html`<oc-managed-img src=${img.url} alt=${img.alt ?? ""}></oc-managed-img>`,
      )}
    </div>
  `;
}

// 本轮改动文件列表（默认折叠）：badge 区分 增/删/改，路径点击经线程级处理器走 cryoclaw.openPath
function renderFileChanges(changes: FileChange[]) {
  const countOf = (kind: FileChange["kind"]) => changes.filter((c) => c.kind === kind).length;
  const added = countOf("added");
  const modified = countOf("modified");
  const deleted = countOf("deleted");
  return html`
    <details class="chat-file-changes">
      <summary>
        <span class="chat-file-changes__icon">${icons.folder}</span>
        <span>${t("chat.fileChanges").replace("{n}", String(changes.length))}</span>
        <span class="chat-file-changes__stats">
          ${added > 0
            ? html`<span class="chat-file-changes__stat chat-file-changes__stat--added">+${added}</span>`
            : nothing}
          ${modified > 0
            ? html`<span class="chat-file-changes__stat chat-file-changes__stat--modified">~${modified}</span>`
            : nothing}
          ${deleted > 0
            ? html`<span class="chat-file-changes__stat chat-file-changes__stat--deleted">−${deleted}</span>`
            : nothing}
        </span>
      </summary>
      <div class="chat-file-changes__list">
        ${changes.map(
          (change) => html`
            <div class="chat-file-change">
              <span class="chat-file-change__badge chat-file-change__badge--${change.kind}"
                >${t(`chat.fileChange.${change.kind}`)}</span
              >
              <a class="chat-path-link" data-path=${change.path} title=${change.path}>${change.path}</a>
            </div>
          `,
        )}
      </div>
    </details>
  `;
}

// 将多个 tool card 折叠到 <details> 元素中
// 单一工具：「⚡ Read · src/main.ts」直接显示动作+目标；多工具：「⚡ N tools · 名单」
function renderCollapsedToolCards(
  toolCards: ToolCard[],
  onOpenSidebar?: (content: string) => void,
) {
  const { totalTools, label: summaryLabel, detail, isSingle, hasError } =
    summarizeToolCards(toolCards);

  // 懒渲染：折叠时 body 不挂载（见 hydrateLazyDetailsBody 头注），
  // 单条 tool output 上限 120k 字符、一轮可达 50 个工具，此处内存收益最大。
  const bodyFn = () =>
    html`${toolCards.map((card) => renderToolCardSidebar(card, onOpenSidebar))}`;

  return html`
    <details
      class="chat-tools-collapse"
      @toggle=${(event: Event) =>
        hydrateLazyDetailsBody(event, ":scope > .chat-tools-collapse__body", bodyFn)}
    >
      <summary class="chat-tools-summary ${hasError ? "chat-tools-summary--failed" : ""}">
        ${
          hasError
            ? html`<span class="chat-tools-summary__error" aria-hidden="true">${icons.x}</span>`
            : nothing
        }
        <span class="chat-tools-summary__icon">${icons.zap}</span>
        ${isSingle
          ? html`
              <span class="chat-tools-summary__names">${summaryLabel}</span>
              ${detail
                ? html`<span class="chat-tools-summary__detail">${detail}</span>`
                : nothing}
            `
          : html`
              <span class="chat-tools-summary__count">${totalTools} tool${totalTools === 1 ? "" : "s"}</span>
              <span class="chat-tools-summary__names">${summaryLabel}</span>
            `}
      </summary>
      <div class="chat-tools-collapse__body"></div>
    </details>
  `;
}

// 折叠区懒渲染（R5 内存优化）：<details> 折叠时 body 不解析 markdown、不挂载 DOM，
// 首次展开（toggle 事件）才把 bodyFn 的结果一次性渲染进 body 容器。
// body 容器在模板里是静态空节点（无 Lit 表达式插槽），宿主 Lit 重渲染不会触碰
// 手动挂载的子树，展开/折叠状态与内容都随 <details> 元素保留，不重复解析。
function hydrateLazyDetailsBody(event: Event, bodySelector: string, bodyFn: () => unknown) {
  const details = event.currentTarget as HTMLDetailsElement | null;
  if (!details || !details.open) {
    return;
  }
  const body = details.querySelector(bodySelector);
  if (!body || (body as HTMLElement).dataset.lazyHydrated === "1") {
    return;
  }
  (body as HTMLElement).dataset.lazyHydrated = "1";
  render(bodyFn() as Parameters<typeof render>[0], body as HTMLElement);
}


// 思考过程默认折叠（summary 一行），点击展开完整推理内容
function renderThinkingCollapsed(reasoningMarkdown: string) {
  return html`
    <details class="chat-thinking-collapse">
      <summary class="chat-thinking-summary">
        <span class="chat-thinking-summary__icon">${icons.brain}</span>
        <span class="chat-thinking-summary__label">${t("chat.thinkingCollapsed")}</span>
      </summary>
      <div class="chat-thinking">${unsafeHTML(
        linkifyPaths(toSanitizedMarkdownHtml(reasoningMarkdown)),
      )}</div>
    </details>
  `;
}
function renderGroupedMessage(
  message: unknown,
  opts: { isStreaming: boolean; showReasoning: boolean; isHydrating?: boolean },
  onOpenSidebar?: (content: string) => void,
) {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "unknown";
  const normalizedRole = normalizeRoleForGrouping(role);

  // 合成错误消息（controllers/chat.ts 发送失败注入，标 cryoclawError）→ 着色卡片，
  // 借鉴 control-ui：⚠️ 图标 + danger 色调背景，整宽显示在消息列里
  if (m.cryoclawError === true) {
    const errorText = extractTextCached(message) ?? "";
    return html`
      <div class="chat-bubble chat-error-card ${opts.isHydrating ? "" : "fade-in"}" role="alert">
        <span class="chat-error-card__icon" aria-hidden="true">${icons.warning}</span>
        <span class="chat-error-card__text">${errorText}</span>
      </div>
    `;
  }

  const isToolResult =
    isToolResultMessage(message) ||
    role.toLowerCase() === "toolresult" ||
    role.toLowerCase() === "tool_result" ||
    typeof m.toolCallId === "string" ||
    typeof m.tool_call_id === "string";

  const toolCards = extractToolCards(message);
  const hasToolCards = toolCards.length > 0;
  const images = extractImages(message);
  const hasImages = images.length > 0;

  const extractedText = extractTextCached(message);
  const extractedThinking =
    opts.showReasoning && role === "assistant" ? extractThinkingCached(message) : null;
  const markdownBase = extractedText?.trim() ? extractedText : null;
  const reasoningMarkdown = extractedThinking ? formatReasoningMarkdown(extractedThinking) : null;
  const markdown = markdownBase;
  const canCopyMarkdown = role === "assistant" && Boolean(markdown?.trim());

  // 检测纯 JSON 消息，用折叠块展示
  const jsonResult = markdown && !opts.isStreaming ? detectJson(markdown) : null;

  const bubbleClasses = [
    "chat-bubble",
    canCopyMarkdown ? "has-copy" : "",
    opts.isStreaming ? "streaming" : "",
    opts.isHydrating ? "" : "fade-in",
  ]
    .filter(Boolean)
    .join(" ");

  // ── streaming 渲染路径（R5 性能优化，与下方 history 路径刻意分叉）────────
  // streaming 的累计文本经 rAF 每帧全量提交（controllers/chat.ts scheduleChatStreamFlush）。
  // 若每帧都对全文 marked.parse + DOMPurify + unsafeHTML 整棵替换，长回复呈 O(n²) 增长，
  // 且每帧新 key 会挤爆 markdown LRU 缓存。因此 streaming 期间只渲染纯文本：
  // lit 文本绑定自动转义（无 XSS 面），CSS `white-space: pre-wrap` 保留换行；
  // 不解析 markdown / JSON，也不触碰 markdown 缓存。run 终态后本条消息转入
  // history，走下方 history 路径一次性解析渲染，用户可见的最终结果不变。
  if (opts.isStreaming) {
    return html`
      <div class="${bubbleClasses}">
        ${canCopyMarkdown ? renderCopyAsMarkdownButton(markdown!) : nothing}
        ${markdown
          ? html`<div class="chat-text chat-text--streaming" dir="${detectTextDirection(markdown)}">${markdown}</div>`
          : nothing}
      </div>
    `;
  }

  // 纯 tool result（无文本）→ 直接折叠展示
  if (!markdown && hasToolCards && isToolResult) {
    return renderCollapsedToolCards(toolCards, onOpenSidebar);
  }

  if (!markdown && !hasToolCards && !hasImages) {
    return nothing;
  }

  // 判断是否为工具消息（需要折叠）
  const isToolMessage = normalizedRole === "tool" || isToolResult;

  // 工具名摘要标签
  const toolSummaryLabel = hasToolCards ? summarizeToolCards(toolCards).label : "";
  const toolPreview =
    markdown && !toolSummaryLabel ? markdown.trim().replace(/\s+/g, " ").slice(0, 120) : "";

  if (isToolMessage) {
    // 懒渲染：折叠时 body 不解析 markdown、不挂载（见 hydrateLazyDetailsBody 头注），
    // 首次展开才一次性渲染；图片/思考/JSON/正文/工具卡全部推迟到展开时求值。
    const bodyFn = () => html`
      ${renderMessageImages(images)}
      ${reasoningMarkdown ? renderThinkingCollapsed(reasoningMarkdown) : nothing}
      ${
        jsonResult
          ? html`<details class="chat-json-collapse">
              <summary class="chat-json-summary">
                <span class="chat-json-badge">JSON</span>
                <span class="chat-json-label">${jsonSummaryLabel(jsonResult.parsed)}</span>
              </summary>
              <pre class="chat-json-content"><code>${jsonResult.pretty}</code></pre>
            </details>`
          : markdown
            ? html`<div class="chat-text" ${chatTextEnhanceRef} dir="${detectTextDirection(markdown)}">${unsafeHTML(linkifyPaths(renderMediaMarkers(toSanitizedMarkdownHtml(markdown))))}</div>`
            : nothing
      }
      ${hasToolCards ? renderCollapsedToolCards(toolCards, onOpenSidebar) : nothing}
    `;
    return html`
      <div class="${bubbleClasses}">
        ${canCopyMarkdown ? renderCopyAsMarkdownButton(markdown!) : nothing}
        <details
          class="chat-tool-msg-collapse"
          @toggle=${(event: Event) =>
            hydrateLazyDetailsBody(event, ":scope > .chat-tool-msg-body", bodyFn)}
        >
          <summary class="chat-tool-msg-summary">
            <span class="chat-tool-msg-summary__icon">${icons.zap}</span>
            <span class="chat-tool-msg-summary__label">${t("chat.toolOutput")}</span>
            ${
              toolSummaryLabel
                ? html`<span class="chat-tool-msg-summary__names">${toolSummaryLabel}</span>`
                : toolPreview
                  ? html`<span class="chat-tool-msg-summary__preview">${toolPreview}</span>`
                  : nothing
            }
          </summary>
          <div class="chat-tool-msg-body"></div>
        </details>
      </div>
    `;
  }

  return html`
    <div class="${bubbleClasses}">
      ${canCopyMarkdown ? renderCopyAsMarkdownButton(markdown!) : nothing}
      ${renderMessageImages(images)}
      ${
        reasoningMarkdown
          ? renderThinkingCollapsed(reasoningMarkdown)
          : nothing
      }
      ${
        jsonResult
          ? html`<details class="chat-json-collapse">
              <summary class="chat-json-summary">
                <span class="chat-json-badge">JSON</span>
                <span class="chat-json-label">${jsonSummaryLabel(jsonResult.parsed)}</span>
              </summary>
              <pre class="chat-json-content"><code>${jsonResult.pretty}</code></pre>
            </details>`
          : markdown
            ? html`<div class="chat-text" ${chatTextEnhanceRef} dir="${detectTextDirection(markdown)}">${unsafeHTML(linkifyPaths(renderMediaMarkers(toSanitizedMarkdownHtml(markdown))))}</div>`
            : nothing
      }
      ${hasToolCards ? renderCollapsedToolCards(toolCards, onOpenSidebar) : nothing}
    </div>
  `;
}
