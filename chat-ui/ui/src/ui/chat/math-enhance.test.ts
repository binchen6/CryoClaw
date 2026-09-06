import test from "node:test";
import assert from "node:assert/strict";

import { BLOCK_RE, INLINE_RE, isValidInlineTex } from "./math-enhance.ts";

// ── LaTeX 公式识别启发式（防 $5 之类金额文本误判）──

test("math：块级 $$...$$ 可匹配跨行公式", () => {
  // String.match（非全局正则）与 RegExp.exec 返回同构匹配数组
  const m = "前文 $$\na^2+b^2=c^2\n$$ 后文".match(BLOCK_RE);
  assert.ok(m, "应匹配块级公式");
  assert.equal(m![1].trim(), "a^2+b^2=c^2");
});

test("math：行内 $...$ 匹配紧凑公式", () => {
  const m = "勾股定理 $a^2+b^2=c^2$ 成立".match(INLINE_RE);
  assert.ok(m, "应匹配行内公式");
  assert.equal(m![1], "a^2+b^2=c^2");
});

test("math：金额文本不误判（首尾空白拒绝）", () => {
  const m = "价格是 $5 and $10".match(INLINE_RE);
  if (m) {
    // 即使正则给出候选，合法性校验必须拒绝（捕获 '5 and ' 尾部空白）
    assert.equal(isValidInlineTex(m[1]), false, "金额候选应被拒绝");
  }
  assert.equal(isValidInlineTex("5 and "), false);
  assert.equal(isValidInlineTex(" leading"), false);
});

test("math：合法性校验基本规则", () => {
  assert.equal(isValidInlineTex("E=mc^2"), true);
  assert.equal(isValidInlineTex(""), false);
  assert.equal(isValidInlineTex("a\nb"), false, "行内公式不得跨行");
  assert.equal(isValidInlineTex("x".repeat(301)), false, "超长拒绝");
});
