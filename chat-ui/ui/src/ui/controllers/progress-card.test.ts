// Progress Card（controllers/progress-card.ts）守护测试：
// 1) 纯逻辑：normalizeProgressCard 容错归一 / progressCardStats / canDismissProgressCard /
//    progressCardChangedNeedsReload（事件过滤 + revision 跳过重拉）
// 2) 异步行为（fake client）：loadProgressCard 的 stale 守卫与在途排队、
//    dismissProgressCard 的 expectedRevision 乐观锁与「拿不到 revision 先 get 再 put」
// 3) 源码审计（同 app-gateway-events.test.ts / app-update-notify.test.ts 模式）：
//    app-gateway.ts 的 progressCard.changed 分支 + onHello 重拉、views/chat.ts 挂载、
//    app-chat-props.ts props 接线、session-transition.ts 会话切换清态、i18n 双区键
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  canDismissProgressCard,
  dismissProgressCard,
  emptyProgressCardState,
  handleProgressCardChanged,
  loadProgressCard,
  normalizeProgressCard,
  progressCardChangedNeedsReload,
  progressCardStats,
  type ProgressCard,
  type ProgressCardHost,
} from "./progress-card.ts";

// ── 纯逻辑 ──

test("normalizeProgressCard：合法卡完整解析（markdown + steps + revision）", () => {
  const card = normalizeProgressCard({
    sessionKey: "s1",
    revision: 3,
    updatedAt: 1720000000000,
    markdown: "**进行中**",
    steps: [
      { step: "收集数据", status: "completed" },
      { step: "生成报告", status: "in_progress" },
      { step: "校对", status: "pending" },
    ],
  });
  assert.ok(card);
  assert.equal(card.sessionKey, "s1");
  assert.equal(card.revision, 3);
  assert.equal(card.updatedAt, 1720000000000);
  assert.equal(card.markdown, "**进行中**");
  assert.equal(card.steps?.length, 3);
});

test("normalizeProgressCard：非对象/缺 sessionKey/缺 revision/空卡均返回 null", () => {
  assert.equal(normalizeProgressCard(null), null);
  assert.equal(normalizeProgressCard("card"), null);
  assert.equal(normalizeProgressCard({ revision: 1, markdown: "x" }), null, "缺 sessionKey");
  assert.equal(normalizeProgressCard({ sessionKey: "s1", markdown: "x" }), null, "缺 revision");
  assert.equal(normalizeProgressCard({ sessionKey: "s1", revision: 0, markdown: "x" }), null, "revision < 1");
  assert.equal(normalizeProgressCard({ sessionKey: "s1", revision: 1 }), null, "空卡等价不存在");
  assert.equal(
    normalizeProgressCard({ sessionKey: "s1", revision: 1, markdown: "   ", steps: [] }),
    null,
    "空白 markdown + 空 steps 视为空卡",
  );
});

test("normalizeProgressCard：步骤容错——非法项跳过、未知 status 归 pending、空文本跳过", () => {
  const card = normalizeProgressCard({
    sessionKey: "s1",
    revision: 1,
    steps: [
      null,
      "not-an-object",
      { step: "   ", status: "completed" },
      { step: "合法步骤", status: "weird-status" },
      { step: "缺 status" },
    ],
  });
  assert.ok(card);
  assert.deepEqual(card.steps, [
    { step: "合法步骤", status: "pending" },
    { step: "缺 status", status: "pending" },
  ]);
});

test("normalizeProgressCard：多个 in_progress 只保留首个，其余降级 pending；超 50 步截断", () => {
  const card = normalizeProgressCard({
    sessionKey: "s1",
    revision: 1,
    steps: [
      { step: "a", status: "in_progress" },
      { step: "b", status: "in_progress" },
      { step: "c", status: "in_progress" },
    ],
  });
  assert.ok(card);
  assert.deepEqual(
    card.steps?.map((s) => s.status),
    ["in_progress", "pending", "pending"],
  );

  const many = normalizeProgressCard({
    sessionKey: "s1",
    revision: 1,
    steps: Array.from({ length: 60 }, (_, i) => ({ step: `step-${i}`, status: "pending" })),
  });
  assert.equal(many?.steps?.length, 50, "步骤上限 50（内核 plan ≤50）");
});

