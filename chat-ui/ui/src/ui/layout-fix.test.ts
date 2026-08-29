// 守护回归（源码审计，同 cc-sidebar.test.ts 模式，R43 Task 2）：
// fullpage 视图（extensions/workspace/tasks/settings/cron/setup 等）贴窗口顶部，
// 顶部内容必须让开沉浸式标题栏（主进程 titleBarOverlay 32 + drag 区 44px，
// sidebar.css .cryoclaw-titlebar height:44），否则与「- □ ×」窗口控件及
// drag 区重叠无法点击。让位统一走 --titlebar-h token，防止回退成裸字面量或漏让位。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function css(rel: string): string {
  const raw = readFileSync(new URL(`../../../../src/styles/${rel}`, import.meta.url), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, ""); // 剥注释：防块内注释干扰规则块捕获（质量审查 Minor 加固）
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

test("同模式容器让位均走 token（防裸字面量回退，补齐守护面）", () => {
  const misc = css("misc.css");
  for (const cls of [".ts-layout", ".wt-layout", ".gitp-layout"]) {
    const block = misc.match(new RegExp(`${cls.replace(/\./g, "\\.")}\\s*\\{[^}]*\\}`))?.[0] ?? "";
    assert.match(block, /var\(--titlebar-h\)/, `${cls} 应走 --titlebar-h`);
  }
  const cron = css("cron.css");
  assert.match(cron.match(/\.cm-layout__detail\s*\{[^}]*\}/)?.[0] ?? "", /var\(--titlebar-h\)/, "cm-layout__detail 应走 --titlebar-h");
  assert.match(cron.match(/\.cm-list__top\s*\{[^}]*\}/)?.[0] ?? "", /var\(--titlebar-h\)/, "cm-list__top 应走 --titlebar-h");
  const settings = css("settings.css");
  assert.match(settings.match(/\.oc-settings-nav\s*\{[^}]*\}/)?.[0] ?? "", /var\(--titlebar-h\)/, "oc-settings-nav 应走 --titlebar-h");
});

test("sidebar.css：titlebar 高度与让位 token 同源（单点修改能力）", () => {
  const sidebar = css("sidebar.css");
  const titlebar = sidebar.match(/\.cryoclaw-titlebar\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(titlebar, /height:\s*var\(--titlebar-h\)/, "titlebar 高度应走 --titlebar-h");
});

test("新整合视图响应式断点（按窗口大小自适应）", () => {
  const ws = css("workspace.css");
  assert.match(ws, /@media\s*\(max-width:\s*860px\)/, "workspace 缺 860px 断点");
  assert.match(ws, /@media\s*\(max-width:\s*768px\)/, "workspace 缺 768px 断点");
  const sk = css("skills.css");
  assert.match(sk, /@media\s*\(max-width:\s*768px\)/, "skills 缺 768px 断点");
});

test("扩展页内容宽屏收束（不过散）", () => {
  const sk = css("skills.css");
  assert.match(sk, /max-width:\s*var\(--ext-column\)/, "扩展页内容缺最大宽度收束");
});

test("design-tokens：--ext-column 扩展视图内容列收束宽度", () => {
  const dt = readFileSync(new URL("../../../../../../shared/design-tokens.css", import.meta.url), "utf8");
  assert.match(dt, /--ext-column:\s*980px/, "缺扩展视图内容列宽 token");
});

test("settings 窄窗导航收窄：width 与 min-width 同源覆盖", () => {
  const s = css("settings.css");
  const block = s.match(/@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  const nav = block.match(/\.oc-settings-nav\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(nav, /width:\s*200px/, "窄窗导航宽度应收窄至 200px");
  assert.match(nav, /min-width:\s*200px/, "min-width 必须同源覆盖，否则 280px 下限抵抗收窄");
});
