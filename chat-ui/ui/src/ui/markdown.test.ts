import test from "node:test";
import assert from "node:assert/strict";

// node 环境无 DOM：DOMPurify 检测到假 window 后走 "not supported" 分支，
// sanitize 成为透传实现（返回输入）。本测试只关心 LRU 缓存写入策略，
// 不关心 sanitize 后的具体 HTML；必须在导入 markdown.ts（→ dompurify）前打桩。
const g = globalThis as Record<string, unknown>;
g.window ??= {
  document: { nodeType: 9, currentScript: null, createElement: () => ({}) },
  Element: class {},
};

const { markdownCacheSize, toSanitizedMarkdownHtml } = await import("./markdown.ts");

// ── R5 任务 2：markdown LRU 防污染 ──

test("markdown 缓存：同一文本第二次命中缓存，结果一致", () => {
  const key = `cache-hit-${Math.random()}`;
  const before = markdownCacheSize();
  const first = toSanitizedMarkdownHtml(`**${key}**`);
  assert.equal(markdownCacheSize(), before + 1, "首次解析应写入缓存");
  const second = toSanitizedMarkdownHtml(`**${key}**`);
  assert.equal(second, first, "缓存命中应返回相同结果");
  assert.equal(markdownCacheSize(), before + 1, "缓存命中不应新增条目");
});

test("markdown 缓存：bypassCache 不读不写（streaming 中间态防污染）", () => {
  const key = `bypass-${Math.random()}`;
  const before = markdownCacheSize();
  const first = toSanitizedMarkdownHtml(`**${key}**`, { bypassCache: true });
  const second = toSanitizedMarkdownHtml(`**${key}**`, { bypassCache: true });
  assert.equal(markdownCacheSize(), before, "bypassCache 不应写入缓存");
  assert.equal(first, second, "bypassCache 渲染结果应与正常路径一致");
  // bypass 写过的内容不会被后续正常调用命中（未污染）
  toSanitizedMarkdownHtml(`**${key}**`);
  assert.equal(markdownCacheSize(), before + 1, "正常调用才写入一条缓存");
});

test("markdown 缓存：超过 50k 的超长文本不写入缓存", () => {
  const before = markdownCacheSize();
  const long = `x${Math.random().toString(36).slice(2)}`.repeat(60_000);
  toSanitizedMarkdownHtml(long);
  assert.equal(markdownCacheSize(), before, "超长文本不应写入缓存");
});

test("markdown 缓存：LRU 上限 200 条，超出后旧条目被逐出", () => {
  // 用独特前缀填 250 条（避开与上面测试的 key 冲突）
  const prefix = `lru-${Math.random().toString(36).slice(2)}-`;
  for (let i = 0; i < 250; i++) {
    toSanitizedMarkdownHtml(`${prefix}${i}`);
  }
  assert.ok(markdownCacheSize() <= 200, `缓存条数应不超过 200，实际 ${markdownCacheSize()}`);
});

// ── markdown 渲染引擎增强 ──

test("markdown 渲染：GFM 任务列表保留只读复选框", () => {
  const html = toSanitizedMarkdownHtml(`- [x] 已完成\n- [ ] 待办-${Math.random()}`);
  assert.ok(html.includes("checkbox"), "任务列表应渲染 checkbox input");
  assert.ok(html.includes("checked"), "已勾选项应保留 checked");
  assert.ok(html.includes("disabled"), "复选框应为只读（disabled）");
});

test("markdown 渲染：原始 HTML 块按字面转义展示，不当作标记渲染", () => {
  const html = toSanitizedMarkdownHtml(`<div id="probe-${Math.random()}">x</div>`);
  assert.ok(!html.includes("<div"), "原始 HTML 标签不应被渲染为元素");
  assert.ok(html.includes("&lt;div"), "应以转义文本形式展示");
});

test("markdown 渲染：超过解析上限的长文本退化为纯文本块", () => {
  const huge = `para ${Math.random().toString(36).slice(2)}\n`.repeat(12_000); // > 40k 字符
  assert.ok(huge.length > 40_000);
  const html = toSanitizedMarkdownHtml(huge, { bypassCache: true });
  assert.ok(
    html.startsWith(`<pre class="code-block">`),
    "超长文本应退化为 pre 纯文本块",
  );
});

