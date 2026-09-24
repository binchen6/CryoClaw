// 守护回归（源码审计，同 toggle-switch.test.ts / markdown.test.ts 模式，R41 Task 10）：
// 抽取 <oc-chat-stream> 组件隔离流式高频重渲染是结构性优化，回退（把 stream 键加回
// memo、或把流式条目塞回 buildChatItems）会让 ≤200 条历史每帧全量重建，必须钉住。
// 组件本体依赖 lit + customElements（node 下直接导入意义不大），故用源码断言。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readSrc(rel: string): string {
  return readFileSync(new URL(`../../../../../src/ui/${rel}`, import.meta.url), "utf8");
}

const componentSrc = readSrc("components/oc-chat-stream.ts");
const chatViewSrc = readSrc("views/chat.ts");
// R41 Task 11：历史构建与 memo 已整体迁入 <oc-chat-history>，历史侧断言改钉组件文件（不弱化）
const historySrc = readSrc("components/oc-chat-history.ts");

// 提取函数体（从声明行到第一个顶格 "}" 行），用于对函数内部做否定断言；
// 兼容 CRLF（源文件在 Windows 上可能是 \r\n 换行）
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `未找到 ${signature}`);
  const endMatch = /\n\}\r?\n/.exec(src.slice(start));
  assert.ok(endMatch, `${signature} 函数体未闭合`);
  return src.slice(start, start + endMatch.index);
}

test("oc-chat-stream：无 shadow DOM（createRenderRoot 返回 this，复用全局样式）", () => {
  assert.match(
    componentSrc,
    /createRenderRoot\(\)\s*\{\s*return this;/,
    "必须 createRenderRoot() { return this; }，否则全局 chat.css 与既有事件委托失效",
  );
});

test("oc-chat-stream：注册为 oc-chat-stream 自定义元素", () => {
  assert.match(
    componentSrc,
    /customElement\("oc-chat-stream"\)|customElements\.define\("oc-chat-stream"/,
    "组件必须以 oc-chat-stream 标签名注册",
  );
});

test("oc-chat-stream：shouldUpdate 只按视觉属性放行，回调新闭包不触发重渲染", () => {
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

test("oc-chat-stream：复用 grouped-render 的流式气泡与思考指示渲染", () => {
  assert.match(componentSrc, /renderStreamingGroup\(/, "流式气泡应复用 renderStreamingGroup");
  assert.match(
    componentSrc,
    /renderReadingIndicatorGroup\(/,
    "空白流（等待首帧/工具间隙）应复用 renderReadingIndicatorGroup",
  );
});

test("views/chat：renderChat 线程装配 <oc-chat-stream> 且引入组件模块", () => {
  assert.match(chatViewSrc, /<oc-chat-stream/, "renderChat 应装配 <oc-chat-stream>");
  assert.match(
    chatViewSrc,
    /import "\.\.\/components\/oc-chat-stream\.ts"/,
    "缺少组件注册副作用导入",
  );
});

test("oc-chat-history：memo 类型与比较/记录逻辑不含 stream / streamStartedAt（R41 Task 11 后迁至组件文件）", () => {
  const memoType = historySrc.match(/type ChatItemsMemo = \{[\s\S]*?\};/)?.[0] ?? "";
  assert.ok(memoType, "未找到 ChatItemsMemo 类型");
  assert.ok(!/stream/i.test(memoType.replace("visibleHistoryCount", "")), "ChatItemsMemo 仍含流式键");
  const memoized = functionBody(historySrc, "export function buildChatItemsMemoized(");
  assert.ok(!memoized.includes("props.stream"), "memo 比较/记录仍读 props.stream");
  assert.ok(!memoized.includes("streamStartedAt"), "memo 比较/记录仍读 streamStartedAt");
});

test("oc-chat-history：buildChatItems 不再消费 stream / streamStartedAt（历史侧与流式解耦）", () => {
  const body = functionBody(historySrc, "function buildChatItems(");
  assert.ok(!body.includes("props.stream"), "buildChatItems 仍读 props.stream");
  assert.ok(!body.includes("streamStartedAt"), "buildChatItems 仍读 streamStartedAt");
  assert.ok(!body.includes('"stream"'), "buildChatItems 仍构造 stream 条目");
});

// ── R90 修复：思考区钉底须经阈值判定（updated() 操作真实 DOM，node 下源码审计）──

test("oc-chat-stream：思考区钉底须经贴近底部阈值判定（用户上滚不拽回）", () => {
  const updatedBody = functionBody(componentSrc, "protected updated(");
  assert.ok(
    updatedBody.includes("PIN_BOTTOM_THRESHOLD_PX"),
    "钉底前应做贴近底部阈值判定（24px），而非无条件拉回",
  );
  assert.ok(
    /scrollHeight\s*-\s*.*scrollTop/.test(updatedBody),
    "阈值判定应基于 scrollHeight - scrollTop - clientHeight 的剩余距离",
  );
  const pinIdx = updatedBody.indexOf("body.scrollTop = body.scrollHeight");
  const gateIdx = updatedBody.indexOf("PIN_BOTTOM_THRESHOLD_PX");
  assert.ok(pinIdx > gateIdx, "scrollTop 钉底赋值必须位于阈值判定之后");
  assert.ok(
    /PIN_BOTTOM_THRESHOLD_PX\s*=\s*24\b/.test(componentSrc),
    "钉底阈值应为 24px（与聊天线程贴底语义对齐的余量）",
  );
});
