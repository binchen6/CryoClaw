// 全局布局 QA 源码审计（R43 Task 5，问题 6「对所有 ui 布局进行 QA」）：
// 七项审计清单的可自动化部分全部落为断言；结论摘要——
//   1. 六视图标题栏让位：全部通过（汇总断言见下）；
//   2. drag 区 no-drag 配对：全部覆盖（逐一断言见下）；
//   3. 滚动容器唯一性：六视图各单一主滚动容器，无同向套娃（断言见下；
//      cron 嵌套视图的 .cm-list__items overflow 在嵌套上下文中不生效，由外层
//      .panel 承载滚动，非冲突）；
//   4. z-index 契约：发现并修复 2 处越界——.exec-approval-overlay 200→1000
//      （浮层 <1000，会被 .oc-modal-overlay 盖住）、compose thinking/rewind
//      popover 100→60（菜单类占用 titlebar 层）；
//   5. 窗口最小 800×600：768/720 断点在 100% 缩放下不可达，但页面缩放
//      （Ctrl ±）会缩小 CSS 视口使其生效，非死代码，保留不修；
//   6. 暗色主题：R43 批次新增规则全部几何属性，无写死色值（白名单断言见下）；
//   7. 按钮右对齐：表单/对话框按钮区全部 flex-end（断言见下）。
// 本批修复 3 处：F1/F2（z-index 越界，见 4）、F3（cron 嵌套视图双重让位：
//   cm-layout__detail/cm-list__top 的 --titlebar-h 让位移除——cron 只嵌在任务
//   视图 .ts-layout.panel 内，根已让位）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function css(rel: string): string {
  const raw = readFileSync(new URL(`../../../../src/styles/${rel}`, import.meta.url), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, ""); // 剥注释：防注释内文字干扰规则捕获
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

const STYLE_FILES = [
  "base.css",
  "chat.css",
  "components.css",
  "compose.css",
  "cron.css",
  "misc.css",
  "panel.css",
  "panels.css",
  "plan.css",
  "primitives.css",
  "settings.css",
  "setup.css",
  "sidebar.css",
  "skills.css",
  "tokens-ext.css",
  "utilities.css",
  "workspace.css",
];

// ── 1. 六视图标题栏让位汇总（T2 复核）──────────────────────────────