test("markdown 渲染：GFM 表格保留完整表格结构", () => {
  const html = toSanitizedMarkdownHtml(
    `| 列A | 列B-${Math.random().toString(36).slice(2)} |\n|---|---|\n| 1 | 2 |`,
  );
  assert.ok(html.includes("<table"), "应渲染 table 元素");
  assert.ok(html.includes("<th"), "应保留表头单元格");
  assert.ok(html.includes("<td"), "应保留数据单元格");
});

test("markdown 渲染：标题保留层级结构", () => {
  const html = toSanitizedMarkdownHtml(`## 小节-${Math.random().toString(36).slice(2)}\n\n正文`);
  assert.ok(html.includes("<h2"), "二级标题应渲染为 h2");
});

// ── R41 任务 8：markdown 安全前缀切分（纯函数） ──

const { splitMarkdownSafePrefix } = await import("./markdown.ts");

test("splitMarkdownSafePrefix：闭合代码围栏之后切分", () => {
  const text = "intro\n```js\ncode\n```\ntail partial `in";
  const { stable, tail } = splitMarkdownSafePrefix(text);
  assert.equal(stable, "intro\n```js\ncode\n```\n", "stable 应以闭合围栏行（含行尾换行）结尾");
  assert.equal(tail, "tail partial `in", "未完成的尾部应整体归 tail");
});

test("splitMarkdownSafePrefix：单个未闭合围栏整段归 tail", () => {
  const text = "a\n```js\nhalf";
  const { stable, tail } = splitMarkdownSafePrefix(text);
  assert.equal(stable, "", "未闭合围栏前无稳定边界，stable 应为空");
  assert.equal(tail, text, "整段文本应归 tail");
});

test("splitMarkdownSafePrefix：无围栏按最后一个空行切分", () => {
  const text = "para one\n\npara two in progress";
  const { stable, tail } = splitMarkdownSafePrefix(text);
  assert.equal(stable, "para one\n\n", "stable 应包含空行");
  assert.equal(tail, "para two in progress");
});

test("splitMarkdownSafePrefix：无空行无围栏全部归 tail", () => {
  const text = "single paragraph";
  const { stable, tail } = splitMarkdownSafePrefix(text);
  assert.equal(stable, "", "无稳定边界时 stable 应为空");
  assert.equal(tail, text);
});

test("splitMarkdownSafePrefix：奇数围栏，边界取最后闭合的围栏之后", () => {
  const text = "a\n```\nx\n```\nb\n```\npartial";
  const { stable, tail } = splitMarkdownSafePrefix(text);
  assert.equal(stable, "a\n```\nx\n```\n", "第三个围栏未闭合，边界应退到第二个围栏之后");
  assert.equal(tail, "b\n```\npartial");
});

test("splitMarkdownSafePrefix：~~~ 围栏同样识别", () => {
  const text = "a\n~~~\nx\n~~~\ntail";
  const { stable, tail } = splitMarkdownSafePrefix(text);
  assert.ok(stable.endsWith("~~~\n"), "stable 应以闭合的 ~~~ 围栏行结尾");
  assert.equal(tail, "tail");
});

test("splitMarkdownSafePrefix：空字符串返回两个空串", () => {
  const { stable, tail } = splitMarkdownSafePrefix("");
  assert.equal(stable, "");
  assert.equal(tail, "");
});

test("splitMarkdownSafePrefix：文本以闭合围栏结尾（无尾换行）全部归 stable", () => {
  const text = "a\n```js\nx\n```";
  const { stable, tail } = splitMarkdownSafePrefix(text);
  assert.equal(stable, text, "围栏行是最后一段时整段文本应为 stable");
  assert.equal(tail, "");
});

test("splitMarkdownSafePrefix：表格行不误判为围栏", () => {
  const text = "| a | b |\n|---|";
  const { stable, tail } = splitMarkdownSafePrefix(text);
  assert.equal(stable, "", "无围栏且无空行时 stable 应为空");
  assert.equal(tail, text);
});
