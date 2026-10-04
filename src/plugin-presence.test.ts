// plugin-presence 四根判定回归（T5）。
// node:test 环境无 Electron（constants 链的 app 为 undefined）：gateway/mirror
// 两个资源根解析抛错后被逐根吞掉，按「该根缺席」跳过——本文件覆盖可布置的
// state extensions 根、npm/projects 受管安装根，以及探针行为与根顺序。
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  defaultPluginDirProbe,
  isPluginPresentAnywhere,
  manifestOnlyPluginDirProbe,
} from "./plugin-presence";

// 创建临时 OPENCLAW_STATE_DIR 并登记环境还原与目录清理（对齐 weixin-config.test.ts）。
function setupTempStateDir(t: TestContext): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-presence-"));
  const prevStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  t.after(() => {
    if (prevStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = prevStateDir;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  return stateDir;
}

function writeManifest(dir: string, id: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), JSON.stringify({ id }), "utf-8");
}

function writeEntry(dir: string, entry: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, entry)), { recursive: true });
  fs.writeFileSync(path.join(dir, entry), "export default {};\n", "utf-8");
}

/* ── 默认探针：清单 + 任一入口变体 ── */

test("defaultPluginDirProbe 应要求清单与任一入口文件同时存在", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-probe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const manifestOnly = path.join(root, "manifest-only");
  writeManifest(manifestOnly, "demo");
  assert.equal(defaultPluginDirProbe(manifestOnly), false, "只有清单不算可用插件");

  const entryOnly = path.join(root, "entry-only");
  fs.mkdirSync(entryOnly, { recursive: true });
  writeEntry(entryOnly, "index.ts");
  assert.equal(defaultPluginDirProbe(entryOnly), false, "只有入口缺清单不算");

  for (const entry of ["index.ts", "dist/index.js", "dist/index.cjs.js", "dist/index.esm.js"]) {
    const dir = path.join(root, `ok-${entry.replace(/[\/.]/g, "-")}`);
    writeManifest(dir, "demo");
    writeEntry(dir, entry);
    assert.equal(defaultPluginDirProbe(dir), true, `入口变体 ${entry} 应命中`);
  }

  assert.equal(defaultPluginDirProbe(path.join(root, "absent")), false, "目录不存在返回 false 而非抛错");
});

test("manifestOnlyPluginDirProbe 应只要求清单存在（vendored 形态入口布局不同）", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-probe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "vendored");
  writeManifest(dir, "demo");
  assert.equal(manifestOnlyPluginDirProbe(dir), true);
  assert.equal(manifestOnlyPluginDirProbe(path.join(root, "absent")), false);
});

/* ── isPluginPresentAnywhere：根命中与顺序 ── */

test("state extensions 根命中：探针按根顺序收到 <state>/extensions/<id> 且命中短路", (t) => {
  const stateDir = setupTempStateDir(t);
  const pluginDir = path.join(stateDir, "extensions", "demo-plugin");
  writeManifest(pluginDir, "demo-plugin");
  writeEntry(pluginDir, "index.ts");

  const probedDirs: string[] = [];
  const present = isPluginPresentAnywhere("demo-plugin", (dir) => {
    probedDirs.push(dir);
    return defaultPluginDirProbe(dir);
  });

  assert.equal(present, true);
  // node:test 环境 gateway/mirror 根不可解析被跳过，首个被探测的目录根即 state extensions
  assert.deepEqual(probedDirs, [pluginDir]);
});

test("npm/projects 受管安装根命中：id 取清单声明（可与包名/目录名不同）", (t) => {
  const stateDir = setupTempStateDir(t);
  const projectDir = path.join(stateDir, "npm", "projects", "proj-a");
  const pkgDir = path.join(projectDir, "node_modules", "@vendor", "some-package-name");
  writeManifest(pkgDir, "demo-plugin");
  fs.writeFileSync(
    path.join(projectDir, "package.json"),
    JSON.stringify({ dependencies: { "@vendor/some-package-name": "1.0.0" } }),
    "utf-8",
  );

  // 目录根全空，仅 npm/projects 命中
  assert.equal(isPluginPresentAnywhere("demo-plugin"), true);
  // 未声明进 dependencies 的传递依赖不算（R93 审查修订语义）
  assert.equal(isPluginPresentAnywhere("other-plugin"), false);
});

test("四根全空 → false", (t) => {
  setupTempStateDir(t);
  assert.equal(isPluginPresentAnywhere("demo-plugin"), false);
});

test("自定义探针应覆盖默认判定；探针异常按该根缺席处理", (t) => {
  const stateDir = setupTempStateDir(t);
  const pluginDir = path.join(stateDir, "extensions", "demo-plugin");
  // 只有清单：默认探针 false，manifest-only 探针 true
  writeManifest(pluginDir, "demo-plugin");
  assert.equal(isPluginPresentAnywhere("demo-plugin"), false, "默认探针要求入口");
  assert.equal(isPluginPresentAnywhere("demo-plugin", manifestOnlyPluginDirProbe), true, "自定义探针放宽");
  assert.equal(isPluginPresentAnywhere("demo-plugin", () => false), false, "自定义探针收紧");

  // 完整插件 + 抛错探针：不得把异常冒泡给调用方（IPC 查询链路）
  writeEntry(pluginDir, "index.ts");
  assert.equal(
    isPluginPresentAnywhere("demo-plugin", () => {
      throw new Error("probe boom");
    }),
    false,
    "探针异常按缺席处理并落到后续根",
  );
});
