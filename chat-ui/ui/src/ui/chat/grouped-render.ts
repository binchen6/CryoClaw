import { html, nothing, render } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { AssistantIdentity } from "../assistant-identity.ts";
import { icons } from "../icons.ts";
import type { MessageGroup, ToolCard } from "../types/chat-types.ts";
import { toSanitizedMarkdownHtml, toStreamingMarkdownParts } from "../markdown.ts";
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
import {
  buildFileCardHtml,
  chatMediaEnhanceRef,
  localPathToFileUrl,
  renderMediaMarkers,
} from "./media-enhance.ts";
import {
  extractMessageMediaAttachments,
  isImageMime,
  type MessageMediaAttachment,
} from "./media-attachments.ts";
import type { ChatAttachment } from "../ui-types.ts";
import { chatTextEnhanceRef } from "./code-block-enhance.ts";
import { extractToolCards, renderToolCardSidebar } from "./tool-cards.ts";
import { summarizeToolCards } from "./tool-summary.ts";
import { resolveToolDisplay } from "../tool-display.ts";
import { t } from "../i18n.ts";
import "../components/managed-image.ts";

// JSON 自动检测最大字符数，防止大 JSON 导致渲染卡顿
const MAX_JSON_AUTOPARSE_CHARS = 20_000;

// 检测文本是否为 JSON 对象或数组（按消息引用缓存：≤20k 字符的 JSON 每次重渲染
// 都重新 JSON.parse + stringify 是纯浪费，R72 对齐 extractTextCached 模式）
const jsonDetectCache = new WeakMap<object, { parsed: unknown; pretty: string } | null>();

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

