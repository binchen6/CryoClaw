import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { placePopover, rectsOverlap } from "../utils/popover-placement.ts";

const source = (relative: string) => readFileSync(new URL(`../../../../../src/${relative}`, import.meta.url), "utf8");

// 浮层返回准则（docs/design-guidelines-zh.md § 浮层返回准则）：触发器再点一次必须关掉同一个浮层。
// 这两条是静态契约测试：一旦有人把手写 showPopover/hidePopover 的 click 开关塞回来，测试就会红。
test("model picker 用声明式 popovertarget 开关，不再靠 click 读 :popover-open 反推", () => {
  const picker = source("ui/components/oc-model-picker.ts");
  assert.match(picker, /popovertarget=\$\{this\.menuId\}/);
  assert.match(picker, /popovertargetaction="toggle"/);
  assert.doesNotMatch(picker, /matches\(':popover-open'\)|matches\(":popover-open"\)/);
  assert.doesNotMatch(picker, /@click=\$\{\(\)=>this\.toggle\(\)\}/);
  // 打开的副作用挂在原生 beforetoggle/toggle 上，菜单 id 与触发器引用同一个值。
  assert.match(picker, /@beforetoggle=\$\{this\.onBeforeToggle\}/);
  assert.match(picker, /@toggle=\$\{this\.onToggle\}/);
  assert.match(picker, /id=\$\{this\.menuId\}/);
});

test("额度圆环同样走声明式 invoker，面板落边带 data-side 且断网有说明", () => {
  const quota = source("ui/components/model-quota.ts");
  assert.match(quota, /popovertarget=\$\{this\.panelId\}/);
  assert.match(quota, /popovertargetaction="toggle"/);
  assert.doesNotMatch(quota, /\.showPopover\(\)|\.hidePopover\(\)/);
  assert.match(quota, /panel\.dataset\.side=placement\.side/);
  assert.match(quota, /quota\.details\.offline/);
  const zh = source("ui/i18n/zh.ts"), en = source("ui/i18n/en.ts");
  for (const table of [zh, en]) assert.match(table, /"quota\.details\.offline": "\S/);
});

test("「更多」菜单贴着触发器落位、并被夹在裁剪容器内（不被 .oc-panel 的 overflow:hidden 裁掉）", () => {
  const panel = source("ui/components/oc-session-panel.ts");
  // 裁剪容器是 .oc-panel 本身，夹取边界必须用它，而不是把「新建对话」「搜索框」当避让目标
  // （那样会把菜单往下推 94px、还推到面板左边界外，正是用户反馈的「更偏了、被遮挡」）。
  assert.match(panel, /const panel = document\.querySelector<HTMLElement>\("\.oc-panel"\)/);
  assert.match(panel, /clip\.right - padding - size\.width/);
  assert.match(panel, /Math\.max\(clip\.left \+ padding, anchor\.right - size\.width\)/);
  assert.doesNotMatch(panel, /"\.oc-panel__new-chat"/);
  assert.doesNotMatch(panel, /"\.oc-panel__search"/);
  // 默认贴着触发器下方 4px，只在放不下时翻上；不再做「沿主轴滑动让位」。
  assert.match(panel, /anchor\.bottom \+ 4/);
  assert.match(panel, /anchor\.top - 4 - size\.height/);
  assert.match(panel, /menu\.style\.left\s*=\s*`\$\{Math\.round\(left - anchor\.left\)\}px`/);
  assert.match(panel, /menu\.style\.top\s*=\s*`\$\{Math\.round\(top - anchor\.top\)\}px`/);
  assert.match(panel, /menu\.style\.right = "auto"/);
  // 窗口尺寸变化时重排，关闭时注销监听（避免常驻 window 监听）。
  assert.match(panel, /window\.addEventListener\("resize", placeMoreMenu\)/);
  assert.match(panel, /window\.removeEventListener\("resize", placeMoreMenu\)/);
});

test("图标轨悬浮卡越出 68px 轨道后要自己提层，否则被树序在后的面板/调宽手柄盖住", () => {
  const shell = readFileSync(new URL("../../../../../src/styles/shell.css", import.meta.url), "utf8");
  for (const selector of [".oc-rail__conn-popup", ".oc-rail__error-popup"]) {
    const block = shell.match(new RegExp(`\\${selector} \\{([^}]*)\\}`));
    assert.ok(block, `${selector} block exists`);
    // 浮层档必须是变量引用（design-guidelines §4.4 / layout-qa 契约），不能写裸值。
    assert.match(block[1], /z-index:\s*var\(--z-dialog\)/, `${selector} 需要 z-index: var(--z-dialog)`);
    assert.match(block[1], /-webkit-app-region:\s*no-drag/, `${selector} 需要 no-drag`);
  }
});

test("面板与主列之间只画一条分割线（面板不再叠加 border-right）", () => {
  const panelCss = source("styles/session-panel.css");
  const block = panelCss.match(/\.oc-panel \{([^}]*)\}/);
  assert.ok(block, ".oc-panel block exists");
  // 先剥注释再断言：注释里提到 border-right 是为了解释「为什么删掉」，不能当作声明。
  const declarations = block[1].replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(declarations, /border-right/, ".oc-panel 不应再画 border-right（会与调宽手柄线并排成两条）");
  // 分割线独家由调宽手柄负责，且常态是 1px 发丝线 + 上下渐隐，不抢眼。
  const shell = readFileSync(new URL("../../../../../src/styles/shell.css", import.meta.url), "utf8");
  const handle = shell.match(/\.cryoclaw-panel-resize::after \{([^}]*)\}/);
  assert.ok(handle, "resize handle ::after exists");
  const handleDeclarations = handle[1].replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(handleDeclarations, /width:\s*1px/);
  assert.match(handleDeclarations, /mask-image:\s*linear-gradient\(to bottom, transparent/, "分割线两端应渐隐");
});