test("progressCardStats：计数/完成态/当前步骤", () => {
  const card: ProgressCard = {
    sessionKey: "s1",
    revision: 1,
    steps: [
      { step: "a", status: "completed" },
      { step: "b", status: "in_progress" },
      { step: "c", status: "pending" },
    ],
  };
  const stats = progressCardStats(card);
  assert.equal(stats.total, 3);
  assert.equal(stats.done, 1);
  assert.equal(stats.allDone, false);
  assert.equal(stats.current?.step, "b");

  const done = progressCardStats({
    sessionKey: "s1",
    revision: 2,
    steps: [
      { step: "a", status: "completed" },
      { step: "b", status: "completed" },
    ],
  });
  assert.equal(done.allDone, true);
  assert.equal(done.current, null);

  const noSteps = progressCardStats({ sessionKey: "s1", revision: 1, markdown: "m" });
  assert.equal(noSteps.allDone, false, "无步骤不算 allDone（计数器不显示）");
});

test("canDismissProgressCard：无步骤或全部完成可 dismiss，否则不可（镜像内核清空放行条件）", () => {
  assert.equal(canDismissProgressCard({ sessionKey: "s", revision: 1, markdown: "m" }), true);
  assert.equal(
    canDismissProgressCard({
      sessionKey: "s",
      revision: 1,
      steps: [{ step: "a", status: "completed" }],
    }),
    true,
  );
  assert.equal(
    canDismissProgressCard({
      sessionKey: "s",
      revision: 1,
      steps: [
        { step: "a", status: "completed" },
        { step: "b", status: "in_progress" },
      ],
    }),
    false,
  );
  assert.equal(
    canDismissProgressCard({
      sessionKey: "s",
      revision: 1,
      steps: [{ step: "a", status: "pending" }],
    }),
    false,
  );
});

test("progressCardChangedNeedsReload：跨会话/缺 sessionKey 事件忽略", () => {
  const card: ProgressCard = { sessionKey: "s1", revision: 1, markdown: "m" };
  assert.equal(progressCardChangedNeedsReload(undefined, "s1", card), false);
  assert.equal(progressCardChangedNeedsReload({}, "s1", card), false);
  assert.equal(progressCardChangedNeedsReload({ sessionKey: "s2", revision: 2 }, "s1", card), false);
});

test("progressCardChangedNeedsReload：revision 与本地一致跳过；不一致/清空广播才重拉", () => {
  const card: ProgressCard = { sessionKey: "s1", revision: 2, markdown: "m" };
  assert.equal(progressCardChangedNeedsReload({ sessionKey: "s1", revision: 2 }, "s1", card), false, "事件回声不重拉");
  assert.equal(progressCardChangedNeedsReload({ sessionKey: "s1", revision: 3 }, "s1", card), true);
  assert.equal(progressCardChangedNeedsReload({ sessionKey: "s1", revision: null }, "s1", card), true, "清空广播且本地有卡");
  assert.equal(progressCardChangedNeedsReload({ sessionKey: "s1", revision: null }, "s1", null), false, "本地已空");
  assert.equal(progressCardChangedNeedsReload({ sessionKey: "s1", revision: 1 }, "s1", null), true, "本地无卡但事件有 revision");
});

// ── 异步行为（fake client） ──

type FakeCall = { method: string; params: unknown };

function makeHost(
  responses: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): { host: ProgressCardHost; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const client = {
    request: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      const handler = responses[method];
      if (!handler) {
        throw new Error(`unexpected request: ${method}`);
      }
      return handler(params);
    },
  };
  const host: ProgressCardHost = {
    client: client as unknown as ProgressCardHost["client"],
    connected: true,
    sessionKey: "s1",
    progressCard: emptyProgressCardState("s1"),
  };
  return { host, calls };
}

test("loadProgressCard：拉取并归一化当前会话卡片", async () => {
  const { host, calls } = makeHost({
    "progressCard.get": () => ({
      card: { sessionKey: "s1", revision: 5, markdown: "hello", steps: [{ step: "x", status: "completed" }] },
    }),
  });
  await loadProgressCard(host);
  assert.deepEqual(calls.map((c) => c.method), ["progressCard.get"]);
  assert.deepEqual(calls[0]?.params, { sessionKey: "s1" });
  assert.equal(host.progressCard.card?.revision, 5);
  assert.equal(host.progressCard.loading, false);
  assert.equal(host.progressCard.error, null);
});

