// 守护回归（源码审计，模式参照 layout-fix.test.ts，R43 Task 3）：
// 会话列表侧边栏支持右缘拖拽调宽（220-420 持久化）。拖拽条必须在 sidebar 整体
// -webkit-app-region: drag 区内声明 no-drag，折叠态隐藏，宽度经 UiSettings 持久化。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function src(rel: string): string {
  return readFileSync(new URL(`../../../../src/${rel}`, import.meta.url), "utf8");
}

test("storage：UiSettings 持久化 sidebarWidth（220-420 范围校验）", () => {
  const s = src("ui/storage.ts");
  assert.match(s, /sidebarWidth:\s*number/, "UiSettings 缺 sidebarWidth");
  assert.match(s, /220/, "缺最小宽约束");
  assert.match(s, /420/, "缺最大宽约束");
});

test("storage：sidebarWidth 缺省 0 = 未自定义（媒体查询生效哨兵）", () => {
  const s = src("ui/storage.ts");
  assert.match(s, /sidebarWidth:\s*0/, "缺省应为 0 哨兵（未自定义）");
});

test("app-render：侧边栏后渲染拖拽条且宽度接线", () => {
  const s = src("ui/app-render.ts");
  assert.match(s, /cryoclaw-sidebar__resize-handle/, "缺拖拽条元素");
  assert.match(s, /sidebarWidth/, "宽度未接线");
});

test("sidebar.css：拖拽条样式 + no-drag + 折叠态隐藏", () => {
  const css = readFileSync(new URL("../../../../src/styles/sidebar.css", import.meta.url), "utf8");
  assert.match(css, /\.cryoclaw-sidebar__resize-handle/, "缺拖拽条样式");
  const block = css.match(/\.cryoclaw-sidebar__resize-handle\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(block, /-webkit-app-region:\s*no-drag/, "拖拽条必须 no-drag（sidebar 整体是 drag 区）");
  assert.match(css, /cryoclaw-shell--sidebar-collapsed\s+\.cryoclaw-sidebar__resize-handle/, "折叠态应隐藏拖拽条");
});
