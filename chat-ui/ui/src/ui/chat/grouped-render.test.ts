import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { html } from "lit";

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
    // DirectiveResult（unsafeHTML 等）：plain object + _$litDirective$ 类。
    // unsafeSVG 只用于 icons.ts 的静态自绘图标（CryoIcons，无用户输入，无 XSS 面），不计入统计。
    if ("_$litDirective$" in value) {
      const directiveClass = (value as { _$litDirective$?: { directiveName?: string } })._$litDirective$;
      if (directiveClass?.directiveName !== "unsafeSVG") {
        acc.directiveCount++;
      }
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

// ── R5 任务 1 → R41 任务 9：streaming 安全前缀渐进 markdown 渲染 ──

test("streaming：稳定段经 unsafeHTML 渐进渲染，不再整段纯文本绑定", () => {
  const text = "# 标题\n\n**加粗** 第二行";
  const result = collect(renderStreamingGroup(text, Date.now()));

  // 稳定段（空行之前）完整解析 → 必出现 unsafeHTML 指令（解析频率 = 边界推进频率）
  assert.ok(result.directiveCount > 0, "streaming 路径应经 unsafeHTML 渲染稳定段 markdown");
  // 累计文本不再作为整段纯文本直接绑定（未闭合尾部经 escapeHtml 进 unsafeHTML）
  assert.ok(!result.values.includes(text), "streaming 不应把整段累计文本作为纯文本绑定");
  // chat-text--streaming 类保留（样式兼容：闪烁光标/块级修正都挂在该类上）
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

// ── R90 实时思考区折叠单行 tail 提取 ──
test("thinkingTail：短文本原样返回", async () => {
  const { thinkingTail } = await import("./grouped-render.ts");
  assert.equal(thinkingTail("短的思考"), "短的思考");
  assert.equal(thinkingTail(""), "");
});

test("thinkingTail：超长文本取末尾 160 字符且不切断代理对", async () => {
  const { thinkingTail } = await import("./grouped-render.ts");
  const bmp = "a".repeat(300);
  const tail = thinkingTail(bmp);
  assert.equal(tail.length, 160);
  assert.ok(bmp.endsWith(tail));
  // 切点落在高代理上（偶偏移）：160 units 恰好是完整 emoji 对，首字符为合法高代理
  const aligned = "x".repeat(300) + "👍".repeat(100);
  const tail2 = thinkingTail(aligned);
  assert.equal(tail2.length, 160);
  assert.ok(aligned.endsWith(tail2));
  const first2 = tail2.codePointAt(0)!;
  assert.ok(!(first2 >= 0xdc00 && first2 <= 0xdfff), "首字符不得是孤立低代理");
  // 切点落在低代理上（emoji 对内部）：丢弃该残缺字符 → 长度 159、仍是原文后缀、首字符合法
  // （160 偶数窗口在完整对序列上恒切偶偏移，末尾补 1 个 BMP 字符使切点推进对内部）
  const odd = "x".repeat(300) + "👍".repeat(100) + "ⓐ";
  const tail3 = thinkingTail(odd);
  assert.equal(tail3.length, 159);
  assert.ok(odd.endsWith(tail3));
  const first3 = tail3.codePointAt(0)!;
  assert.ok(!(first3 >= 0xdc00 && first3 <= 0xdfff), "修正后首字符仍不得是孤立低代理");
});

test("thinkingTail：结尾悬空的高代理丢弃（残缺 emoji 不渲染出 U+FFFD）", async () => {
  const { thinkingTail } = await import("./grouped-render.ts");
  // 全长 301：截窗（-160）以孤立高代理 \uD83D 收尾（其后低代理被截掉）
  const dangling = "x".repeat(300) + "\uD83D";
  const tail = thinkingTail(dangling);
  assert.equal(tail, "x".repeat(159), "结尾悬空高代理应被丢弃，只留完整字符");
  const last = tail.charCodeAt(tail.length - 1);
  assert.ok(
    !(last >= 0xd800 && last <= 0xdbff),
    "尾字符不得是悬空高代理（渲染会变成 U+FFFD）",
  );
  // 完整 emoji 收尾不受影响（尾部是完整代理对：高代理+低代理俱在，不得误丢）
  const intact = "x".repeat(299) + "👍";
  const tail2 = thinkingTail(intact);
  assert.equal(tail2, intact.slice(-160));
  assert.ok(tail2.endsWith("👍"), "完整 emoji 应完整保留");
  const last2 = tail2.charCodeAt(tail2.length - 1);
  assert.ok(
    last2 >= 0xdc00 && last2 <= 0xdfff && tail2.charCodeAt(tail2.length - 2) >= 0xd800,
    "完整对的尾字符是低代理且前有高代理（合法）",
  );
});

// ── R5 懒渲染 + 流式重放：折叠时不求值 bodyFn，展开后随宿主重放 ──

test("懒渲染：折叠状态下 ref/toggle 重放均不求值 bodyFn", async () => {
  const { replayLazyDetailsBody } = await import("./grouped-render.ts");
  let calls = 0;
  const bodyFn = () => {
    calls++;
    return html``;
  };
  // 折叠：不查 body、不求值（querySelector 直接抛桩，被调用即失败）
  const closed = { open: false, querySelector: () => assert.fail("折叠时不应查询 body") };
  replayLazyDetailsBody(closed as never, ":scope > .x", "sig-1", bodyFn);
  assert.equal(calls, 0);
});

test("懒渲染：body 缺失或签名未变化时跳过重放（避免每帧重复解析）", async () => {
  const { replayLazyDetailsBody } = await import("./grouped-render.ts");
  let calls = 0;
  const bodyFn = () => {
    calls++;
    return html``;
  };
  const openNoBody = { open: true, querySelector: () => null };
  replayLazyDetailsBody(openNoBody as never, ":scope > .x", "sig-1", bodyFn);
  assert.equal(calls, 0, "body 占位节点缺失时不应求值 bodyFn");
  // 签名相同（内容未变）：跳过，bodyFn 不求值、不触发 lit render（node 无 DOM 会抛）
  const sameSigBody = { dataset: { lazySig: "sig-1" } };
  const openSameSig = { open: true, querySelector: () => sameSigBody };
  replayLazyDetailsBody(openSameSig as never, ":scope > .x", "sig-1", bodyFn);
  assert.equal(calls, 0, "签名未变化时不应重放");
});

test("懒渲染：展开且签名变化时重放 bodyFn（lit render 在 node 无 DOM，求值后即抛）", async () => {
  const { replayLazyDetailsBody } = await import("./grouped-render.ts");
  let calls = 0;
  const bodyFn = () => {
    calls++;
    return html``;
  };
  const body = { dataset: {} as Record<string, string> };
  const open = { open: true, querySelector: () => body };
  assert.throws(
    () => replayLazyDetailsBody(open as never, ":scope > .x", "sig-2", bodyFn),
    () => true,
    "lit render 需要 DOM，node 下应抛出",
  );
  assert.equal(calls, 1, "签名变化时 bodyFn 应被重放求值");
  assert.equal(body.dataset.lazySig, "sig-2", "重放后应记录签名");
});

// ── 渲染接线审计：懒 details 展开后须 commit 级重放（防回退到一次性水合）──

test("渲染接线审计：折叠 details 挂 ref 重放 + toggle 水合，无一次性 lazyHydrated 门", () => {
  const fromSource = new URL("./grouped-render.ts", import.meta.url);
  const fromDist = new URL("../../../../../src/ui/chat/grouped-render.ts", import.meta.url);
  const srcUrl = existsSync(fromSource) ? fromSource : fromDist;
  const src = readFileSync(srcUrl, "utf8");
  assert.ok(!src.includes("lazyHydrated"), "一次性水合门 lazyHydrated 应已移除");
  assert.ok(
    src.includes("lazyDetailsBodyRef("),
    "折叠 details 应挂 ref 回调实现 commit 级重放",
  );
  assert.ok(
    src.includes("replayLazyDetailsBody("),
    "toggle 展开路径应复用 replayLazyDetailsBody 立即水合",
  );
  const detailsIdx = src.indexOf('class="chat-tools-collapse"');
  assert.ok(detailsIdx >= 0, "工具折叠 details 应存在");
  const detailsTag = src.slice(detailsIdx, detailsIdx + 700);
  assert.ok(
    detailsTag.includes("lazyDetailsBodyRef(") && detailsTag.includes("@toggle"),
    "chat-tools-collapse 应同时挂 ref 重放与 toggle 水合",
  );
});
