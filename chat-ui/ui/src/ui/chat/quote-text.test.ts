import { test } from "node:test";
import assert from "node:assert/strict";
import { appendQuoteToDraft, buildQuoteText, QUOTE_MAX_CHARS } from "./quote-text.ts";

test("buildQuoteText：单行文本加 > 前缀", () => {
  assert.equal(buildQuoteText("你好，世界"), "> 你好，世界");
});

test("buildQuoteText：多行文本逐行加前缀", () => {
  assert.equal(buildQuoteText("第一行\n第二行"), "> 第一行\n> 第二行");
});

test("buildQuoteText：空行保留为 >", () => {
  assert.equal(buildQuoteText("第一段\n\n第二段"), "> 第一段\n>\n> 第二段");
});

test("buildQuoteText：CRLF 归一化", () => {
  assert.equal(buildQuoteText("a\r\nb"), "> a\n> b");
});

test("buildQuoteText：空/纯空白文本返回空串", () => {
  assert.equal(buildQuoteText(""), "");
  assert.equal(buildQuoteText("   \n  "), "");
});

test("buildQuoteText：超长文本截断并标注省略号", () => {
  const long = "字".repeat(QUOTE_MAX_CHARS + 100);
  const quoted = buildQuoteText(long);
  assert.ok(quoted.startsWith("> "));
  assert.ok(quoted.includes("…"), "截断处应有省略号");
  assert.ok(quoted.length < QUOTE_MAX_CHARS + 50, "不应显著超过上限");
});

test("buildQuoteText：自定义上限生效", () => {
  const quoted = buildQuoteText("abcdefghij", 5);
  assert.ok(quoted.startsWith("> abcde"), "截断到上限附近");
  assert.ok(quoted.includes("…"));
  assert.ok(!quoted.includes("fghij"), "超出上限部分被丢弃");
});

test("appendQuoteToDraft：空草稿直接是引用块", () => {
  assert.equal(appendQuoteToDraft("", "hello"), "> hello");
  assert.equal(appendQuoteToDraft("   ", "hello"), "> hello");
});

test("appendQuoteToDraft：非空草稿以两换行追加", () => {
  const next = appendQuoteToDraft("已有草稿", "被引用");
  assert.equal(next, "已有草稿\n\n> 被引用");
});

test("appendQuoteToDraft：引用文本为空时草稿不变", () => {
  assert.equal(appendQuoteToDraft("已有草稿", "   "), "已有草稿");
});

test("appendQuoteToDraft：草稿尾随空白被清理", () => {
  const next = appendQuoteToDraft("已有草稿  \n", "被引用");
  assert.equal(next, "已有草稿\n\n> 被引用");
});
