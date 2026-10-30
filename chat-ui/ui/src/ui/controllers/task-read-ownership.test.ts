import test from "node:test";
import assert from "node:assert/strict";
import { addCronJob, loadCronJobs, type CronState } from "./cron.ts";
import { loadRunHistory, type RunHistoryState } from "./tasks.ts";
import { DEFAULT_CRON_FORM } from "../app-defaults.ts";

function deferred() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>(done => { resolve = done; });
  return { promise, resolve };
}

test("a cron mutation reports success only after its clean post-write list arrives", async () => {
  const s = state(), old = deferred(), fresh = deferred(); let reads = 0, saved = false;
  s.cronForm = { ...DEFAULT_CRON_FORM, name: "new job", payloadText: "work" };
  s.client = { request: (method: string) => method === "cron.list" ? (++reads === 1 ? old.promise : fresh.promise)
    : Promise.resolve(method === "cron.status" ? { enabled: true } : {}) } as never;
  const initial = loadCronJobs(s);
  const mutation = addCronJob(s).then(result => { saved = true; return result; });
  await tick(); old.resolve({ jobs: [{ id: "before-write" }] }); await tick();
  assert.equal(saved, false); assert.equal(s.cronBusy, true); assert.equal(s.cronJobs.length, 0);
  fresh.resolve({ jobs: [{ id: "new job" }] });
  assert.equal(await mutation, true); await initial;
  assert.equal(s.cronJobs[0].id, "new job"); assert.equal(s.cronBusy, false);
});
async function tick() { for (let n = 0; n < 12; n++) await Promise.resolve(); }
function state() {
  return { client: null, connected: true, hello: null, cronLoading: false, cronJobs: [], cronStatus: null,
    cronError: null, cronForm: { ...DEFAULT_CRON_FORM }, cronRunsJobId: null, cronRuns: [], cronBusy: false,
    runsLoading: false, runsError: null, runHistory: [], runsStatusFilter: "all", runsUnsupported: false,
  } as CronState & RunHistoryState;
}
for (const kind of ["jobs", "runs"] as const) {
  const load = (s: CronState & RunHistoryState, force = false) => kind === "jobs" ? loadCronJobs(s, force) : loadRunHistory(s, force);
  const payload = (id: string) => kind === "jobs" ? { jobs: [{ id }] } : { entries: [{ jobId: id, ts: 1 }] };
  const values = (s: CronState & RunHistoryState) => kind === "jobs" ? s.cronJobs.map(row => row.id) : s.runHistory.map(row => row.jobId);
  const loading = (s: CronState & RunHistoryState) => kind === "jobs" ? s.cronLoading : s.runsLoading;

  test(`${kind}: navigation shares a pending preload and awaits its result`, async () => {
    const s = state(), pending = deferred(); let calls = 0, navigationDone = false;
    s.client = { request: () => { calls++; return pending.promise; } } as never;
    const preload = load(s), navigation = load(s).then(() => { navigationDone = true; });
    await tick(); assert.equal(navigationDone, false);
    pending.resolve(payload("current")); await Promise.all([preload, navigation]); await tick();
    assert.equal(calls, 1); assert.deepEqual(values(s), ["current"]);
  });

  test(`${kind}: forced refresh waits for the follow-up and rejects the earlier snapshot`, async () => {
    const s = state(), old = deferred(), fresh = deferred(); let calls = 0, refreshDone = false;
    s.client = { request: () => ++calls === 1 ? old.promise : fresh.promise } as never;
    const first = load(s), refresh = load(s, true).then(() => { refreshDone = true; });
    old.resolve(payload("stale")); await tick();
    assert.equal(refreshDone, false); assert.equal(calls, 2); assert.deepEqual(values(s), []);
    assert.equal(loading(s), true);
    fresh.resolve(payload("fresh")); await Promise.all([first, refresh]);
    assert.deepEqual(values(s), ["fresh"]); assert.equal(loading(s), false);
    await load(s); assert.equal(calls, 2, "only the final snapshot is cached");
  });

  test(`${kind}: a new connection starts immediately and owns its loading flag`, async () => {
    const s = state(), old = deferred(), fresh = deferred(); let calls = 0;
    s.client = { request: () => old.promise } as never;
    const first = load(s);
    s.client = { request: () => { calls++; return fresh.promise; } } as never;
    const next = load(s); assert.equal(calls, 1);
    old.resolve(payload("stale")); await first; await tick();
    assert.equal(loading(s), true); assert.deepEqual(values(s), []);
    fresh.resolve(payload("fresh")); await next;
    assert.deepEqual(values(s), ["fresh"]); assert.equal(loading(s), false);
  });

  test(`${kind}: a cached new connection retires the previous pending reader`, async () => {
    const s = state(), old = deferred();
    const cachedClient = { request: async () => payload("cached") } as never;
    s.client = cachedClient; await load(s);
    const oldClient = { request: () => old.promise } as never;
    s.client = oldClient; const pending = load(s);
    s.client = cachedClient; await load(s);
    assert.equal(loading(s), false); assert.deepEqual(values(s), ["cached"]);
    // Returning to the old connection does not restore its abandoned read owner.
    s.client = oldClient; old.resolve(payload("abandoned")); await pending;
    assert.deepEqual(values(s), ["cached"]);
  });
}
