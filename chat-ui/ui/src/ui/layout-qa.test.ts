// 全局布局 QA 源码审计（2026.9 提案 A 重写版）：
// 审计清单的可自动化部分全部落为断言——
//   1. 壳层结构：图标轨常驻（fullpage 仅 setup）、标题栏 44px 走 token、
//      视图不再自带 --titlebar-h 让位（壳层统一占位）；
//   2. drag/no-drag 配对：rail/面板/上下文栏内可交互元素逐一核对；
//   3. z-index 契约：全样式文件扫描（浮层 ≥1000 / 菜单 ≤60 / 标题栏 100）；
//   4. 窗口最小 800×600 常量与窄窗断点；
//   5. 壳层新增规则无写死色值（暗色主题安全）；
//   6. 确认框渲染于 <main> 之后（同层 1000 按 DOM 序后者在上）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

function css(rel: string): string {
  const raw = readFileSync(new URL(`../../../../src/styles/${rel}`, import.meta.url), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, ""); // 剥注释：防注释内文字干扰规则捕获
}

function uiSrc(rel: string): string {
  return readFileSync(new URL(`../../../../src/ui/${rel}`, import.meta.url), "utf8");
}

/** 精确选择器的规则块（选择器按逗号分组逐一匹配） */
function rule(source: string, cls: string): string {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const selectors = m[1].split(",").map((s) => s.trim());
    if (selectors.includes(cls)) return m[0];
  }
  return "";
}

/** 选择器文本包含片段的第一个规则块（多选择器/组合选择器用） */
function blockContaining(source: string, frag: string): string {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    if (m[1].includes(frag)) return m[0];
  }
  return "";
}

/** 全部叶子规则的 选择器 + z-index 清单（@media 头自身不产出，内部规则照常捕获） */
function zIndexEntries(source: string): Array<{ selector: string; z: number }> {
  const out: Array<{ selector: string; z: number }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const selector = m[1].trim();
    if (selector.startsWith("@")) continue;
    const zm = m[2].match(/z-index:\s*(-?\d+)/);
    if (zm) out.push({ selector, z: Number(zm[1]) });
  }
  return out;
}

/** 声明了指定 app-region 值的选择器集合（按逗号分组展开） */
function appRegionSelectors(source: string, value: "drag" | "no-drag"): Set<string> {
  const set = new Set<string>();
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    if (new RegExp(`-webkit-app-region:\\s*${value}`).test(m[2])) {
      for (const sel of m[1].split(",")) {
        const s = sel.trim();
        if (s && !s.startsWith("@")) set.add(s);
      }
    }
  }
  return set;
}

// 动态枚举样式目录：新增 .css 自动纳入扫描，免手工清单漂移
const STYLE_FILES = readdirSync(new URL("../../../../src/styles", import.meta.url)).filter((f) => f.endsWith(".css"));

// ── 1. 壳层结构契约 ─────────────────────────────────────────────

test("标题栏高度走 --titlebar-h token 且为契约层 100", () => {
  const titlebar = rule(css("shell.css"), ".cryoclaw-titlebar");
  assert.match(titlebar, /height:\s*var\(--titlebar-h\)/, "titlebar 高度应走 token");
  assert.match(titlebar, /z-index:\s*100/, "titlebar 应为契约层 100");
  assert.match(titlebar, /-webkit-app-region:\s*drag/, "titlebar 应为 drag 区");
});

test("tokens-ext：--titlebar-h 保持 44px、--panel-width/--rail-width 存在（旧 --sidebar-width 已删）", () => {
  const t = css("tokens-ext.css");
  assert.match(t, /--titlebar-h:\s*44px/, "--titlebar-h 应保持 44px");
  assert.match(t, /--panel-width:\s*\d+px/, "缺 --panel-width 默认宽");
  assert.match(t, /--rail-width:\s*60px/, "缺 --rail-width（60px 图标轨）");
  assert.ok(!/--sidebar-width/.test(t), "旧 --sidebar-width 变量应已删除");
});

