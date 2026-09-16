// 守护回归（源码审计，同 workspace-ui.test.ts 模式）：
// R42 第二期「扩展视图（技能/插件双 tab）」的接线钉点。技能视图（skills）与
// 设置页插件 tab 整合为新视图 extensions；插件 tab 状态复位从 cleanupSettingsView
// 迁为 extensions 视图 leave hook。重 UI 模块（app.ts / components/cc-sidebar.ts /
// app-render.ts / app-extensions.ts）在 node 下不可导入，只能钉源码。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function src(rel: string): string {
  return readFileSync(new URL(`../../../../src/ui/${rel}`, import.meta.url), "utf8");
}

// 剥掉块注释与行注释：负向断言只针对真实代码，防注释中的字样误匹配
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

test("registry：extensions 视图 id + meta（2026.9：非 fullpage，rail 常驻）", () => {
  const s = src("views/registry.ts");
  assert.match(s, /"extensions",/, "CRYOCLAW_VIEW_IDS 应包含 extensions");
  assert.match(s, /extensions:\s*\{\s*id: "extensions", fullpage: false, titleKey: "sidebar\.extensions" \}/, "缺少 extensions meta");
  // R42 第二期 T5：skills 视图已收敛进 extensions（技能 tab），视图 id 删除
  assert.ok(!/"skills",/.test(stripComments(s)), "skills 视图 id 应已删除");
});

test("app-render：renderActiveView 分发 extensions + rail 接线", () => {
  const s = src("app-render.ts");
  assert.match(s, /case "extensions":\s*\n\s*return renderExtensionsView\(state\)/, "缺少渲染分支");
  assert.match(s, /onOpenExtensions: \(\) => openExtensionsView\(state\)/, "缺少 onOpenExtensions prop");
  assert.match(s, /activeView: cryoclawView/, "应向 cc-rail 传 activeView");
});

test("cc-rail：扩展导航入口", () => {
  const s = src("components/cc-rail.ts");
  assert.match(s, /t\("sidebar\.extensions"\)/, "缺少扩展入口文案");
  assert.match(s, /props\.onOpenExtensions/, "导航项未接 onOpenExtensions");
  assert.match(s, /props\.activeView === opts\.view/, "导航项未接 active 态");
});

test("settings：plugins tab 迁出（SETTINGS_TABS 无 plugins，settings-view 无渲染分支）", () => {
  const tabs = src("views/settings/settings-constants.ts");
  assert.ok(!/"plugins"/.test(tabs), "SETTINGS_TABS 不应再有 plugins");
  const view = src("views/settings/settings-view.ts");
  assert.ok(!/renderTabPlugins\(state\)/.test(view), "settings-view 不应再渲染插件 tab");
  assert.match(view, /resetPluginsView\(\);/, "invalidateAllSettings 仍应复位插件视图状态");
});

test("扩展视图：双 tab + 离开复位（leave hook 迁移）", () => {
  const s = src("app-extensions.ts");
  assert.match(s, /registerViewLeaveHook\("extensions", \(\) => resetPluginsView\(\)\)/, "缺少离开视图复位插件状态的 hook");
  assert.match(s, /"extensions\.tabSkills"/, "缺少技能 tab 文案");
  assert.match(s, /"extensions\.tabPlugins"/, "缺少插件 tab 文案");
  assert.match(s, /renderPluginsView\(state\)/, "插件 tab 未接 renderPluginsView");
  const skills = src("app-skills.ts");
  assert.ok(!/setCryoClawView\(state, "skills"\)/.test(skills), "app-skills 不应再切换 skills 视图");
});

