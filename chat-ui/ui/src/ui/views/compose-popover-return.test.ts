import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (relative: string) => readFileSync(new URL(`../../../../../src/${relative}`, import.meta.url), "utf8");

// 浮层返回准则的输入区三件套：加号菜单、分支 popover、目标表单。
// 共同契约：Esc 收起、选中后收起、关闭回焦触发器、aria-expanded 跟随开关态。
test("加号菜单：Esc 收起并回焦打开它的按钮（加号或权限档位）", () => {
  const compose = source("ui/views/chat-compose.ts");
  assert.match(compose, /let plusMenuOpener: HTMLElement \| null = null/);
  assert.match(compose, /document\.addEventListener\("keydown", plusMenuEscape, true\)/);
  assert.match(compose, /document\.removeEventListener\("keydown", plusMenuEscape, true\)/);
  assert.match(compose, /requestAnimationFrame\(\(\)=>opener\?\.isConnected&&opener\.focus\(\)\)/);
  // 权限档位按钮与加号共用菜单，必须把自身作为 opener 传进去，并声明 aria-expanded。
  assert.match(compose, /openPlusMenu\(props,event\.currentTarget as HTMLElement\)/);
  assert.match(compose, /aria-haspopup="menu" aria-expanded=\$\{plusMenuOpen \? "true" : "false"\} \?disabled=\$\{!props\.connected\} @click=\$\{\(event:Event\)=>\{event\.stopPropagation\(\);if\(plusMenuOpen\)closePlusMenu\(props\);else openPlusMenu\(props,event\.currentTarget as HTMLElement\);\}\}/);
});

test("分支 popover：aria-expanded 跟随、Esc 收起、选中分支后立即收起并回焦", () => {
  const compose = source("ui/views/chat-compose.ts");
  assert.match(compose, /let branchPopoverOpen = false/);
  assert.match(compose, /aria-expanded=\$\{branchPopoverOpen \? "true" : "false"\}/);
  assert.match(compose, /aria-haspopup="menu"/);
  assert.match(compose, /document\.addEventListener\("keydown", branchPopoverEscape, true\)/);
  assert.match(compose, /role="menu" aria-label=\$\{t\("chat\.branch\.title"\)\}/);
  // 切换分支后必须关闭，否则面板悬在原处像「没生效」
  assert.match(compose, /props\.onSwitchBranch\?\.\(branch\.leafEntryId\);\s*\n\s*\/\/[^\n]*\n\s*closeBranchPopover\(\);/);
  // 关闭回焦分支按钮
  assert.match(compose, /querySelector<HTMLElement>\("\.chat-compose__branch \.chat-compose__tool-btn"\)\?\.focus\(\)/);
});

test("目标表单：Esc/取消/提交走同一条关闭路径并回焦加号按钮", () => {
  const compose = source("ui/views/chat-compose.ts");
  assert.match(compose, /const closeGoalForm = \(restoreFocus = true\) => \{/);
  assert.match(compose, /if \(restoreFocus\) requestAnimationFrame\(\(\) => document\.querySelector<HTMLElement>\("\.chat-plus__trigger"\)\?\.focus\(\)\)/);
  assert.match(compose, /e\.key !== "Escape" \|\| e\.isComposing/);
  assert.match(compose, /querySelector<HTMLInputElement>\("\.chat-goal-form__input"\)\?\.focus\(\)/);
});

test("会话信息面板：Esc 与点外部同一条退场，关闭回焦 contextbar 信息按钮", () => {
  const info = source("ui/views/conversation-info.ts");
  assert.match(info, /let opener: HTMLElement \| null = null/);
  assert.match(info, /document\.addEventListener\("keydown", escapeCloser, true\)/);
  assert.match(info, /document\.addEventListener\("click", outsideCloser, true\)/);
  assert.match(info, /document\.removeEventListener\("keydown", escapeCloser, true\)/);
  assert.match(info, /const restore = \(\) => requestAnimationFrame\(\(\) => target\?\.focus\(\)\)/);
  assert.match(info, /export function toggleConversationInfo\(update: \(\) => void, trigger: HTMLElement \| null = null\)/);
  // 面板内部只保留 X 按钮，不再依赖焦点在面板内才能响应 Esc
  assert.doesNotMatch(info, /@keydown=\$\{\(e: KeyboardEvent\) => \{ if \(e\.key === "Escape"\)/);
  const render = source("ui/app-render.ts");
  assert.match(render, /toggleConversationInfo\(\(\) => state\.requestUpdate\(\), event\.currentTarget as HTMLElement\)/);
});
