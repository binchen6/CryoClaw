// 守护回归（源码审计，同 app-gateway-events.test.ts 模式）：
// Gateway 连接状态三态 UI（starting / reconnecting / failed）+ 启动进度 +
// 断开乐观入队的渲染层接线钉点。
// 这些模块依赖 Lit/DOM，node 下不可导入，只能钉源码语义。
//
// 钉住的不变量：
// - app-gateway.ts onClose 用 mapCloseCodeToPhase(code) 推导 phase（1012/1013 →
//   starting，其余 → reconnecting）并 armSustainedFailure——持续失败超时后才升
//   failed；裸 `disconnected (code)` 只写 lastError 详情，不经 errors 列表渲染
// - app.ts connectedCallback 绑定 bindGatewayProgress、disconnectedCallback 对称清理
// - views/chat.ts：断开时不渲染裸 props.error 红色横幅（connected-error 走通用
//   文案 + title 详情）；textarea/send 按钮不再被 !props.connected 硬禁用
// - app-render.ts：oc-rail 的 errors 不再注入 state.lastError 裸串
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 编译产物位于 chat-ui/ui/.test-dist/ui/src/ui/，源文件位于 chat-ui/ui/src/ui/
function src(rel: string): string {
  return readFileSync(new URL(`../../../../src/ui/${rel}`, import.meta.url), "utf8");
}

test("app-gateway.ts：onClose 经 mapCloseCodeToPhase 推导三态并启动持续失败计时", () => {
  const s = src("app-gateway.ts");
  const onClose = s.slice(s.indexOf("onClose: ({ code, reason })"));
  assert.notEqual(onClose.length, 0, "app-gateway.ts 缺少 onClose 分支");
  assert.match(
    onClose,
    /mapCloseCodeToPhase\(code\)/,
    "onClose 应经 mapCloseCodeToPhase 推导 phase（1012/1013 → starting）",
  );
  assert.match(
    onClose,
    /armSustainedFailure\(host\)/,
    "onClose 应启动持续失败计时（超时未重连成功才升 failed）",
  );
  // 1012 不落 lastError（服务重启是预期信号）
  assert.match(
    onClose,
    /if \(code !== 1012\)/,
    "1012（Service Restart）不应写 lastError",
  );
});

test("app-gateway.ts：hello 成功即复位三态与启动进度", () => {
  const s = src("app-gateway.ts");
  const onHello = s.slice(s.indexOf("onHello: (hello)"));
  assert.notEqual(onHello.length, 0, "app-gateway.ts 缺少 onHello 分支");
  assert.match(
    onHello,
    /setGatewayPhase\(host, null\)/,
    "连接成功应清空 phase（三态只在断开窗口存在）",
  );
  assert.match(
    onHello,
    /clearSustainedFailureTimer\(\)/,
    "连接成功应取消持续失败计时",
  );
});

