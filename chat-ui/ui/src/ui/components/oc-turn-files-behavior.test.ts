import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../../../../../src/ui/components/oc-turn-files.ts", import.meta.url),
  "utf8",
);

test("turn-files popover dismisses on outside pointerdown and Escape", () => {
  assert.match(src, /addEventListener\("pointerdown", this\.onDocumentPointerDown, true\)/);
  assert.match(src, /addEventListener\("keydown", this\.onDocumentKeyDown\)/);
  assert.match(src, /removeEventListener\("pointerdown", this\.onDocumentPointerDown, true\)/);
  assert.match(src, /removeEventListener\("keydown", this\.onDocumentKeyDown\)/);
  assert.match(src, /event\.key !== "Escape"/);
});

test("Escape returns focus to the summary trigger", () => {
  assert.match(src, /details\.querySelector<HTMLElement>\("summary"\)\?\.focus\(\)/);
});

test("runActive 门控：终态后胶囊消失，由组底部改动卡片接力", () => {
  assert.match(src, /runActive: \{ attribute: false \}/, "应声明 runActive 属性");
  assert.match(src, /if \(!this\.runActive\) return nothing;/, "runActive=false 时应渲染 nothing");
  // 隐藏期间不打无意义 git 调用
  assert.match(src, /const enabled = this\.runActive && this\.gitAvailable/, "统计拉取应受 runActive 门控");
});

test("浮层精简：只显示 basename（完整路径放 title）+ 每文件 +/−，无 badge / git 按钮", () => {
  assert.match(src, /fileChangeBaseName\(file\.path\)/, "浮层应显示 basename");
  assert.match(src, /class="chat-turn-files__path" title=\$\{file\.path\}/, "完整路径应放 title");
  assert.match(src, /chat-turn-files__row-stat/, "每文件 +/− 行数应保留");
  assert.doesNotMatch(src, /chat-file-change__badge/, "badge 已移除");
  assert.doesNotMatch(src, /chat\.viewInGit/, "浮层「在 git 中查看」按钮已移除");
  assert.doesNotMatch(src, /onOpenGit/, "onOpenGit 回调已移除");
});
