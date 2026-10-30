// skills 加载超时与错误文案守卫（QA：skills.status 永不返回 → 「刷新中」常驻 +
// 技能区空白）。loadSkills 15s 超时落友好错误（重试出按钮），裸 English 错误只进 console。
import test from "node:test";
import assert from "node:assert/strict";
import { loadSkills, listEligibleSkills, updateSkillEnabled, withLoadTimeout, SKILLS_LOAD_TIMEOUT_MS } from "./skills.ts";

test("skill references refresh eligibility and do not leak a replaced connection's response",async()=>{
  let resolve!:(value:unknown)=>void;
  const state=makeState({client:{request:()=>new Promise(done=>{resolve=done;})}});
  const pending=listEligibleSkills(state as never);
  state.client={request:async()=>({skills:[{skillKey:"enabled",name:"Current"},{skillKey:"disabled",disabled:true},{skillKey:"missing",eligible:false}]})};
  resolve({skills:[{skillKey:"old",name:"Old connection"}]});
  assert.deepEqual(await pending,[]);
  assert.deepEqual(await listEligibleSkills(state as never),[{key:"enabled",name:"Current",description:undefined,emoji:undefined}]);
});

test("skill reference loading surfaces a safe retry error instead of an empty list",async()=>{
  const state=makeState({client:{request:async()=>{throw new Error("private gateway details");}}});
  await assert.rejects(listEligibleSkills(state as never),error=>error instanceof Error && !error.message.includes("private gateway"));
});

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    client: null as unknown as { request: (method: string) => Promise<unknown> },
    connected: true,
    skillsLoading: false,
    skillsReport: null,
    skillsError: null as string | null,
    skillsBusyKey: null,
    skillEdits: {},
    skillMessages: {},
    ...overrides,
  };
}

test("withLoadTimeout：超时拒绝、正常返回不清空结果", async () => {
  // 小 ms 直接驱动，避免 15s 真实等待
  await assert.rejects(withLoadTimeout(new Promise(() => {}), 30), /skills load timeout/);
  const ok = await withLoadTimeout(Promise.resolve("data"), 30);
  assert.equal(ok, "data");
  await assert.rejects(
    withLoadTimeout(Promise.reject(new Error("network down")), 30),
    /network down/,
  );
});

test("withLoadTimeout：超时常量 15s（与 UI 超时预期一致）", () => {
  assert.equal(SKILLS_LOAD_TIMEOUT_MS, 15_000);
});

test("loadSkills：请求失败时 skillsError 为友好文案（非裸 English 错误）", async () => {
  const state = makeState({
    client: {
      request: async () => {
        throw new Error("Error: unknown method: skills.status");
      },
    },
  });
  await loadSkills(state as never);
  assert.equal(state.skillsLoading, false, "失败后 loading 复位（按钮恢复可点）");
  assert.ok(state.skillsError, "失败应写入 skillsError");
  assert.ok(
    !state.skillsError.includes("unknown method"),
    `skillsError 不得包含裸 English 错误（实际：${state.skillsError}）`,
  );
});

test("loadSkills reuses a fresh report and force refresh bypasses it", async () => {
  let calls = 0;
  const state = makeState({ client: { request: async () => ({ skills: [{ skillKey: `skill-${++calls}` }] }) } });
  await loadSkills(state as never);
  await loadSkills(state as never);
  assert.equal(calls, 1);
  await loadSkills(state as never, { force: true });
  assert.equal(calls, 2);
});

test("a successful skill mutation queues a fresh status behind an older in-flight read", async () => {
  let first!: (value: unknown) => void, second!: (value: unknown) => void;
  let reads = 0;
  const state = makeState({ client: { request: async (method: string) => method === "skills.status"
    ? new Promise(resolve => { if (++reads === 1) first = resolve; else second = resolve; }) : {} } });
  const loading = loadSkills(state as never);
  const updating = updateSkillEnabled(state as never, "example", false);
  await Promise.resolve(); await Promise.resolve();
  first({ skills: [{ skillKey: "example", disabled: false }] });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(reads, 2, "mutation confirmation must request status from after the update");
  second({ skills: [{ skillKey: "example", disabled: true }] });
  await Promise.all([loading, updating]);
  assert.equal((state.skillsReport as any)?.skills[0].disabled, true);
  await loadSkills(state as never);
  assert.equal(reads, 2, "the fresh result remains reusable in the cache");
});

test("a replacement connection can load skills while an old connection request is still pending", async () => {
  let old!: (value: unknown) => void, current!: (value: unknown) => void;
  const state = makeState({ client: { request: () => new Promise(resolve => { old = resolve; }) } });
  const previous = loadSkills(state as never);
  state.client = { request: () => new Promise(resolve => { current = resolve; }) };
  const latest = loadSkills(state as never);
  old({ skills: [{ skillKey: "old" }] }); await previous;
  assert.equal(state.skillsLoading, true, "the old finally cannot clear the replacement request's loading state");
  current({ skills: [{ skillKey: "current" }] }); await latest;
  assert.equal((state.skillsReport as any)?.skills[0].skillKey, "current");
});

test("loadSkills：成功响应写入 skillsReport 且清空 skillsError", async () => {
  const report = { skills: [{ skillKey: "k1" }] };
  const state = makeState({
    skillsError: "旧错误",
    client: {
      request: async () => report,
    },
  });
  await loadSkills(state as never);
  assert.equal(state.skillsReport, report);
  assert.equal(state.skillsError, null);
  assert.equal(state.skillsLoading, false);
});
