import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../../../src/ui/lazy-view.ts", import.meta.url), "utf8");

test("lazy navigation：已加载入口同步执行，未加载入口保留当前视图守卫", () => {
  assert.match(source, /const loaded = openers\.get\(view\);[\s\S]*?loaded\(state, option\);/);
  assert.match(source, /if \(state\.settings\.cryoclawView === view\) openers\.get\(view\)\?\.\(state, option\)/);
  for (const open of ["openTasksView", "openWorkspaceView", "openExtensionsView"]) {
    assert.match(source, new RegExp(`openers\\.set\\(view, module\\.${open}\\)`));
  }
  for (const view of ["tasks", "workspace", "extensions"]) {
    assert.match(source, new RegExp(`openDeferredView\\(state, "${view}",`));
  }
});
