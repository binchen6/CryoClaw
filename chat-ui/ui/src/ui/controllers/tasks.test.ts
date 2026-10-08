import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveRunStats,
  enrichRunJobNames,
  filterRunsByQuery,
  loadRunHistory,
  runGroupOfStatus,
  runMatchesStatusFilter,
  runTimestampMs,
  sortRunsByTimestamp,
  toRunTimestampMs,
  type RunHistoryState,
} from "./tasks.ts";
import { capabilitiesOf, supportsMethod, supportsEvent } from "./capabilities.ts";
import type { GatewayHelloOk } from "../gateway.ts";
import type { CronJob, CronRunLogEntry } from "../types.ts";

function run(overrides: Partial<CronRunLogEntry> = {}): CronRunLogEntry {
  return { ts: 1000, jobId: "job-1", status: "ok", ...overrides };
}

test("sortRunsByTimestamp 按 ts 降序，runAtMs 兜底，缺失时间戳排在末尾", () => {
  const a = run({ ts: 100 });
  const b = run({ ts: 300 });
  const c = run({ ts: undefined as unknown as number });
  const d = run({ ts: undefined as unknown as number, runAtMs: 200 });

  const sorted = sortRunsByTimestamp([a, b, c, d]);
  assert.deepEqual(
    sorted.map((r) => runTimestampMs(r)),
    [300, 200, 100, null],
  );
});

test("sortRunsByTimestamp 不修改原数组", () => {
  const input = [run({ ts: 100 }), run({ ts: 300 })];
  sortRunsByTimestamp(input);
  assert.deepEqual(
    input.map((r) => r.ts),
    [100, 300],
  );
});

test("toRunTimestampMs：number / ISO string 均解析，非法值返回 null", () => {
  assert.equal(toRunTimestampMs(123), 123);
  assert.equal(toRunTimestampMs("1970-01-01T00:00:01.000Z"), 1000);
  assert.equal(toRunTimestampMs("not-a-date"), null);
  assert.equal(toRunTimestampMs(undefined), null);
  assert.equal(toRunTimestampMs(Number.NaN), null);
});

test("runGroupOfStatus：ok/error/skipped 直通，缺省与未知字符串归 other", () => {
  assert.equal(runGroupOfStatus("ok"), "ok");
  assert.equal(runGroupOfStatus("error"), "error");
  assert.equal(runGroupOfStatus("skipped"), "skipped");
  assert.equal(runGroupOfStatus(undefined), "other");
  assert.equal(runGroupOfStatus("weird"), "other");
});

test("deriveRunStats：混合状态计数（other 含缺省与未知状态）", () => {
  const runs: CronRunLogEntry[] = [
    run({ status: "ok" }),
    run({ status: "ok" }),
    run({ status: "error" }),
    run({ status: "skipped" }),
    run({ status: undefined }),
    run({ status: "weird" }),
  ];
  const stats = deriveRunStats(runs);
  assert.equal(stats.ok, 2);
  assert.equal(stats.error, 1);
  assert.equal(stats.skipped, 1);
  assert.equal(stats.other, 2);
  assert.equal(stats.total, 6);
});

test("filterRunsByQuery：jobName/jobId/summary/error/sessionKey 命中 + 大小写不敏感 + trim", () => {
  const runs: CronRunLogEntry[] = [
    run({ jobId: "j1", jobName: "Deploy Nightly" }),
    run({ jobId: "j2", summary: "agent-ALPHA finished" }),
    run({ jobId: "j3", sessionKey: "sess/beta/main" }),
    run({ jobId: "j4", status: "error", error: "housekeeping failed" }),
  ];
  assert.deepEqual(
    filterRunsByQuery(runs, "  nightly  ").map((x) => x.jobId),
    ["j1"],
    "jobName 命中且两侧 trim",
  );
  assert.deepEqual(
    filterRunsByQuery(runs, "AGENT-alpha").map((x) => x.jobId),
    ["j2"],
    "summary 命中且大小写不敏感",
  );
  assert.deepEqual(
    filterRunsByQuery(runs, "BETA").map((x) => x.jobId),
    ["j3"],
    "sessionKey 命中",
  );
  assert.deepEqual(
    filterRunsByQuery(runs, "housekeeping").map((x) => x.jobId),
    ["j4"],
    "error 命中",
  );
  // 空查询（含纯空白）原样返回，不做过滤
  assert.equal(filterRunsByQuery(runs, "").length, 4);
  assert.equal(filterRunsByQuery(runs, "   ").length, 4);
  // 无命中
  assert.deepEqual(filterRunsByQuery(runs, "nonexistent"), []);
});

