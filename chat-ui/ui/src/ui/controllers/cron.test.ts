import test from "node:test";
import assert from "node:assert/strict";
import { buildCronSchedule, normalizeScheduleKindChange } from "./cron.ts";
import { DEFAULT_CRON_FORM } from "../app-defaults.ts";
import type { CronFormState } from "../ui-types.ts";

function form(over: Partial<CronFormState> = {}): CronFormState {
  return { ...DEFAULT_CRON_FORM, ...over };
}

test("切到 daily：cron 表达式 → 归一化为 HH:MM，显示值不再与 state 脱节", () => {
  const next = normalizeScheduleKindChange(
    form({ scheduleKind: "cron", cronExpr: "0 7 * * *" }),
    { scheduleKind: "daily" },
  );
  assert.equal(next.cronExpr, "10:00");
  // 归一化后即可直接创建（此前会抛 dailyTime 错）
  assert.equal(buildCronSchedule(next).expr, "0 10 * * *");
});

test("切到 daily：已是 HH:MM 时保留用户填的时间", () => {
  const next = normalizeScheduleKindChange(
    form({ scheduleKind: "cron", cronExpr: "07:30" }),
    { scheduleKind: "daily" },
  );
  assert.equal(next.cronExpr, "07:30");
  assert.equal(buildCronSchedule(next).expr, "30 7 * * *");
});

test("daily → cron：HH:MM 转成等价五段表达式（反向脱节同样修复）", () => {
  const next = normalizeScheduleKindChange(
    form({ scheduleKind: "daily", cronExpr: "09:05" }),
    { scheduleKind: "cron" },
  );
  assert.equal(next.cronExpr, "5 9 * * *");
});

test("切到 at/every 不动 cronExpr；未切 kind 时也不动", () => {
  const toAt = normalizeScheduleKindChange(
    form({ scheduleKind: "cron", cronExpr: "0 7 * * *" }),
    { scheduleKind: "at" },
  );
  assert.equal(toAt.cronExpr, "0 7 * * *");
  const same = normalizeScheduleKindChange(
    form({ scheduleKind: "cron", cronExpr: "0 7 * * *" }),
    { name: "x" },
  );
  assert.equal(same.cronExpr, "0 7 * * *");
  assert.equal(same.name, "x");
});

test("normalize 返回新对象，不改入参", () => {
  const original = form({ scheduleKind: "cron", cronExpr: "0 7 * * *" });
  const next = normalizeScheduleKindChange(original, { scheduleKind: "daily" });
  assert.equal(original.cronExpr, "0 7 * * *");
  assert.notEqual(next, original);
});

// ── 能力门控（2026.9.7 适配）：内核未注册对应 cron.* 时零请求静默跳过 ──

import { loadCronJobs, loadCronRuns, loadCronStatus, type CronState } from "./cron.ts";
import type { GatewayHelloOk } from "../gateway.ts";

function helloWith(methods: string[] | undefined): GatewayHelloOk {
  const features: { methods?: string[] } = {};
  if (methods) features.methods = methods;
  return { type: "hello-ok", protocol: 4, features } as GatewayHelloOk;
}

function fakeCronState(hello: GatewayHelloOk | null): CronState & { requests: string[] } {
  const requests: string[] = [];
  return {
    client: {
      request: (method: string) => {
        requests.push(method);
        return Promise.resolve({ jobs: [], entries: [] });
      },
    } as unknown as CronState["client"],
    connected: true,
    hello,
    cronLoading: false,
    cronJobs: [],
    cronStatus: null,
    cronError: null,
    cronForm: form(),
    cronRunsJobId: null,
    cronRuns: [],
    cronBusy: false,
    requests,
  };
}

test("loadCronJobs / loadCronStatus：内核声明无对应方法时零请求", async () => {
  const state = fakeCronState(helloWith(["chat.history"]));
  await loadCronJobs(state);
  await loadCronStatus(state);
  await loadCronRuns(state, "job-1");
  assert.deepEqual(state.requests, [], "未注册的 cron.* 不得发出死 RPC");
});

test("loadCronJobs / loadCronStatus：内核声明对应方法或缺省保守放行时正常请求", async () => {
  const gated = fakeCronState(helloWith(["cron.list", "cron.status", "cron.runs"]));
  await loadCronJobs(gated);
  await loadCronStatus(gated);
  await loadCronRuns(gated, "job-1");
  assert.deepEqual(gated.requests, ["cron.list", "cron.status", "cron.runs"]);

  const legacy = fakeCronState(helloWith(undefined));
  await loadCronJobs(legacy);
  assert.deepEqual(legacy.requests, ["cron.list"], "未声明 features 的旧内核保守放行");
});
