import test from "node:test";
import assert from "node:assert/strict";

// grouped-render.ts 经 components/managed-image.ts 注册自定义元素，
// node 环境无 customElements，动态导入前打桩（lit 本体在 node 可正常加载）。
// 另：history 路径会调 DOMPurify，无 DOM 时给假 window 使其走透传实现。
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

const { renderStreamingGroup, renderMessageGroup } = await import("./grouped-render.ts");

// ── TemplateResult 递归遍历工具（无 DOM，直接检查 lit 模板结构）──

type Collected = {
  strings: string[];
  values: unknown[];
  directiveCount: number;
};

function collectTemplates(value: unknown, acc: Collected): void {
  if (value === null || value === undefined || typeof value === "boolean") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTemplates(item, acc);
    }
    return;
  }
  if (typeof value === "object") {
    // DirectiveResult（unsafeHTML 等）：plain object + _$litDirective$ 类
    if ("_$litDirective$" in value) {
      acc.directiveCount++;
      const values = (value as { values?: unknown[] }).values;
      if (Array.isArray(values)) {
        collectTemplates(values, acc);
      }
      return;
    }
    // TemplateResult：strings + values
    const maybe = value as { strings?: TemplateStringsArray | string[]; values?: unknown[] };
    if (Array.isArray(maybe.strings) && Array.isArray(maybe.values)) {
      acc.strings.push(...(maybe.strings as unknown as string[]));
      collectTemplates(maybe.values, acc);
    }
    return;
  }
  acc.values.push(value);
}

function collect(value: unknown): Collected {
  const acc: Collected = { strings: [], values: [], directiveCount: 0 };
  collectTemplates(value, acc);
  return acc;
}

function serialize(collected: Collected): string {
  return JSON.stringify([collected.strings, collected.values]);
}

// ── R5 任务 1：streaming 纯文本渲染 ──

test("streaming：渲染为纯文本，不走 unsafeHTML 整棵替换", () => {
  const text = "# 标题\n\n**加粗** 第二行\n- item";
  const result = collect(renderStreamingGroup(text, Date.now()));

  // 原始文本作为 lit 文本绑定原样出现（lit 自动转义，无 XSS 面）
  assert.ok(result.values.includes(text), "streaming 应把累计文本作为纯文本绑定");
  // 无 unsafeHTML 指令：markdown 解析推迟到 final 后
  assert.equal(result.directiveCount, 0, "streaming 路径不应出现 unsafeHTML 指令");
  // pre-wrap 类保留换行
  assert.ok(
    result.strings.some((s) => s.includes("chat-text--streaming")),
    "streaming 文本节点应带 chat-text--streaming 类",
  );
  // streaming 状态行仍在
  assert.ok(
    result.strings.some((s) => s.includes("chat-streaming-status")),
    "streaming 状态行应保留",
  );
});

test("history（非 streaming）：assistant 消息仍走 markdown 解析路径", () => {
  const group = {
    kind: "group" as const,
    key: "group:assistant:1",
    role: "assistant",
    messages: [
      {
        key: "msg:1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "**加粗文本**" }],
          timestamp: 1,
        },
      },
    ],
    timestamp: 1,
    isStreaming: false,
  };
  const result = collect(renderMessageGroup(group, { showReasoning: false }));

  assert.ok(result.directiveCount > 0, "history 路径应经 unsafeHTML 渲染 markdown");
  assert.ok(
    !result.values.includes("**加粗文本**"),
    "history 路径不应把 markdown 原文作为纯文本绑定",
  );
  assert.ok(
    !result.strings.some((s) => s.includes("chat-text--streaming")),
    "history 路径不应带 streaming 纯文本类",
  );
});

// ── R5 任务 4：折叠 tool output 懒渲染 ──

test("折叠 tool 消息：初始模板不含 body 内容（懒渲染，展开才求值）", () => {
  const marker = "BIGOUTPUT_MARKER_9f27c1";
  // 无文本、纯 tool result 消息 → renderCollapsedToolCards 直接折叠展示
  const group = {
    kind: "group" as const,
    key: "group:tool:1",
    role: "assistant",
    messages: [
      {
        key: "tool:tc1",
        message: {
          role: "tool",
          toolCallId: "tc1",
          content: [{ type: "toolResult", name: "exec", text: marker }],
          timestamp: 1,
        },
      },
    ],
    timestamp: 1,
    isStreaming: false,
  };
  const result = collect(renderMessageGroup(group, { showReasoning: false }));

  assert.ok(
    !serialize(result).includes(marker),
    "折叠状态下 body 内容（tool output）不应出现在模板里",
  );
  // 折叠容器与 body 占位节点仍在
  assert.ok(
    result.strings.some((s) => s.includes("chat-tools-collapse")),
    "折叠 details 容器应渲染",
  );
  assert.ok(
    result.strings.some((s) => s.includes("chat-tools-collapse__body")),
    "body 占位容器应保留",
  );
});

test("折叠 tool 消息（带文本）：body 内的 markdown 文本同样延迟求值", () => {
  // 折叠 summary 会显示输出前 120 字符预览（既有设计），marker 放在预览窗口之外
  const marker = "TOOLOUT_TEXT_MARKER_3b8d44";
  const outputText = `${"padding ".repeat(30)}${marker}`;
  const group = {
    kind: "group" as const,
    key: "group:tool:2",
    role: "assistant",
    messages: [
      {
        key: "tool:tc2",
        message: {
          role: "tool",
          toolCallId: "tc2",
          content: [{ type: "text", text: outputText }],
          timestamp: 1,
        },
      },
    ],
    timestamp: 1,
    isStreaming: false,
  };
  const result = collect(renderMessageGroup(group, { showReasoning: false }));

  assert.ok(
    !serialize(result).includes(marker),
    "tool-msg-collapse 折叠时正文 markdown 不应提前解析进模板",
  );
  assert.ok(
    result.strings.some((s) => s.includes("chat-tool-msg-body")),
    "tool 消息 body 占位容器应保留",
  );
});
