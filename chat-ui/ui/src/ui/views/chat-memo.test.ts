import test from "node:test";
import assert from "node:assert/strict";

// views/chat.ts 经 components（managed-image / resizable-divider）注册自定义元素，
// node 环境无 customElements，动态导入前打桩（lit 本体在 node 可正常加载）。
const g = globalThis as Record<string, unknown>;
g.customElements ??= {
  define() {},
  get() {
    return undefined;
  },
};

const { buildChatItemsMemoized, computeSessionFileChangesMemoized } = await import("./chat.ts");
const { getLocale, setLocale } = await import("../i18n.ts");

// 共享空数组：memo 按数组引用比较，默认 props 必须复用同一引用
const SHARED_MESSAGES: unknown[] = [];
const SHARED_TOOLS: unknown[] = [];

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    sessionKey: "agent:main:s1",
    messages: SHARED_MESSAGES,
    visibleHistoryCount: 0,
    toolMessages: SHARED_TOOLS,
    stream: null as string | null,
    streamStartedAt: null as number | null,
    ...overrides,
  } as never;
}

// ── R5 任务 3：buildChatItems / computeSessionFileChanges memo ──

test("memo：messages/toolMessages 引用不变时复用上轮结果", () => {
  const props = makeProps({
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
  });
  const first = buildChatItemsMemoized(props);
  // 模拟 Lit 一次无关更新（draft 敲击）：props 是新对象，但数组引用不变
  const second = buildChatItemsMemoized({ ...(props as object) } as never);
  assert.equal(second, first, "数组引用不变应返回同一结果引用");
});

test("memo：messages 数组重赋值后重新计算", () => {
  const props = makeProps({ messages: [{ role: "user", content: "a", timestamp: 1 }] });
  const first = buildChatItemsMemoized(props);
  const next = makeProps({
    messages: [
      { role: "user", content: "a", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "b" }], timestamp: 2 },
    ],
  });
  const second = buildChatItemsMemoized(next);
  assert.notEqual(second, first, "messages 引用变化应重新计算");
});

test("memo：stream 文本每帧变化不再 invalidate 历史 memo（R41 Task 10）", () => {
  // 新契约：流式气泡由 <cc-chat-stream> 独立渲染，stream/streamStartedAt 不再是比较键：
  // 每帧 delta 不应触发 ≤200 条历史的全量重建（旧行为是每帧重算，R41 前钉的就是它）
  const messages = [{ role: "user", content: "hello", timestamp: 1 }];
  const first = buildChatItemsMemoized(
    makeProps({ messages, stream: "partial", streamStartedAt: 100 }),
  );
  const second = buildChatItemsMemoized(
    makeProps({ messages, stream: "partial more", streamStartedAt: 100 }),
  );
  assert.equal(second, first, "stream delta 每帧变化时历史结果应复用同一引用");
  const third = buildChatItemsMemoized(makeProps({ messages, stream: null, streamStartedAt: null }));
  assert.equal(third, first, "stream 终止（置 null）也不应 invalidate 历史 memo");
});

test("buildChatItems：流式条目/思考指示/子代理卡移出（R41 Task 10，改由独立渲染装配）", () => {
  const items = buildChatItemsMemoized(
    makeProps({
      messages: [{ role: "user", content: "a", timestamp: 1 }],
      stream: "typing...",
      streamStartedAt: 100,
      runActive: true,
    }),
  );
  for (const item of items) {
    assert.notEqual(item.kind, "stream", "stream 条目不应再进 chatItems");
    assert.notEqual(item.kind, "reading-indicator", "思考指示不应再进 chatItems");
    assert.notEqual(item.kind, "subagent-cards", "子代理卡不应再进 chatItems");
  }
});

test("memo：locale 切换后缓存失效", () => {
  const original = getLocale();
  const other = original === "zh" ? "en" : "zh";
  try {
    const props = makeProps({ messages: [] });
    const first = buildChatItemsMemoized(props);
    setLocale(other);
    const second = buildChatItemsMemoized(props);
    assert.notEqual(second, first, "locale 变化应重新计算（t() 文案依赖 locale）");
  } finally {
    setLocale(original);
  }
});

test("memo：fileChanges 按 chatItems 引用复用", () => {
  const props = makeProps({
    messages: [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "write", arguments: { path: "a.ts" } }],
        timestamp: 1,
      },
    ],
  });
  const chatItems = buildChatItemsMemoized(props);
  const first = computeSessionFileChangesMemoized(chatItems);
  assert.ok(first.size > 0, "应派生出文件改动");
  const second = computeSessionFileChangesMemoized(chatItems);
  assert.equal(second, first, "chatItems 引用不变应复用同一 Map");
  const third = computeSessionFileChangesMemoized([...chatItems]);
  assert.notEqual(third, first, "chatItems 引用变化应重新计算");
});
