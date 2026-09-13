/**
 * 用量 tab 纯逻辑测试（v2026.913.3 重构）。
 * 载荷形态依据内核 2026.9.3 dist 取证（usage-lCaKvodi.mjs / session-cost-usage-CX1-5s8P.mjs）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mapSessionsUsage,
  mapUsageCost,
  mapUsageStatus,
  resolveUsageRange,
  resolveUsageSessionDisplayLabel,
  sharePercent,
  topRows,
  USAGE_RANGE_IDS,
  type UsageRangeId,
} from "./tab-usage.lib.ts";

test("resolveUsageRange：today/7d/30d/all 的日期边界", () => {
  const now = new Date(2026, 8, 13); // 2026-09-13 本地时区
  const today = resolveUsageRange("today", now);
  assert.equal(today.startDate, "2026-09-13");
  assert.equal(today.endDate, "2026-09-13");
  const d7 = resolveUsageRange("7d", now);
  assert.equal(d7.startDate, "2026-09-07");
  assert.equal(d7.endDate, "2026-09-13");
  const d30 = resolveUsageRange("30d", now);
  assert.equal(d30.startDate, "2026-08-15");
  const all = resolveUsageRange("all", now);
  assert.equal(all.startDate, "2000-01-01");
  assert.equal(USAGE_RANGE_IDS.length, 4);
  for (const id of USAGE_RANGE_IDS as UsageRangeId[]) {
    const r = resolveUsageRange(id, now);
    assert.match(r.startDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(r.endDate, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("mapUsageCost：daily 按日期升序 + totals 宽容映射", () => {
  const { totals, daily } = mapUsageCost({
    totals: { input: 100, output: 50, cacheRead: 25, totalTokens: 175, totalCost: 0.5 },
    daily: [
      { date: "2026-09-13", input: 10, output: 5, cacheRead: 1, totalTokens: 16, totalCost: 0.05 },
      { date: "2026-09-12", input: 20, output: 8, cacheRead: 2, totalTokens: 30, totalCost: 0.1 },
    ],
  });
  assert.equal(totals?.input, 100);
  assert.equal(totals?.totalCost, 0.5);
  assert.equal(daily.length, 2);
  assert.equal(daily[0]!.date, "2026-09-12");
  assert.equal(daily[1]!.date, "2026-09-13");
});

test("mapUsageCost：异常载荷降级为空", () => {
  assert.deepEqual(mapUsageCost(null), { totals: null, daily: [] });
  assert.deepEqual(mapUsageCost(42), { totals: null, daily: [] });
});

test("mapSessionsUsage：会话行/主会话判定/聚合映射", () => {
  const { rows, totals, aggregates } = mapSessionsUsage({
    totals: { input: 1, output: 2, cacheRead: 3 },
    sessions: [
      {
        key: "agent:main:main",
        sessionId: "s-main",
        agentId: "main",
        label: "主会话",
        usage: { input: 10, output: 20, cacheRead: 5, totalCost: 0.2 },
        updatedAt: 2,
      },
      {
        key: "agent:main:weixin-1",
        sessionId: "s-wx",
        agentId: "main",
        origin: { label: "微信群" },
        model: "zai-cn-coding/GLM-5.3-Flash",
        usage: { input: 1, output: 2, cacheRead: 0, totalCost: 0.02 },
        updatedAt: 3,
      },
    ],
    aggregates: {
      sessionCount: 2,
      messages: { total: 10, user: 4, assistant: 5, toolCalls: 6, errors: 1 },
      tools: { totalCalls: 6, tools: [{ name: "exec", count: 4, totals: { totalTokens: 100 } }] },
      byModel: [{ provider: "zai-cn-coding", model: "GLM-5.3-Flash", count: 8, totals: { totalTokens: 500 } }],
      byProvider: [{ provider: "zai-cn-coding", count: 8, totals: { totalTokens: 500 } }],
      byChannel: [{ channel: "weixin", count: 2, totals: { totalTokens: 50 } }],
    },
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.sessionId, "s-wx"); // updatedAt 倒序
  assert.equal(totals?.output, 2);
  assert.equal(aggregates?.sessionCount, 2);
  assert.equal(aggregates?.messages.toolCalls, 6);
  assert.equal(aggregates?.byModel[0]!.label, "zai-cn-coding/GLM-5.3-Flash");
  assert.equal(aggregates?.byProvider[0]!.label, "zai-cn-coding");
  assert.equal(aggregates?.byChannel[0]!.label, "weixin");
  assert.equal(aggregates?.tools[0]!.label, "exec");
  assert.equal(aggregates?.tools[0]!.tokens, 100);
});

test("resolveUsageSessionDisplayLabel：主会话固定展示 + 自定义 label 优先", () => {
  const base = { key: "", customLabel: null, originLabel: null, sessionId: "sid", isMain: false };
  assert.equal(
    mapLabel({ ...base, key: "agent:main:main", isMain: true, customLabel: "x" }),
    "agent:main:main",
  );
  assert.equal(mapLabel({ ...base, key: "agent:main:weixin-1", customLabel: "群", originLabel: "渠道" }), "群");
  assert.equal(mapLabel({ ...base, key: "agent:main:weixin-1", originLabel: "渠道" }), "渠道");
  assert.equal(mapLabel(base), "sid");
  function mapLabel(row: Parameters<typeof resolveUsageSessionDisplayLabel>[0]) {
    return resolveUsageSessionDisplayLabel(row);
  }
});

test("mapUsageStatus：窗口百分比裁剪到 0-100，非数值降级 null", () => {
  const status = mapUsageStatus({
    providers: [
      { provider: "kimi", windows: [{ label: "5h", usedPercent: 180, resetAt: "2026-09-13T12:00:00Z" }, { label: "bad", usedPercent: "x" }] },
      { provider: "", windows: [] },
      "junk",
    ],
  });
  assert.equal(status.length, 1);
  assert.equal(status[0]!.provider, "kimi");
  assert.equal(status[0]!.windows.length, 2);
  assert.equal(status[0]!.windows[0]!.usedPercent, 100);
  assert.equal(status[0]!.windows[1]!.usedPercent, null);
});

test("topRows：按 tokens 降序取前 N", () => {
  const rows = [
    { label: "a", count: 1, tokens: 10 },
    { label: "b", count: 9, tokens: 30 },
    { label: "c", count: 2, tokens: 20 },
  ];
  const top = topRows(rows, 2);
  assert.deepEqual(top.map((r) => r.label), ["b", "c"]);
});

test("sharePercent：max<=0 与比例边界", () => {
  assert.equal(sharePercent(5, 0), 0);
  assert.equal(sharePercent(50, 100), 50);
  assert.equal(sharePercent(200, 100), 100);
});
