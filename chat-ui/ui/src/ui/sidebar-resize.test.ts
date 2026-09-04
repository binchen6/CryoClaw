// 守护回归（源码审计，2026.9 提案 A 重写版）：
// 会话面板（cc-session-panel）支持右缘拖拽调宽（220-420 持久化）。
// 拖拽条声明 no-drag，仅 chat 视图且面板未折叠时渲染，宽度经 UiSettings 持久化。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function src(rel: string): string {
  return readFileSync(new URL(`../../../../src/${rel}`, import.meta.url), "utf8");
}

test("storage：UiSettings 持久化 sidebarWidth（220-420 范围校验）", () => {
  const s = src("ui/storage.ts");
  assert.match(s, /sidebarWidth:\s*number/, "UiSettings 缺 sidebarWidth");
  assert.match(s, /parsed\.sidebarWidth\s*>=\s*220/, "缺最小宽约束");
  assert.match(s, /Math\.min\(420/, "缺最大宽约束");
});

test("storage：sidebarWidth 缺省 0 = 未自定义（CSS 默认值生效哨兵）", () => {
  const s = src("ui/storage.ts");
  assert.match(s, /sidebarWidth:\s*0/, "缺省应为 0 哨兵（未自定义）");
});

test("app-render：会话面板后渲染拖拽条且宽度接线", () => {
  const s = src("ui/app-render.ts");
  assert.match(s, /cryoclaw-panel-resize/, "缺拖拽条元素");
  assert.match(s, /sidebarWidth/, "宽度未接线");
  // 拖拽条与会话面板同一渲染分支（chat 视图且未折叠时才存在）
  assert.match(s, /cryoclawView !== "chat" \|\| panelCollapsed/, "拖拽条应随面板折叠/非 chat 视图隐藏");
});

test("shell.css：拖拽条样式 + no-drag", () => {
  const css = readFileSync(new URL("../../../../src/styles/shell.css", import.meta.url), "utf8");
  assert.match(css, /\.cryoclaw-panel-resize/, "缺拖拽条样式");
  const block = css.match(/\.cryoclaw-panel-resize\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(block, /-webkit-app-region:\s*no-drag/, "拖拽条必须 no-drag");
  assert.match(block, /cursor:\s*col-resize/, "拖拽条应为 col-resize 光标");
});

test("app-render：0 哨兵条件绑定与 :root 变量清除（防默认宽度被内联宽度废除）", () => {
  const s = src("ui/app-render.ts");
  assert.match(s, /sidebarWidth > 0\s*\?\s*`width:/s, "内联宽度必须仅在自定义时存在（0 哨兵条件绑定）");
  assert.match(s, /removeProperty\("--panel-width"\)/, "0 哨兵必须清除 :root 内联变量");
  assert.match(s, /setProperty\("--panel-width"/, "自定义宽度应同步 --panel-width 变量");
});
