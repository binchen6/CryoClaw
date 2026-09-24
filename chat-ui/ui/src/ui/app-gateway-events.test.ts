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
//   探测上限 3 次、间隔钉死 [2000, 4000, 8000]；回调先查 liveOrphanRun()，
//   orphan 已被收养/清除/过期则不拉历史；拉取走 { mergeIfStale: true, silent: true }，
//   拉后做回复检查（hasAssistantReplyAfter）——命中即清流式态 + 作废 orphan 快照（R1）
// - R1 预对齐（shouldStreamPreAlign）拉历史后同样做回复检查，命中即清本地流式态；
//   渲染层另有内容判重兜底（views/chat.ts 跳过与历史末条 assistant 相同的流式气泡）
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

test("app-gateway.ts：探测回调先检查 orphan 存活，为空不拉历史；拉取走 silent + mergeIfStale", () => {
  const s = src("app-gateway.ts");
  // orphan 已被后续 delta 收养 / 被终态清除 / 已过期（TTL 120s）——恢复链路已接管，
  // 探测必须静默跳过，不得再发起无谓的历史拉取。
  assert.match(
    s,
    /const orphan = liveOrphanRun\(host\.sessionKey\);[\s\S]*?if \(!orphan\) \{[\s\S]*?return;[\s\S]*?\}[\s\S]*?await loadChatHistory\(host as unknown as OpenClawApp, \{ mergeIfStale: true, silent: true \}\);/,
    "探测回调应先查 liveOrphanRun()，为空直接 return；非空才走 await loadChatHistory(..., { mergeIfStale: true, silent: true })",
  );
});

