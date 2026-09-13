// R85：工具类型显示（label/icon/source）解析测试。
// 背景 QA：对话页工具调用卡片不显示调用的工具类型——两个叠加缺陷：
//   1. tool-display.json 图标键是短横线（file-text）而 icons.ts 键是驼峰（fileText），
//      icons[key] 取不到 → 内核工具图标全部渲染为空；
//   2. 未映射的插件/MCP 工具（anysearch__search）label 直接用内部原始名。
import test from "node:test";
import assert from "node:assert/strict";

import { icons } from "./icons.ts";
import { getLocale, setLocale } from "./i18n/index.ts";
import { resolveToolDisplay } from "./tool-display.ts";

// 单测进程内 locale 是共享模块状态：结束后必须还原，避免污染其它测试
// （message-meta / tool-summary 的 label 断言依赖默认 en）。
const prevLocale = getLocale();

test("resolveToolDisplay：映射工具图标键统一转驼峰并可渲染", () => {
  for (const name of ["read", "write", "edit", "exec", "web_search", "browser"]) {
    const d = resolveToolDisplay({ name });
    assert.ok(icons[d.icon], `${name} 的图标 ${d.icon} 必须存在于 icons 表`);
  }
});

test("resolveToolDisplay：未知工具图标按动词段推断，非法回落 puzzle", () => {
  assert.equal(resolveToolDisplay({ name: "anysearch__search" }).icon, "search");
  assert.equal(resolveToolDisplay({ name: "foo__fetch" }).icon, "globe");
  assert.equal(resolveToolDisplay({ name: "weird__zzz_unknown" }).icon, "puzzle");
});

test("resolveToolDisplay：插件__动词 名解析出友好 label 与 source", () => {
  setLocale("zh");
  const d = resolveToolDisplay({ name: "anysearch__search" });
  assert.equal(d.label, "搜索");
  assert.equal(d.source, "anysearch");

  const mcp = resolveToolDisplay({ name: "mcp__kimi-webbridge__navigate" });
  assert.equal(mcp.label, "网页操作");
  assert.equal(mcp.source, "kimi-webbridge");

  const unknown = resolveToolDisplay({ name: "myplugin__zzz_custom" });
  assert.equal(unknown.source, "myplugin");
  assert.ok(unknown.label.length > 0, "未知动词段也必须有可读 label");
});

test("resolveToolDisplay：内核工具 label 走 i18n 本地化", () => {
  setLocale("zh");
  assert.equal(resolveToolDisplay({ name: "read" }).label, "读取文件");
  assert.equal(resolveToolDisplay({ name: "exec" }).label, "执行命令");
  assert.equal(resolveToolDisplay({ name: "web_search" }).label, "网页搜索");
  assert.equal(resolveToolDisplay({ name: "read" }).source, undefined);

  setLocale("en");
  assert.equal(resolveToolDisplay({ name: "read" }).label, "Read file");
});

test("resolveToolDisplay：detail 推断与 source 并存不冲突", () => {
  setLocale("zh");
  const d = resolveToolDisplay({ name: "anysearch__search", args: { query: "minecraft 整合包" } });
  assert.equal(d.detail, "minecraft 整合包");
  assert.equal(d.source, "anysearch");
});

// 还原共享 locale（node 环境默认 en；上面多个用例切到 zh）
test("收尾：还原 locale", () => {
  setLocale(prevLocale);
});
