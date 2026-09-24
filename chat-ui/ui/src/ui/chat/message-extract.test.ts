import test from "node:test";
import assert from "node:assert/strict";

const { stripEnvelope, formatReasoningMarkdown } = await import("./message-extract.ts");

// ── stripEnvelope：网关信封头识别 ──

test("stripEnvelope：频道名开头的真实信封头被剥离", () => {
  assert.equal(stripEnvelope("[WhatsApp +15551234567] 帮我查一下快递"), "帮我查一下快递");
  assert.equal(stripEnvelope("[WebChat anonymous] hello"), "hello");
  assert.equal(stripEnvelope("[Telegram 123456 (reply)] 跟进上次的问题"), "跟进上次的问题");
});

test("stripEnvelope：带秒时间戳的信封头被剥离", () => {
  assert.equal(
    stripEnvelope("[2026-01-12 12:19:17] Model switched."),
    "Model switched.",
  );
  assert.equal(
    stripEnvelope("[WebChat anon 2026-01-12 12:19:17] 在吗"),
    "在吗",
  );
});

test("stripEnvelope：用户手打的无秒时间戳提醒不被误剥", () => {
  const text = "[2024-01-01 12:00] 提醒我开会";
  assert.equal(stripEnvelope(text), text, "用户消息前缀不得被当信封头剥掉");
  const noSpace = "[2024-01-01T12:00Z] 提醒我开会";
  assert.equal(stripEnvelope(noSpace), noSpace, "无秒 ISO 时间戳同样保留");
});

test("stripEnvelope：普通方括号文本原样保留", () => {
  assert.equal(stripEnvelope("[重要] 看一下这个"), "[重要] 看一下这个");
  assert.equal(stripEnvelope("[todo] 修复 bug"), "[todo] 修复 bug");
  assert.equal(stripEnvelope("没有方括号"), "没有方括号");
});

// ── formatReasoningMarkdown：思考过程 markdown 包装 ──

test("formatReasoningMarkdown：非空思考包装为斜体行并带头标注", () => {
  const out = formatReasoningMarkdown("先看一下文件\n再改代码");
  assert.ok(out.startsWith("_"), "头标注应为斜体 markdown");
  assert.ok(out.includes("先看一下文件"), "思考行应保留");
});

test("formatReasoningMarkdown：空白输入返回空串", () => {
  assert.equal(formatReasoningMarkdown("   "), "");
  assert.equal(formatReasoningMarkdown(""), "");
});
