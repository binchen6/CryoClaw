// 会话分支 RPC 封装测试：请求参数形状、结果归一、跨会话/忙碌防护。
// 内核 RPC：sessions.branches.{list,switch} / sessions.rewind / sessions.fork。
import test from "node:test";
import assert from "node:assert/strict";

import {
  forkSessionFromEntry,
  loadSessionBranches,
  rewindSessionToEntry,
  switchSessionBranchTo,
  type SessionBranchState,
} from "./session-branches.ts";

type RecordedCall = { method: string; params: Record<string, unknown> };

function makeState(overrides?: Partial<SessionBranchState> & { responses?: unknown[] }) {
  const calls: RecordedCall[] = [];
  const responses = overrides?.responses ?? [];
  let index = 0;
  const client = {
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      const res = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (res instanceof Error) throw res;
      return res;
    },
  };
  const state: Partial<SessionBranchState> & { client: unknown; responses?: unknown } = {
    client: client as unknown as SessionBranchState["client"],
    connected: true,
    sessionBranches: [],
    sessionBranchesKey: null,
    sessionBranchesLoading: false,
    sessionBranchesError: null,
    branchBusyAction: null,
  };
  Object.assign(state, overrides ?? {});
  delete state.responses;
  return { state: state as SessionBranchState, calls };
}

test("loadSessionBranches 请求 sessions.branches.list 并归一 branches 数组", async () => {
  const branches = [
    { leafEntryId: "e1", headline: "第一条", messageCount: 3, active: true },
    { leafEntryId: "e2", headline: "第二条", messageCount: 5, updatedAt: "2026-10-04T00:00:00Z", active: false },
  ];
  const { state, calls } = makeState({ responses: [{ ok: true, branches }] });
  await loadSessionBranches(state, "agent:main:s1");
  assert.deepEqual(calls, [
    { method: "sessions.branches.list", params: { sessionKey: "agent:main:s1" } },
  ]);
  assert.equal(state.sessionBranches, branches);
  assert.equal(state.sessionBranchesKey, "agent:main:s1");
  assert.equal(state.sessionBranchesLoading, false);
  assert.equal(state.sessionBranchesError, null);
});

test("loadSessionBranches 响应缺 branches 字段时归一为空数组", async () => {
  const { state } = makeState({ responses: [{ ok: true }] });
  await loadSessionBranches(state, "s1");
  assert.deepEqual(state.sessionBranches, []);
});

test("loadSessionBranches 失败时写入 error 并清空列表", async () => {
  const { state } = makeState({ responses: [new Error("boom")] });
  await loadSessionBranches(state, "s1");
  assert.deepEqual(state.sessionBranches, []);
  assert.equal(state.sessionBranchesError, "boom");
  assert.equal(state.sessionBranchesLoading, false);
});

test("loadSessionBranches 未连接时不发请求", async () => {
  const { state, calls } = makeState({ connected: false });
  await loadSessionBranches(state, "s1");
  assert.deepEqual(calls, []);
  assert.equal(state.sessionBranchesLoading, false);
});

test("switchSessionBranchTo 发送 leafEntryId 且成功返回 true", async () => {
  const { state, calls } = makeState({ responses: [{}] });
  const ok = await switchSessionBranchTo(state, "s1", "leaf-1");
  assert.ok(ok);
  assert.deepEqual(calls, [
    { method: "sessions.branches.switch", params: { sessionKey: "s1", leafEntryId: "leaf-1" } },
  ]);
  assert.equal(state.branchBusyAction, null);
});

test("switchSessionBranchTo 忙碌时拒绝并发", async () => {
  const { state, calls } = makeState();
  state.branchBusyAction = "switch:other";
  const ok = await switchSessionBranchTo(state, "s1", "leaf-1");
  assert.equal(ok, false);
  assert.deepEqual(calls, []);
});

test("rewindSessionToEntry 返回内核 editorText/editorAttachments", async () => {
  const restored = {
    editorText: "原始提问",
    editorAttachments: [{ mimeType: "image/png", data: "aGk=" }],
  };
  const { state, calls } = makeState({ responses: [restored] });
  const res = await rewindSessionToEntry(state, "s1", "entry-9");
  assert.deepEqual(res, restored);
  assert.deepEqual(calls, [
    { method: "sessions.rewind", params: { sessionKey: "s1", entryId: "entry-9" } },
  ]);
  assert.equal(state.branchBusyAction, null);
});

test("rewindSessionToEntry 失败返回 null 并带错误信息", async () => {
  const { state } = makeState({ responses: [new Error("Rewind is unavailable")] });
  const res = await rewindSessionToEntry(state, "s1", "entry-9");
  assert.equal(res, null);
  assert.equal(state.sessionBranchesError, "Rewind is unavailable");
});

test("forkSessionFromEntry 返回新会话 key", async () => {
  const { state, calls } = makeState({ responses: [{ sessionKey: "agent:main:forked" }] });
  const res = await forkSessionFromEntry(state, "s1", "entry-3");
  assert.equal(res?.sessionKey, "agent:main:forked");
  assert.deepEqual(calls, [
    { method: "sessions.fork", params: { sessionKey: "s1", entryId: "entry-3" } },
  ]);
});

test("forkSessionFromEntry 缺 sessionKey 时抛错并落 error", async () => {
  const { state } = makeState({ responses: [{}] });
  const res = await forkSessionFromEntry(state, "s1", "entry-3");
  assert.equal(res, null);
  assert.match(state.sessionBranchesError ?? "", /missing fork session key/);
});
