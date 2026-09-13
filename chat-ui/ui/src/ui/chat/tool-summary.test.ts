import test from "node:test";
import assert from "node:assert/strict";

// label 断言依赖 en 字典：单测进程共享 locale 模块状态，显式钉住防其它文件污染
import { setLocale } from "../i18n/index.ts";
setLocale("en");

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
  // R85：label 走 i18n 友好名（测试环境 locale=en）
  assert.equal(s.label, "Read file");
  assert.equal(s.detail, "src/main.ts");
  assert.equal(s.totalTools, 1);
});

test("tool summary：单工具无参数时无详情", () => {
  const s = summarizeToolCards([card("call", "exec")]);
  assert.equal(s.isSingle, true);
  assert.equal(s.label, "Run command");
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
  assert.equal(s.label, "Read file, Write file");
});

// ── resolveActiveToolName ──
// R83 合并消息语义：call 消息带 pending 标记 = 执行中；不带 = 已完成

function toolCallMsg(name: string, pending = false) {
  return {
    role: "assistant",
    ...(pending ? { pending: true } : {}),
    content: [{ type: "toolCall", name, arguments: {} }],
  };
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

test("active tool：pending call → 返回工具名", () => {
  assert.equal(resolveActiveToolName([toolCallMsg("read", true)]), "read");
});

test("active tool：合并消息无 pending（result 已并入）→ null（已完成）", () => {
  assert.equal(resolveActiveToolName([toolCallMsg("read", false)]), null);
});

test("active tool：孤儿 result 消息 → null（已完成）", () => {
  assert.equal(resolveActiveToolName([toolCallMsg("read", true), toolResultMsg("read")]), null);
});

test("active tool：完成的工具后再起新 pending call → 新工具名", () => {
  assert.equal(
    resolveActiveToolName([
      toolCallMsg("read", true),
      toolResultMsg("read"),
      textMsg("段间文本"),
      toolCallMsg("exec", true),
    ]),
    "exec",
  );
});

test("active tool：末尾是文本消息时跳过、由最近工具消息决定", () => {
  assert.equal(
    resolveActiveToolName([toolCallMsg("read", true), toolResultMsg("read"), textMsg("正在写")]),
    null,
  );
});

test("active tool：历史 toolResult block 消息也算完成", () => {
  const streamResult = {
    role: "toolResult",
    toolCallId: "tc1",
    content: [{ type: "text", text: "output" }],
  };
  assert.equal(resolveActiveToolName([toolCallMsg("read", true), streamResult]), null);
  assert.equal(
    resolveActiveToolName([toolCallMsg("read", true), streamResult, toolCallMsg("exec", true)]),
    "exec",
  );
});

// ── summarizeToolCards：hasError / status ──

test("tool summary：任一 result 带 error → hasError true + status failed", () => {
  const s = summarizeToolCards([
    card("call", "read"),
    { kind: "result", name: "read", text: "boom", error: "boom" } as ToolCard,
  ]);
  assert.equal(s.hasError, true);
  assert.equal(s.status, "failed");
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

test("tool summary：全部成功 → hasError false + status completed", () => {
  const s = summarizeToolCards([
    card("call", "read"),
    { kind: "result", name: "read", text: "ok" } as ToolCard,
  ]);
  assert.equal(s.hasError, false);
  assert.equal(s.status, "completed");
});

test("tool summary：进行中的 pending call 不算失败，status running", () => {
  const s = summarizeToolCards([{ kind: "call", name: "read", pending: true } as ToolCard]);
  assert.equal(s.hasError, false);
  assert.equal(s.status, "running");
});

test("tool summary（R83 合并卡）：call 块带 result 载荷 → completed", () => {
  const s = summarizeToolCards([
    { kind: "call", name: "exec", args: { command: "ls" }, text: "file list" } as ToolCard,
  ]);
  assert.equal(s.status, "completed");
  assert.equal(s.hasError, false);
  assert.equal(s.totalTools, 1);
});