test("六视图根容器标题栏让位汇总（--titlebar-h 同源）", () => {
  assert.match(rule(css("skills.css"), ".ext-tabs"), /padding-top:\s*var\(--titlebar-h\)/, "extensions ext-tabs 缺让位");
  assert.match(rule(css("workspace.css"), ".wk-layout"), /padding-top:\s*var\(--titlebar-h\)/, "workspace wk-layout 缺让位");
  const misc = css("misc.css");
  for (const cls of [".ts-layout", ".wt-layout", ".gitp-layout"]) {
    assert.match(rule(misc, cls), /var\(--titlebar-h\)/, `tasks ${cls} 缺让位`);
  }
  const settings = css("settings.css");
  assert.match(rule(settings, ".oc-settings-nav"), /var\(--titlebar-h\)/, "settings nav 缺让位");
  assert.match(rule(settings, ".oc-settings-content"), /var\(--titlebar-h\)/, "settings content 缺让位");
  const setup = css("setup.css");
  assert.match(rule(setup, ".oc-setup-progress"), /top:\s*var\(--titlebar-h\)/, "setup 进度条缺让位");
  assert.match(rule(setup, ".oc-setup-container--step2"), /padding-top:\s*calc\(var\(--titlebar-h\)/, "setup step2 缺让位");
  // chat 视图为沉浸式（消息流可贴顶部），交互仅浮动按钮（已 no-drag），无让位需求；
  // titlebar 高度与让位同源
  assert.match(rule(css("sidebar.css"), ".cryoclaw-titlebar"), /height:\s*var\(--titlebar-h\)/, "titlebar 高度应走 token");
});

test("F3 守护：cron 嵌套视图不得自带标题栏让位（双重让位）", () => {
  // cron 只作为任务视图 .ts-layout.panel 的嵌套内容渲染（app-tasks cronSlot），
  // 根已让位；cm-layout__detail/cm-list__top 若再让位会多出 44px 顶部留白。
  const cron = css("cron.css");
  assert.doesNotMatch(rule(cron, ".cm-layout__detail"), /var\(--titlebar-h\)/, "cm-layout__detail 不得双重让位");
  assert.doesNotMatch(rule(cron, ".cm-list__top"), /var\(--titlebar-h\)/, "cm-list__top 不得双重让位");
});

// ── 2. drag 区与 no-drag 配对（逐一核对侧边栏全部可交互元素）────────

test("drag 区容器声明（侧边栏整体/品牌区/标题栏）", () => {
  const sidebar = css("sidebar.css");
  const compose = css("compose.css");
  const drag = new Set([...appRegionSelectors(sidebar, "drag"), ...appRegionSelectors(compose, "drag")]);
  for (const cls of [".cryoclaw-sidebar", ".cryoclaw-sidebar__brand", ".cryoclaw-titlebar"]) {
    assert.ok(drag.has(cls), `${cls} 应为 drag 区`);
  }
});

test("drag 区内全部可交互元素均有 no-drag（自身或祖先规则）", () => {
  const sidebar = css("sidebar.css");
  const compose = css("compose.css");
  const noDrag = new Set([...appRegionSelectors(sidebar, "no-drag"), ...appRegionSelectors(compose, "no-drag")]);
  // 逐一列举侧边栏可交互元素：[元素类, 覆盖来源（自身或祖先容器类）]
  // 结构依据 cc-sidebar.ts：brand(collapse) / nav(new-chat/more/session-add/搜索/会话列表) / footer(图标轨)
  const pairs: Array<[el: string, via: string]> = [
    [".cryoclaw-sidebar__collapse", ".cryoclaw-sidebar__collapse"], // 折叠按钮（品牌区内）
    [".cryoclaw-sidebar__new-chat-btn", ".cryoclaw-sidebar__new-chat-btn"], // 新会话按钮
    [".cryoclaw-sidebar__more-btn", ".cryoclaw-sidebar__nav"], // 「更多」按钮（nav 祖先）
    [".cryoclaw-sidebar__more-item", ".cryoclaw-sidebar__nav"], // 「更多」菜单项（nav 祖先）
    [".cryoclaw-sidebar__session-add", ".cryoclaw-sidebar__session-add"], // 归档切换（compose 白名单）
    [".cryoclaw-sidebar__session-search-input", ".cryoclaw-sidebar__nav"], // 搜索输入（nav 祖先）
    [".cryoclaw-sidebar__session-item", ".cryoclaw-sidebar__session-item"], // 会话项
    [".cryoclaw-sidebar__session-action", ".cryoclaw-sidebar__session-item"], // 会话「⋯」按钮（会话项祖先）
    [".cryoclaw-sidebar__session-menu-item", ".cryoclaw-sidebar__session-item"], // 会话菜单项（会话项祖先）
    [".cryoclaw-sidebar__rail-item", ".cryoclaw-sidebar__footer"], // 图标轨按钮（footer 祖先）
    [".cryoclaw-sidebar__item", ".cryoclaw-sidebar__item"], // webbridge pill / 导航项
    [".cryoclaw-sidebar__resize-handle", ".cryoclaw-sidebar__resize-handle"], // T3 拖拽条
    [".cryoclaw-floating-actions", ".cryoclaw-floating-actions"], // fullpage/折叠态浮动按钮
  ];
  for (const [el, via] of pairs) {
    assert.ok(noDrag.has(via), `${el} 缺 no-drag 覆盖（期望自身或祖先 ${via} 声明）`);
  }
});

// ── 3. 滚动容器唯一性（六视图主滚动容器清点）────────────────────────

test("各视图主滚动容器唯一（无外层滚动 + 内层同向套娃）", () => {
  // chat：.chat-thread 单一滚动（外层 .cryoclaw-content overflow:hidden）
  assert.match(rule(css("chat.css"), ".chat-thread"), /overflow-y:\s*auto/);
  assert.match(rule(css("sidebar.css"), ".cryoclaw-content"), /overflow:\s*hidden/);
  // setup：step-body 单一滚动（容器与 step 均 overflow:hidden 夹逼）
  const setup = css("setup.css");
  assert.match(rule(setup, ".oc-setup-step-body"), /overflow-y:\s*auto/);
  assert.match(rule(setup, ".oc-setup-container"), /overflow:\s*hidden/);
  // settings：nav/content 并列双滚动（非嵌套）
  const settings = css("settings.css");
  assert.match(rule(settings, ".oc-settings-nav"), /overflow-y:\s*auto/);
  assert.match(rule(settings, ".oc-settings-content"), /overflow-y:\s*auto/);
  assert.match(rule(settings, ".oc-settings-container"), /overflow:\s*hidden/);
  // workspace：wk-nav__tree 与 wk-main 并列；preview 内容在 wk-preview(height:100%) 内
  // 自滚，wk-main 不叠加滚动
  const ws = css("workspace.css");
  assert.match(rule(ws, ".wk-layout"), /overflow:\s*hidden/);
  assert.match(rule(ws, ".wk-nav__tree"), /overflow-y:\s*auto/);
  assert.match(rule(ws, ".wk-main"), /overflow:\s*auto/);
  assert.match(rule(ws, ".wk-preview"), /height:\s*100%/);
  // tasks：.panel 为根滚动容器（.ts-layout 挂 .panel），子级无同向滚动
  assert.match(rule(css("panel.css"), ".panel"), /overflow-y:\s*auto/);
  // extensions：ext-layout overflow:hidden，skills-scroll / 插件 section 单列滚动
  const sk = css("skills.css");
  assert.match(rule(sk, ".ext-layout"), /overflow:\s*hidden/);
  assert.match(rule(sk, ".skills-scroll"), /overflow-y:\s*auto/);
});

// ── 4. z-index 契约全量核对（菜单 ≤60 / titlebar 100 / 浮层 ≥1000）──

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
  const titlebar = rule(css("sidebar.css"), ".cryoclaw-titlebar");
  assert.match(titlebar, /z-index:\s*100/, "titlebar 应为契约层 100");
});

