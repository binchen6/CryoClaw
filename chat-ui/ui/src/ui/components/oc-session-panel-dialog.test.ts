import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 新建工作区对话框的键盘可达性（dialog-a11y 全局机制只对满足契约的弹窗生效）：
// ① 容器带 tabindex="-1"，focusOpenDialogIfNeeded 才能把焦点移入；
// ② 取消按钮带 data-dialog-dismiss，closeTopDialog（全局 Escape）才能点击它关闭——
//    该对话框的 role=dialog 挂在内层卡片上，容器自身 @click 是 stopPropagation，
//    没有 dismiss 标记时焦点在框外按 Esc 不会有任何反应。
const src = readFileSync(new URL("../../../../../src/ui/components/oc-session-panel.ts", import.meta.url), "utf8").replace(/\s+/g, " ");

test("workspace-create dialog container is focusable for the global focus handoff", () => {
  assert.ok(
    src.includes('class="oc-panel__ws-dialog" role="dialog" aria-modal="true" tabindex="-1"'),
    "dialog container must carry tabindex=\"-1\" so focusOpenDialogIfNeeded can move focus into it",
  );
});

test("workspace-create cancel button is marked data-dialog-dismiss for global Escape", () => {
  assert.ok(
    src.includes("data-dialog-dismiss @click=${() => closeWorkspaceDialog(host)}"),
    "cancel button must carry data-dialog-dismiss so closeTopDialog (Escape) can dismiss the dialog",
  );
});
