import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

// views/chat.ts 的线程级交互（keydown 拦截 / aria-live / 路径链接键盘委托）
// 依赖真实 DOM 事件流，node 环境做源码审计钉住接线，防止回退。

function readSource(): string {
  const fromSource = new URL("./chat.ts", import.meta.url);
  const fromDist = new URL("../../../../../src/ui/views/chat.ts", import.meta.url);
  const srcUrl = existsSync(fromSource) ? fromSource : fromDist;
  return readFileSync(srcUrl, "utf8");
}

test("渲染接线审计：命令建议键盘拦截前重校验 draft（过期建议不劫持 Enter）", () => {
  const src = readSource();
  // 以 @input 的 refreshCommandSuggestions 为锚，其前方的 keydown 即 compose 输入框拦截
  const inputIdx = src.indexOf("refreshCommandSuggestions(props, target.value)");
  assert.ok(inputIdx >= 0, "compose 输入框应保留 @input 建议刷新");
  const keydownIdx = src.lastIndexOf("@keydown=${(e: KeyboardEvent) => {", inputIdx);
  assert.ok(keydownIdx >= 0 && keydownIdx < inputIdx, "compose 输入框应保留 keydown 拦截");
  // 定位命令建议拦截分支（commandSuggestions.length > 0）
  const suggestIdx = src.indexOf("if (commandSuggestions.length > 0)", keydownIdx);
  assert.ok(suggestIdx >= 0, "keydown 内应保留命令建议拦截分支");
  const between = src.slice(keydownIdx, suggestIdx);
  assert.ok(
    between.includes("!/^\\/(\\S*)$/.test(props.draft"),
    "拦截分支须以 /^\\/(\\S*)$/ 重校验 draft 为前提（程序化改 draft 后建议须作废）",
  );
  // renderCommandSuggestions 的同款防御须保留（两处缺一不可）
  assert.ok(
    src.includes('if (!/^\\/(\\S*)$/.test(props.draft ?? ""))'),
    "renderCommandSuggestions 的 draft 形状防御须保留",
  );
});

test("渲染接线审计：流式组件 aria-live off（逐 token 不进 log live 区域）", () => {
  const src = readSource();
  const streamIdx = src.indexOf("html`<oc-chat-stream");
  assert.ok(streamIdx >= 0, "应装配 oc-chat-stream（html 模板起始标签）");
  const openTag = src.slice(streamIdx, streamIdx + 200);
  assert.ok(
    openTag.includes('aria-live="off"'),
    "oc-chat-stream 须显式 aria-live=\"off\"，流式子树移出 .chat-thread 的 polite log 区域",
  );
  // 线程保持 log live 区域：终态消息仍经历史区播报
  const threadIdx = src.indexOf('class="chat-thread');
  assert.ok(threadIdx >= 0, "应保留 chat-thread 容器");
  const threadTag = src.slice(threadIdx, threadIdx + 400);
  assert.ok(
    threadTag.includes('role="log"') && threadTag.includes('aria-live="polite"'),
    "chat-thread 终态消息 live 区域（role=log polite）须保留",
  );
});

test("渲染接线审计：路径链接键盘委托（Enter/Space 与点击同路径打开）", () => {
  const src = readSource();
  const threadIdx = src.indexOf('class="chat-thread');
  assert.ok(threadIdx >= 0);
  const threadTag = src.slice(threadIdx, threadIdx + 2200);
  assert.ok(
    threadTag.includes("@keydown="),
    "chat-thread 应挂 keydown 委托（无 href 的 <a tabindex=\"0\"> 不响应 Enter/Space）",
  );
  assert.ok(
    threadTag.includes('closest(".chat-path-link")'),
    "keydown 委托应识别 .chat-path-link",
  );
  assert.ok(
    threadTag.includes("openChatPathLink("),
    "键盘与点击委托应共用 openChatPathLink（同一路径打开语义）",
  );
  // 点击委托同样走共用函数
  const clickIdx = threadTag.indexOf("@click=");
  assert.ok(clickIdx >= 0, "chat-thread 应保留 click 委托");
  assert.ok(
    threadTag.slice(clickIdx).includes("openChatPathLink("),
    "click 委托应复用 openChatPathLink",
  );
});

test("i18n 审计：zh 界面英文硬编码已清（复制按钮/工具计数/JSON 摘要/截断/推理头/token 单位）", () => {
  const chatSrc = readSource();
  assert.ok(!chatSrc.includes("Copy as markdown"), "views 不应残留 Copy as markdown 硬编码");

  const read = (rel: string) => {
    const fromSource = new URL(rel, import.meta.url);
    const fromDist = new URL(`../../../../../src/ui/${rel}`, import.meta.url);
    return readFileSync(existsSync(fromSource) ? fromSource : fromDist, "utf8");
  };
  const copySrc = read("chat/copy-as-markdown.ts");
  assert.ok(
    !copySrc.includes('"Copy as markdown"') &&
      !copySrc.includes('"Copied"') &&
      !copySrc.includes('"Copy failed"'),
    "copy-as-markdown 三态文案应走 t()",
  );
  const groupedSrc = read("chat/grouped-render.ts");
  assert.ok(
    !groupedSrc.includes("${totalTools} tool") &&
      !groupedSrc.includes("Array (") &&
      !groupedSrc.includes("Object ("),
    "工具计数/JSON 摘要应走 t()",
  );
  const markdownSrc = read("markdown.ts");
  assert.ok(
    !markdownSrc.includes("truncated ("),
    "markdown 截断提示应走 t()",
  );
  const extractSrc = read("chat/message-extract.ts");
  assert.ok(
    !extractSrc.includes("_Reasoning:_"),
    "推理头标注应走 t()",
  );
  const metaSrc = read("chat/message-meta.ts");
  assert.ok(
    !metaSrc.includes("`${formatTokens(usage.totalTokens)} tokens`"),
    "usage token 单位应走 t()",
  );
});
