// 守护回归（源码审计，同 cc-chat-stream.test.ts 模式，R41 Task 11）：
// 抽取 <cc-chat-history> 组件隔离历史列表重渲染是结构性优化——回退（把
// repeat(chatItems) 塞回 renderChat 模板、或让回调/流式属性进视觉清单）会让
// 草稿敲击、连接态、流式帧等高频更新重新全量求值 ≤200 条历史这棵最重子树，必须钉住。
// 组件本体依赖 lit + customElements（node 下直接导入意义不大），故用源码断言。
// 注意：源文件在 Windows 上是 CRLF 换行，所有跨行正则用 \s/[\s\S] 而非裸 \n。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readSrc(rel: string): string {
  return readFileSync(new URL(`../../../../../src/ui/${rel}`, import.meta.url), "utf8");
}

const componentSrc = readSrc("components/cc-chat-history.ts");
const chatViewSrc = readSrc("views/chat.ts");

test("cc-chat-history：无 shadow DOM（createRenderRoot 返回 this，复用全局样式）", () => {
  assert.match(
    componentSrc,
    /createRenderRoot\(\)\s*\{\s*return this;/,
    "必须 createRenderRoot() { return this; }，否则全局 chat.css、.chat-thread 事件委托与滚动测量失效",
  );
});

test("cc-chat-history：注册为 cc-chat-history 自定义元素", () => {
  assert.match(
    componentSrc,
    /customElement\("cc-chat-history"\)|customElements\.define\("cc-chat-history"/,
    "组件必须以 cc-chat-history 标签名注册",
  );
});

test("cc-chat-history：静态属性声明 + shouldUpdate 只按视觉属性放行", () => {
  assert.match(componentSrc, /static properties\s*=/, "缺少静态属性声明（attribute: false 清单）");
  assert.match(componentSrc, /shouldUpdate\(/, "缺少 shouldUpdate 门控");
  const visualList = componentSrc.match(/VISUAL_PROPS\s*=\s*\[[\s\S]*?\]/)?.[0] ?? "";
  assert.ok(visualList, "缺少视觉属性清单（VISUAL_PROPS）");
  // 历史列表真正驱动重渲染的字段：消息数组/工具流/可见数/推理开关/身份/文件变更入口
  for (const name of [
    "messages",
    "toolMessages",
    "visibleHistoryCount",
    "showReasoning",
    "assistantName",
    "assistantAvatar",
    "gitAvailable",
  ]) {
    assert.ok(visualList.includes(`"${name}"`), `视觉属性清单缺 ${name}`);
  }
  // 回调每帧新闭包（buildChatProps），进视觉清单会导致每次外层渲染都重求值历史子树
  for (const name of ["onOpenSidebar", "onQuoteMessage", "onResendError"]) {
    assert.ok(
      !visualList.includes(name),
      `回调属性 ${name} 不得进视觉清单（每帧新闭包会让优化失效）`,
    );
  }
});

test("cc-chat-history：memo 调用点在组件内，复用 renderMessageGroup + repeat", () => {
  assert.match(
    componentSrc,
    /buildChatItemsMemoized\(/,
    "buildChatItemsMemoized 调用点应移入组件（历史只在真正变化时重建）",
  );
  assert.match(
    componentSrc,
    /computeSessionFileChangesMemoized\(/,
    "computeSessionFileChangesMemoized 调用点应随 chatItems 移入组件",
  );
  assert.match(componentSrc, /renderMessageGroup\(/, "分组渲染应复用 renderMessageGroup");
  assert.match(componentSrc, /repeat\(/, "历史列表应继续用 lit repeat（keyed 复用）");
});

test("views/chat：renderChat 不再直接调用历史 memo（调用点已迁入组件）", () => {
  assert.ok(
    !/\b(buildChatItemsMemoized|computeSessionFileChangesMemoized)\(/.test(chatViewSrc),
    "views/chat.ts 仍存在历史 memo 直接调用（应只保留再导出与装配）",
  );
  assert.ok(!/const chatItems\b/.test(chatViewSrc), "views/chat.ts 不应再持有 chatItems 局部量");
});

test("views/chat：renderChat 装配 <cc-chat-history> 且引入组件模块", () => {
  assert.match(chatViewSrc, /<cc-chat-history/, "renderChat 应装配 <cc-chat-history>");
  assert.match(
    chatViewSrc,
    /import "\.\.\/components\/cc-chat-history\.ts"/,
    "缺少组件注册副作用导入",
  );
});

test("views/chat：装配顺序——历史组件在流式组件之前（时间线先历史后流式）", () => {
  // 用装配特征（html`<标签）定位，避开注释中的标签字样；属性绑定也是装配独有特征备用验证
  const historyIdx = chatViewSrc.indexOf("html`<cc-chat-history");
  const streamIdx = chatViewSrc.indexOf("html`<cc-chat-stream");
  assert.ok(historyIdx >= 0, "缺少 <cc-chat-history> 装配");
  assert.ok(streamIdx >= 0, "缺少 <cc-chat-stream> 装配（Task 10 产物不得丢失）");
  assert.ok(historyIdx < streamIdx, "<cc-chat-history> 必须装配在 <cc-chat-stream> 之前");
  assert.match(chatViewSrc, /\.messages=\$\{props\.messages\}/, "历史组件缺少 messages 属性绑定");
});
