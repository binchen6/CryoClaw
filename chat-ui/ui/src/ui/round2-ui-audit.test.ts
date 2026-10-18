// Round2 整体 UI 审查的源码/样式守护（task-6）。
// 每一项都对应一条“用户可见 + 低风险”的修复，防止后续回退：
//   1. 固定工作区 UI：未定义 token/裸 hex/no-drag/私有按钮 kit；
//   2. 工作区 800px：固定工作区入口不得再被 display:none 隐藏；
//   3. 工作区自定义 focus outline 不得复辟（统一走 --focus-ring）；
//   4. Tasks 搜索/筛选可访问名 + 失败详情展开钮命中区；
//   5. 用量页区间控件 ARIA 语义 + 首屏加载占位；
//   6. 概览页复制按钮可访问名；
//   7. 图标轨连接浮层 no-drag（拖拽区内按钮可点）；
//   8. toast 关闭按钮文案/图标；
//   9. compose 工具栏窄窗收缩兜底；
//  10. 概览统计标签不得 uppercase；
//  11. 新增 i18n 键中英同步。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function css(rel: string): string {
  const raw = readFileSync(new URL(`../../../../src/styles/${rel}`, import.meta.url), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, "");
}

function uiSrc(rel: string): string {
  return readFileSync(new URL(`../../../../src/ui/${rel}`, import.meta.url), "utf8");
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** 按逗号分组精确匹配选择器（前缀重叠的类名用这个，避免误取 backdrop 等相似块） */
function ruleExact(source: string, selector: string): string {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const selectors = m[1].split(",").map((s) => s.trim());
    if (selectors.includes(selector)) return m[0];
  }
  return "";
}

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\(/;
const UNDEFINED_TOKENS = ["--text-primary", "--bg-primary", "--border-subtle", "--overlay-scrim", "--color-danger", "--text-accent"];

// ── 1. 固定工作区 UI ─────────────────────────────────────────────

test("session-panel.css：固定工作区 UI 不再引用未定义 token / 裸色值", () => {
  const s = css("session-panel.css");
  for (const token of UNDEFINED_TOKENS) {
    assert.ok(!s.includes(`var(${token}`), `session-panel.css 仍引用未定义 token ${token}`);
  }
  // 对话框/分组头相关规则不得再出现裸 hex/rgba（token 缺失被 fallback 掩盖的形态）
  for (const frag of [".oc-panel__workspace-label", ".oc-panel__workspace-action", ".oc-panel__ws-dialog", ".oc-panel__ws-field"]) {
    const block = ruleExact(s, frag);
    assert.ok(block, `session-panel.css 缺规则块 ${frag}`);
    assert.doesNotMatch(block, COLOR_LITERAL, `${frag} 含写死色值`);
  }
});

test("session-panel.css：工作区对话框在面板拖拽区内声明 no-drag", () => {
  const s = css("session-panel.css");
  const backdrop = ruleExact(s, ".oc-panel__ws-dialog-backdrop");
  assert.match(backdrop, /-webkit-app-region:\s*no-drag/, "backdrop 缺 no-drag：.oc-panel 是 drag 区，输入框/按钮会点不到");
  const dialog = ruleExact(s, ".oc-panel__ws-dialog");
  assert.match(dialog, /var\(--bg-elevated\)/, "对话框背景应走 --bg-elevated");
  assert.match(dialog, /var\(--hairline\)/, "对话框边框应走 --hairline");
  assert.match(dialog, /var\(--shadow-xl\)/, "对话框阴影应走 --shadow-xl");
});

test("oc-session-panel：工作区对话框复用 .btn kit + 打开时聚焦首个输入 + 关闭归还焦点", () => {
  const s = stripComments(uiSrc("components/oc-session-panel.ts"));
  assert.ok(!/oc-panel__ws-btn/.test(s), "对话框按钮应迁到全局 .btn kit（不得保留私有按钮类）");
  assert.ok(!/oc-panel__ws-browse/.test(s), "浏览按钮应迁到 .btn kit");
  assert.match(s, /class="btn btn--sm"/, "对话框次按钮应使用 .btn.btn--sm");
  assert.match(s, /class="btn btn--sm primary"/, "对话框主按钮应使用 .btn.btn--sm.primary");
  assert.match(s, /\.oc-panel__ws-dialog \.oc-panel__ws-field input"\)\?\.focus\(\)/, "打开对话框应聚焦首个输入");
  assert.match(s, /workspaceDialogReturnFocus/, "关闭对话框应归还焦点");
});

test("oc-session-panel：工作区分组操作钮复用 .icon-btn--xs（命中区不再 18px）", () => {
  const s = uiSrc("components/oc-session-panel.ts");
  const matches = [...s.matchAll(/class="icon-btn icon-btn--xs oc-panel__workspace-action[^"]*"/g)];
  assert.equal(matches.length, 2, "新建会话/移除工作区两个操作钮应复用 icon-btn--xs");
});

test("oc-session-panel：未读点/置顶优先用 role=img 暴露名称（无 role 的 aria-label 会被 AT 忽略）", () => {
  const s = uiSrc("components/oc-session-panel.ts");
  assert.match(s, /class="oc-panel__unread-dot" role="img" aria-label=/, "未读点应 role=img");
  assert.match(s, /class="oc-panel__session-pin" role="img" aria-label=/, "置顶图钉应 role=img");
});

// ── 2. 工作区页窄窗与焦点 ────────────────────────────────────────

test("workspace.css：800px 不得隐藏「固定工作区」等功能入口，只允许换行", () => {
  const s = css("workspace.css");
  assert.ok(!/\.wk-browser-toolbar\s*>\s*\.btn\s*\{[^}]*display:\s*none/.test(s), "工具行按钮不得在窄窗 display:none（功能丢失）");
  assert.match(
    s,
    /@media\s*\(max-width:\s*800px\)\s*\{[\s\S]*?\.wk-browser-toolbar\s*\{[^}]*flex-wrap:\s*wrap/,
    "窄窗（≤800px）工具行应换行而不是隐藏功能入口",
  );
});

test("workspace.css：不得再用自定义 outline 覆盖统一 focus-ring", () => {
  const s = css("workspace.css");
  assert.ok(
    !/:focus-visible\s*\{[^}]*outline:/.test(s),
    "workspace.css 含 :focus-visible 自定义 outline（应统一走 base.css 的 --focus-ring）",
  );
});

// ── 3. Tasks 页可访问性 / 命中区 ────────────────────────────────

test("views/tasks.ts：搜索框与状态筛选有可访问名称（不再只靠 placeholder）", () => {
  const s = stripComments(uiSrc("views/tasks.ts"));
  assert.match(s, /aria-label=\$\{t\("tasks\.searchLabel"\)\}/, "搜索输入缺 aria-label");
  assert.match(s, /aria-label=\$\{t\("tasks\.statusFilter"\)\}/, "状态下拉缺 aria-label");
});

test("tasks-misc.css：失败详情展开钮点击区 ≥28px；worktrees compact 工具行允许换行", () => {
  const s = css("tasks-misc.css");
  const toggle = ruleExact(s, ".ts-detail-toggle");
  assert.match(toggle, /min-height:\s*28px/, "展开/收起按钮命中区应 ≥28px");
  const compact = ruleExact(s, ".wt-compact-toolbar");
  assert.match(compact, /flex-wrap:\s*wrap/, "compact 工具行应换行，避免 800px 左导航横向滚动");
});

// ── 4. 用量页 ARIA / 加载态 ─────────────────────────────────────

test("tab-usage.ts：区间选择用 group+aria-pressed（不是没有 tabpanel 的 tablist）", () => {
  const s = stripComments(uiSrc("views/settings/tab-usage.ts"));
  assert.ok(!/role="tablist"/.test(s), "区间选择不应使用 role=tablist（内容区无 tabpanel）");
  assert.match(s, /role="group" aria-label=\$\{t\("settings\.usage\.rangeLabel"\)\}/, "区间组缺 role=group/aria-label");
  assert.match(s, /aria-pressed=\$\{s\.range === id \? "true" : "false"\}/, "区间按钮缺 aria-pressed");
});

test("tab-usage.ts：首屏加载态有占位卡与状态语义（不再是孤零零的「…」）", () => {
  const s = stripComments(uiSrc("views/settings/tab-usage.ts"));
  assert.match(s, /aria-busy=\$\{showSkeleton \? "true" : nothing\}/, "加载中应标记 aria-busy");
  assert.match(s, /role="status" aria-live="polite"/, "加载占位应为 live status");
  assert.match(s, /"settings\.usage\.loading"/, "加载占位缺 loading 文案");
  assert.match(s, /renderStatCard\(t\("settings\.usage\.statTokens"\), "…"\)/, "加载态应渲染 stat 占位卡");
});

// ── 5. 概览页复制按钮 ───────────────────────────────────────────

test("tab-overview.ts：路径复制按钮有可访问名称与已复制反馈", () => {
  const s = stripComments(uiSrc("views/settings/tab-overview.ts"));
  assert.match(s, /aria-label=\$\{copied \? t\("settings\.overview\.copied"\) : t\("settings\.overview\.copy"\)\}/, "复制按钮缺 aria-label");
});

// ── 6. 图标轨 / toast / compose ─────────────────────────────────

test("shell.css：连接状态浮层在 drag 轨内声明 no-drag（重试按钮可点）", () => {
  const s = css("shell.css");
  const popup = ruleExact(s, ".oc-rail__conn-popup");
  assert.match(popup, /-webkit-app-region:\s*no-drag/, "连接浮层缺 no-drag");
});

test("app-render.ts：toast 关闭按钮用专用 dismiss 文案 + CryoIcons 图标", () => {
  const s = uiSrc("app-render.ts");
  assert.match(s, /aria-label=\$\{t\("toast\.dismiss"\)\}/, "toast 关闭按钮 aria-label 应为 toast.dismiss");
  assert.ok(!/aria-label=\$\{t\("settings\.cancel"\)\}[^>]*>×</.test(s), "toast 关闭按钮不得再用「取消」文案 + × 字符");
});

test("compose.css：工具栏窄窗有收缩/换行兜底（min-width:0 + flex-wrap）", () => {
  const s = css("compose.css");
  const toolbar = ruleExact(s, ".chat-compose__toolbar");
  assert.match(toolbar, /flex-wrap:\s*wrap/, "工具栏应允许换行");
  const left = ruleExact(s, ".chat-compose__toolbar-left");
  assert.match(left, /min-width:\s*0/, "工具行左组应可收缩");
  const select = ruleExact(s, ".field .chat-compose__model-select");
  assert.match(select, /min-width:\s*0/, "模型选择器应可收缩");
  assert.match(s, /@media \(max-width: 900px\)[\s\S]{0,160}?max-width:\s*120px/, "窄窗应进一步收窄模型选择器");
});

// ── 7. 设计规范红线 ────────────────────────────────────────────

test("settings-misc.css：概览统计标签不得 text-transform: uppercase（CLAUDE.md 设计规则 #2）", () => {
  const s = css("settings-misc.css");
  const label = ruleExact(s, ".ov-stat__label");
  assert.ok(label, "缺 .ov-stat__label 规则");
  assert.doesNotMatch(label, /text-transform:\s*uppercase/, "标签不得 uppercase（CJK/品牌名大小写被改写）");
});

// ── 8. i18n 新键中英同步 ────────────────────────────────────────

test("i18n：round2 新增键在 zh/en 双区齐全", () => {
  const zh = uiSrc("i18n/zh.ts");
  const en = uiSrc("i18n/en.ts");
  for (const key of [
    '"toast.dismiss"',
    '"settings.usage.rangeLabel"',
    '"settings.usage.loading"',
    '"settings.overview.copied"',
    '"tasks.searchLabel"',
    '"tasks.statusFilter"',
  ]) {
    assert.ok(zh.includes(key), `zh.ts 缺少 ${key}`);
    assert.ok(en.includes(key), `en.ts 缺少 ${key}`);
  }
});
