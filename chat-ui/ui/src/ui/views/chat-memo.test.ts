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

test("memo：stream 文本变化（每帧 delta）触发重算", () => {
  const base = makeProps({ stream: "partial", streamStartedAt: 100 });
  const first = buildChatItemsMemoized(base);
  const second = buildChatItemsMemoized(
    makeProps({ stream: "partial more", streamStartedAt: 100 }),
  );
  assert.notEqual(second, first);
  const third = buildChatItemsMemoized(makeProps({ stream: "partial more", streamStartedAt: 100 }));
  assert.equal(third, second, "stream 文本不变时应复用");
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
