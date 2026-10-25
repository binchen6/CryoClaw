import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../../../src/ui/lazy-view.ts", import.meta.url), "utf8");

test("lazy navigation：异步初始化只在当前视图仍是目标时执行", () => {
  for (const [view, open] of [
    ["tasks", "openTasksView"],
    ["workspace", "openWorkspaceView"],
    ["extensions", "openExtensionsView"],
  ] as const) {
    assert.match(source, new RegExp(`if \\(state\\.settings\\.cryoclawView === "${view}"\\) module\\.${open}`));
  }
});
