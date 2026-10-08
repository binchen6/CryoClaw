// skills 加载超时与错误文案守卫（QA：skills.status 永不返回 → 「刷新中」常驻 +
// 技能区空白）。loadSkills 15s 超时落友好错误（重试出按钮），裸 English 错误只进 console。
import test from "node:test";
import assert from "node:assert/strict";
import { loadSkills, withLoadTimeout, SKILLS_LOAD_TIMEOUT_MS } from "./skills.ts";

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
