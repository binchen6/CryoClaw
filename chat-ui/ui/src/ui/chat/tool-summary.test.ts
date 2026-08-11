import test from "node:test";
import assert from "node:assert/strict";

import { resolveActiveToolName, summarizeToolCards } from "./tool-summary.ts";
import type { ToolCard } from "../types/chat-types.ts";

function card(kind: "call" | "result", name: string, args?: unknown): ToolCard {
  return { kind, name, args } as ToolCard;
}

// ── summarizeToolCards：单工具详情 ──

test("tool summary：单工具显示显示名 + 参数详情（路径）", () => {
  const s = summarizeToolCards([
    card("call", "read", { path: "src/main.ts" }),
    card("result", "read"),
  ]);
  assert.equal(s.isSingle, true);
  assert.equal(s.label, "read");
  assert.equal(s.detail, "src/main.ts");
  assert.equal(s.totalTools, 1);
});

test("tool summary：单工具无参数时无详情", () => {
  const s = summarizeToolCards([card("call", "exec")]);
  assert.equal(s.isSingle, true);
  assert.equal(s.label, "exec");
  assert.equal(s.detail, undefined);
});

test("tool summary：exec 命令参数进入详情", () => {
  const s = summarizeToolCards([card("call", "exec", { command: "npm test" })]);
  assert.equal(s.detail, "npm test");
});

test("tool summary：多工具走计数 + 名单，非单工具", () => {
  const s = summarizeToolCards([card("call", "read"), card("call", "write")]);
  assert.equal(s.isSingle, false);
  assert.equal(s.detail, undefined);
  assert.equal(s.label, "read, write");
});

// ── resolveActiveToolName ──

function toolCallMsg(name: string) {
  return { role: "assistant", content: [{ type: "toolCall", name, arguments: {} }] };
}
function toolResultMsg(name: string) {
  return { role: "tool", content: [{ type: "toolResult", name, text: "ok" }] };
}
function textMsg(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

test("active tool：空时间线返回 null", () => {
  assert.equal(resolveActiveToolName([]), null);
});

test("active tool：最后一条是有 call 无 result → 返回工具名", () => {
  assert.equal(resolveActiveToolName([toolCallMsg("read")]), "read");
});

test("active tool：call 后已有 result → null（工具已完成）", () => {
  assert.equal(resolveActiveToolName([toolCallMsg("read"), toolResultMsg("read")]), null);
});

test("active tool：完成的工具后再起新 call → 新工具名", () => {
  assert.equal(
    resolveActiveToolName([
      toolCallMsg("read"),
      toolResultMsg("read"),
      textMsg("段间文本"),
      toolCallMsg("exec"),
    ]),
    "exec",
  );
});

test("active tool：末尾是文本消息时跳过、由最近工具消息决定", () => {
  assert.equal(
    resolveActiveToolName([toolCallMsg("read"), toolResultMsg("read"), textMsg("正在写")]),
    null,
  );
});

test("active tool：流式时间线 resultMessage（role=toolResult + 纯文本）也算完成", () => {
  // 与 app-tool-stream.ts::buildToolResultMessage 同构
  const streamResult = {
    role: "toolResult",
    toolCallId: "tc1",
    content: [{ type: "text", text: "output" }],
  };
  assert.equal(resolveActiveToolName([toolCallMsg("read"), streamResult]), null);
  assert.equal(resolveActiveToolName([toolCallMsg("read"), streamResult, toolCallMsg("exec")]), "exec");
});

// ── summarizeToolCards：hasError ──

test("tool summary：任一 result 带 error → hasError true", () => {
  const s = summarizeToolCards([
    card("call", "read"),
    { kind: "result", name: "read", text: "boom", error: "boom" } as ToolCard,
  ]);
  assert.equal(s.hasError, true);
});

test("tool summary：多工具中一个失败 → hasError true", () => {
  const s = summarizeToolCards([
    card("call", "read"),
    { kind: "result", name: "read", text: "ok" } as ToolCard,
    card("call", "exec"),
    { kind: "result", name: "exec", text: "exit 1", error: "exit 1" } as ToolCard,
  ]);
  assert.equal(s.hasError, true);
});

test("tool summary：全部成功 → hasError false", () => {
  const s = summarizeToolCards([
    card("call", "read"),
    { kind: "result", name: "read", text: "ok" } as ToolCard,
  ]);
  assert.equal(s.hasError, false);
});

test("tool summary：进行中的 pending call 不算失败", () => {
  const s = summarizeToolCards([{ kind: "call", name: "read", pending: true } as ToolCard]);
  assert.equal(s.hasError, false);
});
