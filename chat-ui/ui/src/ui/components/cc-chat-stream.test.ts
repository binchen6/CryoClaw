// 守护回归（源码审计，同 toggle-switch.test.ts / markdown.test.ts 模式，R41 Task 10）：
// 抽取 <cc-chat-stream> 组件隔离流式高频重渲染是结构性优化，回退（把 stream 键加回
// memo、或把流式条目塞回 buildChatItems）会让 ≤200 条历史每帧全量重建，必须钉住。
// 组件本体依赖 lit + customElements（node 下直接导入意义不大），故用源码断言。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readSrc(rel: string): string {
  return readFileSync(new URL(`../../../../../src/ui/${rel}`, import.meta.url), "utf8");
}

const componentSrc = readSrc("components/cc-chat-stream.ts");
const chatViewSrc = readSrc("views/chat.ts");

// 提取函数体（从声明行到第一个顶格 "}" 行），用于对函数内部做否定断言；
// 兼容 CRLF（源文件在 Windows 上可能是 \r\n 换行）
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `未找到 ${signature}`);
  const endMatch = /\n\}\r?\n/.exec(src.slice(start));
  assert.ok(endMatch, `${signature} 函数体未闭合`);
  return src.slice(start, start + endMatch.index);
}

test("cc-chat-stream：无 shadow DOM（createRenderRoot 返回 this，复用全局样式）", () => {
  assert.match(
    componentSrc,
    /createRenderRoot\(\)\s*\{\s*return this;/,
    "必须 createRenderRoot() { return this; }，否则全局 chat.css 与既有事件委托失效",
  );
});

test("cc-chat-stream：注册为 cc-chat-stream 自定义元素", () => {
  assert.match(
    componentSrc,
    /customElement\("cc-chat-stream"\)|customElements\.define\("cc-chat-stream"/,
    "组件必须以 cc-chat-stream 标签名注册",
  );
});

test("cc-chat-stream：shouldUpdate 只按视觉属性放行，回调新闭包不触发重渲染", () => {
  assert.match(componentSrc, /shouldUpdate\(/, "缺少 shouldUpdate 门控");
  const visualList = componentSrc.match(/VISUAL_PROPS\s*=\s*\[[\s\S]*?\]/)?.[0] ?? "";
  assert.ok(visualList, "缺少视觉属性清单（VISUAL_PROPS）");
  for (const name of ["stream", "streamStartedAt", "assistantName", "assistantAvatar"]) {
    assert.ok(visualList.includes(`"${name}"`), `视觉属性清单缺 ${name}`);
  }
  assert.ok(
    !visualList.includes("onOpenSidebar"),
    "回调属性不得进视觉清单（每帧新闭包会导致每帧重渲染，优化失效）",
  );
});

test("cc-chat-stream：复用 grouped-render 的流式气泡与思考指示渲染", () => {
  assert.match(componentSrc, /renderStreamingGroup\(/, "流式气泡应复用 renderStreamingGroup");
  assert.match(
    componentSrc,
    /renderReadingIndicatorGroup\(/,
    "空白流（等待首帧/工具间隙）应复用 renderReadingIndicatorGroup",
  );
});

test("views/chat：renderChat 线程装配 <cc-chat-stream> 且引入组件模块", () => {
  assert.match(chatViewSrc, /<cc-chat-stream/, "renderChat 应装配 <cc-chat-stream>");
  assert.match(
    chatViewSrc,
    /import "\.\.\/components\/cc-chat-stream\.ts"/,
    "缺少组件注册副作用导入",
  );
});

test("views/chat：memo 类型与比较/记录逻辑不再含 stream / streamStartedAt", () => {
  const memoType = chatViewSrc.match(/type ChatItemsMemo = \{[\s\S]*?\};/)?.[0] ?? "";
  assert.ok(memoType, "未找到 ChatItemsMemo 类型");
  assert.ok(!/stream/i.test(memoType.replace("visibleHistoryCount", "")), "ChatItemsMemo 仍含流式键");
  const memoized = functionBody(chatViewSrc, "export function buildChatItemsMemoized(");
  assert.ok(!memoized.includes("props.stream"), "memo 比较/记录仍读 props.stream");
  assert.ok(!memoized.includes("streamStartedAt"), "memo 比较/记录仍读 streamStartedAt");
});

test("views/chat：buildChatItems 不再消费 stream / streamStartedAt（历史侧与流式解耦）", () => {
  const body = functionBody(chatViewSrc, "function buildChatItems(");
  assert.ok(!body.includes("props.stream"), "buildChatItems 仍读 props.stream");
  assert.ok(!body.includes("streamStartedAt"), "buildChatItems 仍读 streamStartedAt");
  assert.ok(!body.includes('"stream"'), "buildChatItems 仍构造 stream 条目");
});
