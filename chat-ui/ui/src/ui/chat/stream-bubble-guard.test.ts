import test from "node:test";
import assert from "node:assert/strict";
import { isStreamTextDuplicatedInHistory } from "./stream-bubble-guard.ts";

function assistant(text: string, extra: Record<string, unknown> = {}) {
  return { role: "assistant", content: [{ type: "text", text }], ...extra };
}

test("流式文本与历史末条 assistant 相同（归一化后）→ 判定重复", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    assistant("The answer is 42."),
  ];
  assert.equal(isStreamTextDuplicatedInHistory(messages, "The answer is 42."), true);
});

test("空白差异（换行/首尾空格）不影响判定", () => {
  const messages = [assistant("The answer\nis  42.")];
  assert.equal(isStreamTextDuplicatedInHistory(messages, "  The answer is 42.  "), true);
});

test("流式文本是历史的严格前缀 → 仍在续流，不抑制", () => {
  const messages = [assistant("The answer is 42. And more.")];
  assert.equal(isStreamTextDuplicatedInHistory(messages, "The answer is 42."), false);
});

test("流式文本比历史长 → 不抑制", () => {
  const messages = [assistant("short")];
  assert.equal(isStreamTextDuplicatedInHistory(messages, "shorter stream tail"), false);
});

test("末条 assistant 之后的 user 消息不影响：仍与最近 assistant 比较", () => {
  const messages = [
    assistant("The answer is 42."),
    { role: "user", content: [{ type: "text", text: "thanks" }] },
  ];
  assert.equal(isStreamTextDuplicatedInHistory(messages, "The answer is 42."), true);
});

test("历史无 assistant 消息 / 空流式文本 → 不抑制", () => {
  assert.equal(
    isStreamTextDuplicatedInHistory([{ role: "user", content: [] }], "text"),
    false,
  );
  assert.equal(isStreamTextDuplicatedInHistory([assistant("x")], ""), false);
  assert.equal(isStreamTextDuplicatedInHistory([assistant("x")], null), false);
  assert.equal(isStreamTextDuplicatedInHistory([assistant("x")], "   "), false);
});

test("末条 assistant 是纯工具卡（无正文文本）时继续向前找可比较文本", () => {
  const messages = [
    assistant("The answer is 42."),
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
    },
  ];
  assert.equal(isStreamTextDuplicatedInHistory(messages, "The answer is 42."), true);
  assert.equal(
    isStreamTextDuplicatedInHistory(messages, "unrelated streaming tail"),
    false,
  );
});