test("F1/F2 修复点位守护", () => {
  // F1：确认框遮罩原 200（低于 .oc-modal-overlay 1000）→ 1000
  assert.match(rule(css("panels.css"), ".exec-approval-overlay"), /z-index:\s*1000/, "exec-approval-overlay 应 ≥1000");
  // F2：compose 两个选项 popover 原 100（与 titlebar 同层）→ 菜单层 60
  const compose = css("compose.css");
  assert.match(rule(compose, ".chat-compose__thinking-popover"), /z-index:\s*60/);
  assert.match(rule(compose, ".chat-compose__rewind-popover"), /z-index:\s*60/);
});

// ── 5. 窗口最小 800×600 与断点可达性 ───────────────────────────────

test("窗口最小尺寸常量（横向溢出防线基准）", () => {
  const constants = readFileSync(new URL("../../../../../../src/constants.ts", import.meta.url), "utf8");
  assert.match(constants, /WINDOW_MIN_WIDTH\s*=\s*800/, "窗口最小宽应为 800");
  assert.match(constants, /WINDOW_MIN_HEIGHT\s*=\s*600/, "窗口最小高应为 600");
});

test("断点可达性评估：768/720 断点在最小宽 800 下靠页面缩放（Ctrl±）生效，保留", () => {
  // 100% 缩放时视口 ≥800，768/720/640/560 断点不触发；放大（110% 起）后
  // CSS 视口缩小即触发——非死代码，作为缩放/未来最小宽调整的降级保留。
  assert.match(css("workspace.css"), /@media\s*\(max-width:\s*768px\)/, "workspace 768 断点应保留（缩放降级）");
  assert.match(css("settings.css"), /@media\s*\(max-width:\s*768px\)/, "settings 768 断点应保留");
  assert.match(css("skills.css"), /@media\s*\(max-width:\s*768px\)/, "skills 768 断点应保留");
  assert.match(css("sidebar.css"), /@media\s*\(max-width:\s*900px\)/, "sidebar 900 断点（最小宽内可达）");
  assert.match(css("sidebar.css"), /@media\s*\(max-width:\s*720px\)/, "sidebar 720 断点应保留（缩放降级）");
});

