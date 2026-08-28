import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWorktreeSessionMap,
  gcWorktrees,
  isLiveWorktree,
  isNotGitCheckoutError,
  isRestorableWorktree,
  loadWorktrees,
  removeWorktree,
  restoreWorktree,
  sortWorktrees,
  type WorktreeRecord,
  type WorktreesState,
} from "./worktrees.ts";

function wt(id: string, overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    id,
    name: id,
    repoFingerprint: "0123456789abcdef",
    repoRoot: "/repo",
    path: `/wt/${id}`,
    branch: `wt/${id}`,
    baseRef: "main",
    ownerKind: "manual",
    createdAt: 100,
    lastActiveAt: 100,
    ...overrides,
  };
}

function mockState(handler: (method: string, params: unknown) => Promise<unknown>): WorktreesState {
  return {
    client: { request: handler } as unknown as WorktreesState["client"],
    connected: true,
    worktreesLoading: false,
    worktreesError: null,
    worktrees: [],
    worktreesBusyIds: new Set<string>(),
    worktreesGcBusy: false,
  };
}

test("isLiveWorktree / isRestorableWorktree 状态判定", () => {
  assert.equal(isLiveWorktree(wt("a")), true);
  assert.equal(isLiveWorktree(wt("a", { removedAt: 200 })), false);
  assert.equal(isRestorableWorktree(wt("a")), false);
  assert.equal(isRestorableWorktree(wt("a", { removedAt: 200 })), false);
  assert.equal(isRestorableWorktree(wt("a", { removedAt: 200, snapshotRef: "snap1" })), true);
});

test("sortWorktrees：活跃按 lastActiveAt 降序在前，已删除按 removedAt 降序排尾", () => {
  const sorted = sortWorktrees([
    wt("removed-old", { removedAt: 100, snapshotRef: "s" }),
    wt("live-stale", { lastActiveAt: 100 }),
    wt("removed-new", { removedAt: 300, snapshotRef: "s" }),
    wt("live-fresh", { lastActiveAt: 500 }),
  ]);
  assert.deepEqual(
    sorted.map((w) => w.id),
    ["live-fresh", "live-stale", "removed-new", "removed-old"],
  );
});

test("buildWorktreeSessionMap：仅收录活跃 session 持有的 worktree", () => {
  const map = buildWorktreeSessionMap([
    wt("a", { ownerKind: "session", ownerId: "agent:main:s1" }),
    wt("b", { ownerKind: "manual", ownerId: "agent:main:s2" }),
    wt("c", { ownerKind: "session", ownerId: "agent:main:s3", removedAt: 1, snapshotRef: "s" }),
    wt("d", { ownerKind: "session" }),
  ]);
  assert.equal(map.size, 1);
  assert.equal(map.get("agent:main:s1")?.id, "a");
});

test("isNotGitCheckoutError：识别内核 git checkout 报错", () => {
  assert.equal(isNotGitCheckoutError(new Error("agent workspace is not a git checkout")), true);
  assert.equal(isNotGitCheckoutError("fatal: not a git repository"), true);
  assert.equal(isNotGitCheckoutError(new Error("gateway disconnected")), false);
});

test("loadWorktrees：拉取并排序写入 state", async () => {
  const state = mockState(async (method) => {
    assert.equal(method, "worktrees.list");
    return { worktrees: [wt("b", { lastActiveAt: 1 }), wt("a", { lastActiveAt: 9 })] };
  });
  await loadWorktrees(state);
  assert.deepEqual(state.worktrees.map((w) => w.id), ["a", "b"]);
  assert.equal(state.worktreesError, null);
  assert.equal(state.worktreesLoading, false);
});

test("loadWorktrees：失败写 worktreesError 且不抛出", async () => {
  const state = mockState(async () => {
    throw new Error("UNAVAILABLE: boom");
  });
  await loadWorktrees(state);
  assert.match(String(state.worktreesError), /boom/);
  assert.equal(state.worktreesLoading, false);
});

test("loadWorktrees：未连接时直接返回不发请求", async () => {
  const state = mockState(async () => {
    throw new Error("should not be called");
  });
  state.connected = false;
  await loadWorktrees(state);
  assert.equal(state.worktreesError, null);
});

test("removeWorktree：透传 id/force 并重拉列表；busy 期间拒绝重入", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const state = mockState(async (method, params) => {
    calls.push({ method, params });
    if (method === "worktrees.list") return { worktrees: [] };
    return { removed: true };
  });
  assert.equal(await removeWorktree(state, "w1", true), true);
  assert.deepEqual(calls[0], { method: "worktrees.remove", params: { id: "w1", force: true } });
  assert.equal(calls[1].method, "worktrees.list");
  assert.equal(state.worktreesBusyIds.size, 0, "结束后 busy 标记应清理");
});

test("removeWorktree：失败返回 false 并写错误，busy 标记仍清理", async () => {
  const state = mockState(async (method) => {
    if (method === "worktrees.remove") throw new Error("unknown active worktree: w1");
    return { worktrees: [] };
  });
  assert.equal(await removeWorktree(state, "w1"), false);
  assert.match(String(state.worktreesError), /unknown active worktree/);
  assert.equal(state.worktreesBusyIds.size, 0);
});

test("restoreWorktree：调用 worktrees.restore 并重拉列表", async () => {
  const calls: string[] = [];
  const state = mockState(async (method) => {
    calls.push(method);
    if (method === "worktrees.list") return { worktrees: [] };
    return {};
  });
  assert.equal(await restoreWorktree(state, "w2"), true);
  assert.deepEqual(calls, ["worktrees.restore", "worktrees.list"]);
});

test("gcWorktrees：返回内核结果并重拉列表；gc 进行中拒绝重入", async () => {
  const state = mockState(async (method) => {
    if (method === "worktrees.gc") return { removed: ["w1"], orphansDeleted: 2, snapshotsPruned: 1 };
    return { worktrees: [] };
  });
  const res = await gcWorktrees(state);
  assert.deepEqual(res, { removed: ["w1"], orphansDeleted: 2, snapshotsPruned: 1 });
  assert.equal(state.worktreesGcBusy, false);
});

test("gcWorktrees：失败返回 null 并写错误", async () => {
  const state = mockState(async () => {
    throw new Error("gc boom");
  });
  assert.equal(await gcWorktrees(state), null);
  assert.match(String(state.worktreesError), /gc boom/);
  assert.equal(state.worktreesGcBusy, false);
});