test("图标轨是 drag 区域，额度圆环与轨道按钮一样显式退出拖拽，否则真实鼠标点不开", () => {
  const shell = readFileSync(new URL("../../../../../src/styles/shell.css", import.meta.url), "utf8");
  const block = shell.match(/\.oc-rail__footer \.chat-quota__trigger\[data-placement="rail"\] \{([^}]*)\}/);
  assert.ok(block, "rail quota trigger block exists");
  assert.match(block[1], /-webkit-app-region: no-drag/);
  assert.match(shell, /\.oc-rail__footer oc-model-quota \{[^}]*-webkit-app-region: no-drag/);
});

test("入场/退场方向跟随落边：picker 上下、quota 四向都有 data-side 变体与 @starting-style", () => {
  const pickerCss = source("styles/model-picker.css"), quotaCss = source("styles/chat.css"), panelCss = source("styles/session-panel.css");
  assert.match(pickerCss, /\.model-picker__menu\[data-side=bottom\]\{transform:translateY\(-8px\)/);
  assert.match(pickerCss, /@starting-style\{\.model-picker__menu\[data-side=top\]:popover-open/);
  for (const side of ["top", "bottom", "left", "right"]) assert.match(quotaCss, new RegExp(`\\.chat-quota__details\\[data-side=${side}\\]`));
  assert.match(quotaCss, /\.chat-quota__details\[data-side=right\] \{ transform: translateX\(-6px\); transform-origin: right top; \}/);
  assert.match(panelCss, /\.oc-panel__more-menu\[data-side="top"\] \{\s*transform-origin: bottom right;/);
});

test("设计规范记录了浮层返回准则，中英文同步", () => {
  const zh = readFileSync(new URL("../../../../../../../docs/design-guidelines-zh.md", import.meta.url), "utf8");
  const en = readFileSync(new URL("../../../../../../../docs/design-guidelines-en.md", import.meta.url), "utf8");
  assert.match(zh, /### 浮层返回准则（2026\.10\.30）/);
  assert.match(zh, /popovertarget/);
  assert.match(zh, /placePopover\(\)/);
  assert.match(en, /### Overlay return rules \(2026-10-30\)/);
  assert.match(en, /popovertarget/);
});

test("真机几何：输入框底部向上展开、图标轨向右展开、「更多」菜单下滑避开主按钮", () => {
  const viewport = { width: 1520, height: 983 };
  // 模型选择器：触发器在输入框底部（y 919），菜单向上展开，不越出视口、不盖触发器。
  const pickerAnchor = { left: 457, top: 919, width: 177, height: 34 };
  const picker = placePopover({
    anchor: pickerAnchor,
    panel: { width: 348, height: 457 },
    viewport,
    candidates: [{ side: "top", align: "start" }, { side: "bottom", align: "start" }],
    avoid: [pickerAnchor],
  });
  assert.equal(picker.side, "top");
  assert.equal(picker.left, 457);
  assert.equal(picker.top, 454);
  assert.equal(rectsOverlap({ left: picker.left, top: picker.top, ...pickerSize(348, 457) }, pickerAnchor), false);

  // 额度圆环在图标轨底部（y 835..875）：向右展开、底边对齐，避开圆环本身。
  const ringAnchor = { left: 0, top: 835, width: 67, height: 40 };
  const ring = placePopover({
    anchor: ringAnchor,
    panel: { width: 320, height: 297 },
    viewport,
    candidates: [{ side: "right", align: "end" }, { side: "left", align: "end" }, { side: "top", align: "end" }, { side: "bottom", align: "end" }],
    avoid: [ringAnchor],
  });
  assert.equal(ring.side, "right");
  assert.equal(ring.left, 75);
  assert.equal(ring.top, 578);
  assert.equal(ring.covered, false);

  // 「更多」菜单：触发器在面板头右侧，下方紧跟「新建对话」主按钮与搜索框，必须下滑避开两者。
  const moreAnchor = { left: 221, top: 22, width: 30, height: 26 };
  const newChat = { left: 91, top: 70, width: 210, height: 36 };
  const search = { left: 91, top: 116, width: 210, height: 34 };
  const more = placePopover({
    anchor: moreAnchor,
    panel: { width: 188, height: 75 },
    viewport,
    gap: 4,
    padding: 10,
    candidates: [{ side: "bottom", align: "end" }, { side: "top", align: "end" }],
    avoid: [moreAnchor, newChat, search],
  });
  assert.equal(more.side, "bottom");
  assert.equal(more.covered, false);
  const moreRect = { left: more.left, top: more.top, ...pickerSize(188, 75) };
  assert.equal(rectsOverlap(moreRect, newChat), false);
  assert.equal(rectsOverlap(moreRect, search), false);
  assert.ok(more.top >= search.top + search.height);
});

function pickerSize(width: number, height: number) {
  return { width, height };
}