test("横向溢出防线：关键 flex/grid 子项 min-width:0 与收束宽度", () => {
  assert.match(rule(css("sidebar.css"), ".cryoclaw-main"), /min-width:\s*0/, "主内容列应 min-width:0");
  assert.match(rule(css("workspace.css"), ".wk-layout"), /minmax\(0,/, "workspace grid 轨道应 minmax(0,…)");
  assert.match(rule(css("cron.css"), ".cm-layout__detail"), /min-width:\s*0/, "cron detail 轨道应 min-width:0");
  assert.match(css("skills.css"), /max-width:\s*var\(--ext-column\)/, "扩展页收束宽度应存在");
});

// ── 6. 暗色主题：R43 新增规则无写死色值 ─────────────────────────────

test("R43 批次新增/修改规则全部几何属性（无写死色值）", () => {
  const colorLiteral = /#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6,8}\b|rgba?\(/;
  // R43 触碰的规则块白名单（T2 让位 + T3 拖拽条 + T4 断点/收束）
  const targets: Array<[file: string, frag: string]> = [
    ["misc.css", ".ts-layout"],
    ["misc.css", ".wt-layout"],
    ["misc.css", ".gitp-layout"],
    ["settings.css", ".oc-settings-nav"],
    ["settings.css", ".oc-settings-content"],
    ["skills.css", ".ext-tabs"],
    ["skills.css", ".ext-layout > .skills-scroll"],
    ["workspace.css", ".wk-layout"],
    ["sidebar.css", "cc-sidebar"],
    ["sidebar.css", ".cryoclaw-sidebar__resize-handle"],
    ["sidebar.css", ".cryoclaw-titlebar"],
    ["setup.css", ".oc-setup-container--step2"],
    ["setup.css", ".oc-setup-progress"],
  ];
  for (const [file, frag] of targets) {
    const block = blockContaining(css(file), frag);
    assert.ok(block, `${file} 缺 R43 规则块 ${frag}`);
    assert.doesNotMatch(block, colorLiteral, `${file} ${frag} 含写死色值（暗色主题风险）`);
  }
  // 拖拽条伪元素高亮也走 token
  const handleAfter = css("sidebar.css").match(/\.cryoclaw-sidebar__resize-handle::after\s*\{[^}]*\}/)?.[0] ?? "";
  assert.doesNotMatch(handleAfter, colorLiteral, "resize-handle ::after 含写死色值");
});

// ── 7. 按钮右对齐约定（表单/对话框按钮区）────────────────────────────

test("表单/对话框按钮区右对齐（justify-content: flex-end）", () => {
  assert.match(rule(css("cron.css"), ".cron-form__footer"), /justify-content:\s*flex-end/, "cron 表单底部按钮应右对齐");
  assert.match(rule(css("misc.css"), ".gitp-commit__actions"), /justify-content:\s*flex-end/, "git 提交按钮应右对齐");
  assert.match(rule(css("panels.css"), ".exec-approval-actions"), /justify-content:\s*flex-end/, "confirm-dialog 按钮应右对齐");
  assert.match(rule(css("primitives.css"), ".cc-dialog__foot"), /justify-content:\s*flex-end/, "cc-dialog 底部按钮应右对齐");
});
