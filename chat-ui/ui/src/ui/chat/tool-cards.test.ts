import test from "node:test";
import assert from "node:assert/strict";

import { extractToolCards } from "./tool-cards.ts";

// ── extractToolCards：三态（pending / error）归并 ──

test("tool cards：流式 call 消息带 pending → call 卡标记进行中", () => {
  // 与 app-tool-stream.ts::buildToolCallMessage 同构
  const msg = {
    role: "assistant",
    pending: true,
    content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
  };
  const cards = extractToolCards(msg);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, "call");
  assert.equal(cards[0].pending, true);
  assert.equal(cards[0].error, undefined);
});

test("tool cards：历史 call 消息无 pending 字段 → 不标进行中", () => {
  const msg = {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }],
  };
  const cards = extractToolCards(msg);
  assert.equal(cards[0].pending, undefined);
});

test("tool cards：消息级 isError=true（流式 resultMessage）→ result 卡带 error", () => {
  // 与 app-tool-stream.ts::buildToolResultMessage 同构
  const msg = {
    role: "toolResult",
    toolCallId: "tc1",
    isError: true,
    content: [{ type: "text", text: "command failed: exit 1" }],
  };
  const cards = extractToolCards(msg);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, "result");
  assert.equal(cards[0].error, "command failed: exit 1");
});

test("tool cards：消息级无 isError → result 卡无 error", () => {
  const msg = {
    role: "toolResult",
    toolCallId: "tc1",
    content: [{ type: "text", text: "ok" }],
  };
  const cards = extractToolCards(msg);
  assert.equal(cards[0].error, undefined);
});

test("tool cards：toolResult block 级 isError=true → error（历史形态）", () => {
  const msg = {
    role: "tool",
    content: [{ type: "toolResult", name: "exec", text: "boom", isError: true }],
  };
  const cards = extractToolCards(msg);
  assert.equal(cards[0].kind, "result");
  assert.equal(cards[0].error, "boom");
});

test("tool cards：isError 非严格 true（字符串/0）宽容忽略", () => {
  const msg = {
    role: "tool",
    content: [{ type: "toolResult", name: "exec", text: "ok", isError: "true" }],
  };
  assert.equal(extractToolCards(msg)[0].error, undefined);
  const msg2 = {
    role: "toolResult",
    toolCallId: "tc1",
    isError: 0,
    content: [{ type: "text", text: "ok" }],
  };
  assert.equal(extractToolCards(msg2)[0].error, undefined);
});
