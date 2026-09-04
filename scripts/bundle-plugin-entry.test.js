// bundle-plugin-entry.js 单元测试：banner 注入（createRequire/__dirname shim）、
// isBundleFresh 的 banner 标记新鲜度判断、patchPluginEntryFields 幂等性、
// rebundlePluginDistChunks 的 ws 内联 + 相对导入保留。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ensurePluginNativeEntry,
  rebundlePluginDistChunks,
  isBundleFresh,
  patchPluginEntryFields,
  BUNDLE_REL,
  BUNDLE_BANNER_MARKER,
} = require("./lib/bundle-plugin-entry");

function makePluginDir(t) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-bundle-entry-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  const pluginDir = path.join(tmpRoot, "plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  return pluginDir;
}

function writePkg(pluginDir, openclawField) {
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    `${JSON.stringify({ name: "test-plugin", openclaw: openclawField }, null, 2)}\n`,
  );
}

test("esbuild 产物头部注入 createRequire/__filename/__dirname banner", async (t) => {
  const pluginDir = makePluginDir(t);
  writePkg(pluginDir, { extensions: ["./index.ts"] });
  fs.writeFileSync(path.join(pluginDir, "index.ts"), "export default function register() {}\n");

  const result = await ensurePluginNativeEntry(pluginDir, { label: "test-plugin" });

  assert.equal(result.action, "bundled");
  const bundle = fs.readFileSync(path.join(pluginDir, BUNDLE_REL), "utf-8");
  assert.ok(bundle.includes(BUNDLE_BANNER_MARKER), "产物应含 createRequire 标记");
  assert.ok(bundle.includes('createRequire as __cryoclawCreateRequire } from "node:module"'));
  assert.ok(bundle.includes("const require = __cryoclawCreateRequire(import.meta.url);"));
  assert.ok(bundle.includes("const __filename = __cryoclawFileURLToPath(import.meta.url);"));
  assert.ok(bundle.includes("const __dirname = __cryoclawDirname(__filename);"));
});

test("isBundleFresh 对不含 banner 标记的旧 bundle 判过期", (t) => {
  const pluginDir = makePluginDir(t);
  const entry = path.join(pluginDir, "index.js");
  const bundle = path.join(pluginDir, BUNDLE_REL);
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  fs.writeFileSync(entry, "export default 1;\n");

  assert.equal(isBundleFresh(bundle, entry), false, "bundle 不存在时判过期");

  // 老格式 bundle：mtime 比 entry 新，但头部没有 banner 标记 → 仍判过期
  fs.writeFileSync(bundle, "export default 1;\n");
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(entry, past, past);
  fs.utimesSync(bundle, new Date(), new Date());
  assert.equal(isBundleFresh(bundle, entry), false, "无 banner 标记的旧 bundle 应判过期");

  // 新格式 bundle：头部有标记且 mtime 不旧 → 新鲜
  fs.writeFileSync(bundle, `import { createRequire as ${BUNDLE_BANNER_MARKER} } from "node:module";\nexport default 1;\n`);
  fs.utimesSync(bundle, new Date(), new Date());
  assert.equal(isBundleFresh(bundle, entry), true);

  // entry 比 bundle 新 → 判过期
  fs.utimesSync(entry, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  assert.equal(isBundleFresh(bundle, entry), false, "entry 更新时应判过期");
});

test("patchPluginEntryFields 幂等，且同步改写 runtimeExtensions[0]", (t) => {
  const pluginDir = makePluginDir(t);
  writePkg(pluginDir, {
    extensions: ["./index.ts"],
    runtimeExtensions: ["./dist/index.js"],
    channel: { id: "qqbot" },
  });

  patchPluginEntryFields(pluginDir, BUNDLE_REL);

  const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf-8"));
  const normalized = `./${BUNDLE_REL.replace(/\\/g, "/")}`;
  assert.deepEqual(pkg.openclaw.extensions, [normalized]);
  assert.deepEqual(pkg.openclaw.runtimeExtensions, [normalized]);
  assert.deepEqual(pkg.openclaw.channel, { id: "qqbot" }, "其他 openclaw 字段不应被动");

  const before = fs.readFileSync(path.join(pluginDir, "package.json"), "utf-8");
  patchPluginEntryFields(pluginDir, BUNDLE_REL);
  const after = fs.readFileSync(path.join(pluginDir, "package.json"), "utf-8");
  assert.equal(after, before, "二次 patch 不应改写文件（幂等）");
});

test("patchPluginEntryFields 无 extensions 字段时补写，且无 runtimeExtensions 时不新增", (t) => {
  const pluginDir = makePluginDir(t);
  writePkg(pluginDir, {});

  patchPluginEntryFields(pluginDir, BUNDLE_REL);

  const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf-8"));
  const normalized = `./${BUNDLE_REL.replace(/\\/g, "/")}`;
  assert.deepEqual(pkg.openclaw.extensions, [normalized]);
  assert.equal("runtimeExtensions" in pkg.openclaw, false);
});

test("entryOverride 指向 vendored 插件的 runtimeExtensions 入口", async (t) => {
  const pluginDir = makePluginDir(t);
  // 模拟 qqbot 形态：extensions[0] 指向不存在的 ./index.ts，真实入口在 dist/index.js
  writePkg(pluginDir, { extensions: ["./index.ts"], runtimeExtensions: ["./dist/index.js"] });
  fs.mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "dist", "index.js"), "export default { id: \"qqbot\" };\n");

  const missing = await ensurePluginNativeEntry(pluginDir, { label: "qqbot" });
  assert.equal(missing.action, "missing", "无 entryOverride 时 resolve 不到入口");

  const result = await ensurePluginNativeEntry(pluginDir, { label: "qqbot", entryOverride: "./dist/index.js" });
  assert.equal(result.action, "bundled");
  const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf-8"));
  const normalized = `./${BUNDLE_REL.replace(/\\/g, "/")}`;
  assert.deepEqual(pkg.openclaw.extensions, [normalized]);
  assert.deepEqual(pkg.openclaw.runtimeExtensions, [normalized]);
});