function detectJsonCached(message: object, text: string): { parsed: unknown; pretty: string } | null {
  if (jsonDetectCache.has(message)) {
    return jsonDetectCache.get(message) ?? null;
  }
  const value = detectJson(text);
  jsonDetectCache.set(message, value);
  return value;
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

// 按消息引用缓存（R72，对齐 extractTextCached）：图片抽取遍历 content 数组，
// 工具密集 run 期间每 tick 重摊平时未变消息无需重扫。返回数组视为只读。
const imagesCache = new WeakMap<object, ImageBlock[]>();

function extractImages(message: unknown): ImageBlock[] {
  if (!message || typeof message !== "object") {
    return extractImagesUncached(message);
  }
  const obj = message as object;
  const cached = imagesCache.get(obj);
  if (cached) {
    return cached;
  }
  const images = extractImagesUncached(message);
  imagesCache.set(obj, images);
  return images;
}

function extractImagesUncached(message: unknown): ImageBlock[] {
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

// 阶段感知提示文案（读取指示/实时思考区共用）：工具执行中显示友好工具类型名
// （R85：原始内部名经 resolveToolDisplay 本地化，如 anysearch__search → 搜索）；
// 等待子代理显示等待文案；否则「思考中」。
function phaseStatusLabel(activeToolName?: string | null, subagentWaiting?: boolean) {
  return activeToolName
    ? t("chat.phaseTool").replace("{name}", resolveToolDisplay({ name: activeToolName }).label)
    : subagentWaiting
      ? t("chat.subagent.waiting")
      : t("chat.phaseThinking");
}

export function renderReadingIndicatorGroup(
  assistant?: AssistantIdentity,
  activeToolName?: string | null,
  subagentWaiting?: boolean,
) {
  const label = phaseStatusLabel(activeToolName, subagentWaiting);
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

// R90 实时思考区（默认折叠）：summary 单行窗口展示最新思考输出（tail 提取 +
// 无缝垂直向上滚动动画，css 沿 transform 合成层动画不触发重排；prefers-reduced-motion
// 时静止并钉住列尾）；展开后正文限高滚动，最新内容自动滚底（oc-chat-stream updated
// 钩子驱动）。正文走纯文本绑定（高频帧免 markdown 解析开销）。
const LIVE_THINKING_TAIL_CHARS = 160;

export function thinkingTail(thinking: string): string {
  if (thinking.length <= LIVE_THINKING_TAIL_CHARS) {
    return thinking;
  }
  // 尾部截取后修正代理对边界（首字符若是低代理则丢弃，避免渲染出残缺字形）
  let tail = thinking.slice(-LIVE_THINKING_TAIL_CHARS);
  const first = tail.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) {
    tail = tail.slice(1);
  }
  return tail;
}

function renderLiveThinkingBlock(thinking: string) {
  const tail = thinkingTail(thinking);
  const tickerOn = tail.trim().length > 0;
  return html`
    <details class="chat-thinking-collapse chat-thinking-live">
      <summary class="chat-thinking-summary">
        <span class="chat-reading-indicator__dots" aria-hidden="true">
          <span></span><span></span><span></span>
        </span>
        <span class="chat-thinking-summary__label">${t("chat.phaseThinking")}</span>
        ${tickerOn
          ? html`<span class="chat-thinking-ticker" aria-hidden="true">
              <span class="chat-thinking-ticker__track"
                ><span class="chat-thinking-ticker__copy">${tail}</span
                ><span class="chat-thinking-ticker__copy">${tail}</span
              ></span>
            </span>`
          : nothing}
      </summary>
      <div class="chat-thinking chat-thinking-live__text">${thinking}</div>
    </details>
  `;
}

// R88：实时思考/解说分组（正文尚未到达但 reasoning/commentary 已在流式输出）。
export function renderLiveThinkingGroup(
  assistant?: AssistantIdentity,
  thinkingStream?: string | null,
  narrationText?: string | null,
  activeToolName?: string | null,
  subagentWaiting?: boolean,
) {
  const label = phaseStatusLabel(activeToolName, subagentWaiting);
  const hasThinking = (thinkingStream ?? "").trim().length > 0;
  const hasNarration = (narrationText ?? "").trim().length > 0;
  return html`
    <div class="chat-group assistant">
      ${renderAvatar("assistant", assistant)}
      <div class="chat-group-messages">
        <div class="chat-bubble chat-thinking-live-bubble">
          ${hasNarration ? html`<div class="chat-stream-narration">${narrationText}</div>` : nothing}
          ${hasThinking
            ? renderLiveThinkingBlock(thinkingStream!)
            : html`
                <div class="chat-reading-indicator" role="status" aria-live="polite">
                  <span class="chat-reading-indicator__dots" aria-hidden="true">
                    <span></span><span></span><span></span>
                  </span>
                  <span class="chat-reading-indicator__label">${label}</span>
                </div>
              `}
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
  live?: { thinkingStream?: string | null; narrationText?: string | null },
) {
  const timestamp = new Date(startedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const name = assistant?.name ?? "Assistant";
  const narration = (live?.narrationText ?? "").trim().length > 0 ? live!.narrationText : null;
  const thinking = (live?.thinkingStream ?? "").trim().length > 0 ? live!.thinkingStream : null;

  return html`
    <div class="chat-group assistant">
      ${renderAvatar("assistant", assistant)}
      <div class="chat-group-messages">
        ${narration
          ? html`<div class="chat-bubble"><div class="chat-stream-narration">${narration}</div></div>`
          : nothing}
        ${thinking
          ? html`<div class="chat-bubble">${renderLiveThinkingBlock(thinking)}</div>`
          : nothing}
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
    // git 可用时 file-changes 面板尾部带「在 git 中查看」链接（点击由线程级委托处理）
    gitAvailable?: boolean | null;
    onQuoteMessage?: (text: string) => void;
    onResendError?: (text: string, attachments?: ChatAttachment[]) => void;
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
              onQuoteMessage: opts.onQuoteMessage,
              onResendError: opts.onResendError,
            },
            opts.onOpenSidebar,
          ),
        )}
        ${opts.fileChanges?.length ? renderFileChanges(opts.fileChanges, opts.gitAvailable) : nothing}
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
// git 可用时尾部带「在 git 中查看」链接（class 由 views/chat.ts 线程级点击委托处理）
function renderFileChanges(changes: FileChange[], gitAvailable?: boolean | null) {
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
        ${gitAvailable === true
          ? html`<div class="chat-file-changes__footer">
              <a class="chat-git-view-link">${icons.diff} ${t("chat.viewInGit")}</a>
            </div>`
          : nothing}
      </div>
    </details>
  `;
}

// ── 已发送附件卡片（user 消息顶层 MediaPaths/MediaTypes，乐观气泡与 history 同构）──

// 图片附件加载失败（media store TTL 清理后文件缺失等）：降级为文件卡片，仍显示文件名
function degradeMediaImageToFileCard(event: Event, att: MessageMediaAttachment) {
  const img = event.currentTarget as HTMLImageElement | null;
  if (!img || !img.isConnected) {
    return;
  }
  const tpl = document.createElement("template");
  tpl.innerHTML = buildFileCardHtml(att.path, att.fileName);
  const card = tpl.content.firstElementChild;
  if (card) {
    img.replaceWith(card);
  }
}

function renderMessageMediaAttachments(atts: MessageMediaAttachment[]) {
  if (atts.length === 0) {
    return nothing;
  }
  // 文件卡片复用 media-enhance 的 buildFileCardHtml（卡片样式/图标/打开+定位委托）；
  // 图片 mime 直渲 <img src=file://...>（页面本身 file:// 协议可直读本地文件），
  // 加载失败 onerror 降级为文件卡片。容器 ref 确保点击委托已安装。
  return html`
    <div class="chat-message-attachments" ${chatMediaEnhanceRef}>
      ${atts.map((att) => {
        const url = isImageMime(att.mimeType) ? localPathToFileUrl(att.path) : null;
        if (url) {
          return html`<img
            class="chat-attachment-image"
            src=${url}
            alt=${att.fileName}
            title=${att.path}
            loading="lazy"
            @error=${(event: Event) => degradeMediaImageToFileCard(event, att)}
          />`;
        }
        return unsafeHTML(buildFileCardHtml(att.path, att.fileName));
      })}
    </div>
  `;
}

// 将多个 tool card 折叠到 <details> 元素中
// 单一工具：「⚡ Read · src/main.ts」直接显示动作+目标；多工具：「⚡ N tools · 名单」
// 摘要行右端是聚合状态（R83）：执行中 spinner / 失败 ✗ / 全部完成 ✓ 已完成
function renderCollapsedToolCards(
  toolCards: ToolCard[],
  onOpenSidebar?: (content: string) => void,
) {
  const { totalTools, label: summaryLabel, detail, isSingle, hasError, status } =
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
      <summary class="chat-tools-summary ${hasError ?"chat-tools-summary--failed" : ""}">
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
        ${
          status === "running"
            ? html`<span class="chat-tools-summary__status chat-tools-summary__status--running" role="status">
                <span class="chat-tool-card__spinner" aria-hidden="true"></span>
              </span>`
            : status === "failed"
              ? html`<span class="chat-tools-summary__status chat-tools-summary__status--failed">${icons.x}</span>`
              : html`<span class="chat-tools-summary__status chat-tools-summary__status--done">
                  ${icons.check}<span>${t("chat.toolCompleted")}</span>
                </span>`
        }
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

// 图片/附件/思考/JSON 卡/正文/工具卡的公共组装（工具消息懒渲染 body 与普通气泡共用）。
// mediaAttachments 仅普通气泡路径传入；工具消息 body 不传，保持不渲染附件的原行为。
function renderMessageBodyParts(opts: {
  images: ImageBlock[];
  mediaAttachments?: MessageMediaAttachment[];
  reasoningMarkdown: string | null;
  jsonResult: ReturnType<typeof detectJson>;
  markdown: string | null;
  toolCards: ToolCard[];
  hasToolCards: boolean;
  onOpenSidebar?: (content: string) => void;
}) {
  return html`
    ${renderMessageImages(opts.images)}
    ${opts.mediaAttachments ? renderMessageMediaAttachments(opts.mediaAttachments) : nothing}
    ${opts.reasoningMarkdown ? renderThinkingCollapsed(opts.reasoningMarkdown) : nothing}
    ${
      opts.jsonResult
        ? html`<details class="chat-json-collapse">
            <summary class="chat-json-summary">
              <span class="chat-json-badge">JSON</span>
              <span class="chat-json-label">${jsonSummaryLabel(opts.jsonResult.parsed)}</span>
            </summary>
            <pre class="chat-json-content"><code>${opts.jsonResult.pretty}</code></pre>
          </details>`
        : opts.markdown
          ? html`<div class="chat-text" ${chatTextEnhanceRef} dir="${detectTextDirection(opts.markdown)}">${unsafeHTML(linkifyPaths(renderMediaMarkers(toSanitizedMarkdownHtml(opts.markdown))))}</div>`
          : nothing
    }
    ${opts.hasToolCards ? renderCollapsedToolCards(opts.toolCards, opts.onOpenSidebar) : nothing}
  `;
}

function renderGroupedMessage(
  message: unknown,
  opts: {
    isStreaming: boolean;
    showReasoning: boolean;
    isHydrating?: boolean;
    onQuoteMessage?: (text: string) => void;
    onResendError?: (text: string, attachments?: ChatAttachment[]) => void;
  },
  onOpenSidebar?: (content: string) => void,
) {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "unknown";
  const normalizedRole = normalizeRoleForGrouping(role);

  // 合成错误消息（controllers/chat.ts 发送失败注入，标 cryoclawError）→ 着色卡片，
  // 借鉴 control-ui：⚠️ 图标 + danger 色调背景，整宽显示在消息列里
  if (m.cryoclawError === true) {
    const errorText = extractTextCached(message) ?? "";
    const resendText = typeof m.resendText === "string" && m.resendText.trim() ? m.resendText : null;
    // 发送失败时随错误卡保存的附件（controllers/chat.ts），重发时带回防附件丢失
    const resendAttachments = Array.isArray(m.resendAttachments)
      ? (m.resendAttachments as ChatAttachment[])
      : undefined;
    return html`
      <div class="chat-bubble chat-error-card ${opts.isHydrating ?"" : "fade-in"}" role="alert">
        <span class="chat-error-card__icon" aria-hidden="true">${icons.warning}</span>
        <span class="chat-error-card__text">${errorText}</span>
        ${resendText && opts.onResendError
          ? html`<button
              class="chat-error-card__resend"
              type="button"
              title=${t("chat.resendError")}
              aria-label=${t("chat.resendError")}
              @click=${() => opts.onResendError?.(resendText, resendAttachments)}
            >${icons.rotateCcw}${t("chat.resendError")}</button>`
          : nothing}
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
  // 已发送附件元数据（内核 transcript 顶层 MediaPaths/MediaTypes + 乐观气泡同构字段）
  const mediaAttachments = extractMessageMediaAttachments(message);
  const hasMediaAttachments = mediaAttachments.length > 0;

  const extractedText = extractTextCached(message);
  const extractedThinking =
    opts.showReasoning && role === "assistant" ? extractThinkingCached(message) : null;
  const markdownBase = extractedText?.trim() ? extractedText : null;
  const reasoningMarkdown = extractedThinking ? formatReasoningMarkdown(extractedThinking) : null;
  const markdown = markdownBase;
  const canCopyMarkdown = role === "assistant" && Boolean(markdown?.trim());
  // 引用：用户/助手气泡有文本即可引用（原文交给状态层构造引用块，避免二次转义）
  const canQuote =
    (normalizedRole === "user" || normalizedRole === "assistant") &&
    Boolean(markdown?.trim()) &&
    Boolean(opts.onQuoteMessage);

  const quoteButton = canQuote
    ? html`<button
        class="chat-quote-btn"
        type="button"
        title=${t("chat.quoteMessage")}
        aria-label=${t("chat.quoteMessage")}
        @click=${() => opts.onQuoteMessage?.(markdown!)}
      >${icons.quote}</button>`
    : nothing;

  // 检测纯 JSON 消息，用折叠块展示
  const jsonResult =
    markdown && !opts.isStreaming && message && typeof message === "object"
      ? detectJsonCached(message as object, markdown)
      : null;

  const bubbleClasses = [
    "chat-bubble",
    canCopyMarkdown ? "has-copy" : "",
    canQuote ? "has-quote" : "",
    opts.isStreaming ? "streaming" : "",
    opts.isHydrating ? "" : "fade-in",
  ]
    .filter(Boolean)
    .join(" ");

  // ── streaming 渲染路径（与下方 history 路径刻意分叉）────────
  // streaming 的累计文本经 rAF 每帧全量提交（controllers/chat.ts scheduleChatStreamFlush）。
  // R41 Task 9：安全前缀渐进渲染——稳定段（已完成结构）完整解析且命中 LRU，
  // 未闭合尾部转义纯文本，解析频率 = 边界推进频率（远低于帧率）。
  // R83 拆分双节点：稳定段与尾部各占一个节点。lit 的 unsafeHTML 对同字符串是
  // no-op——尾部每帧变化时稳定段 DOM 不重建，代码块的复制按钮/hljs 高亮结果
  // 保留（此前每帧整块 innerHTML 重写 + 全部 pre 重新增强/重高亮，是流式卡顿热点）。
  // 安全面：稳定段经 DOMPurify，尾部走纯文本绑定（lit 自动转义）；run 终态后
  // 转入 history 路径一次性完整渲染，用户可见的最终结果不变。
  if (opts.isStreaming) {
    const parts = markdown ? toStreamingMarkdownParts(markdown) : { stableHtml: "", tail: "" };
    return html`
      <div class="${bubbleClasses}">
        ${canCopyMarkdown ? renderCopyAsMarkdownButton(markdown!) : nothing}
        ${parts.stableHtml
          ? html`<div
              class="chat-text chat-text--streaming chat-text--stable"
              dir="${detectTextDirection(markdown)}"
              ${chatTextEnhanceRef}
            >${unsafeHTML(linkifyPaths(parts.stableHtml))}</div>`
          : nothing}
        ${parts.tail
          ? html`<div
              class="chat-text chat-text--streaming chat-text--tail"
              dir="${detectTextDirection(markdown)}"
            >${parts.tail}</div>`
          : nothing}
      </div>
    `;
  }
  // 纯 tool result（无文本）→ 直接折叠展示
  if (!markdown && hasToolCards && isToolResult) {
    return renderCollapsedToolCards(toolCards, onOpenSidebar);
  }

  if (!markdown && !hasToolCards && !hasImages && !hasMediaAttachments) {
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
    const bodyFn = () =>
      renderMessageBodyParts({
        images,
        reasoningMarkdown,
        jsonResult,
        markdown,
        toolCards,
        hasToolCards,
        onOpenSidebar,
      });
    return html`
      <div class="${bubbleClasses}">
        ${canCopyMarkdown ? renderCopyAsMarkdownButton(markdown!) : nothing}
        ${quoteButton}
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
      ${quoteButton}
      ${renderMessageBodyParts({
        images,
        mediaAttachments,
        reasoningMarkdown,
        jsonResult,
        markdown,
        toolCards,
        hasToolCards,
        onOpenSidebar,
      })}
    </div>
  `;
}
