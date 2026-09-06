import test from "node:test";
import assert from "node:assert/strict";

import {
  countUnifiedDiffStat,
  formatToolOutputForSidebar,
  parseDiffStat,
  resolveToolCardErrorText,
} from "./tool-helpers.ts";

// ── parseDiffStat：input_delta data.diff 的宽容解析（对齐 control-ui ts()）──

test("parseDiffStat：合法 {added, removed} 非负整数对原样返回", () => {
  assert.deepEqual(parseDiffStat({ added: 3, removed: 1 }), { added: 3, removed: 1 });
  assert.deepEqual(parseDiffStat({ added: 0, removed: 0 }), { added: 0, removed: 0 });
});

test("parseDiffStat：非对象/缺字段/负数/非整数一律丢弃", () => {
  assert.equal(parseDiffStat(undefined), undefined);
  assert.equal(parseDiffStat(null), undefined);
  assert.equal(parseDiffStat("added"), undefined);
  assert.equal(parseDiffStat({ added: 1 }), undefined);
  assert.equal(parseDiffStat({ added: 1, removed: -1 }), undefined);
  assert.equal(parseDiffStat({ added: 1.5, removed: 0 }), undefined);
  assert.equal(parseDiffStat({ added: "3", removed: 1 }), undefined);
});

// ── countUnifiedDiffStat：result details.diff 文本的最终统计 ──

test("countUnifiedDiffStat：统计 +/- 行，跳过 +++/--- 头部", () => {
  const diff = ["--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1,3 @@", "-old", "+new", "+new2", " ctx"].join(
    "\n",
  );
  assert.deepEqual(countUnifiedDiffStat(diff), { added: 2, removed: 1 });
});

test("countUnifiedDiffStat：无 +/- 行返回 undefined（无徽标）", () => {
  assert.equal(countUnifiedDiffStat("@@ -1 +1 @@\n ctx"), undefined);
  assert.equal(countUnifiedDiffStat(""), undefined);
  assert.equal(countUnifiedDiffStat(undefined), undefined);
  assert.equal(countUnifiedDiffStat(42), undefined);
});

// ── resolveToolCardErrorText：失败卡文案优先 toolErrorSummary ──

test("resolveToolCardErrorText：errorSummary 优先于裸输出", () => {
  assert.equal(
    resolveToolCardErrorText({ errorSummary: "compile failed: TS2304", text: "raw output…" }),
    "compile failed: TS2304",
  );
});

test("resolveToolCardErrorText：无摘要回退 error/text；全空返回 undefined", () => {
  assert.equal(resolveToolCardErrorText({ error: "boom" }), "boom");
  assert.equal(resolveToolCardErrorText({ text: "raw" }), "raw");
  assert.equal(resolveToolCardErrorText({ errorSummary: "   ", text: "raw" }), "raw");
  assert.equal(resolveToolCardErrorText({}), undefined);
});

// ── formatToolOutputForSidebar：语言围栏 ──

test("sidebar 格式化：JSON 仍优先走 json 围栏（不受 language 影响）", () => {
  const out = formatToolOutputForSidebar('{"a":1}', { language: "typescript" });
  assert.ok(out.startsWith("```json\n"));
  assert.ok(out.includes('"a": 1'));
});

test("sidebar 格式化：带 language 时整体包代码围栏", () => {
  const out = formatToolOutputForSidebar("const x = 1;", { language: "typescript" });
  assert.equal(out, "```typescript\nconst x = 1;\n```");
});

test("sidebar 格式化：无 language 或输出已含围栏时不包裹", () => {
  assert.equal(formatToolOutputForSidebar("plain text"), "plain text");
  const fenced = "```ts\nconst x = 1;\n```";
  assert.equal(formatToolOutputForSidebar(fenced, { language: "typescript" }), fenced);
  assert.equal(formatToolOutputForSidebar("x", { language: "  " }), "x");
});
