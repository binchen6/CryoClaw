// 守护回归（源码审计，同 app-session-actions.test.ts 模式）：
// toggle-switch.ts 顶层 new CSSStyleSheet() 在 node 下不可直接导入，故用源码断言。
// 钉住两件事：
// 1. 键盘可达性 —— 组件渲染为 div，必须带 role="switch" / aria-checked / tabindex，
//    且 keydown 处理 Enter/Space 切换（Space 需 preventDefault 防页面滚动），disabled 不响应。
// 2. 焦点可见 —— :focus-visible 必须给出焦点环（var(--focus-ring)），不能只有 outline:none。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../../../../../src/ui/components/toggle-switch.ts", import.meta.url),
  "utf8",
);

test("toggle-switch：根元素带 switch 语义与键盘焦点", () => {
  assert.match(src, /role="switch"/, "缺少 role=\"switch\"");
  assert.match(src, /aria-checked=\$\{/, "aria-checked 未绑定 checked 状态");
  assert.match(src, /tabindex=\$\{/, "tabindex 未按 disabled 动态绑定");
});

test("toggle-switch：Enter/Space 触发切换，Space 阻止默认滚动，disabled 不响应", () => {
  assert.match(src, /@keydown=\$\{this\.onKeydown\}/, "根元素未绑定 keydown");
  assert.match(src, /e\.key === "Enter" \|\| e\.key === " "/, "keydown 未覆盖 Enter/Space");
  assert.match(src, /e\.preventDefault\(\)/, "Space 未 preventDefault（会滚动页面）");
  // onKeydown 与 toggle 一样必须先挡 disabled
  const keydownBody = src.match(/private onKeydown[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(keydownBody, /if \(this\.disabled\) return;/, "onKeydown 未拦截 disabled 态");
});

test("toggle-switch：长按 key repeat 不反复切换", () => {
  const keydownBody = src.match(/private onKeydown[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(keydownBody, /e\.repeat\) return;/, "onKeydown 未拦截 e.repeat（长按会反复切换）");
});

test("toggle-switch：无文字 label 时支持 aria-label 且转发到 role=switch 的内部 div", () => {
  assert.match(src, /attribute: "aria-label"/, "ariaLabel 属性未绑定 aria-label attribute");
  assert.match(src, /aria-label=\$\{this\.ariaLabel \|\| nothing\}/, "aria-label 未转发到内部 switch 元素");
});

test("toggle-switch：滑块钮颜色走 --toggle-knob（暗色下 --text-on-accent 为深青不可见）", () => {
  assert.match(src, /background:\s*var\(--toggle-knob/, "滑块钮未使用 --toggle-knob token");
});

test("toggle-switch：:focus-visible 有焦点环", () => {
  assert.match(
    src,
    /\.oc-toggle:focus-visible\s*\{[^}]*box-shadow:\s*var\(--focus-ring/,
    ":focus-visible 缺少 var(--focus-ring) 焦点环",
  );
});