test("i18n：新键双区齐全，settings.nav.plugins 已删", () => {
  const zh = src("i18n/zh.ts");
  const en = src("i18n/en.ts");
  for (const key of ['"sidebar.extensions"', '"extensions.tabSkills"', '"extensions.tabPlugins"']) {
    assert.ok(zh.includes(key), `zh.ts 缺少 ${key}`);
    assert.ok(en.includes(key), `en.ts 缺少 ${key}`);
  }
  assert.ok(!zh.includes('"settings.nav.plugins"'), "zh.ts 应删除 settings.nav.plugins");
  assert.ok(!en.includes('"settings.nav.plugins"'), "en.ts 应删除 settings.nav.plugins");
});

test("settings：extensions 分组与死键清理彻底", () => {
  const tabs = src("views/settings/settings-constants.ts");
  assert.ok(!/"extensions"/.test(tabs), "分组 union 不应残留 extensions");
  const zh = src("i18n/zh.ts");
  const en = src("i18n/en.ts");
  for (const key of ['"settings.group.extensions"', '"sidebar.skillStore"']) {
    assert.ok(!zh.includes(key), `zh.ts 应删除死键 ${key}`);
    assert.ok(!en.includes(key), `en.ts 应删除死键 ${key}`);
  }
});

// ── R91 扩展页增强：插件更新 / 详情 / 市场发现 / 技能推荐 ──

test("R91 tab-plugins：检查更新 + 单项/全部更新 + 重启网关接线", () => {
  const s = stripComments(src("views/settings/tab-plugins.ts"));
  assert.match(s, /pluginStoreCheckUpdates/, "缺少检查更新 IPC 调用");
  assert.match(s, /pluginStoreUpdate\(/, "缺少更新 IPC 调用");
  assert.match(s, /restartGateway\?\.\(\)/, "更新后缺少重启网关入口");
  assert.match(s, /updatable/, "缺少可更新列表状态");
});

test("R91 tab-plugins：市场浏览 + 推荐算法接入", () => {
  const s = stripComments(src("views/settings/tab-plugins.ts"));
  assert.match(s, /pluginStoreMarketBrowse/, "缺少市场浏览 IPC");
  assert.match(s, /buildRecommendations/, "市场浏览未接推荐算法");
  assert.match(s, /rankMarket/, "市场浏览未接评分排序");
  assert.match(s, /ext\.market\.recommended/, "缺少为你推荐 rail 文案");
  assert.match(s, /openPluginDetail/, "缺少插件详情入口");
});

test("R91 ext-detail：插件/技能详情对话框 + 请求代次守卫", () => {
  const s = stripComments(src("views/ext-detail.ts"));
  assert.match(s, /pluginStoreDetail/, "插件详情未走 IPC");
  assert.match(s, /skillStoreDetail/, "技能详情未走 IPC");
  assert.match(s, /detailToken/, "缺少请求代次守卫");
  assert.match(s, /toSanitizedMarkdownHtml/, "readme 未走净化 Markdown 链路");
  const render = stripComments(src("app-render.ts"));
  assert.match(render, /renderExtDetailDialog\(state\)/, "对话框未挂到应用根");
});

test("R91 app-skills：技能推荐 rail + 详情回调", () => {
  const s = stripComments(src("app-skills.ts"));
  assert.match(s, /buildRecommendations/, "技能商店未接推荐算法");
  assert.match(s, /skillToMarketItem/, "技能条目未映射为市场核心类型");
  assert.match(s, /openSkillDetail/, "缺少技能详情入口");
  assert.match(s, /skillStore\.recommended/, "缺少推荐 rail 文案键");
});

test("R91 skills.css：市场网格 + 详情对话框样式落地（全 token）", () => {
  const css = readFileSync(new URL("../../../../src/styles/skills.css", import.meta.url), "utf8");
  assert.match(css, /\.ext-market__grid\s*\{/, "缺少市场网格样式");
  assert.match(css, /\.ext-detail__dialog\s*\{/, "缺少详情对话框样式");
  assert.match(css, /\.skill-store__recommend-card\s*\{/, "缺少技能推荐卡样式");
  assert.match(css, /repeat\(auto-fill, minmax\(340px, 1fr\)\)/, "技能列表未网格化");
});
