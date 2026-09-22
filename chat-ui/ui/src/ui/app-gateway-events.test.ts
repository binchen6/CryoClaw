// 守护回归（源码审计，同 workspace-ui.test.ts 模式）：
// R41 Task 5「后台会话终态及时刷新侧边栏 + lastActiveSessionKey 守卫」+ 
// R41 Task 6「重连 orphan 未收养时的有限次历史探测」。
// app-gateway.ts 为重模块（依赖 gateway 客户端/大量 UI 控制器），在 node 下
// 不可导入，只能钉源码。本文件钉住以下语义：
//
// 钉住的不变量：
// - 后台会话（cron/渠道/sub-agent）的 final/error/aborted 终态，在
//   `payload.sessionKey !== host.sessionKey` 过滤后调用模块内既有的
//   scheduleTerminalSessionsRefresh（per-sessionKey 去重 + in-flight 合并），
//   侧边栏排序/标题/未读及时更新，不落到 30s ticker 兜底
// - setLastActiveSessionKey 仅在 `payload.sessionKey === host.sessionKey`
//   （当前会话事件）时调用；后台会话事件不得覆写「上次活跃会话」，
//   否则重启后会恢复到后台会话而非用户上次所看的会话
// - onHello 的 previousClient 重连分支调用 scheduleReconnectOrphanProbe(host)：
//   断连期间 run 已结束 + 重连读连续命中滞后快照（退避耗尽）时补有限次静默探测；
//   探测上限 3 次、间隔钉死 [2000, 4000, 8000]；回调先查 liveOrphanRunId()，
//   orphan 已被收养/清除/过期则不拉历史；拉取走 { mergeIfStale: true, silent: true }
// - onClose 分支调用 cancelReconnectOrphanProbe()：新断连作废上轮挂起探测
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 编译产物位于 chat-ui/ui/.test-dist/ui/src/ui/，源文件位于 chat-ui/ui/src/ui/
function src(rel: string): string {
  return readFileSync(new URL(`../../../../src/ui/${rel}`, import.meta.url), "utf8");
}

// 截取 chat 事件分支（自 `if (evt.event === "chat")` 到下一个事件分支边界）
function chatBranch(s: string): string {
  const start = s.indexOf('if (evt.event === "chat")');
  assert.notEqual(start, -1, "app-gateway.ts 缺少 chat 事件分支");
  const end = s.indexOf('if (evt.event === "exec.approval.requested")', start);
  assert.notEqual(end, -1, "无法定位 chat 事件分支边界");
  return s.slice(start, end);
}

test("app-gateway.ts：后台会话终态（final/error/aborted）触发侧边栏刷新", () => {
  const s = chatBranch(src("app-gateway.ts"));
  // 后台会话判定（sessionKey 不等）+ 终态判定 → 复用既有去重刷新，而非新写拉取逻辑
  assert.match(
    s,
    /payload\.sessionKey !== host\.sessionKey[\s\S]*?payload\.state === "final"[\s\S]*?payload\.state === "error"[\s\S]*?payload\.state === "aborted"[\s\S]*?scheduleTerminalSessionsRefresh\(host as unknown as OpenClawApp, payload\.sessionKey\);/,
    "后台会话终态应在 payload.sessionKey !== host.sessionKey 过滤后调用 scheduleTerminalSessionsRefresh(host, payload.sessionKey)",
  );
  // 补刷新后提前 return：不进 handleChatEvent（其首行按 sessionKey 过滤），
  // 也不触碰仅服务当前会话的 consumePendingSessionReset / loadChatHistory
  assert.match(
    s,
    /scheduleTerminalSessionsRefresh\(host as unknown as OpenClawApp, payload\.sessionKey\);\s*\n\s*return;/,
    "后台会话终态补刷新后应提前 return",
  );
});

