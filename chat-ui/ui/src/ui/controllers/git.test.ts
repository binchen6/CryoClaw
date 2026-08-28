// git 面板控制器纯函数用例（P4）。状态编排依赖 window.cryoclaw bridge，
// 这里只覆盖可独立断言的纯函数：分组/仓库选项/错误分类/选中 key。
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGitRepoOptions,
  gitFileKey,
  groupGitEntries,
  isGitIdentityError,
  type GitStatusEntry,
} from "./git.ts";
import type { WorktreeRecord } from "./worktrees.ts";

function entry(overrides: Partial<GitStatusEntry>): GitStatusEntry {
  return { kind: "tracked", index: ".", worktree: ".", path: "a.ts", ...overrides };
}

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

test("groupGitEntries：staged / unstaged / untracked 三分组", () => {
  const groups = groupGitEntries([
    entry({ path: "staged.ts", index: "M" }),
    entry({ path: "unstaged.ts", worktree: "M" }),
    entry({ path: "both.ts", index: "M", worktree: "M" }),
    entry({ path: "new.ts", kind: "untracked", index: "?", worktree: "?" }),
    entry({ path: "ign.log", kind: "ignored", index: "!", worktree: "!" }),
    entry({ path: "renamed.ts", kind: "renamed", index: "R", origPath: "old.ts" }),
    entry({ path: "conflict.ts", kind: "unmerged", index: "U", worktree: "U" }),
  ]);
  assert.deepEqual(groups.staged.map((e) => e.path), ["staged.ts", "both.ts", "renamed.ts"]);
  assert.deepEqual(groups.unstaged.map((e) => e.path), ["unstaged.ts", "both.ts", "conflict.ts"]);
  assert.deepEqual(groups.untracked.map((e) => e.path), ["new.ts"]);
});

test("buildGitRepoOptions：workspace 根在前 + 活跃 worktree，去重且排除已删除", () => {
  const options = buildGitRepoOptions("/ws", [
    wt("a"),
    wt("b", { removedAt: 200 }),
    wt("c", { path: "/ws" }),
  ]);
  assert.deepEqual(
    options.map((o) => [o.kind, o.path]),
    [
      ["workspace", "/ws"],
      ["worktree", "/wt/a"],
    ],
  );
  assert.equal(options[1].branch, "wt/a");
});

test("buildGitRepoOptions：无 workspace 根时只剩 worktree", () => {
  const options = buildGitRepoOptions(null, [wt("a")]);
  assert.deepEqual(options.map((o) => o.path), ["/wt/a"]);
});

test("isGitIdentityError：识别未配置提交身份的 stderr", () => {
  assert.ok(
    isGitIdentityError(
      "Author identity unknown\n*** Please tell me who you are.\nfatal: unable to auto-detect email address",
    ),
  );
  assert.ok(isGitIdentityError("fatal: empty ident name (for <a@b.c>) not allowed"));
  assert.ok(!isGitIdentityError("fatal: pathspec 'x' did not match any files"));
  assert.ok(!isGitIdentityError("nothing to commit, working tree clean"));
});

test("gitFileKey：staged/worktree 两侧同名文件 key 不同", () => {
  assert.equal(gitFileKey("cached", "a.ts"), "cached:a.ts");
  assert.equal(gitFileKey("worktree", "a.ts"), "worktree:a.ts");
  assert.notEqual(gitFileKey("cached", "a.ts"), gitFileKey("worktree", "a.ts"));
});
