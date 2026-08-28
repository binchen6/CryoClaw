import test from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { isInsideAnyRoot } from "./workspace-ipc.ts";

// P3：workspace-ipc 守卫放宽为双白名单根（workspace 根 + ~/.openclaw/worktrees/）。
// 这里钉住纯 containment 谓词的行为；handler 接线由 chat-ui 侧源码审计覆盖。

const workspaceRoot = path.join(path.sep, "home", "u", ".openclaw", "workspace");
const worktreesRoot = path.join(path.sep, "home", "u", ".openclaw", "worktrees");
const roots = [workspaceRoot, worktreesRoot];

test("isInsideAnyRoot：workspace 根内的路径通过", () => {
  assert.equal(isInsideAnyRoot(path.join(workspaceRoot, "a.txt"), roots), true);
  assert.equal(isInsideAnyRoot(workspaceRoot, roots), true);
});

test("isInsideAnyRoot：worktrees 根内的路径通过（第二白名单根）", () => {
  assert.equal(
    isInsideAnyRoot(path.join(worktreesRoot, "abcdef0123456789", "my-wt", "README.md"), roots),
    true,
  );
  assert.equal(isInsideAnyRoot(worktreesRoot, roots), true);
});

test("isInsideAnyRoot：两根之外的路径拒绝", () => {
  assert.equal(isInsideAnyRoot(path.join(path.sep, "etc", "passwd"), roots), false);
  assert.equal(
    isInsideAnyRoot(path.join(path.sep, "home", "u", ".openclaw", "credentials"), roots),
    false,
  );
});

test("isInsideAnyRoot：前缀相似但不是子目录的兄弟路径拒绝", () => {
  assert.equal(isInsideAnyRoot(workspaceRoot + "-evil", roots), false);
  assert.equal(isInsideAnyRoot(worktreesRoot + "-evil", roots), false);
});

test("isInsideAnyRoot：.. 穿越后被 resolve 收回根内的路径允许，逃出的拒绝", () => {
  assert.equal(
    isInsideAnyRoot(path.join(worktreesRoot, "fp", "..", "fp2", "x"), roots),
    true,
  );
  assert.equal(
    isInsideAnyRoot(path.join(worktreesRoot, "..", "openclaw.json"), roots),
    false,
  );
});

test("isInsideAnyRoot：空根列表全部拒绝", () => {
  assert.equal(isInsideAnyRoot(workspaceRoot, []), false);
});
