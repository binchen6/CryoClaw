import test from "node:test";
import assert from "node:assert/strict";
import { buildCronSchedule, buildCronPayload, cronJobToForm, normalizeScheduleKindChange } from "./cron.ts";
import type { CronJob } from "../types.ts";
import { DEFAULT_CRON_FORM } from "../app-defaults.ts";
import type { CronFormState } from "../ui-types.ts";

function form(over: Partial<CronFormState> = {}): CronFormState {
  return { ...DEFAULT_CRON_FORM, ...over };
}

test("editing keeps disabled state, metadata, payload timeout and delivery", () => {
  const job: CronJob={id:"a",name:"A",enabled:false,description:"keep",agentId:"agent-b",wakeMode:"next-heartbeat",sessionTarget:"isolated",schedule:{kind:"cron",expr:"30 8 * * *",tz:"Asia/Shanghai"},payload:{kind:"agentTurn",message:"hello",model:"provider/model",timeoutSeconds:123},delivery:{mode:"announce",channel:"test",to:"user"}};
  const edit=cronJobToForm(job,form());
  assert.equal(edit.enabled,false);assert.equal(edit.description,"keep");assert.equal(edit.agentId,"agent-b");assert.equal(edit.wakeMode,"next-heartbeat");
  assert.deepEqual(buildCronSchedule(edit),job.schedule);
  assert.deepEqual(buildCronPayload(edit),job.payload);
  assert.equal(edit.deliveryTo,"user");assert.equal(edit.deliveryChannel,"test");
});

test("one-shot UTC time survives a local datetime input round trip", () => {
  const at="2027-06-01T03:04:05.123Z";
  const edit=cronJobToForm({id:"a",schedule:{kind:"at",at},payload:{kind:"agentTurn",message:"hello"}},form());
  assert.doesNotMatch(edit.scheduleAt,/Z$/);
  assert.equal(buildCronSchedule(edit).at,at);
});

test("editing preserves second and millisecond intervals without rounding", () => {
  for(const everyMs of [1,1001,30000,90000,60000,3600000,86400000]){
    const edit=cronJobToForm({id:"a",schedule:{kind:"every",everyMs},payload:{kind:"agentTurn",message:"hello"}},form());
    assert.equal(buildCronSchedule(edit).everyMs,everyMs);
  }
});

test("daily schedule rejects out-of-range hours and minutes", () => {
  for (const cronExpr of ["24:00", "23:60", "99:99", "-1:00"]) {
    assert.throws(() => buildCronSchedule(form({scheduleKind:"daily",cronExpr})));
  }
  assert.equal(buildCronSchedule(form({scheduleKind:"daily",cronExpr:"23:59"})).expr,"59 23 * * *");
  assert.equal(buildCronSchedule(form({scheduleKind:"daily",cronExpr:"0:00"})).expr,"0 0 * * *");
});

test("interval schedule rejects unknown units and unsafe millisecond values", () => {
  for (const patch of [{everyAmount:"1e308"},{everyAmount:"Infinity"},{everyAmount:"0"},{everyAmount:"0.00000001"},{everyUnit:"weeks"}]) {
    assert.throws(() => buildCronSchedule(form({scheduleKind:"every",...patch})));
  }
  assert.equal(buildCronSchedule(form({scheduleKind:"every",everyAmount:"1.5",everyUnit:"minutes"})).everyMs,90000);
});

test("cron and daily schedules validate explicit timezones", () => {
  for (const scheduleKind of ["cron","daily"] as const) {
    const cronExpr=scheduleKind==="daily"?"09:30":"30 9 * * *";
    assert.throws(()=>buildCronSchedule(form({scheduleKind,cronExpr,cronTz:"Asia/NotAZone"})));
    assert.equal(buildCronSchedule(form({scheduleKind,cronExpr,cronTz:" Asia/Shanghai "})).tz,"Asia/Shanghai");
  }
});

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
import { addCronJob, updateCronJob } from "./cron.ts";
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

function deferred<T>() {
  let resolve!:(value:T)=>void, reject!:(error:Error)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

test("status and runs ignore responses and errors from replaced connections", async () => {
  for(const method of ["status","runs"]){
    const state=fakeCronState(null), pending=deferred<any>();
    state.client={request:()=>pending.promise} as unknown as CronState["client"];
    const request=method==="status"?loadCronStatus(state):loadCronRuns(state,"old");
    state.client=fakeCronState(null).client;
    pending.resolve({enabled:true,entries:[{ts:1}]});await request;
    assert.equal(state.cronStatus,null);assert.deepEqual(state.cronRuns,[]);
    const failed=deferred<any>();state.client={request:()=>failed.promise} as unknown as CronState["client"];
    const retry=method==="status"?loadCronStatus(state):loadCronRuns(state,"old");
    state.connected=false;failed.reject(new Error("stale"));await retry;
    assert.equal(state.cronError,null);
  }
});

test("the latest status and run-history request owns the result", async () => {
  for(const method of ["status","runs"]){
    const state=fakeCronState(null),old=deferred<any>(),next=deferred<any>();let count=0;
    state.client={request:()=>count++===0?old.promise:next.promise} as unknown as CronState["client"];
    const a=method==="status"?loadCronStatus(state):loadCronRuns(state,"a");
    const b=method==="status"?loadCronStatus(state):loadCronRuns(state,"b");
    next.resolve({enabled:true,entries:[{ts:2}]});await b;
    old.resolve({enabled:false,entries:[{ts:1}]});await a;
    if(method==="status")assert.equal(state.cronStatus?.enabled,true);
    else {assert.equal(state.cronRunsJobId,"b");assert.equal(state.cronRuns[0].ts,2);}
  }
});

test("save no-ops report failure and late creation cannot clear a new form", async () => {
  const state=fakeCronState(null);state.connected=false;
  assert.equal(await addCronJob(state),false);assert.equal(await updateCronJob(state,"a"),false);
  state.connected=true;state.cronForm=form({name:"old",payloadText:"old"});
  const pending=deferred<any>();state.client={request:()=>pending.promise} as unknown as CronState["client"];
  const request=addCronJob(state);state.client=fakeCronState(null).client;
  state.cronForm=form({name:"new",payloadText:"new"});pending.resolve({});
  assert.equal(await request,false);assert.equal(state.cronForm.name,"new");assert.equal(state.cronForm.payloadText,"new");
});

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
