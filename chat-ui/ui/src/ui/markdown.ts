import DOMPurify from "dompurify";
import { marked } from "marked";
import { truncateText } from "./format.ts";

marked.setOptions({
  gfm: true,
  breaks: true,
});

const allowedTags = [
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "hr",
  "i",
  "input",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
  "img",
];

const allowedAttrs = [
  "class",
  "href",
  "rel",
  "target",
  "title",
  "start",
  "src",
  "alt",
  // GFM 任务列表（- [x]）的 <input> 仅放行只读复选框属性
  "type",
  "checked",
  "disabled",
];
const sanitizeOptions = {
  ALLOWED_TAGS: allowedTags,
  ALLOWED_ATTR: allowedAttrs,
  ADD_DATA_URI_TAGS: ["img"],
};

let hooksInstalled = false;
const MARKDOWN_CHAR_LIMIT = 140_000;
const MARKDOWN_PARSE_LIMIT = 40_000;
const MARKDOWN_CACHE_LIMIT = 200;
const MARKDOWN_CACHE_MAX_CHARS = 50_000;
const markdownCache = new Map<string, string>();

function getCachedMarkdown(key: string): string | null {
  const cached = markdownCache.get(key);
  if (cached === undefined) {
    return null;
  }
  markdownCache.delete(key);
  markdownCache.set(key, cached);
  return cached;
}

function setCachedMarkdown(key: string, value: string) {
  markdownCache.set(key, value);
  while (markdownCache.size > MARKDOWN_CACHE_LIMIT) {
    const oldest = markdownCache.keys().next().value;
    if (!oldest) {
      break;
    }
    markdownCache.delete(oldest);
  }
}

// 测试观测钩子：返回当前 LRU 缓存条数（防污染回归测试用）
export function markdownCacheSize(): number {
  return markdownCache.size;
}

function installHooks() {
  if (hooksInstalled) {
    return;
  }
  hooksInstalled = true;

  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node instanceof HTMLInputElement) {
      // GFM 任务列表：强制只读复选框，剥掉其它形态
      node.setAttribute("type", "checkbox");
      node.setAttribute("disabled", "");
      return;
    }
    if (!(node instanceof HTMLAnchorElement)) {
      return;
    }
    const href = node.getAttribute("href");
    if (!href) {
      return;
    }
    node.setAttribute("rel", "noreferrer noopener");
    node.setAttribute("target", "_blank");
  });
}

export type MarkdownRenderOptions = {
  // streaming 中间态等一次性文本传 true：不读不写 LRU，
  // 防止每帧新 key 挤爆缓存、把 history 高频条目逐出。
  bypassCache?: boolean;
};

export function toSanitizedMarkdownHtml(
  markdown: string,
  opts?: MarkdownRenderOptions,
): string {
  const input = markdown.trim();
  if (!input) {
    return "";
  }
  installHooks();
  // 写入上限兜底：超过 MARKDOWN_CACHE_MAX_CHARS 的超长文本不读不写缓存
  const useCache = !opts?.bypassCache && input.length <= MARKDOWN_CACHE_MAX_CHARS;
  if (useCache) {
    const cached = getCachedMarkdown(input);
    if (cached !== null) {
      return cached;
    }
  }
  const truncated = truncateText(input, MARKDOWN_CHAR_LIMIT);
  const suffix = truncated.truncated
    ? `\n\n… truncated (${truncated.total} chars, showing first ${truncated.text.length}).`
    : "";
  if (truncated.text.length > MARKDOWN_PARSE_LIMIT) {
    const escaped = escapeHtml(`${truncated.text}${suffix}`);
    const html = `<pre class="code-block">${escaped}</pre>`;
    const sanitized = DOMPurify.sanitize(html, sanitizeOptions);
    if (useCache) {
      setCachedMarkdown(input, sanitized);
    }
    return sanitized;
  }
  const rendered = renderWithFallback(`${truncated.text}${suffix}`);
  const sanitized = DOMPurify.sanitize(rendered, sanitizeOptions);
  if (useCache) {
    setCachedMarkdown(input, sanitized);
  }
  return sanitized;
}

// Prevent raw HTML in chat messages from being rendered as formatted HTML.
// Display it as escaped text so users see the literal markup.
// Security is handled by DOMPurify, but rendering pasted HTML (e.g. error
// pages) as formatted output is confusing UX (#13937).
const htmlEscapeRenderer = new marked.Renderer();
htmlEscapeRenderer.html = ({ text }: { text: string }) => escapeHtml(text);

// marked 解析异常兜底：退化为转义纯文本块，绝不让单条消息拖垮渲染
function renderWithFallback(text: string): string {
  try {
    return marked.parse(text, {
      renderer: htmlEscapeRenderer,
    }) as string;
  } catch (error) {
    console.warn("[markdown] parse failed, falling back to plain text", error);
    return `<pre class="code-block">${escapeHtml(text)}</pre>`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
