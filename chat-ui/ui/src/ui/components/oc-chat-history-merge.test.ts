import test from "node:test";
import assert from "node:assert/strict";

// 与 grouped-render.test.ts 相同的 node 环境打桩：customElements / 假 window
const g = globalThis as Record<string, unknown>;
g.customElements ??= {
  define() {},
  get() {
    return undefined;
  },
};
g.window ??= {
  document: { nodeType: 9, currentScript: null, createElement: () => ({}) },
  Element: class {},
};

const { buildChatItemsMemoized } = await import("./oc-chat-history.ts");

// ── R83：历史 toolResult 消息合并进 assistant toolCall 内容块 ──
// 一次工具调用在 transcript 里是两条消息（assistant toolCall block + toolResult），
// buildChatItems 应把它们合并成一条（call 块带 text/isError 等 result 载荷），
// 与流式路径（app-tool-stream）的合并形态保持一致。

function callMessage(id: string, name: string, args: Record<string, unknown>, timestamp = 1) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    timestamp,
  };
}

function resultMessage(
  toolCallId: string,
  text: string,
  extra: Record<string, unknown> = {},
  timestamp = 2,
) {
  return {
    role: "toolResult",
    toolCallId,
    content: [{ type: "text", text }],
    timestamp,
    ...extra,
  };
}

function runBuild(messages: unknown[]) {
  return buildChatItemsMemoized({
    messages,
    toolMessages: [],
    visibleHistoryCount: 0,
    // 强制 memo 失效：不同 messages 引用天然 miss；同引用时跳过
  });
}

test("历史合并：toolResult 按 toolCallId 并入对应 call 块", () => {
  const input = [
    callMessage("tc1", "read", { path: "a.ts" }),
    resultMessage("tc1", "file content…"),
  ];
  const items = runBuild(input);
  // toolResult 消息被吸收：只剩 1 条消息（1 个 group）
  assert.equal(items.length, 1);
  const group = items[0] as { kind: string; messages: Array<{ message: Record<string, unknown> }> };
  assert.equal(group.messages.length, 1);
  const block = (group.messages[0].message.content as Array<Record<string, unknown>>)[0];
  assert.equal(block.type, "toolCall");
  assert.equal(block.name, "read");
  assert.equal(block.text, "file content…");
  assert.equal(block.isError, undefined);
});

test("历史合并：失败 result 的 isError/toolErrorSummary/exitCode 一并并入", () => {
  const input = [
    callMessage("tc1", "exec", { command: "npm test" }),
    resultMessage("tc1", "raw failure output", {
      isError: true,
      toolErrorSummary: "exit 2",
      exitCode: 2,
    }),
  ];
  const items = runBuild(input);
  const group = items[0] as { messages: Array<{ message: Record<string, unknown> }> };
  const block = (group.messages[0].message.content as Array<Record<string, unknown>>)[0];
  assert.equal(block.text, "raw failure output");
  assert.equal(block.isError, true);
  assert.equal(block.toolErrorSummary, "exit 2");
  assert.equal(block.exitCode, 2);
});

test("历史合并：多条 call/result 交替按 id 各自配对", () => {
  const input = [
    callMessage("tc1", "read", { path: "a.ts" }, 1),
    callMessage("tc2", "read", { path: "b.ts" }, 2),
    resultMessage("tc2", "B content", {}, 3),
    resultMessage("tc1", "A content", {}, 4),
  ];
  const items = runBuild(input);
  const group = items[0] as { messages: Array<{ message: Record<string, unknown> }> };
  assert.equal(group.messages.length, 2);
  const block1 = (group.messages[0].message.content as Array<Record<string, unknown>>)[0];
  const block2 = (group.messages[1].message.content as Array<Record<string, unknown>>)[0];
  assert.equal(block1.text, "A content");
  assert.equal(block2.text, "B content");
});

test("历史合并：孤儿 result（无对应 call）保留独立消息", () => {
  const input = [resultMessage("tc-unknown", "orphan output")];
  const items = runBuild(input);
  const group = items[0] as { messages: Array<{ message: Record<string, unknown> }> };
  assert.equal(group.messages.length, 1);
  assert.equal(group.messages[0].message.role, "toolResult");
});

test("历史合并：不修改 gateway 缓存里的原消息对象", () => {
  const call = callMessage("tc1", "read", { path: "a.ts" });
  const result = resultMessage("tc1", "content");
  const callFrozen = JSON.stringify(call);
  runBuild([call, result]);
  assert.equal(JSON.stringify(call), callFrozen, "原 call 消息对象不应被改动");
});

test("历史合并：assistant 文本消息与 call 同在时不误伤文本", () => {
  const input = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "让我读一下文件" },
        { type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
      ],
      timestamp: 1,
    },
    resultMessage("tc1", "content"),
  ];
  const items = runBuild(input);
  const group = items[0] as { messages: Array<{ message: Record<string, unknown> }> };
  assert.equal(group.messages.length, 1);
  const content = group.messages[0].message.content as Array<Record<string, unknown>>;
  assert.equal(content[0].type, "text");
  assert.equal(content[0].text, "让我读一下文件");
  assert.equal(content[1].text, "content");
});
