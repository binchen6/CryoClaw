// controllers/workspace.ts 纯状态单测（R42 第二期 Task 3）：
// 右主区模式切换直接改 workspaceViewState.mode，无 bridge 依赖，可在 node 下断言。
import test from "node:test";
import assert from "node:assert/strict";
import { selectWorkspaceMode, workspaceViewState } from "./workspace.ts";

test("selectWorkspaceMode 切换右主区模式", () => {
  selectWorkspaceMode("git");
  assert.strictEqual(workspaceViewState.mode, "git");
  selectWorkspaceMode("files");
  assert.strictEqual(workspaceViewState.mode, "files");
});