test("loadProgressCard：stale 守卫——响应晚到时会话已切换则丢弃", async () => {
  const resolvers: Array<(v: unknown) => void> = [];
  const { host } = makeHost({
    "progressCard.get": () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      }),
  });
  const pending = loadProgressCard(host);
  assert.equal(host.progressCard.loading, true);
  host.sessionKey = "s2"; // 拉取在途期间切换会话
  resolvers[0]?.({ card: { sessionKey: "s1", revision: 1, markdown: "stale" } });
  await pending;
  assert.equal(host.progressCard.card, null, "旧会话响应不得写入新会话状态");
});

test("loadProgressCard：未连接/空会话不发起请求", async () => {
  const { host, calls } = makeHost({});
  host.connected = false;
  await loadProgressCard(host);
  host.connected = true;
  host.sessionKey = "  ";
  await loadProgressCard(host);
  assert.equal(calls.length, 0);
});

test("loadProgressCard：在途期间再次请求置脏，完成后补跑一轮", async () => {
  let round = 0;
  const { host, calls } = makeHost({
    "progressCard.get": () => {
      round += 1;
      return { card: { sessionKey: "s1", revision: round, markdown: `r${round}` } };
    },
  });
  const first = loadProgressCard(host);
  // loading 在首个 await 之前同步置位；趁在途（未让出微任务）再触发一次 → 应置脏而非并发第二枪
  assert.equal(host.progressCard.loading, true);
  void loadProgressCard(host);
  await first;
  // 补跑是异步的，等微任务收敛
  await new Promise((resolve) => setTimeout(resolve, 0));
  const getCalls = calls.filter((c) => c.method === "progressCard.get");
  assert.equal(getCalls.length, 2, "在途期间的刷新请求应在完成后补跑");
  assert.equal(host.progressCard.card?.revision, 2, "最终状态为补跑结果");
});

test("handleProgressCardChanged：命中当前会话且 revision 不同才重拉", async () => {
  const { host, calls } = makeHost({
    "progressCard.get": () => ({ card: { sessionKey: "s1", revision: 2, markdown: "new" } }),
  });
  host.progressCard = {
    ...host.progressCard,
    card: { sessionKey: "s1", revision: 1, markdown: "old" },
  };
  handleProgressCardChanged(host, { sessionKey: "s2", revision: 9 });
  handleProgressCardChanged(host, { sessionKey: "s1", revision: 1 }); // 回声：revision 一致
  assert.equal(calls.length, 0, "跨会话与回声事件不应触发拉取");
  handleProgressCardChanged(host, { sessionKey: "s1", revision: 2 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.filter((c) => c.method === "progressCard.get").length, 1);
  assert.equal(host.progressCard.card?.markdown, "new");
});

test("dismissProgressCard：带 expectedRevision 清空；内核返回 card=null 视为成功", async () => {
  const { host, calls } = makeHost({
    "progressCard.put": () => ({ card: null }),
  });
  host.progressCard = {
    ...host.progressCard,
    card: { sessionKey: "s1", revision: 7, markdown: "m" },
  };
  const ok = await dismissProgressCard(host);
  assert.equal(ok, true);
  assert.deepEqual(calls, [
    { method: "progressCard.put", params: { sessionKey: "s1", expectedRevision: 7 } },
  ]);
  assert.equal(host.progressCard.card, null);
  assert.equal(host.progressCard.dismissing, false);
});

test("dismissProgressCard：本地无卡时先 get 再 put（拿不到 revision 的兜底路径）", async () => {
  const { host, calls } = makeHost({
    "progressCard.get": () => ({ card: { sessionKey: "s1", revision: 4, markdown: "m" } }),
    "progressCard.put": () => ({ card: null }),
  });
  const ok = await dismissProgressCard(host);
  assert.equal(ok, true);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["progressCard.get", "progressCard.put"],
  );
  assert.deepEqual(calls[1]?.params, { sessionKey: "s1", expectedRevision: 4 });
});

test("dismissProgressCard：内核拒绝清空（返回当前卡）时校正本地状态、不算成功", async () => {
  const current = { sessionKey: "s1", revision: 8, steps: [{ step: "a", status: "in_progress" }] };
  const { host } = makeHost({
    "progressCard.put": () => ({ card: current }),
  });
  host.progressCard = { ...host.progressCard, card: { ...current, revision: 8 } as ProgressCard };
  const ok = await dismissProgressCard(host);
  assert.equal(ok, false);
  assert.equal(host.progressCard.card?.revision, 8, "拒绝时以返回值刷新本地卡");
  assert.equal(host.progressCard.dismissing, false);
});

