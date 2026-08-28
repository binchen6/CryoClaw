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

export type MarkdownSafeSplit = { stable: string; tail: string };

// 流式渐进渲染（对齐官方安全前缀做法）：稳定段完整解析（内容作缓存键，
// 边界不推进时命中缓存不重解析——流式期间解析频率 = 边界推进频率，
// 而非帧率），尾部转义纯文本。尾部不进缓存（每帧都变，进缓存只会污染）。
//
// 演进说明（防后人按旧结论回退）：R5 曾定论「流式不解析 markdown」，因为当时是
// 每帧对全文全量 marked.parse + DOMPurify，长回复呈 O(n²)。本函数（R41 Task 9）
// 是有意升级：解析对象只剩不变稳定段且命中 LRU，成本降到边界推进频率；
// 安全面不变——稳定段经 DOMPurify，尾部经 escapeHtml。
export function toStreamingMarkdownHtml(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  const { stable, tail } = splitMarkdownSafePrefix(trimmed);
  // 稳定段走默认缓存路径：内部以 trim 后全文作键，边界不推进时稳定段内容不变即命中；
  // splitMarkdownSafePrefix 的边界含行尾 \n，键不会因尾随空白抖动。
  const stableHtml = stable ? toSanitizedMarkdownHtml(stable) : "";
  if (!tail) {
    return stableHtml;
  }
  return `${stableHtml}<p>${escapeHtml(tail)}</p>`;
}

// 安全前缀切分（对齐官方 control-ui 流式 markdown 做法）：
// 找到最后一个「稳定块边界」——闭合的代码围栏之后，或最后一个空行处。
// 边界之前是已完成结构（可完整解析渲染），之后是进行中内容（调用方按纯文本渲染），
// 避免半截代码围栏被 marked 反复解析成不同结构造成抖动。
// 围栏按行首 ``` / ~~~ 识别；奇数个围栏说明最后一个未闭合，边界退到倒数第二个之后。
export function splitMarkdownSafePrefix(text: string): MarkdownSafeSplit {
  if (!text) {
    return { stable: "", tail: "" };
  }
  const fenceRe = /^(```|~~~)/gm;
  const fences: number[] = []; // 每个围栏行的行首偏移
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    fences.push(m.index);
  }
  if (fences.length >= 2) {
    // 偶数个：最后一个是闭合围栏；奇数个：最后一个未闭合，边界取倒数第二个
    const lastClosed = fences.length % 2 === 0 ? fences.length - 1 : fences.length - 2;
    const cut = fences[lastClosed];
    // 边界 = 该围栏行结束处（含行尾换行）
    const nl = text.indexOf("\n", cut);
    const stableEnd = nl >= 0 ? nl + 1 : text.length;
    return { stable: text.slice(0, stableEnd), tail: text.slice(stableEnd) };
  }
  const lastBlank = text.lastIndexOf("\n\n");
  if (lastBlank >= 0) {
    return { stable: text.slice(0, lastBlank + 2), tail: text.slice(lastBlank + 2) };
  }
  return { stable: "", tail: text };
}