test("app-gateway.ts：orphan 探测拉历史后做回复检查，命中清流式态 + 作废 orphan 快照（R1）", () => {
  const s = src("app-gateway.ts");
  const start = s.indexOf("function scheduleReconnectOrphanProbe");
  assert.notEqual(start, -1, "app-gateway.ts 缺少 scheduleReconnectOrphanProbe");
  const branch = s.slice(start);
  // 拉取期间 orphan 已被 delta 收养/被终态清除 → 收养路径自管活跃 run，探测不得清它
  assert.match(
    branch,
    /liveOrphanRunId\(host\.sessionKey\) !== orphan\.runId\)[\s\S]*?return;/,
    "拉历史后应先复查 orphan 仍未被收养，已被收养则不得 reset 活跃 run",
  );
  // orphan 标记（断连）之后落盘的 assistant 回复 = 该 run 实际已结束（终态帧丢失）：
  // 清本地流式残留 + 作废 orphan 快照，历史成为唯一渲染源（与 180s 看门狗同一判定）。
  assert.match(
    branch,
    /if \(!hasAssistantReplyAfter\(host\.chatMessages, orphan\.markedAt\)\) \{\s*\n\s*return;\s*\n\s*\}[\s\S]*?resetChatStreamState\([\s\S]*?resetToolStream\([\s\S]*?clearReconnectOrphanRun\(orphan\.runId, host\.sessionKey\);/,
    "回复命中应 resetChatStreamState + resetToolStream + clearReconnectOrphanRun(orphan.runId)",
  );
});

test("app-gateway.ts：回复命中的清态三处均以 inFlightRun 权威闸门否决（回归：误清活跃 run）", () => {
  const s = src("app-gateway.ts");
  // run 期间内核会落盘中间产物（progressive persist/子代理公告），仅凭"历史里有回复"
  // 清活跃 run 会把仍在途的 run 误判为终态——清态后 delta 被僵尸过滤丢弃，流式永久
  // 中断。响应的 inFlightRun 是内核对「本 run 仍在途」的显式声明，命中回复但内核
  // 声明在途时必须跳过清态（预对齐 / 看门狗 / orphan 探测三处同规则）。
  assert.match(
    s,
    /if \(inFlightRunId === probeRunId\) \{[\s\S]*?pre-align reply hit ignored[\s\S]*?return;/,
    "预对齐分支应检查 loadResult.inFlightRun，内核声明在途时不清",
  );
  assert.match(
    s,
    /if \(inFlightRunId === probeRunId\) \{[\s\S]*?watchdog reply hit ignored[\s\S]*?return;/,
    "看门狗分支应检查 loadResult.inFlightRun，内核声明在途时不清",
  );
  assert.match(
    s,
    /if \(inFlightRunId === orphan\.runId\) \{[\s\S]*?orphan probe reply hit ignored[\s\S]*?return;/,
    "orphan 探测分支应检查 loadResult.inFlightRun，内核声明在途时不清",
  );
  // 可恢复性兜底：清态（内核未声明在途）前快照 orphan——万一 in-flight 读是陈旧
  // 快照，清错了后续 delta 仍可被 orphan 收养续显（run 真死则 TTL 120s 自然失效）。
  assert.match(
    s,
    /console\.warn\("\[gateway\] pre-align recovered terminal reply from history"\);[\s\S]*?markReconnectOrphanRun\(probeRunId, host\.sessionKey\);[\s\S]*?resetChatStreamState\(/,
    "预对齐清态前应 markReconnectOrphanRun(probeRunId) 兜底",
  );
  assert.match(
    s,
    /console\.warn\("\[gateway\] stalled stream recovered via history probe"\);[\s\S]*?markReconnectOrphanRun\(probeRunId, host\.sessionKey\);[\s\S]*?resetChatStreamState\(/,
    "看门狗清态前应 markReconnectOrphanRun(probeRunId) 兜底",
  );
});

test("app-gateway.ts：预对齐拉历史后做回复检查（R1，此前只拉历史不查回复）", () => {
  const s = src("app-gateway.ts");
  const start = s.indexOf("function checkStalledStream");
  assert.notEqual(start, -1, "app-gateway.ts 缺少 checkStalledStream");
  const end = s.indexOf("function scheduleReconnectOrphanProbe", start);
  assert.notEqual(end, -1, "无法定位 checkStalledStream 边界");
  const branch = s.slice(start, end);
  assert.match(
    branch,
    /shouldStreamPreAlign\(host\.chatRunId, idleFor, RUN_IDLE_ALIGN_MS\)\) \{[\s\S]*?await loadChatHistory\(host as unknown as OpenClawApp, \{ mergeIfStale: true, silent: true \}\);[\s\S]*?hasAssistantReplyAfter\(host\.chatMessages, probeStartedAt\)[\s\S]*?resetChatStreamState\(/,
    "预对齐分支拉历史后应用 hasAssistantReplyAfter 判定，命中即清本地流式态（与看门狗同规则）",
  );
  // 负向钉点：预对齐不得退化为「每 tick 无条件 void loadChatHistory」的旧写法
  assert.doesNotMatch(
    branch,
    /if \(shouldStreamPreAlign\(host\.chatRunId, idleFor, RUN_IDLE_ALIGN_MS\)\) \{\s*\n\s*void loadChatHistory\(/,
    "预对齐分支不得只 void loadChatHistory 而不做回复检查",
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
  // R6：收养从零重建 run 态——必须显式清空上一 run 的流式残留，否则与收养后文本
  // 叠加成双份。
  assert.match(
    adoptBranch,
    /state\.chatStream = "";[\s\S]*?state\.chatPendingStreamText = null;[\s\S]*?state\.chatStreamFrozenPrefix = "";/,
    "收养分支应显式清空 chatStream/chatPendingStreamText/chatStreamFrozenPrefix",
  );
});

test("controllers/chat.ts：in-flight run 收养前检查历史已含本 run 回复（R6，有则不收养）", () => {
  const s = src("controllers/chat.ts");
  assert.match(
    s,
    /function historyAlreadyHasRunReply\([\s\S]*?typeof m\.runId === "string" && m\.runId === runId[\s\S]*?if \(useTimestampFallback\) \{[\s\S]*?hasAssistantReplyAfter\(freshMessages, startedAt\)[\s\S]*?hasAssistantReplyAfter\(state\.chatMessages, startedAt\)/,
    "historyAlreadyHasRunReply 应按 runId 精确匹配 + 时间戳兜底（仅在快照缺 startedAt 时启用）判定",
  );
  // 有内核 startedAt 时关闭时间戳兜底：改用 stopReason 终态标记判定——run 中途落盘
  // 产物（progressive persist/子代理公告）与终态回复时间戳不可区分，靠时间戳拒收养
  // 会误杀仍在途的 run（切会话回来流式断掉）。
  assert.match(
    s,
    /if \(typeof m\.stopReason !== "string" \|\| !m\.stopReason\) continue;/,
    "有 startedAt 时应回退到 stopReason 终态标记判定",
  );
  assert.match(
    s,
    /if \(historyAlreadyHasRunReply\(state, freshMessages \?\? \[\], runId, startedAt, !hasKernelStartedAt\)\) \{\s*\n\s*debugLog\("lifecycle", "in-flight run adoption skipped: reply already in history"/,
    "adoptInFlightRunFromHistory 应在收养前调用 historyAlreadyHasRunReply（按快照是否带 startedAt 选择判定档），命中即拒绝收养",
  );
  assert.match(
    s,
    /adoptInFlightRunFromHistory\(state, res\.inFlightRun, raw\);/,
    "loadChatHistory 应把本次拉取的新消息列表（raw）传给收养判定",
  );
});

test("controllers/chat.ts：delta 消费 reducer 新信号（R3 作废冻结段 / R4 清 narration / R5 计数）", () => {
  const s = src("controllers/chat.ts");
  const start = s.indexOf('if (payload.state === "delta") {');
  assert.notEqual(start, -1, "chat.ts 缺少 delta 分支");
  const end = s.indexOf('} else if (payload.state === "final") {', start);
  assert.notEqual(end, -1, "无法定位 delta 分支边界");
  const branch = s.slice(start, end);
  // R3
  assert.match(
    branch,
    /if \(reduced\.invalidatesFrozenPrefix\) \{[\s\S]*?state\.onReplaceBeyondFrozenPrefix\?\.\(\);[\s\S]*?state\.chatStreamFrozenPrefix = "";/,
    "replace 越过 frozenPrefix 时应调用 onReplaceBeyondFrozenPrefix 钩子并清空 frozenPrefix",
  );
  // R4
  assert.match(
    branch,
    /if \(reduced\.text\.trim\(\)\.length > 0\) \{[\s\S]*?state\.chatPendingNarrationText = null;[\s\S]*?state\.chatNarrationText = null;/,
    "正文 delta 首次非空时应清掉 narration（防 narration 气泡 + 正文气泡同文双份）",
  );
  // R5
  assert.match(
    branch,
    /mismatchCount: state\.chatStreamMismatchCount,[\s\S]*?state\.chatStreamMismatchCount = reduced\.mismatchCount \?\? 0;/,
    "delta 分支应透传并回写 chatStreamMismatchCount（reducer 连续失败强制 resync 的载体）",
  );
});

test("app-tool-stream.ts：invalidateFrozenLeadingSegments 作废被重写的冻结段（R3 消费端）", () => {
  const s = src("app-tool-stream.ts");
  assert.match(
    s,
    /export function invalidateFrozenLeadingSegments\(host: ToolStreamHost\) \{[\s\S]*?entry\.leadingSegment = undefined;[\s\S]*?host\.evictedLeadingSegments = \[\];[\s\S]*?flushToolStreamSync\(host\);[\s\S]*?\}/,
    "invalidateFrozenLeadingSegments 应清各 entry 的 leadingSegment + sticky 列表并同步时间线",
  );
});

test("app-gateway.ts：stream-recovery import 含 R1/R6 新 API", () => {
  const s = src("app-gateway.ts");
  assert.match(
    s,
    /import \{[\s\S]*?liveOrphanRun,[\s\S]*?\} from "\.\/stream-recovery\.ts"/,
    "app-gateway.ts 的 stream-recovery import 应包含 liveOrphanRun（探测回调取 orphan.markedAt）",
  );
});

// ---- F9：pendingReset 消费必须按 isOwnRunEvent 门控（跨 run final 不得抢先消费） ----

test("app-gateway.ts：final 分支 consumePendingSessionReset 按 isOwnRunEvent 门控", () => {
  const s = chatBranch(src("app-gateway.ts"));
  // inject/sub-agent 的 cross-run final 先消费标记，会让真正 reset run 的 final
  // 到达时 wasReset=false → 强制替换被跳过 → 旧对话在新会话残留。
  assert.match(
    s,
    /const wasReset = isOwnRunEvent \? consumePendingSessionReset\(sessionKey\) : false;/,
    "final 分支仅在 isOwnRunEvent 时消费 pendingReset",
  );
});

test("app-gateway.ts：error/aborted 分支的 consumePendingSessionReset 移入 isOwnRunEvent 块", () => {
  const s = chatBranch(src("app-gateway.ts"));
  assert.match(
    s,
    /if \(isOwnRunEvent\) \{\s*\n\s*consumePendingSessionReset\(sessionKey\);\s*\n\s*void loadChatHistory\(host as unknown as OpenClawApp, \{ mergeIfStale: true \}\);\s*\n\s*\}/,
    "error/aborted 分支应仅 own-run 时消费 pendingReset 并补拉历史",
  );
  // 负向钉点：不得再出现块外的无条件消费（final 分支的三元表达式除外）
  const withoutFinal = s.replace(
    /const wasReset = isOwnRunEvent \? consumePendingSessionReset\(sessionKey\) : false;/,
    "",
  );
  assert.equal(
    withoutFinal.includes("consumePendingSessionReset(sessionKey);"),
    true,
    "error/aborted 块内应保留唯一消费点",
  );
});

test("app-gateway.ts：own-run 终态清零 chatAbortPending（中止在途标记的终态出口）", () => {
  const s = chatBranch(src("app-gateway.ts"));
  assert.match(
    s,
    /if \(isOwnRunEvent\) \{[\s\S]*?host\.chatAbortPending = false;/,
    "own-run 终态应清零 chatAbortPending，让新一轮 run 的 Stop 按钮恢复可用",
  );
});