test("dismissProgressCard：get 后仍无卡则不 put；dismissing 重入被拒", async () => {
  const { host, calls } = makeHost({
    "progressCard.get": () => ({ card: null }),
  });
  const ok = await dismissProgressCard(host);
  assert.equal(ok, false);
  assert.deepEqual(calls.map((c) => c.method), ["progressCard.get"], "无卡不得发起 put");

  host.progressCard = { ...host.progressCard, dismissing: true, card: { sessionKey: "s1", revision: 1, markdown: "m" } };
  const reentry = await dismissProgressCard(host);
  assert.equal(reentry, false);
  assert.equal(calls.filter((c) => c.method === "progressCard.put").length, 0);
});

test("loadProgressCard：不同 host 的在途刷新队列互不干扰", async () => {
  const deferred: Array<(value: unknown) => void> = [];
  const { host: firstHost, calls: firstCalls } = makeHost({
    "progressCard.get": () =>
      new Promise((resolve) => {
        deferred.push(resolve);
      }),
  });
  const { host: secondHost, calls: secondCalls } = makeHost({
    "progressCard.get": () => ({ card: { sessionKey: "s1", revision: 1, markdown: "second" } }),
  });

  const firstLoad = loadProgressCard(firstHost);
  void loadProgressCard(firstHost); // queue a refresh only for the first host
  await loadProgressCard(secondHost);
  assert.equal(secondCalls.filter((call) => call.method === "progressCard.get").length, 1);

  deferred[0]?.({ card: { sessionKey: "s1", revision: 1, markdown: "first" } });
  await firstLoad;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(firstCalls.filter((call) => call.method === "progressCard.get").length, 2);
  assert.equal(secondCalls.filter((call) => call.method === "progressCard.get").length, 1);
});

test("dismissProgressCard：无本地卡时 fetch 前即上锁，连续 dismiss 只清空一次", async () => {
  let resolveGet: ((value: unknown) => void) | undefined;
  const { host, calls } = makeHost({
    "progressCard.get": () =>
      new Promise((resolve) => {
        resolveGet = resolve;
      }),
    "progressCard.put": () => ({ card: null }),
  });
  const first = dismissProgressCard(host);
  const second = dismissProgressCard(host);
  assert.equal(host.progressCard.dismissing, true);
  assert.equal(await second, false, "第二次 dismiss 必须被 fetch 前的锁拒绝");
  resolveGet?.({ card: { sessionKey: "s1", revision: 4, markdown: "m" } });
  assert.equal(await first, true);
  assert.deepEqual(calls.map((call) => call.method), ["progressCard.get", "progressCard.put"]);
  assert.equal(host.progressCard.dismissing, false);
});
// ── 源码审计（钉住接线；重 UI 模块在 node 下不可导入） ──

// 编译产物位于 chat-ui/ui/.test-dist/ui/src/ui/controllers/，源文件位于 chat-ui/ui/src/ui/
function src(rel: string): string {
  return readFileSync(new URL(`../../../../../src/ui/${rel}`, import.meta.url), "utf8");
}

