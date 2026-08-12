import test from "node:test";
import assert from "node:assert/strict";

import {
  extractMessageModel,
  extractMessageUsage,
  formatUsageFooter,
  sumGroupUsage,
} from "./message-meta.ts";
import { summarizeToolCards } from "./tool-summary.ts";
import type { ToolCard } from "../types/chat-types.ts";

// ── extractMessageModel ──

test("message meta：复合键 model 取最后一段", () => {
  assert.equal(
    extractMessageModel({ role: "assistant", model: "moonshot/kimi-k2-0711-preview" }),
    "kimi-k2-0711-preview",
  );
});

test("message meta：裸 model id 原样返回", () => {
  assert.equal(extractMessageModel({ role: "assistant", model: "gpt-5" }), "gpt-5");
});

test("message meta：缺 model / 空串 / 非字符串返回 null", () => {
  assert.equal(extractMessageModel({ role: "assistant" }), null);
  assert.equal(extractMessageModel({ role: "assistant", model: "  " }), null);
  assert.equal(extractMessageModel({ role: "assistant", model: 42 }), null);
});

// ── extractMessageUsage ──

test("message meta：totalTokens 直取", () => {
  assert.deepEqual(
    extractMessageUsage({ usage: { totalTokens: 1234 } }),
    { totalTokens: 1234, costUsd: null },
  );
});

test("message meta：total / input+output / prompt+completion 多命名 fallback", () => {
  assert.deepEqual(extractMessageUsage({ usage: { total: 99 } }), {
    totalTokens: 99,
    costUsd: null,
  });
  assert.deepEqual(extractMessageUsage({ usage: { inputTokens: 10, outputTokens: 5 } }), {
    totalTokens: 15,
    costUsd: null,
  });
  assert.deepEqual(extractMessageUsage({ usage: { promptTokens: 7, completionTokens: 3 } }), {
    totalTokens: 10,
    costUsd: null,
  });
  assert.deepEqual(extractMessageUsage({ usage: { input: 4, output: 6 } }), {
    totalTokens: 10,
    costUsd: null,
  });
});

test("message meta：cost.total 提取", () => {
  assert.deepEqual(
    extractMessageUsage({ usage: { totalTokens: 100, cost: { total: 0.0123 } } }),
    { totalTokens: 100, costUsd: 0.0123 },
  );
});

test("message meta：全零合成消息与缺字段返回 null", () => {
  assert.equal(extractMessageUsage({ usage: { totalTokens: 0, cost: { total: 0 } } }), null);
  assert.equal(extractMessageUsage({ usage: {} }), null);
  assert.equal(extractMessageUsage({}), null);
  assert.equal(extractMessageUsage({ usage: "nope" }), null);
});

// ── sumGroupUsage ──

test("message meta：组内多条消息 token/成本求和", () => {
  const sum = sumGroupUsage([
    { usage: { totalTokens: 100, cost: { total: 0.01 } } },
    { usage: { inputTokens: 40, outputTokens: 10, cost: { total: 0.02 } } },
    { role: "user" },
  ]);
  assert.deepEqual(sum, { totalTokens: 150, costUsd: 0.03 });
});

test("message meta：全组无 usage 返回 null", () => {
  assert.equal(sumGroupUsage([{ role: "user" }, { usage: {} }]), null);
  assert.equal(sumGroupUsage([]), null);
});

// ── formatUsageFooter ──

test("message meta：footer 文案格式", () => {
  assert.equal(formatUsageFooter({ totalTokens: 12300, costUsd: null }), "12.3K tokens");
  assert.equal(
    formatUsageFooter({ totalTokens: 999, costUsd: 0.04 }),
    "999 tokens · $0.04",
  );
  // 小额成本用 4 位小数，避免显示 $0.00
  assert.equal(
    formatUsageFooter({ totalTokens: null, costUsd: 0.0012 }),
    "$0.0012",
  );
});

// ── summarizeToolCards ──

function card(kind: "call" | "result", name: string): ToolCard {
  return { kind, name } as ToolCard;
}

test("tool summary：≤3 个工具名全列", () => {
  const { totalTools, label } = summarizeToolCards([
    card("call", "read"),
    card("call", "write"),
  ]);
  assert.equal(totalTools, 2);
  assert.equal(label, "read, write");
});

test("tool summary：>3 个工具名折叠为前 2 个 + 「+N more」", () => {
  const { label } = summarizeToolCards([
    card("call", "a"),
    card("call", "b"),
    card("call", "c"),
    card("call", "d"),
  ]);
  assert.equal(label, "a, b +2 more");
});

test("tool summary：call/result 成对时总数取大者不重复计数", () => {
  const { totalTools } = summarizeToolCards([
    card("call", "exec"),
    card("result", "exec"),
    card("call", "read"),
    card("result", "read"),
  ]);
  assert.equal(totalTools, 2);
});

test("tool summary：同名工具去重", () => {
  const { label } = summarizeToolCards([
    card("call", "exec"),
    card("call", "exec"),
    card("result", "exec"),
  ]);
  assert.equal(label, "exec");
});
