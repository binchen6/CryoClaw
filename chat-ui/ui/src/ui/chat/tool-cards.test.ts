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

// ── R52 T4：diffStat / errorSummary / exitCode / toolArgs 提取 ──

test("tool cards：call 内容块带 diffStat（input_delta 实时/终态最终）→ 卡带 diffStat", () => {
  // 与 app-tool-stream.ts::buildToolCallMessage 同构
  const msg = {
    role: "assistant",
    pending: true,
    content: [
      {
        type: "toolCall",
        id: "tc1",
        name: "write",
        arguments: { path: "a.ts" },
        diffStat: { added: 3, removed: 1 },
      },
    ],
  };
  const cards = extractToolCards(msg);
  assert.deepEqual(cards[0].diffStat, { added: 3, removed: 1 });
});

test("tool cards：call 内容块 diffStat 非法载荷宽容忽略", () => {
  const msg = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "tc1", name: "write", arguments: {}, diffStat: { added: -1 } },
    ],
  };
  assert.equal(extractToolCards(msg)[0].diffStat, undefined);
});

test("tool cards：流式 resultMessage 消息级 toolErrorSummary/exitCode/diffStat/toolArgs 提取", () => {
  // 与 app-tool-stream.ts::buildToolResultMessage 同构
  const msg = {
    role: "toolResult",
    toolCallId: "tc1",
    toolName: "exec",
    toolArgs: { command: "npm test" },
    isError: true,
    toolErrorSummary: "command failed: exit 2",
    exitCode: 2,
    diffStat: { added: 0, removed: 4 },
    content: [{ type: "text", text: "raw output…" }],
  };
  const cards = extractToolCards(msg);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, "result");
  assert.equal(cards[0].error, "raw output…");
  assert.equal(cards[0].errorSummary, "command failed: exit 2");
  assert.equal(cards[0].exitCode, 2);
  assert.deepEqual(cards[0].diffStat, { added: 0, removed: 4 });
  assert.deepEqual(cards[0].args, { command: "npm test" });
});

test("tool cards：消息级字段缺失/非法时卡不携带对应字段", () => {
  const msg = {
    role: "toolResult",
    toolCallId: "tc1",
    toolErrorSummary: "   ",
    exitCode: 1.5,
    diffStat: "nope",
    content: [{ type: "text", text: "ok" }],
  };
  const card = extractToolCards(msg)[0];
  assert.equal(card.errorSummary, undefined);
  assert.equal(card.exitCode, undefined);
  assert.equal(card.diffStat, undefined);
  assert.equal(card.args, undefined);
});

test("tool cards：历史 toolResult block 级 toolErrorSummary/exitCode 宽容读取", () => {
  const msg = {
    role: "tool",
    content: [
      {
        type: "toolResult",
        name: "exec",
        text: "boom",
        isError: true,
        toolErrorSummary: "exit 1",
        exitCode: 1,
      },
    ],
  };
  const card = extractToolCards(msg)[0];
  assert.equal(card.errorSummary, "exit 1");
  assert.equal(card.exitCode, 1);
});