test("app-gateway.ts：progressCard.changed 事件分支失效重拉 + onHello 重拉当前会话", () => {
  const s = src("app-gateway.ts");
  assert.match(s, /if \(evt\.event === "progressCard\.changed"\)/, "缺少 progressCard.changed 事件分支");
  assert.match(
    s,
    /if \(evt\.event === "progressCard\.changed"\) \{[\s\S]*?handleProgressCardChanged\([\s\S]*?return;/,
    "changed 分支应调 handleProgressCardChanged 后 return",
  );
  assert.match(
    s,
    /onHello[\s\S]*?void loadTasks\(host as unknown as OpenClawApp\);[\s\S]*?void loadProgressCard\(host as unknown as OpenClawApp\);/,
    "onHello 应在 loadTasks 后重拉当前会话 Progress Card（断连窗口事件已丢失）",
  );
});

test("views/chat.ts：Progress Card 优先替代旧 plan，旧内核与历史会话仍保留 fallback", () => {
  const s = src("views/chat.ts");
  assert.match(s, /import \{ renderProgressCard \} from "\.\/progress-card\.ts";/, "应引入 renderProgressCard");
  assert.match(
    s,
    /const hasProgressCardForSession =[\s\S]*?props\.progressCard\.card\?\.sessionKey === props\.sessionKey/,
    "有效新卡必须按当前会话确认",
  );
  assert.match(
    s,
    /!hasProgressCardForSession[\s\S]*?\? renderPlanPanel\(props\.plan[\s\S]*?: nothing[\s\S]*?renderProgressCard\(props\.progressCard[\s\S]*?renderExecStrip\(props\)/,
    "新卡存在时应隐藏 legacy plan；无卡时回退旧 plan，并仍在审批弹条前渲染",
  );
  assert.match(s, /runActive: props\.runActive/, "无活跃 run 降级 paused 依赖 runActive 透传");
});

test("app-chat-props.ts：progressCard props 接线（状态/折叠偏好/dismiss）", () => {
  const s = src("app-chat-props.ts");
  assert.match(s, /progressCard: state\.progressCard/, "应透传 progressCard 状态");
  assert.match(
    s,
    /progressCardCollapsed: state\.settings\.chatProgressCardCollapsed/,
    "折叠态应读取持久化偏好 chatProgressCardCollapsed",
  );
  assert.match(
    s,
    /chatProgressCardCollapsed: !state\.settings\.chatProgressCardCollapsed/,
    "折叠切换应写回 UiSettings（applySettings 持久化）",
  );
  assert.match(s, /onDismissProgressCard: \(\) => void dismissProgressCard\(state\)/, "dismiss 应走 controller");
});

test("session-transition.ts：会话切换静态重建 Progress Card 状态", () => {
  const s = src("session-transition.ts");
  assert.match(
    s,
    /import \{ resetProgressCardForSession, type ProgressCardHost \} from "\.\/controllers\/progress-card\.ts";/,
    "切换会话应静态引入 Progress Card controller，避免新增动态 import chunk",
  );
  assert.match(s, /resetProgressCardForSession\(host as unknown as ProgressCardHost, trimmed\);/);
  assert.doesNotMatch(s, /import\("\.\/controllers\/progress-card\.ts"\)/);
});

test("progress-card controller：刷新队列按 host 隔离，失败提示不泄漏内部错误", () => {
  const s = src("controllers/progress-card.ts");
  assert.match(s, /new WeakMap<ProgressCardHost, string>\(\)/);
  assert.match(s, /new WeakMap<ProgressCardHost, symbol>\(\)/);
  assert.match(s, /error: "refresh_failed"/);
  assert.match(s, /error: "dismiss_failed"/);
});

test("storage.ts：chatProgressCardCollapsed 持久化字段齐备", () => {
  const s = src("storage.ts");
  assert.match(s, /chatProgressCardCollapsed: boolean/, "UiSettings 应声明该字段");
  assert.match(s, /chatProgressCardCollapsed: false/, "默认值应为 false（展开）");
  assert.match(
    s,
    /typeof parsed\.chatProgressCardCollapsed === "boolean"/,
    "解析侧应做 boolean 校验（防脏缓存）",
  );
});

test("styles/chat.css：Progress Card 样式块存在且无硬编码 hex", () => {
  const s = src("../styles/chat.css");
  assert.match(s, /\.chat-progress-card \{/, "缺 .chat-progress-card 主块");
  assert.match(s, /\.chat-progress-card__spinner/, "缺 in_progress spinner 样式");
  assert.match(s, /\.chat-progress-card--done/, "缺全部完成的完成态样式");
  const start = s.indexOf(".chat-progress-card {");
  const block = s.slice(start);
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, "样式块不得硬编码 hex（走 design token）");
});

test("i18n：progressCard.* 键双区齐全（全集一致性由 i18n.test.ts 保证）", () => {
  const zh = src("i18n/zh.ts");
  const en = src("i18n/en.ts");
  for (const key of [
    "progressCard.title",
    "progressCard.collapse",
    "progressCard.expand",
    "progressCard.dismiss",
    "progressCard.paused",
  ]) {
    assert.ok(zh.includes(`"${key}"`), `zh 缺 ${key}`);
    assert.ok(en.includes(`"${key}"`), `en 缺 ${key}`);
  }
});