test("app-gateway.ts：onClose 稳定化守卫——starting/failed 不被后续 close 降级", () => {
  const s = src("app-gateway.ts");
  const onClose = s.slice(s.indexOf("onClose: ({ code, reason })"));
  // starting 保持 + 静默兜底计时：进度事件停止流动（监督链耗尽/ready 后握手
  // 持续被拒）时仍能升 failed，否则「启动中」横幅无限挂起
  assert.match(
    onClose,
    /if \(host\.gatewayPhase === "starting"\) \{[\s\S]*?armSustainedFailure\(host, STARTING_SILENCE_MS\);/,
    "starting 态的 close 不得降级为 reconnecting（闪烁），但要臂静默兜底计时",
  );
  // failed 保持：长期断连时退避重连的失败 close 不应把 failed 打回 reconnecting
  // （红色错误态每周期只出现几秒的无限抖动）；1012/1013（内核活着在重启）除外
  assert.match(
    onClose,
    /if \(host\.gatewayPhase === "failed" && code !== 1012 && code !== 1013\) \{/,
    "failed 态不得被普通 close 降级（1012/1013 内核重启信号除外）",
  );
});

test("app.ts：bindGatewayProgress 绑定 + 卸载对称清理", () => {
  const s = src("app.ts");
  assert.match(
    s,
    /this\.bindGatewayProgress\(\);/,
    "connectedCallback 应绑定 gateway:progress 订阅",
  );
  assert.match(
    s,
    /private bindGatewayProgress\(\)/,
    "app.ts 应有 bindGatewayProgress 方法",
  );
  assert.match(
    s,
    /this\.gatewayProgressCleanup\?\.?\(\);?\s*\n\s*this\.gatewayProgressCleanup = null;/,
    "disconnectedCallback 应对称清理 progress 订阅",
  );
});

test("进度事件纠正 phase：启动窗口内 WS 拒连不得误升 failed", () => {
  const gw = src("app-gateway.ts");
  assert.match(
    gw,
    /export function noteGatewayStartProgress\(host: GatewayHost\)/,
    "app-gateway.ts 应导出 noteGatewayStartProgress（进度事件 = 启动中的权威信号）",
  );
  const fn = gw.slice(gw.indexOf("export function noteGatewayStartProgress"));
  assert.match(
    fn,
    /clearSustainedFailureTimer\(\)/,
    "进度事件应取消持续失败计时（长启动窗口不得被 10s 无握手误判 failed）",
  );
  assert.match(
    fn,
    /setGatewayPhase\(host, "starting"\)/,
    "进度事件应把 phase 纠正回 starting（WS 拒连会先打成 reconnecting）",
  );
  const app = src("app.ts");
  assert.match(
    app,
    /noteGatewayStartProgress\(this\)/,
    "app.ts apply()/backfill 应调用 noteGatewayStartProgress",
  );
  assert.match(
    app,
    /info\?\.state !== "starting"/,
    "getGatewayState 回填只采纳 starting 态的进度（防御过期 ready/health 快照）",
  );
});

test("主进程：gateway:state 仅启动窗口内携带进度，状态机离启动即清快照", () => {
  const main = readFileSync(new URL("../../../../../../src/main.ts", import.meta.url), "utf8");
  assert.match(
    main,
    /progress: state === "starting" \? gateway\.getLastProgress\(\) : null/,
    "gateway:state 只在 starting 时下发 progress（running/stopped 携带会补出过期进度卡）",
  );
  const gp = readFileSync(new URL("../../../../../../src/gateway-process.ts", import.meta.url), "utf8");
  assert.match(
    gp,
    /if \(s === "starting" \|\| s === "stopped"\) \{\s*\n\s*this\.lastProgress = null;/,
    "进入 starting/stopped 应清空 lastProgress（防跨轮次/失败后的过期进度）",
  );
});

test("views/chat.ts：断开时不再硬禁用输入与主发送键（乐观入队由 handleSendChat 兜）", () => {
  const s = src("views/chat.ts");
  // textarea：整块内不得有 disabled（断开时保持可编辑）
  const textareaStart = s.indexOf("<textarea");
  assert.notEqual(textareaStart, -1, "views/chat.ts 应有 compose textarea");
  const textareaEnd = s.indexOf("></textarea>", textareaStart);
  const textareaBlock = s.slice(textareaStart, textareaEnd);
  assert.ok(
    !textareaBlock.includes("disabled"),
    "textarea 不应再被 disabled（断开时保持可编辑）",
  );
  // 主发送键（arrowUp 那颗）：禁用逻辑移除——断开时点击=乐观入队；
  // Stop 键（onAbort）保留禁用（中止需连接），thinking/model/branch 同理。
  const sendBtn = s.indexOf("${icons.arrowUp}");
  assert.notEqual(sendBtn, -1, "views/chat.ts 应有主发送键");
  const sendTagStart = s.lastIndexOf("<button", sendBtn);
  const sendTag = s.slice(sendTagStart, sendBtn);
  assert.ok(
    !sendTag.includes("disabled"),
    "主发送键不应再被 disabled（断开时发送走待发送队列）",
  );
  assert.match(
    s,
    /renderGatewayCallout\(props\)/,
    "断开状态应渲染三态 callout（替代裸错误横幅）",
  );
  assert.match(
    s,
    /chat\.queuedPendingHint/,
    "断开入队应给出「待发送」提示",
  );
  assert.match(
    s,
    /title=\$\{props\.error\}/,
    "连接态错误应保留原始详情（title），文案走本地化通用语",
  );
});

test("views/chat.ts：裸 props.error 不得作为可见文本直接渲染", () => {
  const s = src("views/chat.ts");
  // 允许出现在 title= 属性里（详情），不允许作为元素正文
  const bodyRefs = s.match(/<span(?![^>]*title=)[^>]*>\$\{props\.error\}<\/span>/g) ?? [];
  assert.equal(
    bodyRefs.length,
    0,
    "props.error（裸 English 错误）不得直接作为可见文本渲染",
  );
});

test("app-render.ts：oc-rail errors 不再注入裸 lastError", () => {
  const s = src("app-render.ts");
  assert.ok(
    !s.includes("errors: [chatDisabledReason, state.lastError]"),
    "rail errors 不再拼接裸 lastError（连接状态走 connection 三态）",
  );
  assert.match(
    s,
    /connection = state\.connected\s*\n?\s*\? null/,
    "app-render 应向 oc-rail 传 connection 三态",
  );
});

test("首 token 等待期：chatStream=\"\" 即挂 oc-chat-stream（三点点点指示）", () => {
  const s = src("views/chat.ts");
  assert.match(
    s,
    /props\.stream !== null \|\| props\.thinkingStream !== null \|\| props\.narrationText !== null/,
    "挂载条件以 !== null 判定——chatStream 发送即置 \"\"（非 null），首 token 前思考指示即时出现",
  );
  const stream = src("components/oc-chat-stream.ts");
  assert.match(
    stream,
    /renderReadingIndicatorGroup\(/,
    "stream 空白时应降级为三点点点思考指示（renderReadingIndicatorGroup）",
  );
});

test("流式渲染 perf 门完好：oc-chat-history / oc-chat-stream shouldUpdate 仅视觉属性", () => {
  const history = src("components/oc-chat-history.ts");
  assert.match(
    history,
    /VISUAL_PROPS\.some\(\(name\) => changed\.has\(name\)\)/,
    "oc-chat-history shouldUpdate 应按 VISUAL_PROPS 门控",
  );
  assert.ok(
    !history.includes('"onOpenSidebar"') ||
      !history.match(/VISUAL_PROPS[\s\S]*?"onOpenSidebar"/),
    "回调属性不得进入 VISUAL_PROPS",
  );
  const stream = src("components/oc-chat-stream.ts");
  assert.match(
    stream,
    /OcChatStream\.VISUAL_PROPS\.some\(\(name\) => changed\.has\(name\)\)/,
    "oc-chat-stream shouldUpdate 应按 VISUAL_PROPS 门控",
  );
});
