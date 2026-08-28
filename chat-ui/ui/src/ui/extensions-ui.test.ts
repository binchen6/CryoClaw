// 守护回归（源码审计，同 git-ui.test.ts 模式）：
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

test("registry：extensions 视图 id + fullpage meta", () => {
  const s = src("views/registry.ts");
  assert.match(s, /"extensions",/, "CRYOCLAW_VIEW_IDS 应包含 extensions");
  assert.match(s, /extensions:\s*\{\s*id: "extensions", fullpage: true, titlebarBack: true \}/, "缺少 extensions meta");
});

test("app-render：renderActiveView 分发 extensions + sidebar props 更名", () => {
  const s = src("app-render.ts");
  assert.match(s, /case "extensions":\s*\n\s*return renderExtensionsView\(state\)/, "缺少渲染分支");
  assert.match(s, /extensionsActive: cryoclawView === "extensions"/, "缺少 extensionsActive prop");
  assert.match(s, /onOpenExtensions: \(\) => openExtensionsView\(state\)/, "缺少 onOpenExtensions prop");
  assert.ok(!/skillsActive: cryoclawView === "skills"/.test(s), "skillsActive prop 应已移除");
});

test("cc-sidebar：技能导航项更名为扩展入口", () => {
  const s = src("components/cc-sidebar.ts");
  assert.match(s, /t\("sidebar\.extensions"\)/, "缺少扩展入口文案");
  assert.match(s, /props\.onOpenExtensions/, "导航项未接 onOpenExtensions");
  assert.match(s, /extensionsActive \? "active"/, "导航项未接 active 态");
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
