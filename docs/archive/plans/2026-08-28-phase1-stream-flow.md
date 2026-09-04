# 第一期：消息流式体验优化 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复消息刷新/流式恢复 5 处确凿短板、对齐官方事件驱动刷新、完成渲染层组件化（流式高频更新不再牵连历史列表与侧边栏）、流式气泡升级为安全前缀 markdown 渐进渲染。

**Architecture:** 纯 chat-ui 改动（主进程/内核零改动）。先做低风险正确性修复（TDD），再做渲染层组件化（`<cc-chat-stream>` → `<cc-chat-history>` → `<cc-sidebar>` 顺序抽取，状态仍归 `OpenClawApp`），每步全量测试。

**Tech Stack:** TypeScript 5 + Lit（LitElement 子组件 + shouldUpdate props 浅比较）+ vitest（chat-ui 测试）；样式走既有 CSS 分块 + design token。

**设计文档：** `docs/specs/2026-08-28-stream-flow-and-sidebar-design.md`

**项目硬约定（每个任务都适用）：**
- 测试命令：`npm test`（全量）；chat-ui 单测快速验证：`npx vitest run <file>`（vitest.config.ts include 列表控制）
- 新增 `.test.ts` 文件同步两处：`vitest.config.ts` include（若在 vitest 范围）；参考 `chat-ui/ui/src/ui/chat.test.ts` 的 mock 模式（`chatLastActivityAt` 等非响应式字段直接赋桩对象）
- 源码审计测试（钉 UI 接线）参照 `chat-ui/ui/src/ui/i18n.test.ts` / `git-ui.test.ts` 模式：`fs.readFileSync` 读源码 + 正则断言
- 不主动 `git commit`，除非到达任务内的提交步骤（用户已授权本计划内的提交）
- 样式禁止硬编码 hex；transition 用具体属性；`prefers-reduced-motion` 尊重
- 取证材料：`.cache/control-ui-extract/`（官方 control-ui minified JS，只读）

---

### Task 1: 滞后补拉预算 per-session 化

**背景：** `controllers/chat.ts` 的 `staleRetryAttempt` 是模块级全局。会话 A 挂起重试期间切到会话 B 时，`clearTimeout` 但 `staleRetryAttempt` 不复位（L166-172），B 继承 A 的计数；`attempt >= 3` 耗尽后静默 return 且永不复位（L163-165），任何会话的滞后读都不再补拉。

