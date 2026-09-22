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

// L16：Windows/macOS 文件系统大小写不敏感，同一真实目录可能以两种大小写形态出现
// （OPENCLAW_STATE_DIR 环境变量写法与实际目录不符、realpath 返回磁盘真实大小写而白名单
// root 来自另一来源）。大小写敏感比较会把合法路径误判为越界，用户看到 "Access denied"。
// 平台通过第三参数注入，这些用例在任意宿主平台都能跑。
test("isInsideAnyRoot：大小写不敏感平台（win32/darwin）忽略路径大小写", () => {
  const upperWorkspaceRoot = workspaceRoot.toUpperCase();
  const upperWorktreesRoot = worktreesRoot.toUpperCase();

  assert.equal(isInsideAnyRoot(path.join(upperWorkspaceRoot, "A.TXT"), roots, true), true);
  assert.equal(isInsideAnyRoot(upperWorkspaceRoot, roots, true), true);
  assert.equal(
    isInsideAnyRoot(path.join(upperWorktreesRoot, "ABCDEF0123456789", "MY-WT", "README.MD"), roots, true),
    true,
  );
});

test("isInsideAnyRoot：大小写敏感平台（linux）不折叠大小写", () => {
  assert.equal(isInsideAnyRoot(path.join(workspaceRoot.toUpperCase(), "A.TXT"), roots, false), false);
  assert.equal(isInsideAnyRoot(path.join(workspaceRoot, "A.TXT"), roots, false), true);
});

test("isInsideAnyRoot：折叠不放宽拒绝方向（根外、兄弟路径、穿越仍拒绝）", () => {
  // 大小写折叠只在大小写不敏感平台上生效，这类平台上"仅大小写不同"的兄弟目录不存在，
  // 因此折叠不会让任何真实的不同目录通过。
  assert.equal(isInsideAnyRoot(path.join(path.sep, "ETC", "PASSWD"), roots, true), false);
  assert.equal(isInsideAnyRoot(path.join(path.sep, "HOME", "U", ".OPENCLAW", "CREDENTIALS"), roots, true), false);
  assert.equal(isInsideAnyRoot(workspaceRoot.toUpperCase() + "-EVIL", roots, true), false);
  assert.equal(
    isInsideAnyRoot(path.join(worktreesRoot.toUpperCase(), "..", "OPENCLAW.JSON"), roots, true),
    false,
  );
});

test("isInsideAnyRoot：默认折叠跟随平台（win32/darwin 折叠，其余不折叠）", () => {
  const caseInsensitivePlatform = process.platform === "win32" || process.platform === "darwin";
  assert.equal(
    isInsideAnyRoot(path.join(workspaceRoot.toUpperCase(), "A.TXT"), roots),
    caseInsensitivePlatform,
  );
});
