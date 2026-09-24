import DOMPurify from "dompurify";
import { marked } from "marked";
import { truncateText } from "./format.ts";
import { t } from "./i18n.ts";

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
  // R83：模型/内核输出的 <progress> 进度条元素（value/max 属性）是唯一放行的
  // 「活」HTML——长任务的进度反馈需要原生进度条。属性面由 DOMPurify 白名单
  // 收口（仅 value/max/class/title 等），事件属性一律剥除。
  "progress",
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
  // <progress> 的进度属性（DOMPurify 对 progress 元素只保留白名单属性）
  "value",
  "max",
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
  // trim 只用于空判定：解析必须用原文——开头 4 空格缩进代码块依赖行首缩进，
  // 先 trim 会把缩进代码块剥成普通段落。
  if (!markdown.trim()) {
    return "";
  }
  const input = markdown;
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
    ? `\n\n${t("chat.markdownTruncated")
        .replace("{total}", String(truncated.total))
        .replace("{shown}", String(truncated.text.length))}`
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
// R83 例外：<progress> 进度条标签原样放行（唯一白名单「活」元素），
// 其余 HTML 仍字面转义；放行的标签随后仍经 DOMPurify 属性收口。
const PROGRESS_TAG_RE = /<\/?progress\b[^>]*\/?>/gi;
const htmlEscapeRenderer = new marked.Renderer();
htmlEscapeRenderer.html = ({ text }: { text: string }) => {
  if (!text) {
    return "";
  }
  // \x00 占位符可被用户文本里的字面「\x005\x00」伪造还原——这不是防护，只是约定：
  // NUL 不可能出现在正常聊天/markdown 文本中，按可接受风险放行
  const passthrough: string[] = [];
  const masked = text.replace(PROGRESS_TAG_RE, (tag) => {
    passthrough.push(tag);
    return `\x00${passthrough.length - 1}\x00`;
  });
  return escapeHtml(masked).replace(/\x00(\d+)\x00/g, (_, idx: string) => {
    const tag = passthrough[Number(idx)];
    return tag ?? "";
  });
};

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
// 缓存条目知悉即可：稳定段每推进一次边界会向 LRU 新增一个一次性缓存条目，
// 由读时提升与 50k 上限缓解，无需特殊处理。
//
// 演进说明（防后人按旧结论回退）：R5 曾定论「流式不解析 markdown」，因为当时是
// 每帧对全文全量 marked.parse + DOMPurify，长回复呈 O(n²)。本函数（R41 Task 9）
// 是有意升级：解析对象只剩不变稳定段且命中 LRU，成本降到边界推进频率；
// 安全面不变——稳定段经 DOMPurify，尾部经 escapeHtml。
//
// R72 单槽 memo：rAF 每帧都会带着当前全文调用（delta 合帧后文本未变的帧也很多），
// >50k 的稳定段又不读 LRU——同文本帧直接复用上次结果，把超长回复的每帧
// escapeHtml+DOMPurify 降为只在文本实际变化时执行一次。只存最近一条，无泄漏面。
// R83 改为返回 {stableHtml, tail} 两段（调用方分两个节点渲染）：
// 稳定段节点绑定 unsafeHTML（lit 对同字符串是 no-op，DOM 不重建——代码块的
// 复制按钮/hljs 高亮结果得以保留），尾部节点纯文本绑定（每帧只更新 textContent）。
let streamingPartsMemo: { text: string; stableHtml: string; tail: string } | null = null;

export type StreamingMarkdownParts = { stableHtml: string; tail: string };

export function toStreamingMarkdownParts(text: string): StreamingMarkdownParts {
  const trimmed = text.trim();
  if (!trimmed) {
    return { stableHtml: "", tail: "" };
  }
  if (streamingPartsMemo && streamingPartsMemo.text === trimmed) {
    return { stableHtml: streamingPartsMemo.stableHtml, tail: streamingPartsMemo.tail };
  }
  const { stable, tail } = splitMarkdownSafePrefix(trimmed);
  // 稳定段走默认缓存路径：内部以 trim 后全文作键，边界不推进时稳定段内容不变即命中；
  // splitMarkdownSafePrefix 的边界含行尾 \n，键不会因尾随空白抖动。
  const stableHtml = stable ? toSanitizedMarkdownHtml(stable) : "";
  streamingPartsMemo = { text: trimmed, stableHtml, tail };
  return { stableHtml, tail };
}