test("app-gateway.ts：setLastActiveSessionKey 仅对当前会话事件调用（守卫）", () => {
  const s = chatBranch(src("app-gateway.ts"));
  assert.match(
    s,
    /payload\.sessionKey === host\.sessionKey[\s\S]*?setLastActiveSessionKey\(/,
    "setLastActiveSessionKey 调用应被 payload.sessionKey === host.sessionKey 条件包裹",
  );
  // 回归钉点：禁止此前「只要有 payload.sessionKey 就无条件调用」的写法
  assert.doesNotMatch(
    s,
    /if \(payload\?\.sessionKey\) \{\s*\n\s*setLastActiveSessionKey\(/,
    "setLastActiveSessionKey 不得在仅判断 payload.sessionKey 存在时无条件调用",
  );
});

// ---- R41 Task 6：重连 orphan 未收养时的有限次历史探测 ----

test("app-gateway.ts：onHello previousClient 重连分支调度 scheduleReconnectOrphanProbe", () => {
  const s = src("app-gateway.ts");
  // F7 后重连读的 loadChatHistory 选项由 hasPendingSessionReset 三元决定，
  // 探测调度仍须紧跟重连读之后、仅在 previousClient 分支内：首次连接没有
  // 「断连窗口内结束的 run」，不需要探测；onGap 耗尽软恢复路径不断连也不需要。
  assert.match(
    s,
    /if \(previousClient\) \{[\s\S]*?void loadChatHistory\([\s\S]*?scheduleReconnectOrphanProbe\(host\);[\s\S]*?\}/,
    "onHello 的 previousClient 分支应在重连读后调用 scheduleReconnectOrphanProbe(host)",
  );
  // 顶部 import 必须引入 liveOrphanRunId（探测回调的存活检查只消费这一个 orphan API）
  assert.match(
    s,
    /from "\.\/stream-recovery\.ts"/,
    "app-gateway.ts 应从 ./stream-recovery.ts 导入",
  );
  assert.match(
    s,
    /liveOrphanRunId[\s\S]*?\} from "\.\/stream-recovery\.ts"/,
    "stream-recovery import 列表应包含 liveOrphanRunId",
  );
});

// ---- F7：/new、/reset 的 final 帧丢失在断连窗口 → 重连读强制替换历史 ----

test("app-gateway.ts：onHello 重连分支对未消费的 pendingReset 跳过 mergeIfStale", () => {
  const s = src("app-gateway.ts");
  // pendingReset 未消费 = /new、/reset 已发送但终态帧丢失：内核 transcript 已被清空，
  // 此时 mergeIfStale 的滞后兜底（内核短于本地时保留本地 + R23 空读保护）会把
  // 旧对话/乐观写入永久留在「新会话」里。必须强制替换（传 undefined 选项）。
  assert.match(
    s,
    /if \(previousClient\) \{[\s\S]*?hasPendingSessionReset\(host\.sessionKey\);[\s\S]*?reconnectReplace \? undefined : \{ mergeIfStale: true \}[\s\S]*?scheduleReconnectOrphanProbe\(host\);/,
    "onHello 重连分支应以 hasPendingSessionReset(host.sessionKey) 判定，pendingReset 未消费时强制替换历史",
  );
  // 负向钉点：重连分支不得再有无条件的 mergeIfStale 重连读
  const helloStart = s.indexOf("onHello: (hello) => {");
  assert.notEqual(helloStart, -1, "app-gateway.ts 缺少 onHello 分支");
  const helloEnd = s.indexOf("onClose: ({ code, reason }) => {", helloStart);
  assert.notEqual(helloEnd, -1, "无法定位 onHello 分支边界");
  const helloBranch = s.slice(helloStart, helloEnd);
  assert.doesNotMatch(
    helloBranch,
    /void loadChatHistory\(host as unknown as OpenClawApp, \{ mergeIfStale: true \}\);/,
    "onHello 分支不得再保留无条件的 mergeIfStale 重连读（F7 漏洞面）",
  );
});

test("app-gateway.ts：onGap 耗尽软恢复分支同样对未消费的 pendingReset 强制替换", () => {
  const s = src("app-gateway.ts");
  const gapStart = s.indexOf("onGap: ({ expected, received }) => {");
  assert.notEqual(gapStart, -1, "app-gateway.ts 缺少 onGap 分支");
  const gapBranch = s.slice(gapStart);
  assert.match(
    gapBranch,
    /hasPendingSessionReset\(host\.sessionKey\) \? undefined : \{ mergeIfStale: true \}/,
    "onGap 软恢复的历史对齐应与重连分支一致：pendingReset 未消费时强制替换",
  );
});

test("app-gateway.ts：hasPendingSessionReset 只读探测（重连路径不得消费标记）", () => {
  const s = src("app-gateway.ts");
  // 标记的生命周期仍归终态事件（final/error/aborted）与发送失败回滚消费；
  // 重连路径只 peek——若重连分支 delete 了标记，随后到达的终态会再走
  // mergeIfStale 滞后兜底，且失败回滚的撤销语义也被破坏。
  assert.doesNotMatch(
    s,
    /consumePendingSessionReset\(host\.sessionKey\)/,
    "host.sessionKey 维度的 reset 消费仅限终态/回滚路径，重连探测不得消费",
  );
  assert.match(
    s,
    /import \{[\s\S]*?hasPendingSessionReset[\s\S]*?\} from "\.\/session-pending\.ts"/,
    "app-gateway.ts 应从 ./session-pending.ts 导入 hasPendingSessionReset",
  );
});

test("app-gateway.ts：ORPHAN_PROBE_DELAYS_MS 钉死探测上限 3 次与间隔 [2000, 4000, 8000]", () => {
  const s = src("app-gateway.ts");
  assert.match(
    s,
    /const ORPHAN_PROBE_DELAYS_MS = \[2000, 4000, 8000\];/,
    "探测间隔必须钉死为 [2000, 4000, 8000]（上限 3 次，覆盖内核持久化窗口）",
  );
  // 调度函数先取消旧探测再排新：重复触发（如连续重连）不得叠加出双份探测序列。
  assert.match(
    s,
    /function scheduleReconnectOrphanProbe\(host: GatewayHost\) \{[\s\S]*?cancelReconnectOrphanProbe\(\);[\s\S]*?ORPHAN_PROBE_DELAYS_MS\.forEach/,
    "scheduleReconnectOrphanProbe 应先 cancelReconnectOrphanProbe() 再按延迟序列排新探测",
  );
});

test("app-gateway.ts：探测回调先检查 liveOrphanRunId，为空不拉历史；拉取走 silent + mergeIfStale", () => {
  const s = src("app-gateway.ts");
  // orphan 已被后续 delta 收养 / 被终态清除 / 已过期（TTL 120s）——恢复链路已接管，
  // 探测必须静默跳过，不得再发起无谓的历史拉取。
  assert.match(
    s,
    /if \(!liveOrphanRunId\(host.sessionKey\)\) \{[\s\S]*?return;[\s\S]*?\}[\s\S]*?void loadChatHistory\(host as unknown as OpenClawApp, \{ mergeIfStale: true, silent: true \}\);/,
    "探测回调应先查 liveOrphanRunId()，为空直接 return；非空才走 loadChatHistory(..., { mergeIfStale: true, silent: true })",
  );
});

test("app-gateway.ts：onClose 分支调用 cancelReconnectOrphanProbe（新断连作废旧探测）", () => {
  const s = src("app-gateway.ts");
  const start = s.indexOf("onClose: ({ code, reason }) => {");
  assert.notEqual(start, -1, "app-gateway.ts 缺少 onClose 分支");
  const end = s.indexOf("onEvent:", start);
  assert.notEqual(end, -1, "无法定位 onClose 分支边界");
  const closeBranch = s.slice(start, end);
  assert.match(
    closeBranch,
    /cancelReconnectOrphanProbe\(\);/,
    "onClose 分支应调用 cancelReconnectOrphanProbe()，新断连作废旧探测",
  );
});

test("app-gateway.ts：onGap 分支不得调度 scheduleReconnectOrphanProbe（负向）", () => {
  const s = src("app-gateway.ts");
  const start = s.indexOf("onGap: ({ expected, received }) => {");
  assert.notEqual(start, -1, "app-gateway.ts 缺少 onGap 分支");
  // onGap 是 client 配置的最后一个回调，分支结束后紧跟配置收尾 `});`
  const end = s.indexOf("});", start);
  assert.notEqual(end, -1, "无法定位 onGap 分支边界");
  const gapBranch = s.slice(start, end);
  // 探测仅在 onHello previousClient 重连分支调度；onGap 耗尽软恢复路径不断连，
  // 不得调度探测（否则 gap 耗尽后叠加冗余静默历史拉取）。
  assert.equal(
    gapBranch.includes("scheduleReconnectOrphanProbe"),
    false,
    "onGap 分支不得包含 scheduleReconnectOrphanProbe（探测仅限 onHello 重连分支）",
  );
});

test("controllers/chat.ts：orphan 收养分支调用 clearReconnectOrphanRun（收养即停探测）", () => {
  const s = src("controllers/chat.ts");
  const start = s.indexOf(
    'if (payload.state === "delta" && payload.runId === liveOrphanRunId(state.sessionKey))',
  );
  assert.notEqual(start, -1, "chat.ts 缺少 orphan 收养分支");
  const end = s.indexOf("} else if", start);
  assert.notEqual(end, -1, "无法定位收养分支边界");
  const adoptBranch = s.slice(start, end);
  assert.match(
    adoptBranch,
    /orphan run adopted after reconnect/,
    "收养分支应含 debugLog(\"lifecycle\", \"orphan run adopted after reconnect\")",
  );
  // 收养即恢复链路接管：必须清 orphan 快照，否则 app-gateway 挂起的重连探测仍会
  // 命中 liveOrphanRunId() 发起冗余静默历史拉取。
  assert.match(
    adoptBranch,
    /clearReconnectOrphanRun\(payload\.runId, state\.sessionKey\);/,
    "收养分支应调用 clearReconnectOrphanRun(payload.runId)，收养即停重连探测",
  );
});
