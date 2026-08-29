// 守护回归（源码审计，同 cc-sidebar.test.ts 模式，R43 Task 2）：
// fullpage 视图（extensions/workspace/tasks/settings/cron/setup 等）贴窗口顶部，
// 顶部内容必须让开沉浸式标题栏（主进程 titleBarOverlay 32 + drag 区 44px，
// sidebar.css .cryoclaw-titlebar height:44），否则与「- □ ×」窗口控件及
// drag 区重叠无法点击。让位统一走 --titlebar-h token，防止回退成裸字面量或漏让位。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function css(rel: string): string {
  return readFileSync(new URL(`../../../../src/styles/${rel}`, import.meta.url), "utf8");
}

test("tokens-ext：--titlebar-h 布局 token 存在", () => {
  assert.match(css("tokens-ext.css"), /--titlebar-h:\s*44px/, "缺标题栏让位 token");
});

test("fullpage 视图顶部让位沉浸式标题栏（不再与窗口控件重叠）", () => {
  const extTabs = css("skills.css").match(/\.ext-tabs\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(extTabs, /padding-top:\s*var\(--titlebar-h\)/, "ext-tabs 缺标题栏让位");
  const wkLayout = css("workspace.css").match(/\.wk-layout\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(wkLayout, /padding-top:\s*var\(--titlebar-h\)/, "wk-layout 缺标题栏让位");
});

test("ts-layout 顶部让位统一走 token", () => {
  const tsLayout = css("misc.css").match(/\.ts-layout\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(tsLayout, /var\(--titlebar-h\)/, "ts-layout 应改用 --titlebar-h");
});
