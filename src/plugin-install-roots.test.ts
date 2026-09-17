// plugin-install-roots.test.ts — scanNpmProjectPlugins / listNpmProjectPluginIds
// 的单元测试（node:test，真实临时目录 IO）。钉住 R93 的关键契约：
//   1. 只认项目 package.json dependencies 声明的、带 openclaw.plugin.json 的包
//      （运行时 id 与包名不同的 @scope 形态也要命中）
//   2. 传递依赖（axios 等，无插件清单）绝不进 id 集合（R93 审查：basename 兜底
//      曾把 wecom 项目的 45 个依赖包污染成 47 个假 id）
//   3. 三态错误语义：目录缺失 = 合法空集合；非 ENOENT 读失败 = ok:false
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { listNpmProjectPluginIds, scanNpmProjectPlugins } from "./plugin-install-roots.ts";

function makeTmpState(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "plugin-roots-test-"));
}

function writeProject(state: string, project: string, depName: string, manifest: object | null, extraDirs: string[] = []): void {
  const projectDir = path.join(state, "npm", "projects", project);
  const pkgDir = path.join(projectDir, "node_modules", ...depName.split("/"));
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ private: true, dependencies: { [depName]: "1.0.0" } }));
  if (manifest) fs.writeFileSync(path.join(pkgDir, "openclaw.plugin.json"), JSON.stringify(manifest));
  for (const extra of extraDirs) {
    fs.mkdirSync(path.join(projectDir, "node_modules", extra), { recursive: true });
  }
}

test("scanNpmProjectPlugins：收集 manifest id（@scope 包名 ≠ 运行时 id）+ channels", () => {
  const state = makeTmpState();
  try {
    writeProject(state, "wecom-wecom-openclaw-plugin-18f843d908", "@wecom/wecom-openclaw-plugin",
      { id: "wecom-openclaw-plugin", channels: ["wecom"] });
    writeProject(state, "openclaw-tavily-plugin-8ad843922d", "@openclaw/tavily-plugin",
      { id: "tavily" });
    const scan = scanNpmProjectPlugins(state);
    assert.equal(scan.ok, true);
    if (!scan.ok) return;
    assert.ok(scan.plugins.has("wecom-openclaw-plugin"), "应有 wecom 运行时 id");
    assert.deepEqual(scan.plugins.get("wecom-openclaw-plugin")?.channels, ["wecom"]);
    assert.ok(scan.plugins.has("tavily"), "应有 tavily 运行时 id");
    assert.deepEqual(scan.plugins.get("tavily")?.channels, []);
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("scanNpmProjectPlugins：传递依赖（无插件清单）不进集合", () => {
  const state = makeTmpState();
  try {
    writeProject(state, "proj-1", "@wecom/wecom-openclaw-plugin",
      { id: "wecom-openclaw-plugin" }, ["axios", "debug", "ms", "@scope", "lodash"]);
    // 依赖目录里塞上普通 package.json，模拟真实传递依赖
    fs.writeFileSync(path.join(state, "npm", "projects", "proj-1", "node_modules", "axios", "package.json"), "{}");
    const scan = scanNpmProjectPlugins(state);
    assert.equal(scan.ok, true);
    if (!scan.ok) return;
    assert.equal(scan.plugins.size, 1, "只有声明的插件本体命中");
    assert.ok(scan.plugins.has("wecom-openclaw-plugin"));
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("scanNpmProjectPlugins：目录缺失 = 合法空集合；半成品项目跳过", () => {
  const empty = scanNpmProjectPlugins(path.join(os.tmpdir(), "definitely-missing-dir-xyz"));
  assert.equal(empty.ok, true);
  if (empty.ok) assert.equal(empty.plugins.size, 0);

  const state = makeTmpState();
  try {
    // 有 node_modules 但项目 package.json 缺失（半成品）→ 跳过而非失败
    fs.mkdirSync(path.join(state, "npm", "projects", "half-done", "node_modules", "@x", "y"), { recursive: true });
    const scan = scanNpmProjectPlugins(state);
    assert.equal(scan.ok, true);
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("scanNpmProjectPlugins：非 ENOENT 读失败 = 硬失败（ok:false）", () => {
  const state = makeTmpState();
  try {
    // 堵 stateDir/npm/projects 本身（父组件缺失/为文件在 Windows 上是 ENOENT）
    fs.mkdirSync(path.join(state, "npm"), { recursive: true });
    fs.writeFileSync(path.join(state, "npm", "projects"), "");
    const scan = scanNpmProjectPlugins(state);
    assert.equal(scan.ok, false, "ENOTDIR 应视为硬失败");
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("listNpmProjectPluginIds：硬失败回退空集合（mirror 侧自愈语义）", () => {
  const state = makeTmpState();
  try {
    fs.mkdirSync(path.join(state, "npm"), { recursive: true });
    fs.writeFileSync(path.join(state, "npm", "projects"), "");
    const ids = listNpmProjectPluginIds(state);
    assert.equal(ids.size, 0);
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
});