**Files:**
- Modify: `chat-ui/ui/src/ui/controllers/chat.ts:143-186`
- Test: `chat-ui/ui/src/ui/controllers/chat.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

在 `chat-ui/ui/src/ui/controllers/chat.test.ts` 追加（沿用文件内既有桩对象与 `vi.useFakeTimers()` 模式）：

```ts
describe("scheduleStaleHistoryRetry budget", () => {
  it("切换目标会话时补拉预算复位（新会话满额重试）", () => {
    // 构造 state（client.request 返回比本地短的 messages 触发 mergeIfStale 保留）
    // 1) 会话 A 上触发一次滞后保留 → 推进 800ms → 第二次保留 → attempt=1
    // 2) state.sessionKey 切到 B，再触发 B 的滞后保留
    // 3) 断言 B 的补拉延迟仍是 800（首档），而非继承 A 的 1600
  });
  it("预算耗尽后切换会话可重新补拉", () => {
    // A 上连续 3 次滞后保留耗尽预算（800/1600/2400 全走完仍滞后）
    // 切到 B 触发滞后保留 → 800ms 后应有 loadChatHistory 调用（而非静默放弃）
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run chat-ui/ui/src/ui/controllers/chat.test.ts`
Expected: 新增 2 例 FAIL（预算未复位）

- [ ] **Step 3: 实现**

`controllers/chat.ts` `scheduleStaleHistoryRetry` 改为：

```ts
function scheduleStaleHistoryRetry(state: ChatState, sessionKey: string) {
  if (staleRetryTimer !== null && staleRetryKey !== sessionKey) {
    // 目标会话切换：预算随之复位——旧会话消耗的档位不应由新会话继承，
    // 否则长期滞后的会话会吃光全局预算，其余会话「问了没答」永不再补拉
    clearTimeout(staleRetryTimer);
    staleRetryTimer = null;
    staleRetryAttempt = 0;
  }
  if (staleRetryAttempt >= STALE_RETRY_DELAYS_MS.length) {
    return;
  }
  if (staleRetryTimer !== null) {
    return; // 已有同会话的挂起重试，合并
  }
  // ……后续不变（staleRetryKey 赋值、delay、setTimeout 回调）
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run chat-ui/ui/src/ui/controllers/chat.test.ts`
Expected: 全 PASS（含既有滞后补拉链用例）

---

### Task 2: 终态刷新保留可见消息数（消除缩回抖动）

**背景：** `loadChatHistory` 替换成功路径无条件 `chatVisibleMessageCount = min(len, 20)` + 渐进注水（L239-243）。每轮终态/看门狗探测/重连后，60 条会话先缩到 20 条再逐批补回——闪烁 + 滚动位移。仅切会话/重置需要渐进注水。

**Files:**
- Modify: `chat-ui/ui/src/ui/controllers/chat.ts:188-255`
- Test: `chat-ui/ui/src/ui/controllers/chat.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

```ts
describe("loadChatHistory visible count", () => {
  it("同会话终态刷新（mergeIfStale）保留现有可见数，不重走渐进注水", () => {
    // 预置 state.chatMessages 50 条、chatVisibleMessageCount = 50
    // client.request 返回 52 条（比本地长，合法替换）
    // await loadChatHistory(state, { mergeIfStale: true })
    // 断言 chatVisibleMessageCount === 52（而非 20）；推进定时器后无注水帧行为变化
  });
  it("替换语义（无 mergeIfStale）仍走 20 条渐进注水", () => {
    // await loadChatHistory(state) 返回 50 条
    // 断言 chatVisibleMessageCount === 20；推进 32ms×3 后递增到 50
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run chat-ui/ui/src/ui/controllers/chat.test.ts`
Expected: 第 1 例 FAIL

- [ ] **Step 3: 实现**

替换 `loadChatHistory` 中 `state.chatVisibleMessageCount = Math.min(...)` 起的三行：

```ts
    // 同会话刷新（终态/看门狗/重连的 mergeIfStale 路径）保留可见数——历史只是
    // 追加/更新，重走 20 条渐进注水会让视图先缩回再补回（闪烁 + 上方插入位移）。
    // 渐进注水仅服务「整段替换」的首屏（切会话/重置/首次加载）。
    const priorCount = state.chatVisibleMessageCount;
    const keepCount =
      Boolean(opts?.mergeIfStale) &&
      priorCount > 0 &&
      priorCount >= state.chatMessages.length;
    if (keepCount) {
      state.chatVisibleMessageCount = Math.max(priorCount, deduplicated.length);
    } else {
      state.chatVisibleMessageCount = Math.min(
        deduplicated.length,
        INITIAL_CHAT_HISTORY_RENDER_COUNT,
      );
      scheduleChatHistoryHydration(state, requestSessionKey, deduplicated.length);
    }
```

注意：`priorCount >= state.chatMessages.length` 守卫防「用户滚动只露出部分消息时刷新把未露出的也强行展开」——仅当先前已全量可见时才保持。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run chat-ui/ui/src/ui/controllers/chat.test.ts`
Expected: 全 PASS

---

### Task 3: 看门狗恢复判定跳过缺时间戳条目

**背景：** `hasAssistantReplyAfter`（`stream-recovery.ts` L86-97）遇到第一条（自尾向前）缺 `timestamp` 的 assistant 消息直接 `return false`，看门狗永不清挂起态。

**Files:**
- Modify: `chat-ui/ui/src/ui/stream-recovery.ts:80-99`
- Test: `chat-ui/ui/src/ui/stream-recovery.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

```ts
it("最后一条 assistant 缺 timestamp 时继续向前扫描", () => {
  const messages = [
    { role: "assistant", timestamp: 5000, content: [{ type: "text", text: "a" }] },
    { role: "assistant", content: [{ type: "text", text: "b" }] }, // 无 timestamp
  ];
  assert.strictEqual(hasAssistantReplyAfter(messages, 4000), true);
});
it("cryoclawError 合成卡与缺时间戳条目混合仍正确", () => {
  const messages = [
    { role: "assistant", timestamp: 5000, content: [] },
    { role: "assistant", cryoclawError: true, timestamp: 6000, content: [] },
    { role: "assistant", content: [] },
  ];
  assert.strictEqual(hasAssistantReplyAfter(messages, 4000), true);
});
```

（沿用该测试文件既有 node:test assert 风格）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run chat-ui/ui/src/ui/stream-recovery.test.ts`（或该文件所在测试运行器，对齐文件头现有模式）
Expected: 新增 2 例 FAIL

- [ ] **Step 3: 实现**

`hasAssistantReplyAfter` 循环体末尾改为：

```ts
    const ts = typeof m.timestamp === "number" ? m.timestamp : Number.NaN;
    // 缺 timestamp 的条目无法判定——跳过继续向前扫（此前直接 return 导致
    // 末尾一条缺时间戳时看门狗恒不清挂起态）；时间戳早于阈值的旧回复同样跳过
    if (Number.isFinite(ts) && ts >= threshold) {
      return true;
    }
```

函数尾 `return false` 不变，头注释同步（删「保守返回 false」句，写明新语义）。

- [ ] **Step 4: 运行确认通过**

Run: 同上
Expected: 全 PASS

---

### Task 4: loadChatHistory silent 选项

**背景：** 看门狗探测与重连探测走 `loadChatHistory` 会置 `chatLoading=true`，消息线程顶部「加载中」每 30s 闪一次。

**Files:**
- Modify: `chat-ui/ui/src/ui/controllers/chat.ts`（`loadChatHistory` 签名与 `chatLoading` 赋值处）
- Modify: `chat-ui/ui/src/ui/app-gateway.ts:245`（看门狗探测调用点）
- Test: `chat-ui/ui/src/ui/controllers/chat.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

```ts
it("silent 探测不置 chatLoading（不闪「加载中」）", () => {
  // await loadChatHistory(state, { mergeIfStale: true, silent: true })
  // 断言全程 state.chatLoading === false
});
```

- [ ] **Step 2: 运行确认失败** — Expected: FAIL（unknown option 不生效）

- [ ] **Step 3: 实现**

```ts
export async function loadChatHistory(
  state: ChatState,
  opts?: { mergeIfStale?: boolean; silent?: boolean },
) {
  // ...
  cancelChatHistoryHydration(state);
  if (!opts?.silent) {
    state.chatLoading = true;
  }
  // ...finally 分支同样守卫：
  //   if (state.sessionKey === requestSessionKey && !opts?.silent) { state.chatLoading = false; }
```

`app-gateway.ts` `checkStalledStream` 的探测调用改为：

```ts
    await loadChatHistory(host as unknown as OpenClawApp, { mergeIfStale: true, silent: true });
```

- [ ] **Step 4: 运行确认通过** — `npx vitest run chat-ui/ui/src/ui/controllers/chat.test.ts` 全 PASS

---

### Task 5: 后台会话终态及时刷新侧边栏 + lastActiveSessionKey 守卫

**背景：** `handleChatEvent` 对 `sessionKey ≠ 当前` 的事件直接返回 `null`，后台会话（cron/渠道/sub-agent）的终态不触发 `loadSessions`，侧边栏更新落到 30s ticker；且 `handleGatewayEventUnsafe` 里任意会话的 chat 事件都覆写 `lastActiveSessionKey`，重启后可能恢复到后台会话。

**Files:**
- Modify: `chat-ui/ui/src/ui/app-gateway.ts:456-508`（chat 事件分支）
- Test: `chat-ui/ui/src/ui/gateway.test.ts`（追加；若无合适宿主则新建 `app-gateway-events.test.ts` 走源码审计模式）

- [ ] **Step 1: 写失败测试**

```ts
// handleGatewayEventUnsafe 是模块内部函数——用源码审计模式钉住两条语义：
it("后台会话终态触发 scheduleTerminalSessionsRefresh", () => {
  const src = read("chat-ui/ui/src/ui/app-gateway.ts");
  // chat 分支存在「payload.sessionKey !== host.sessionKey」的终态判断，
  // 且其内调用 scheduleTerminalSessionsRefresh(host, payload.sessionKey)
});
it("lastActiveSessionKey 仅当前会话写入", () => {
  const src = read("chat-ui/ui/src/ui/app-gateway.ts");
  // setLastActiveSessionKey 调用被 payload.sessionKey === host.sessionKey 条件包裹
});
```

- [ ] **Step 2: 运行确认失败** — Expected: FAIL

- [ ] **Step 3: 实现**

`handleGatewayEventUnsafe` chat 分支：

```ts
  if (evt.event === "chat") {
    const payload = evt.payload as ChatEventPayload | undefined;
    // 仅当前会话的活跃事件代表「用户正在看的对话」；后台会话（cron/渠道/
    // sub-agent）事件覆写会让重启恢复到后台会话而非用户上次所看
    if (payload?.sessionKey && payload.sessionKey === host.sessionKey) {
      setLastActiveSessionKey(
        host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
        payload.sessionKey,
      );
    }
    // 后台会话终态：不进 handleChatEvent（其首行按 sessionKey 过滤），
    // 但侧边栏排序/标题/未读需要及时刷新——对齐官方事件驱动刷新，
    // 不落到 30s ticker 兜底（走既有 per-session 去重 + in-flight 合并）
    if (
      payload?.sessionKey &&
      payload.sessionKey !== host.sessionKey &&
      (payload.state === "final" || payload.state === "error" || payload.state === "aborted")
    ) {
      scheduleTerminalSessionsRefresh(host as unknown as OpenClawApp, payload.sessionKey);
      return;
    }
    // ……以下既有逻辑不变（isOwnRunEvent / handleChatEvent / ……）
```

- [ ] **Step 4: 运行确认通过** — 相关测试文件全 PASS；再跑 `npm run test:typecheck` 确认类型

---

### Task 6: 重连 orphan 未收养时的有限次历史探测

**背景：** 断连期间 run 已结束、重连读又连续命中滞后快照（2.4s 窗口耗尽）后，无任何通道再拉当前会话历史，回复静默缺失；看门狗也不生效（onHello 已清 `chatRunId`）。

**Files:**
- Modify: `chat-ui/ui/src/ui/app-gateway.ts`（onHello 重连分支 + 新函数）
- Test: `chat-ui/ui/src/ui/chat.test.ts` 或 `app-gateway` 源码审计（模式同 Task 5）

- [ ] **Step 1: 写失败测试（源码审计）**

```ts
it("重连存在未收养 orphan 时调度有限次历史探测", () => {
  const src = read("chat-ui/ui/src/ui/app-gateway.ts");
  // 1) onHello 的 previousClient 分支调用 scheduleReconnectOrphanProbe
  // 2) 探测上限 3 次、间隔 2000/4000/8000、每次前检查 liveOrphanRunId()
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

`app-gateway.ts` 新增（放在 `checkStalledStream` 附近）：

```ts
// R41 重连盲区补强：断连窗口内结束的 run + 重连读连续命中滞后快照（退避窗口
// 耗尽）时，此前无任何后续刷新通道。存在未收养 orphan 快照期间做有限次历史
// 探测（silent，不闪加载态）；orphan 被 delta 收养或被终态清除后立即停止。
const ORPHAN_PROBE_DELAYS_MS = [2000, 4000, 8000];
let orphanProbeTimers: Array<ReturnType<typeof setTimeout>> = [];

function cancelReconnectOrphanProbe() {
  for (const t of orphanProbeTimers) {
    clearTimeout(t);
  }
  orphanProbeTimers = [];
}
export function cancelReconnectOrphanProbeForTests() {
  cancelReconnectOrphanProbe();
}

function scheduleReconnectOrphanProbe(host: GatewayHost) {
  cancelReconnectOrphanProbe();
  ORPHAN_PROBE_DELAYS_MS.forEach((delay) => {
    const timer = setTimeout(() => {
      orphanProbeTimers = orphanProbeTimers.filter((x) => x !== timer);
      if (!liveOrphanRunId()) {
        return; // orphan 已被收养/清除/过期——恢复链路已接管
      }
      void loadChatHistory(host as unknown as OpenClawApp, { mergeIfStale: true, silent: true });
    }, delay);
    orphanProbeTimers.push(timer);
  });
}
```

接线：
1. `onHello` 的 `if (previousClient) { void loadChatHistory(...) }` 之后追加 `scheduleReconnectOrphanProbe(host);`
2. `onClose` 分支追加 `cancelReconnectOrphanProbe();`（新断连作废旧探测）
3. 顶部 import 追加 `liveOrphanRunId`（from `./stream-recovery.ts`）

- [ ] **Step 4: 运行确认通过** — 审计测试 PASS + typecheck

---

### Task 7: sessions.changed 本地 patch（事件驱动刷新对齐官方）

**背景：** 当前每条 `sessions.changed` 都全量 `loadSessions`。官方做法：先尝试用事件携带的行数据本地 patch，失败才全量重拉。

**Files:**
- Create: `chat-ui/ui/src/ui/controllers/sessions-patch.ts`（纯函数）
- Modify: `chat-ui/ui/src/ui/app-gateway.ts:554-558`（sessions.changed 分支）
- Test: `chat-ui/ui/src/ui/controllers/sessions-patch.test.ts`（新建）

- [ ] **Step 0: 取证 payload 形态**

在 `app-gateway.ts` sessions.changed 分支临时加 `debugLog("gateway", "sessions.changed payload", evt.payload)`，`npm run dev` 起应用做一次会话改名/新消息，记录真实 payload 结构。**按实测结构实现下面的函数**；若 payload 不含行数据（仅通知型），跳过本任务并在设计文档记录「降级保留全量重拉」。

- [ ] **Step 1: 写失败测试**

```ts
// sessions-patch.test.ts
import { applySessionsChangedPatch } from "./sessions-patch.ts";

describe("applySessionsChangedPatch", () => {
  const base = { sessions: [
    { key: "a", updatedAt: 1, title: "old" },
    { key: "b", updatedAt: 2, title: "keep" },
  ] };
  it("命中已有行 → 返回合并后的新数组（不可变）", () => {
    const next = applySessionsChangedPatch(base, { key: "a", updatedAt: 9, title: "new" });
    assert(next && next.sessions[0].updatedAt === 9);
    assert(base.sessions[0].updatedAt === 1); // 原对象不变
  });
  it("新会话行 → 追加", () => { /* key 不在列表，返回含新行的结果 */ });
  it("行数据缺 key 或结构不符 → 返回 null（调用方全量重拉）", () => {
    assert(applySessionsChangedPatch(base, {}) === null);
  });
});
```

- [ ] **Step 2: 运行确认失败**（模块不存在）

- [ ] **Step 3: 实现**

```ts
// controllers/sessions-patch.ts
export type SessionRow = Record<string, unknown> & { key: string };
export type SessionsListLike = { sessions?: SessionRow[] } & Record<string, unknown>;

// sessions.changed 事件先本地 patch（对齐官方 control-ui 的事件驱动刷新）：
// 命中已有行就地合并行字段，未见过的行追加；结构不符返回 null 由调用方全量重拉。
export function applySessionsChangedPatch(
  current: SessionsListLike | null,
  row: unknown,
): SessionsListLike | null {
  const incoming = row as Partial<SessionRow> | null;
  if (!incoming || typeof incoming.key !== "string" || !incoming.key) {
    return null;
  }
  if (!current?.sessions) {
    return null; // 无基线可 patch
  }
  const idx = current.sessions.findIndex((s) => s.key === incoming.key);
  const sessions =
    idx >= 0
      ? current.sessions.map((s, i) => (i === idx ? { ...s, ...incoming } : s))
      : [...current.sessions, incoming as SessionRow];
  return { ...current, sessions };
}
```

`app-gateway.ts` sessions.changed 分支：

```ts
  if (evt.event === "sessions.changed") {
    const app = host as unknown as OpenClawApp;
    // 事件携带行数据时先本地 patch（免一次全量 sessions.list）；
    // 通知型/结构不符则回落全量重拉
    const patched = applySessionsChangedPatch(app.sessionsResult, evt.payload);
    if (patched) {
      app.sessionsResult = patched as typeof app.sessionsResult;
      app.requestUpdate?.();
    } else {
      void loadSessions(app as any);
    }
    return;
  }
```

（`sessionsResult`/`requestUpdate` 字段名以 `OpenClawApp` 实际定义为准，实施时核对。）

- [ ] **Step 4: 运行确认通过** — 新测试 + 全量 `npm test` + typecheck

---

### Task 8: markdown 安全前缀切分（纯函数）

**背景：** 官方做法：流式文本按「最后一个闭合代码围栏/空行」切分，稳定段完整渲染、未闭合尾部纯文本，消除半截代码块反复解析抖动。为 Task 9 流式渐进 markdown 渲染打基础。

**Files:**
- Modify: `chat-ui/ui/src/ui/markdown.ts`（追加纯函数 + 导出）
- Test: `chat-ui/ui/src/ui/markdown.test.ts`（新建或追加；核对 vitest include）

- [ ] **Step 1: 写失败测试**

```ts
describe("splitMarkdownSafePrefix", () => {
  it("闭合代码围栏之后切分", () => {
    const text = "intro\n```js\ncode\n```\ntail partial `in";
    const { stable, tail } = splitMarkdownSafePrefix(text);
    assert(stable.endsWith("```\n"));  // 稳定段含闭合围栏
    assert(tail === "tail partial `in");
  });
  it("未闭合围栏整段归 tail（stable 为空）", () => {
    const { stable, tail } = splitMarkdownSafePrefix("a\n```js\nhalf");
    assert(stable === "");
    assert(tail === "a\n```js\nhalf");
  });
  it("无围栏按最后一个空行切分", () => {
    const { stable, tail } = splitMarkdownSafePrefix("para one\n\npara two in progress");
    assert(stable === "para one\n\n");
    assert(tail === "para two in progress");
  });
  it("无空行无围栏 → 全部归 tail", () => {
    const { stable, tail } = splitMarkdownSafePrefix("single paragraph");
    assert(stable === "");
  });
  it("列表/表格行内竖线不误判为围栏", () => {
    const { tail } = splitMarkdownSafePrefix("| a | b |\n|---|");
    assert(typeof tail === "string"); // 不崩溃，行为以实现的确定性为准
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```ts
// markdown.ts 追加
export type MarkdownSafeSplit = { stable: string; tail: string };

// 安全前缀切分（对齐官方 control-ui 流式 markdown 做法）：
// 找到最后一个「稳定块边界」——闭合的代码围栏之后，或最后一个空行处。
// 边界之前是已完成结构（可完整解析渲染），之后是进行中内容（调用方按纯文本渲染），
// 避免半截代码围栏被 marked 反复解析成不同结构造成抖动。
export function splitMarkdownSafePrefix(text: string): MarkdownSafeSplit {
  if (!text) {
    return { stable: "", tail: "" };
  }
  // 围栏成对性：奇数个围栏说明最后一个未闭合，边界只能取到倒数第二个围栏之后
  const fenceRe = /^(```|~~~)/gm;
  const fences: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    fences.push(m.index + m[0].length);
  }
  if (fences.length >= 2 && fences.length % 2 === 0) {
    const cut = fences[fences.length - 1];
    const nl = text.indexOf("\n", cut);
    const stableEnd = nl >= 0 ? nl + 1 : text.length;
    return { stable: text.slice(0, stableEnd), tail: text.slice(stableEnd) };
  }
  if (fences.length >= 2) {
    // 奇数围栏：边界取倒数第二个（最后闭合的）围栏之后
    const cut = fences[fences.length - 2];
    const nl = text.indexOf("\n", cut);
    const stableEnd = nl >= 0 ? nl + 1 : text.length;
    return { stable: text.slice(0, stableEnd), tail: text.slice(stableEnd) };
  }
  const lastBlank = text.lastIndexOf("\n\n");
  if (lastBlank >= 0) {
    return { stable: text.slice(0, lastBlank + 2), tail: text.slice(lastBlank + 2) };
  }
  return { stable: "", tail: text };
}
```

- [ ] **Step 4: 运行确认通过** — 新测试全 PASS

---

### Task 9: 流式气泡渐进 markdown 渲染（安全前缀 + 稳定段缓存）

**背景：** 当前流式纯文本渲染（R5 定论，防 O(n²)）。升级为官方做法：稳定段走 `toSanitizedMarkdownHtml`（按稳定段内容缓存，边界推进才重解析），尾部纯文本。稳定段边界只在围栏闭合/空行出现时推进，解析频率远低于每帧。

**Files:**
- Modify: `chat-ui/ui/src/ui/markdown.ts`（新增 `toStreamingMarkdownHtml`）
- Modify: `chat-ui/ui/src/ui/chat/grouped-render.ts:568-584`（streaming 分支）
- Test: `chat-ui/ui/src/ui/markdown.test.ts`（追加）+ 源码审计钉住渲染接线

- [ ] **Step 1: 写失败测试**

```ts
describe("toStreamingMarkdownHtml", () => {
  it("稳定段渲染为 markdown、尾部保持纯文本转义", () => {
    const htmlOut = toStreamingMarkdownHtml("**bold**\n\nhalf `code");
    assert(htmlOut.includes("<strong>bold</strong>"));
    assert(htmlOut.includes("half `code")); // 尾部转义后原样
  });
  it("同稳定段重复调用命中缓存（不重复解析）", () => {
    // 用解析计数观测桩或缓存尺寸断言：连续 3 次同文本，
    // markdownCacheSize 增量 ≤ 1（尾部不进缓存）
  });
  it("无稳定段时全部走纯文本", () => {
    const out = toStreamingMarkdownHtml("plain streaming text");
    assert(!out.includes("<p>"));
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

`markdown.ts`：

```ts
// 流式渐进渲染（对齐官方安全前缀做法）：稳定段完整解析（内容作缓存键，
// 边界不推进时命中缓存不重解析——流式期间解析频率 = 边界推进频率，
// 而非帧率），尾部转义纯文本。尾部不进缓存（每帧都变，进缓存只会污染）。
export function toStreamingMarkdownHtml(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  const { stable, tail } = splitMarkdownSafePrefix(trimmed);
  const stableHtml = stable
    ? toSanitizedMarkdownHtml(stable)
    : "";
  if (!tail) {
    return stableHtml;
  }
  return `${stableHtml}<p>${escapeHtml(tail)}</p>`;
}
```

`grouped-render.ts` streaming 分支（替换 L575-584）：

```ts
  if (opts.isStreaming) {
    const streamHtml = markdown ? toStreamingMarkdownHtml(markdown) : "";
    return html`
      <div class="${bubbleClasses}">
        ${canCopyMarkdown ? renderCopyAsMarkdownButton(markdown!) : nothing}
        ${streamHtml
          ? html`<div class="chat-text chat-text--streaming" dir="${detectTextDirection(markdown)}"
              >${unsafeHTML(linkifyPaths(streamHtml))}</div>`
          : nothing}
      </div>
    `;
  }
```

注意：
- `toSanitizedMarkdownHtml(stable)` 默认走缓存——稳定段内容重复命中，不会挤爆缓存（边界推进频率低）；若实测缓存抖动，改 `bypassCache` + 模块级单槽 `lastStableHtml` 记忆。
- 性能回归观测点：长回复 + 高频围栏切换场景跑一次真机确认帧率（见 Task 13）。

- [ ] **Step 4: 运行确认通过** — 新测试 + 全量 `npm test`

---

### Task 10: 抽取 `<cc-chat-stream>` 组件 + memo 解耦

**背景：** 流式期间 `chatStream` 变化触发整棵 `OpenClawApp` 模板重求值；`buildChatItemsMemoized` 的 memo 键含 `stream` 每帧 miss 全量重建。抽流式气泡为独立组件后，高频更新只命中该组件。

**Files:**
- Create: `chat-ui/ui/src/ui/components/cc-chat-stream.ts`
- Modify: `chat-ui/ui/src/ui/views/chat.ts`（buildChatItems 流式条目构造移出 + memo 键去 `stream`/`streamStartedAt` + renderChat 装配点）
- Modify: `chat-ui/ui/src/ui/app-render.ts`（若装配点在此层，实施时核对）
- Test: 源码审计 + 既有聊天渲染用例回归

- [ ] **Step 1: 取证现状**

读 `views/chat.ts` 中 `buildChatItems` 消费 `props.stream`/`props.streamStartedAt` 的位置（构造流式 ChatItem 的段落）与 `renderChat` 装配流式条目的位置，记录精确行号。确认流式条目与 `chatToolMessages`/`frozenPrefix` 段（leadingSegment）的渲染关系——**工具流时间线（`chatToolMessages`）留在历史侧不动**，只抽「当前正在打字的流式气泡」。

- [ ] **Step 2: 写失败测试（源码审计）**

```ts
it("buildChatItemsMemoized memo 键不再含流式文本", () => {
  const src = read("chat-ui/ui/src/ui/views/chat.ts");
  // ChatItemsMemo 类型与比较逻辑中不含 stream 字段
});
it("renderChat 通过 <cc-chat-stream> 渲染流式气泡", () => {
  const src = read("chat-ui/ui/src/ui/views/chat.ts");
  assert(src.includes("cc-chat-stream"));
});
```

- [ ] **Step 3: 实现**

新组件骨架（`components/cc-chat-stream.ts`）：

```ts
import { LitElement, html, nothing } from "lit";
import { property } from "lit/decorators.js";
// 流式气泡独立组件：chatStream 高频变化只触发本组件重渲染，
// 历史列表与侧边栏不再每帧重求值（R41 渲染层组件化第一步）。
export class CcChatStream extends LitElement {
  @property({ type: String }) stream: string | null = null;
  @property({ attribute: false }) streamingMessage: Record<string, unknown> | null = null;
  @property({ type: Boolean }) showReasoning = false;
  // 关闭 shadow DOM：复用全局样式（项目既有组件模式，实施时对齐其他自定义元素写法）
  createRenderRoot() { return this; }
  render() {
    if (!this.stream && !this.streamingMessage) {
      return nothing;
    }
    // 复用 grouped-render 的单消息渲染（isStreaming: true 分支）——
    // 把 renderChat 里构造流式条目的既有代码原样搬进来，不重写渲染逻辑
    return html`…既有流式条目模板（含 leadingSegment 之后的当前段）…`;
  }
  shouldUpdate(changed: Map<string, unknown>) {
    // 只有流式相关 props 变化才重渲染（防御性：父级误传也不牵连）
    return changed.has("stream") || changed.has("streamingMessage") || changed.has("showReasoning");
  }
}
customElements.define("cc-chat-stream", CcChatStream);
```

改造点：
1. `buildChatItems` 不再接收/消费 `stream`/`streamStartedAt`（`ChatProps` 对应字段移除或标注仅流组件使用）；流式条目构造代码整体搬入 `cc-chat-stream` 的 render。
2. `ChatItemsMemo` 类型与 `buildChatItemsMemoized` 比较删 `stream`/`streamStartedAt` 两键（流式变化不再使历史 memo 失效）。
3. `renderChat` 在历史条目序列末尾追加 `<cc-chat-stream .stream=… .streamingMessage=…>`，条件与原流式条目出现条件一致（含 Stop 按钮/思考指示等周边元素——若它们原本在流式条目模板内，一并搬入组件）。
4. 事件回调（引用/复制等）以属性传入组件。

- [ ] **Step 4: 运行验证**

- 审计测试 PASS
- 全量 `npm test` PASS
- `npm run build` + `npx tsc --noEmit`（对齐项目 typecheck 命令）
- 手工验证：`npm run dev` 发一条长回复，观察流式气泡正常、Stop 可用、终态转历史无跳变

---

### Task 11: 抽取 `<cc-chat-history>` 组件

**背景：** 继续隔离——历史列表只在 `chatMessages`/`visibleCount` 变化时重渲染。

**Files:**
- Create: `chat-ui/ui/src/ui/components/cc-chat-history.ts`
- Modify: `chat-ui/ui/src/ui/views/chat.ts`（历史条目渲染下沉）

- [ ] **Step 1: 写失败测试（源码审计）**：`renderChat` 历史部分经 `<cc-chat-history>` 渲染；`cc-chat-history` 存在 `shouldUpdate` props 浅比较（`messages`/`visibleCount`/`toolMessages`/`sessionKey` 等）。

- [ ] **Step 2: 实现**

组件接收 `messages`（已按可见数截取）、`toolMessages`、`fileChanges`、事件回调集合等属性；内部调用既有 `buildChatItemsMemoized` + 分组渲染（**整体搬迁，不重写**）。`shouldUpdate` 浅比较所有 `@property`：任一引用变化才渲染。注意懒渲染（`hydrateLazyDetailsBody`）、lightbox 事件委托（挂在 `.chat-thread` 容器上的委托若是全局的，确认容器仍在组件外或委托随组件迁移）、滚动锚点元素（`scheduleChatScroll` 读取的元素必须仍可被 `document.querySelector`/既有引用找到——组件 `createRenderRoot` 返回 `this`（无 shadow DOM）可保兼容）。

- [ ] **Step 3: 验证**：审计测试 + 全量测试 + typecheck + 手工：切会话、终态、上翻加载、复制/引用、图片 lightbox 全链路冒烟。

---

### Task 12: 抽取 `<cc-sidebar>` 组件

**背景：** 流式帧不再触发侧边栏模板重求值；同时为第二期图标轨重组落好组件载体。

**Files:**
- Create: `chat-ui/ui/src/ui/components/cc-sidebar.ts`
- Modify: `chat-ui/ui/src/ui/sidebar.ts`（`renderSidebar` 内容迁入组件；保留导出兼容或删除并改调用点）
- Modify: `chat-ui/ui/src/ui/app-render.ts:142`（调用点）

- [ ] **Step 1: 写失败测试（源码审计）**：`app-render.ts` 使用 `<cc-sidebar>`；`SidebarProps` 字段集不变（第二期再精简）。

- [ ] **Step 2: 实现**

`cc-sidebar.ts`：`@property({ attribute: false }) props: SidebarProps | null`；`createRenderRoot() { return this; }`（全局样式兼容 + 会话菜单的 `document.querySelector` 逻辑依赖无 shadow DOM）；`shouldUpdate` 比较 `props` 中会话相关字段引用（`sessionOptions`/`connected`/徽标计数/`settingsBadge` 等）——**注意**：`props` 对象每次 renderApp 都是新字面量，需比较字段值而非对象引用，或改组件直接接收拆分属性（推荐：把 `SidebarProps` 展开为组件属性，`app-render` 逐个绑定）。会话菜单（`sessionMenuKey` 模块态）、内联重命名逻辑随模板整体搬迁。

- [ ] **Step 3: 验证**：审计测试 + 全量测试 + 手工冒烟（会话切换/重命名/菜单/归档切换/徽标/折叠）。

---

### Task 13: 全量验证 + 代码审查 + 发版

- [ ] **Step 1: 全量测试与构建**

```
npm test
npm run build
npm run dupcheck
```

Expected: 0 fail；重复率 ≤1.08% 不回退。

- [ ] **Step 2: CDP 真机冒烟**（对齐发版经验：`npx electron . --remote-debugging-port`，gateway 就绪留 40-50s）：
  - light/dark × 1280/800 宽：聊天页流式长回复、终态无缩回、侧边栏不闪
  - 断连重连（杀网关再起）：历史恢复、无「加载中」频闪
  - 后台会话（若有渠道）收到回复时侧边栏及时更新

- [ ] **Step 3: CodeReview 代理复审**，处理 blocker/major

- [ ] **Step 4: 发版**（用户已授权）：
  - `package.json` version → `2026.828.4`（或当日下一序号）+ `release-notes.json` 顶部条目
  - 同步 `website/index.html` 版本徽章（`hero-version`/`download-version`）
  - `docs/OPTIMIZATION-PROGRESS.md` 追加 `### R41` 小节
  - `git add -A && git commit && git push`
  - `npm run dist:win` → 产物断言 → 安装验证 → `gh release create`
  - 发版后 `npm run dupcheck`

---

## 自审记录

1. **Spec 覆盖**：1.1 组件化 → Task 10-12；memo 解耦 → Task 10；markdown 安全前缀 → Task 8-9；工具流节流 → **已存在**（`app-tool-stream.ts` `TOOL_STREAM_THROTTLE_MS=80` + `scheduleToolStreamSync`，取证确认，无需实施）；1.2 五项修复 → Task 2/1/6/3/5；1.3 本地 patch + silent + ticker 保留 → Task 7/4/（ticker 不动）；1.4 测试 → 每任务内嵌；1.5 不做项无任务。✔
2. **占位符**：Task 7 Step 0 的「取证后按实测结构实现」是外部事实依赖而非设计占位——已给出防御实现与降级路径。其余步骤均有代码。✔
3. **类型一致**：`loadChatHistory` opts 扩展（Task 4）被 Task 6 消费；`splitMarkdownSafePrefix`（Task 8）被 Task 9 消费；`SidebarProps` 第二期精简不在本期。✔