// 安全前缀切分（对齐官方 control-ui 流式 markdown 做法）：
// 找到最后一个「稳定块边界」——闭合的代码围栏之后，或最后一个空行处。
// 边界之前是已完成结构（可完整解析渲染），之后是进行中内容（调用方按纯文本渲染），
// 避免半截代码围栏被 marked 反复解析成不同结构造成抖动。
// 围栏按行首 ``` / ~~~ 识别；奇数个围栏说明最后一个未闭合，边界退到倒数第二个之后。
// 未闭合围栏体内的行尾切点/空行切点一律拒绝（ marked 对未闭合围栏也会
// 即时产出代码块结构，切进去会让每帧增长的 stable 段反复重解析、视觉上
// 行从段落「跳」进代码块）——切点必须落在未闭合围栏行首偏移之前。
//
// 行尾推进边界：除上述块级边界外，单个行尾 \n 也可作为推进边界（与上方
// toStreamingMarkdownParts 注释「边界含行尾 \n」的既定语义对齐），让已完成
// 的行（如 `已生成 MEDIA:C:\out\report.pdf`）尽早进入 stable 段完整渲染。
// 保守条件（不安全切分点跳过该 \n，回退空行/围栏逻辑）：
//   - 切分点所在行不是围栏行（``` / ~~~ 开头）——未闭合围栏内按行切会把
//     半截围栏交给 marked 解析；
//   - 切分行与下一行均不以 | 开头——表格行被切开时，下一行到来可能把已渲染
//     的段落并入表格（结构突变），且 stable 可能回缩（边界退回空行搜索）；
//   - 下一行不是 setext 下划线（= / -）或主题分隔（--- / *** / ___）——否则
//     切出的「段落」随后会变成标题/分隔线。
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
  // 未闭合围栏的行首偏移（奇数个围栏时最后一个未闭合）；切点落在大于该
  // 偏移处即处于围栏体内，一律拒绝（下方行尾扫描与空行兜底都适用）。
  const unclosedFenceStart = fences.length % 2 === 1 ? (fences[fences.length - 1] ?? -1) : -1;
  if (fences.length >= 2) {
    // 偶数个：最后一个是闭合围栏；奇数个：最后一个未闭合，边界取倒数第二个
    const lastClosed = fences.length % 2 === 0 ? fences.length - 1 : fences.length - 2;
    const cut = fences[lastClosed];
    // 边界 = 该围栏行结束处（含行尾换行）
    const nl = text.indexOf("\n", cut);
    const stableEnd = nl >= 0 ? nl + 1 : text.length;
    return { stable: text.slice(0, stableEnd), tail: text.slice(stableEnd) };
  }
  // 行尾推进边界（从后往前找最近的合格切点）：若最后的行尾因下一行变成
  // 表格/setext 形态而不合格，向前回溯可保住单调推进（stable 只增长不回缩），
  // 避免已渲染的 stable 段被撤下重排造成闪烁。
  let searchFrom = text.length;
  for (;;) {
    const nl = text.lastIndexOf("\n", searchFrom - 1);
    if (nl < 0) {
      break;
    }
    const lineStart = text.lastIndexOf("\n", nl - 1) + 1;
    const cutLine = text.slice(lineStart, nl);
    const nextNl = text.indexOf("\n", nl + 1);
    const nextLine = text.slice(nl + 1, nextNl === -1 ? text.length : nextNl);
    // 未闭合围栏体内不按行切：半截围栏进 stable 会被 marked 解析成代码块，
    // stable 每增长一次就整段重解析（marked+DOMPurify+hljs）且视觉抖动。
    if (unclosedFenceStart >= 0 && nl > unclosedFenceStart) {
      searchFrom = nl;
      continue;
    }
    if (isSafeStreamLineCut(cutLine, nextLine)) {
      return { stable: text.slice(0, nl + 1), tail: text.slice(nl + 1) };
    }
    searchFrom = nl;
  }
  // 空行兜底：同样拒绝未闭合围栏体内的空行（围栏内容里的空行不是结构边界，
  // 切进去同样会把半截围栏交给 marked）；向前回溯找围栏前的空行。
  let blankSearchFrom = text.length;
  for (;;) {
    const lastBlank = text.lastIndexOf("\n\n", blankSearchFrom - 1);
    if (lastBlank < 0) {
      break;
    }
    if (unclosedFenceStart < 0 || lastBlank < unclosedFenceStart) {
      return { stable: text.slice(0, lastBlank + 2), tail: text.slice(lastBlank + 2) };
    }
    blankSearchFrom = lastBlank;
  }
  return { stable: "", tail: text };
}

// 行尾切分安全性判断（见 splitMarkdownSafePrefix 头注）。
// 下一行形态相关的不合格判定会让该切点失效（依赖右侧内容，追加文本可能
// 使既有切点失效），调用方因此从后往前回溯，保住 stable 单调推进。
function isSafeStreamLineCut(cutLine: string, nextLine: string): boolean {
  const cutTrimmed = cutLine.trimStart();
  if (cutTrimmed.startsWith("```") || cutTrimmed.startsWith("~~~")) {
    return false; // 围栏行：未闭合围栏内按行切不安全
  }
  if (cutTrimmed.startsWith("|")) {
    return false; // 表格行：切开后结构可能随下一行改变
  }
  const nextTrimmed = nextLine.trim();
  if (nextTrimmed.startsWith("|")) {
    return false; // 下一行是表格行：可能与切分行同属一张表
  }
  if (nextTrimmed.startsWith("```") || nextTrimmed.startsWith("~~~")) {
    return false; // 下一行是围栏行：围栏开启后该切点会随围栏处理回退，避免闪烁
  }
  if (/^(?:=+|-+|\*{3,}|_{3,})$/.test(nextTrimmed)) {
    return false; // setext 下划线（= / -）或主题分隔（--- / *** / ___）
  }
  return true;
}