test("registry：fullpage 仅 setup，titlebarBack 已删除", () => {
  // 剥注释：文件头注释会提到已删除的 titlebarBack，负向断言只针对真实代码
  const r = uiSrc("views/registry.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.match(r, /setup:\s*\{[^}]*fullpage:\s*true/, "setup 应为唯一 fullpage");
  const fullpageTrue = r.match(/fullpage:\s*true/g) ?? [];
  assert.equal(fullpageTrue.length, 1, "fullpage:true 应只有 setup 一条");
  assert.ok(!/titlebarBack/.test(r), "titlebarBack 应已删除（rail 提供全局导航）");
});

test("app-render：壳结构（cc-rail 常驻 + cc-session-panel 仅 chat + 上下文栏）", () => {
  const s = uiSrc("app-render.ts");
  assert.match(s, /<cc-rail\s/, "renderApp 应装配 <cc-rail>");
  assert.match(s, /import "\.\/components\/cc-rail\.ts"/, "缺少 cc-rail 注册导入");
  assert.match(s, /<cc-session-panel\s/, "renderApp 应装配 <cc-session-panel>");
  assert.match(s, /import "\.\/components\/cc-session-panel\.ts"/, "缺少 cc-session-panel 注册导入");
  // 会话面板仅在 chat 视图且未折叠时渲染
  assert.match(s, /cryoclawView !== "chat" \|\| panelCollapsed/, "会话面板应仅在 chat 视图且未折叠时渲染");
  // 上下文栏在标题栏内
  assert.match(s, /class="cryoclaw-titlebar"[\s\S]{0,300}?renderContextBar/, "上下文栏应渲染在标题栏内");
});

test("视图层禁止自带标题栏让位（壳层统一占位，防双重让位复发）", () => {
  // 旧模型（视图根 padding-top: var(--titlebar-h)）已废弃：titlebar 改为主列内
  // 44px 占位块，视图内容从其下缘开始。任何视图 CSS 回插让位都是回归。
  for (const file of STYLE_FILES) {
    if (file === "shell.css" || file === "tokens-ext.css") continue;
    assert.doesNotMatch(
      css(file),
      /padding-top:\s*(?:calc\()?var\(--titlebar-h\)/,
      `${file} 不得用 --titlebar-h 做顶部让位（壳层已统一占位）`,
    );
  }
});

// ── 2. drag/no-drag 配对 ────────────────────────────────────────

test("drag 区容器声明（图标轨/会话面板/标题栏）", () => {
  const shell = css("shell.css");
  const panel = css("session-panel.css");
  const drag = new Set([...appRegionSelectors(shell, "drag"), ...appRegionSelectors(panel, "drag")]);
  for (const cls of [".cryoclaw-titlebar", ".cc-rail", ".cc-panel", ".cc-panel__header"]) {
    assert.ok(drag.has(cls), `${cls} 应为 drag 区`);
  }
});

test("drag 区内全部可交互元素均有 no-drag", () => {
  const shell = css("shell.css");
  const panel = css("session-panel.css");
  const noDrag = new Set([...appRegionSelectors(shell, "no-drag"), ...appRegionSelectors(panel, "no-drag")]);
  // [元素类, 覆盖来源（自身或祖先容器类）]，结构依据 cc-rail.ts / cc-session-panel.ts / app-render.ts
  const pairs: Array<[el: string, via: string]> = [
    [".cc-rail__item", ".cc-rail__item"], // 图标轨全部按钮
    [".cc-contextbar__toggle", ".cc-contextbar__toggle"], // 上下文栏面板开关
    [".cc-contextbar__title", ".cc-contextbar__title"], // 标题文本（选择不拖拽）
    [".cc-panel__icon-btn", ".cc-panel__icon-btn"], // 面板头按钮（新会话/更多/归档）
    [".cc-panel__more-menu", ".cc-panel__more-menu"], // 「更多」菜单
    [".cc-panel__search", ".cc-panel__search"], // 搜索区
    [".cc-panel__list", ".cc-panel__list"], // 会话列表（含项/菜单，祖先覆盖）
    [".cryoclaw-panel-resize", ".cryoclaw-panel-resize"], // 调宽手柄
  ];
  for (const [el, via] of pairs) {
    assert.ok(noDrag.has(via), `${el} 缺 no-drag 覆盖（期望自身或祖先 ${via} 声明）`);
  }
});

// ── 3. z-index 契约全量核对（菜单 ≤60 / titlebar 100 / 浮层 ≥1000）──

test("z-index 层叠契约：菜单类 ≤60、浮层弹窗类 ≥1000、titlebar 100", () => {
  const overlayPattern = /overlay|lightbox|toast|tooltip|modal|-popup/;
  const menuPattern = /menu|popover|suggest|picker/;
  for (const file of STYLE_FILES) {
    for (const { selector, z } of zIndexEntries(css(file))) {
      if (overlayPattern.test(selector)) {
        assert.ok(z >= 1000, `${file} ${selector} z-index:${z} 浮层类应 ≥1000`);
      }
      if (menuPattern.test(selector)) {
        assert.ok(z <= 60, `${file} ${selector} z-index:${z} 菜单类应 ≤60`);
      }
    }
  }
});

test("确认框渲染于 <main> 之后（同层 1000 按 DOM 序后者在上）", () => {
  // 确认框与 .oc-modal-overlay 同为 1000 层，确认框浮于设置
  // modal 之上依赖模板内渲染顺序；若未来重排根模板会静默复发
  const s = uiSrc("app-render.ts");
  const mainIdx = s.indexOf("<main");
  const confirmIdx = s.indexOf("renderConfirmDialog(state)");
  assert.ok(mainIdx >= 0 && confirmIdx > mainIdx, "renderConfirmDialog 应在 <main> 之后渲染");
});

// ── 4. 窗口最小尺寸与断点 ───────────────────────────────────────

test("窗口最小尺寸常量（横向溢出防线基准）", () => {
  const constants = readFileSync(new URL("../../../../../../src/constants.ts", import.meta.url), "utf8");
  assert.match(constants, /WINDOW_MIN_WIDTH\s*=\s*800/, "窗口最小宽应为 800");
  assert.match(constants, /WINDOW_MIN_HEIGHT\s*=\s*600/, "窗口最小高应为 600");
});

test("会话面板窄窗断点保留（900/720）", () => {
  const panel = css("session-panel.css");
  assert.match(panel, /@media\s*\(max-width:\s*900px\)/, "panel 900 断点应保留");
  assert.match(panel, /@media\s*\(max-width:\s*720px\)/, "panel 720 断点应保留（缩放降级）");
});

test("横向溢出防线：壳层关键容器 min-width:0", () => {
  assert.match(rule(css("shell.css"), ".cryoclaw-main"), /min-width:\s*0/, "主内容列应 min-width:0");
});

// ── 5. 壳层新增规则无写死色值（暗色主题安全）─────────────────────

test("壳层（shell/session-panel）规则无写死色值", () => {
  const colorLiteral = /#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6,8}\b|rgba?\(/;
  const targets: Array<[file: string, frag: string]> = [
    ["shell.css", ".cryoclaw-shell"],
    ["shell.css", ".cryoclaw-titlebar"],
    ["shell.css", ".cc-contextbar__toggle"],
    ["shell.css", ".cc-rail"],
    ["shell.css", ".cc-rail__item"],
    ["shell.css", ".cryoclaw-panel-resize"],
    ["session-panel.css", "cc-session-panel"],
    ["session-panel.css", ".cc-panel"],
    ["session-panel.css", ".cc-panel__session-item"],
    ["session-panel.css", ".cc-panel__search-input"],
  ];
  for (const [file, frag] of targets) {
    const block = blockContaining(css(file), frag);
    assert.ok(block, `${file} 缺规则块 ${frag}`);
    assert.doesNotMatch(block, colorLiteral, `${file} ${frag} 含写死色值（暗色主题风险）`);
  }
});