test("入口已是过期 bundle（缓存复用目录）时原地重 bundle 补 banner", async (t) => {
  const pluginDir = makePluginDir(t);
  const normalized = `./${BUNDLE_REL.replace(/\\/g, "/")}`;
  // 模拟 stamp 缓存复用的目录：extensions[0] 已指向上次 patch 的 bundle，
  // bundle 是无 banner 的老产物（完整 single-file）
  writePkg(pluginDir, { extensions: [normalized] });
  const bundleAbs = path.join(pluginDir, BUNDLE_REL);
  fs.mkdirSync(path.dirname(bundleAbs), { recursive: true });
  fs.writeFileSync(bundleAbs, 'import { x } from "openclaw/plugin-sdk/x";\nexport default function register() { return x; }\n');

  const result = await ensurePluginNativeEntry(pluginDir, { label: "cached-plugin" });

  assert.equal(result.action, "bundled");
  const bundle = fs.readFileSync(bundleAbs, "utf-8");
  assert.ok(bundle.includes(BUNDLE_BANNER_MARKER), "重 bundle 后应含 banner 标记");
  assert.equal(bundle.match(/const require = /g).length, 1, "banner const require 不应重复声明");
  // 二次运行：bundle 已新鲜 → 复用
  const second = await ensurePluginNativeEntry(pluginDir, { label: "cached-plugin" });
  assert.equal(second.action, "bundled-reused");
});

test("rebundlePluginDistChunks 内联 ws、保留相对导入、幂等", async (t) => {
  const pluginDir = makePluginDir(t);
  writePkg(pluginDir, { extensions: ["./index.js"] });

  // 插件自带 node_modules 里的假 ws（CJS），模拟 vendored ws@8；
  // 故意带一层 node_modules 内部的相对 require（ws/lib/* 的真实形态），
  // 确保依赖内部的相对导入会被正常内联而不是误判 external。
  const wsDir = path.join(pluginDir, "node_modules", "ws");
  fs.mkdirSync(path.join(wsDir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(wsDir, "package.json"), JSON.stringify({ name: "ws", main: "index.js" }));
  fs.writeFileSync(
    path.join(wsDir, "index.js"),
    'const { WS_MARKER } = require("./lib/thing.js");\nclass FakeWebSocket {}\nFakeWebSocket.MARKER = WS_MARKER;\nmodule.exports = FakeWebSocket;\n',
  );
  fs.writeFileSync(path.join(wsDir, "lib", "thing.js"), 'module.exports = { WS_MARKER: "fake-ws-inline-ok" };\n');

  const distDir = path.join(pluginDir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, "util.js"), "export function helper() { return 42; }\n");
  fs.writeFileSync(
    path.join(distDir, "gateway.js"),
    [
      'import WebSocket from "ws";',
      'import { helper } from "./util.js";',
      "export function connect() { return new WebSocket(helper()); }",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(distDir, "index.js"), "export default {};\n");

  const result = await rebundlePluginDistChunks(pluginDir, { label: "test-plugin" });

  assert.equal(result.action, "rebundled");
  assert.deepEqual(result.rebundled, [path.join("dist", "gateway.js")]);

  const gateway = fs.readFileSync(path.join(distDir, "gateway.js"), "utf-8");
  assert.equal(gateway.includes('from "ws"'), false, "ws 应被静态内联，不再 import");
  assert.ok(gateway.includes("FakeWebSocket"), "ws 的实现应内联进 chunk");
  assert.ok(gateway.includes("fake-ws-inline-ok"), "ws 内部的相对 require 也应内联");
  assert.equal(gateway.includes("./lib/thing.js"), false, "依赖内部相对导入不应外泄成 external");
  assert.ok(gateway.includes('from "./util.js"'), "相对导入应保持 external（跨 chunk 单例共享）");
  assert.ok(gateway.includes(BUNDLE_BANNER_MARKER), "chunk 也应带 banner");

  // 未命中 ws 的 chunk 不动
  assert.equal(fs.readFileSync(path.join(distDir, "index.js"), "utf-8"), "export default {};\n");

  // 幂等：重 bundle 后不再含 `from "ws"`，二次运行跳过
  const second = await rebundlePluginDistChunks(pluginDir, { label: "test-plugin" });
  assert.equal(second.action, "none");
});