test("runMatchesStatusFilter：select 单状态优先，chip 分组兜底，other 覆盖未知状态", () => {
  const okRun = run({ status: "ok" });
  const weirdRun = run({ status: "weird" });
  assert.equal(runMatchesStatusFilter(okRun, "all", "all"), true);
  assert.equal(runMatchesStatusFilter(okRun, "ok", "all"), true);
  assert.equal(runMatchesStatusFilter(okRun, "error", "all"), false);
  assert.equal(runMatchesStatusFilter(weirdRun, "all", "other"), true);
  assert.equal(runMatchesStatusFilter(okRun, "all", "other"), false);
  // select 生效时忽略分组态（视图互斥联动的纯函数侧语义）
  assert.equal(runMatchesStatusFilter(okRun, "ok", "error"), true);
});

test("enrichRunJobNames：缺 jobName 的记录按 cron.list 反查补全，已有值不覆盖", () => {
  const jobs: CronJob[] = [
    { id: "j1", name: "Nightly", schedule: { kind: "cron" }, payload: { kind: "agentTurn" } },
  ];
  const runs: CronRunLogEntry[] = [
    run({ jobId: "j1" }),
    run({ jobId: "j1", jobName: "已有名" }),
    run({ jobId: "gone" }),
  ];
  const next = enrichRunJobNames(runs, jobs);
  assert.equal(next[0].jobName, "Nightly");
  assert.equal(next[1].jobName, "已有名");
  assert.equal(next[2].jobName, undefined, "任务已删除时不补全");
  // 全部已有 jobName / 空任务列表时原样返回（引用不变）
  const untouched = [runs[1]];
  assert.equal(enrichRunJobNames(untouched, jobs), untouched);
  assert.equal(enrichRunJobNames(runs, []), runs);
});

// ── 能力门控 ────────────────────────────────────────────────────────

function helloWith(methods: string[] | undefined, events: string[] | undefined): GatewayHelloOk {
  const features: { methods?: string[]; events?: string[] } = {};
  if (methods) features.methods = methods;
  if (events) features.events = events;
  return { type: "hello-ok", protocol: 4, features } as GatewayHelloOk;
}

test("supportsMethod 判定表：无能力面保守放行，有能力面按集合命中", () => {
  assert.equal(supportsMethod(null, "cron.runs"), true, "hello 缺失（未连接）保守放行");
  assert.equal(supportsMethod(helloWith(undefined, undefined), "cron.runs"), true, "内核未声明 features 保守放行");
  assert.equal(supportsMethod(helloWith(["cron.runs", "cron.list"], undefined), "cron.runs"), true);
  assert.equal(supportsMethod(helloWith(["cron.list"], undefined), "cron.runs"), false);
  assert.equal(supportsMethod(helloWith(["cron.list"], undefined), "tasks.list"), false, "2026.9.7 形态：无 tasks.*");
  assert.equal(supportsEvent(helloWith(undefined, ["task.suggestion"]), "task"), false);
  assert.equal(supportsEvent(helloWith(undefined, ["cron"]), "cron"), true);
  // 缓存一致性：同一 hello 对象多次解析结果稳定
  const h = helloWith(["a.b"], undefined);
  assert.equal(capabilitiesOf(h), capabilitiesOf(h));
});

function fakeState(hello: GatewayHelloOk | null): RunHistoryState & { requests: Array<{ method: string; params: unknown }> } {
  const requests: Array<{ method: string; params: unknown }> = [];
  return {
    client: {
      request: (method: string, params: unknown) => {
        requests.push({ method, params });
        return Promise.resolve({ entries: [run({ ts: 100 }), run({ ts: 300, jobName: "Nightly" })] });
      },
    } as unknown as RunHistoryState["client"],
    connected: true,
    hello,
    runsLoading: false,
    runsError: null,
    runHistory: [],
    runsStatusFilter: "all",
    cronJobs: [],
    runsUnsupported: false,
    requests,
  };
}

test("loadRunHistory：内核无 cron.runs 时零请求并置空态标记", async () => {
  const state = fakeState(helloWith(["cron.list"], ["task.suggestion"]));
  await loadRunHistory(state);
  assert.deepEqual(state.requests, [], "不得发出死 RPC");
  assert.equal(state.runsUnsupported, true);
  assert.equal(state.runsError, null, "门控路径不报错");
});

test("loadRunHistory：内核有 cron.runs 时以 scope:all 拉取并按时间降序", async () => {
  const state = fakeState(helloWith(["cron.runs"], undefined));
  await loadRunHistory(state);
  assert.deepEqual(
    state.requests.map((r) => r.method),
    ["cron.runs"],
  );
  assert.deepEqual(state.requests[0].params, { scope: "all", limit: 200 });
  assert.equal(state.runsUnsupported, false);
  assert.deepEqual(
    state.runHistory.map((r) => r.ts),
    [300, 100],
    "按展示时间降序",
  );
});

test("loadRunHistory：响应缺 entries 字段时防御为空数组", async () => {
  const state = fakeState(helloWith(undefined, undefined)); // 未声明 features → 保守放行
  (state.client as unknown as { request: () => Promise<unknown> }).request = () => Promise.resolve({});
  await loadRunHistory(state);
  assert.deepEqual(state.runHistory, []);
  assert.equal(state.runsError, null);
});
