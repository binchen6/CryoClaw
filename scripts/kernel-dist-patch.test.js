// kernel-dist-patch.js 的 patchKimiThinkingProfile 单元测试：
// kimi 插件思考档位补丁必须幂等、按 marker 匹配，并让带
// compat.supportedReasoningEfforts 的模型获得完整档位。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const kdp = require("./lib/kernel-dist-patch");

const KIMI_INDEX = [
  "var kimi_coding_default = definePluginEntry({",
  "\tid: PLUGIN_ID,",
  "\tregister(api) {",
  "\t\tapi.registerProvider({",
  "\t\t\tid: PROVIDER_ID,",
  '\t\t\taliases: ["kimi-code", "kimi-coding"],',
  "\t\t\tresolveThinkingProfile: () => ({",
  "\t\t\t\tlevels: [{",
  '\t\t\t\t\tid: "off",',
  '\t\t\t\t\tlabel: "off"',
  "\t\t\t\t}, {",
  '\t\t\t\t\tid: "low",',
  '\t\t\t\t\tlabel: "on"',
  "\t\t\t\t}],",
  '\t\t\t\tdefaultLevel: "off"',
  "\t\t\t}),",
  "\t\t\twrapStreamFn: wrapKimiProviderStream",
  "\t\t});",
  "\t}",
  "});",
  "",
].join("\n");

function makeGateway(t, indexContent) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-kimi-thinking-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  const gatewayDir = path.join(tmpRoot, "gateway");
  const target = path.join(
    gatewayDir,
    "node_modules",
    "openclaw",
    "dist",
    "extensions",
    "kimi",
    "dist",
    "index.js"
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, indexContent);
  return { gatewayDir, target };
}

test("kimi 思考档位补丁命中并注入 context 感知逻辑", (t) => {
  const { gatewayDir, target } = makeGateway(t, KIMI_INDEX);
  assert.equal(kdp.patchKimiThinkingProfile(gatewayDir), 1);
  const patched = fs.readFileSync(target, "utf-8");
  assert.match(patched, /\/\* cryoclaw-thinking-profile \*\//);
  assert.match(patched, /supportedReasoningEfforts/);
  assert.match(patched, /resolveThinkingProfile: \(context\) => \{/);
  // 原二值兜底仍保留（无 compat 时）
  assert.match(patched, /label: "on"/);
});

test("kimi 思考档位补丁幂等：二次运行返回 0", (t) => {
  const { gatewayDir, target } = makeGateway(t, KIMI_INDEX);
  assert.equal(kdp.patchKimiThinkingProfile(gatewayDir), 1);
  const once = fs.readFileSync(target, "utf-8");
  assert.equal(kdp.patchKimiThinkingProfile(gatewayDir), 0);
  assert.equal(fs.readFileSync(target, "utf-8"), once);
});

test("kimi 思考档位补丁：目标缺失或 marker 不匹配返回 0 且不改动", (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-kimi-thinking-miss-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  // 文件不存在
  assert.equal(kdp.patchKimiThinkingProfile(tmpRoot), 0);
  // marker 不匹配（上游结构变化）
  const { gatewayDir, target } = makeGateway(t, "var x = 1;\n");
  assert.equal(kdp.patchKimiThinkingProfile(gatewayDir), 0);
  assert.equal(fs.readFileSync(target, "utf-8"), "var x = 1;\n");
});

test("kimi 思考档位补丁后钩子行为：有 compat 全档位 / 无 compat 二值", (t) => {
  const { gatewayDir, target } = makeGateway(
    t,
    // 模拟可独立执行的插件注册片段（无需 openclaw 依赖）
    KIMI_INDEX.replace(
      "var kimi_coding_default = definePluginEntry({",
      'function definePluginEntry(e) { return e; }\nconst PLUGIN_ID = "kimi";\nconst PROVIDER_ID = "kimi";\nconst wrapKimiProviderStream = () => {};\nvar kimi_coding_default = definePluginEntry({'
    ) + "\nmodule.exports = kimi_coding_default;\n"
  );
  assert.equal(kdp.patchKimiThinkingProfile(gatewayDir), 1);
  // 打补丁后的文件必须是可加载的合法 CJS
  const mod = require(target);
  let captured;
  mod.register({ registerProvider: (p) => (captured = p) });
  const full = captured.resolveThinkingProfile({
    compat: { supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh", "max"] },
  });
  assert.deepEqual(
    full.levels.map((l) => l.id),
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
  );
  assert.equal(full.defaultLevel, "high");
  const binary = captured.resolveThinkingProfile({});
  assert.deepEqual(
    binary.levels.map((l) => l.id),
    ["off", "low"]
  );
  assert.equal(binary.defaultLevel, "off");
  // 空 efforts 数组也回落二值
  const empty = captured.resolveThinkingProfile({ compat: { supportedReasoningEfforts: [] } });
  assert.equal(empty.levels.length, 2);
});

// ─── 2026.8.x kimi-provider 新包形态（provider-policy-api.js） ───

const KIMI_POLICY_API = [
  'const KIMI_K3_MODEL_IDS = ["k3", "k3-256k"];',
  "function isKimiK3ModelId(modelId) {",
  "\treturn KIMI_K3_MODEL_IDS.includes(modelId.trim().toLowerCase());",
  "}",
  "function resolveThinkingProfile({ modelId }) {",
  "\tif (isKimiK3ModelId(modelId)) return {",
  '\t\tlevels: [{ id: "off" }, { id: "high" }],',
  '\t\tdefaultLevel: "high",',
  "\t\tpreserveWhenCatalogReasoningFalse: true",
  "\t};",
  "\treturn {",
  '\t\tlevels: [{ id: "off", label: "off" }, { id: "low", label: "on" }],',
  '\t\tdefaultLevel: "off"',
  "\t};",
  "}",
  "module.exports = { resolveThinkingProfile, isKimiK3ModelId };",
  "",
].join("\n");

function makeGatewayPolicyApi(t, content) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-kimi-policy-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  const gatewayDir = path.join(tmpRoot, "gateway");
  const target = path.join(
    gatewayDir,
    "node_modules",
    "openclaw",
    "dist",
    "extensions",
    "kimi",
    "dist",
    "provider-policy-api.js"
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return { gatewayDir, target };
}

test("kimi 补丁命中 2026.8.x 包形态（provider-policy-api.js）", (t) => {
  const { gatewayDir, target } = makeGatewayPolicyApi(t, KIMI_POLICY_API);
  assert.equal(kdp.patchKimiThinkingProfile(gatewayDir), 1);
  const patched = fs.readFileSync(target, "utf-8");
  assert.match(patched, /\/\* cryoclaw-thinking-profile \*\//);
  assert.match(patched, /function resolveThinkingProfile\(context\) \{/);
  // 上游 K3 白名单逻辑保留为兜底
  assert.match(patched, /isKimiK3ModelId\(modelId\)/);
});

test("kimi 补丁 2026.8.x 形态幂等且行为正确", (t) => {
  const { gatewayDir, target } = makeGatewayPolicyApi(t, KIMI_POLICY_API);
  assert.equal(kdp.patchKimiThinkingProfile(gatewayDir), 1);
  const once = fs.readFileSync(target, "utf-8");
  assert.equal(kdp.patchKimiThinkingProfile(gatewayDir), 0);
  assert.equal(fs.readFileSync(target, "utf-8"), once);

  const mod = require(target);
  // 有 compat：全档位，默认 high
  const full = mod.resolveThinkingProfile({
    modelId: "my-custom-model",
    compat: { supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh", "max"] },
  });
  assert.deepEqual(
    full.levels.map((l) => l.id),
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
  );
  assert.equal(full.defaultLevel, "high");
  // 无 compat、K3 白名单模型：走上游 K3 分支
  const k3 = mod.resolveThinkingProfile({ modelId: "k3" });
  assert.equal(k3.defaultLevel, "high");
  // 无 compat、非 K3：二值兜底
  const binary = mod.resolveThinkingProfile({ modelId: "k2" });
  assert.deepEqual(
    binary.levels.map((l) => l.id),
    ["off", "low"]
  );
});

test("kimi 补丁：新包形态 marker 未命中时不再尝试旧 index.js", (t) => {
  const { gatewayDir, target } = makeGatewayPolicyApi(t, "var x = 1;\n");
  assert.equal(kdp.patchKimiThinkingProfile(gatewayDir), 0);
  assert.equal(fs.readFileSync(target, "utf-8"), "var x = 1;\n");
});

// ─── asar 边界补丁：按内核世代 fixture 验证 ───

function makeGatewayDist(t, files) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-asar-patch-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  const gatewayDir = path.join(tmpRoot, "gateway");
  const distDir = path.join(gatewayDir, "node_modules", "openclaw", "dist");
  fs.mkdirSync(distDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(distDir, name), content);
  }
  return { gatewayDir, distDir };
}

test("asar 补丁命中 ≥2026.6 世代全部现存 marker（含 2026.8.2 形态）", (t) => {
  const { gatewayDir, distDir } = makeGatewayDist(t, {
    "root-file-DJGGfXq8.js": [
      "function openRootFileSync(params) {\n\treturn resolveRootFilePathGeneric(params);\n}",
      "async function openRootFile(params) {\n\treturn resolveRootFilePathGeneric(params);\n}",
    ].join("\n"),
    "regular-file-CbpO--0m.js": "function verifyStableReadTarget(params) {\n\tcheck(params);\n}",
    "pinned-open-DhaBotzA.js": "function openPinnedFileSync(params) {\n\treturn pin(params);\n}",
    "file-identity-CaVBmM56.js": "function sameFileIdentity(left, right, platform = process.platform) {\n\treturn left.dev === right.dev;\n}",
    "plugin-peer-link-CijC8-mZ.js": [
      "async function auditOpenClawPeerDependency(params) {\n\treturn null;\n}",
      "async function linkOpenClawPeerDependency(params) {\n\treturn \"linked\";\n}",
    ].join("\n"),
    // 2026.7.x 世代的 peer-link 修复检查（2026.8.2 已删除，但旧内核仍需命中）
    "package-update-utils-AbC123.js": "function installedPackageNeedsOpenClawPeerLinkRepair(dir) {\n\treturn true;\n}",
  });
  const patched = kdp.patchAsarBoundaryCheck(gatewayDir);
  assert.equal(patched, 6, "六个文件都应被补丁");
  assert.ok(kdp.hasAsarBoundaryPatchMarker(gatewayDir));
  const peerLink = fs.readFileSync(path.join(distDir, "plugin-peer-link-CijC8-mZ.js"), "utf-8");
  assert.match(peerLink, /params\.hostRoot && params\.hostRoot\.includes\('\.asar'\)/);
  const identity = fs.readFileSync(path.join(distDir, "file-identity-CaVBmM56.js"), "utf-8");
  assert.match(identity, /Number\(left\.dev\) === 1 \|\| Number\(right\.dev\) === 1/);
  // 幂等：二次运行返回 0，内容不变
  assert.equal(kdp.patchAsarBoundaryCheck(gatewayDir), 0);
});

test("asar 补丁命中 2026.4.x 世代 marker", (t) => {
  const { gatewayDir, distDir } = makeGatewayDist(t, {
    "boundary-file-read-XyZ.js": [
      "function openBoundaryFileSync(params) {\n\treturn check(params);\n}",
      "function openVerifiedFileSync(params) {\n\treturn check(params);\n}",
    ].join("\n"),
  });
  assert.equal(kdp.patchAsarBoundaryCheck(gatewayDir), 1);
  const patched = fs.readFileSync(path.join(distDir, "boundary-file-read-XyZ.js"), "utf-8");
  assert.match(patched, /\/\* asar-bypass \*\//);
  assert.match(patched, /\/\* asar-bypass-verified \*\//);
  assert.equal(kdp.patchAsarBoundaryCheck(gatewayDir), 0);
});

test("asar 补丁：无 marker 命中返回 0 且 marker 检查为 false", (t) => {
  const { gatewayDir } = makeGatewayDist(t, { "entry.js": "module.exports = {};\n" });
  assert.equal(kdp.patchAsarBoundaryCheck(gatewayDir), 0);
  assert.equal(kdp.hasAsarBoundaryPatchMarker(gatewayDir), false);
});

// ─── asar-bypass 行为级回归：rootRealPath 不能为 undefined ───
// v2026.904.1 生产事故：补丁 3/4 返回 rootRealPath: params.rootRealPath，但该参数
// 是原逻辑的输出（调用方不传），下游 bindPluginCacheRoot 的 path.resolve(undefined)
// 使内核 2026.8.2 在 asar 形态直接崩溃。这里把补丁后的函数体真正跑起来验证。

function evalPatchedRootFile(patchedSource) {
  // 补丁后的 chunk 只含函数声明，以 fs/path 为自由变量注入即可执行
  const factory = new Function(
    "fs",
    "path",
    `${patchedSource}\nreturn { openRootFileSync, openRootFile };`
  );
  return factory(fs, path);
}

test("asar-bypass openRootFileSync/openRootFile：rootRealPath 兜底 rootPath", async (t) => {
  const { gatewayDir, distDir } = makeGatewayDist(t, {
    "root-file-AAA.js": [
      "function openRootFileSync(params) {\n\treturn resolveRootFilePathGeneric(params);\n}",
      "async function openRootFile(params) {\n\treturn resolveRootFilePathGeneric(params);\n}",
    ].join("\n"),
  });
  assert.equal(kdp.patchAsarBoundaryCheck(gatewayDir), 1);
  const patched = fs.readFileSync(path.join(distDir, "root-file-AAA.js"), "utf-8");
  const { openRootFileSync, openRootFile } = evalPatchedRootFile(patched);

  // 伪造 asar 内部路径（目录名含 .asar 即触发 bypass，文件真实存在以便 open/stat 成功）
  const fakeAsar = path.join(gatewayDir, "gateway.asar");
  fs.mkdirSync(fakeAsar, { recursive: true });
  const innerFile = path.join(fakeAsar, "plugin.js");
  fs.writeFileSync(innerFile, "x");
  const rootPath = path.join(fakeAsar, "plugins");

  // 调用方不传 rootRealPath（public-surface 加载链的真实形态）
  const opened = openRootFileSync({ absolutePath: innerFile, rootPath });
  assert.equal(opened.ok, true);
  assert.equal(opened.rootRealPath, rootPath, "rootRealPath 必须兜底为 rootPath");
  assert.ok(opened.rootRealPath !== undefined);
  fs.closeSync(opened.fd);

  // 调用方显式传 rootRealPath 时透传
  const opened2 = openRootFileSync({
    absolutePath: innerFile,
    rootPath,
    rootRealPath: "C:\\canonical",
  });
  assert.equal(opened2.rootRealPath, "C:\\canonical");
  fs.closeSync(opened2.fd);

  // async 变体同样兜底
  const openedAsync = await openRootFile({ absolutePath: innerFile, rootPath });
  assert.equal(openedAsync.ok, true);
  assert.equal(openedAsync.rootRealPath, rootPath);
  fs.closeSync(openedAsync.fd);
});

// ─── openclaw ≥2026.9.2 形态：@openclaw/fs-safe 独立包 ───
// R56：v9 把边界校验函数迁到 node_modules/@openclaw/fs-safe/dist/*.js，
// 旧扫描只看 openclaw dist chunk 时全部漏打（仅 peer-link 命中），
// 渠道插件公开构件身份校验恒失败。补丁必须扫进 fs-safe 包。

const FS_SAFE_ROOT_FILE = [
  'import fs from "node:fs";',
  'import { openPinnedFileSync } from "./pinned-open.js";',
  "export function openRootFileSync(params) {",
  "    const ioFs = params.ioFs ?? fs;",
  "    return finalizeRootFileOpen({ resolved: resolveRoot(params), ioFs });",
  "}",
  "export async function openRootFile(params) {",
  "    const ioFs = params.ioFs ?? fs;",
  "    return finalizeRootFileOpen({ resolved: await resolveRoot(params), ioFs });",
  "}",
  "",
].join("\n");

const FS_SAFE_PINNED_OPEN = [
  'import fs from "node:fs";',
  "export function openPinnedFileSync(params) {",
  "    const ioFs = params.ioFs ?? fs;",
  "    let fd = null;",
  "    try {",
  "        const realPath = params.resolvedPath ?? ioFs.realpathSync(params.filePath);",
  "        const preOpenStat = inspectFileIdentitySync(() => {",
  '            const stat = ioFs.lstatSync(realPath, { bigint: true });',
  "            return stat;",
  "        });",
  "        fd = ioFs.openSync(realPath, openReadFlags);",
  "        const openedStat = ioFs.fstatSync(fd);",
  "        inspectFileIdentitySync(() => {",
  '            const stat = ioFs.lstatSync(realPath, { bigint: true });',
  "            return stat;",
  "        }, preOpenStat);",
  "        const opened = { ok: true, path: realPath, fd, stat: openedStat };",
  "        fd = null;",
  "        return opened;",
  "    }",
  "    finally {",
  "        if (fd !== null) ioFs.closeSync(fd);",
  "    }",
  "}",
  "",
].join("\n");

const FS_SAFE_REGULAR_FILE = [
  'import fsSync from "node:fs";',
  'import fs from "node:fs/promises";',
  "function regularFileTooLargeError(filePath, maxBytes) {",
  '    return new Error(`too large: ${filePath}`);',
  "}",
  "export function readRegularFileSync(params) {",
  "    const before = inspectFileIdentitySync(() => fsSync.lstatSync(params.filePath, { bigint: true }));",
  "    return readOpened({ fd: fsSync.openSync(params.filePath), preOpenStat: before });",
  "}",
  "export async function readRegularFile(params) {",
  "    const before = await inspectFileIdentity(async () => fsSync.lstatSync(params.filePath, { bigint: true }));",
  "    return readOpened({ fd: await fs.open(params.filePath), preOpenStat: before });",
  "}",
  "",
].join("\n");

const FS_SAFE_FILE_IDENTITY = [
  "export function sameFileIdentity(left, right, platform = process.platform) {",
  "    return left.dev === right.dev && left.ino === right.ino;",
  "}",
  "",
].join("\n");

function makeGatewayV9(t) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-asar-patch-v9-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  const gatewayDir = path.join(tmpRoot, "gateway");
  const openclawDist = path.join(gatewayDir, "node_modules", "openclaw", "dist");
  const fsSafeDist = path.join(gatewayDir, "node_modules", "@openclaw", "fs-safe", "dist");
  fs.mkdirSync(openclawDist, { recursive: true });
  fs.mkdirSync(fsSafeDist, { recursive: true });
  fs.writeFileSync(path.join(openclawDist, "entry.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(fsSafeDist, "root-file.js"), FS_SAFE_ROOT_FILE);
  fs.writeFileSync(path.join(fsSafeDist, "pinned-open.js"), FS_SAFE_PINNED_OPEN);
  fs.writeFileSync(path.join(fsSafeDist, "regular-file.js"), FS_SAFE_REGULAR_FILE);
  fs.writeFileSync(path.join(fsSafeDist, "file-identity.js"), FS_SAFE_FILE_IDENTITY);
  return { gatewayDir, fsSafeDist };
}

test("v9 形态：fs-safe 包内 root-file/pinned-open/regular-file/file-identity 全部命中", (t) => {
  const { gatewayDir, fsSafeDist } = makeGatewayV9(t);
  const patched = kdp.patchAsarBoundaryCheck(gatewayDir);
  assert.equal(patched, 4, "fs-safe 四个文件都应被补丁");

  const rootFile = fs.readFileSync(path.join(fsSafeDist, "root-file.js"), "utf-8");
  assert.match(rootFile, /\/\* asar-bypass \*\/ if \(params\.absolutePath && params\.absolutePath\.includes\('\.asar'\)\)/);
  assert.match(rootFile, /\/\* asar-bypass-async \*\//);

  const pinnedOpen = fs.readFileSync(path.join(fsSafeDist, "pinned-open.js"), "utf-8");
  assert.match(pinnedOpen, /\/\* asar-bypass \*\/ if \(params\.filePath && params\.filePath\.includes\('\.asar'\)\)/);

  const regularFile = fs.readFileSync(path.join(fsSafeDist, "regular-file.js"), "utf-8");
  assert.match(regularFile, /\/\* asar-bypass \*\/ if \(typeof params\.filePath === 'string' && params\.filePath\.includes\('\.asar'\)\)/);
  assert.match(regularFile, /\/\* asar-bypass-async \*\//);
  assert.match(regularFile, /fsSync\.statSync\(params\.filePath\)/);
  assert.match(regularFile, /await fs\.stat\(params\.filePath\)/);

  const identity = fs.readFileSync(path.join(fsSafeDist, "file-identity.js"), "utf-8");
  assert.match(identity, /Number\(left\.dev\) === 1 \|\| Number\(right\.dev\) === 1/);

  // 幂等
  assert.equal(kdp.patchAsarBoundaryCheck(gatewayDir), 0);
  // 覆盖断言通过
  kdp.assertAsarBoundaryCoverage(gatewayDir);
});

test("v9 形态：pinned-open 身份观测映射只包住 lstat，opened.path 保持 asar 路径", (t) => {
  const { gatewayDir, fsSafeDist } = makeGatewayV9(t);
  kdp.patchAsarBoundaryCheck(gatewayDir);
  assert.equal(kdp.patchFsSafeAsarUnpacked(gatewayDir), 1);

  const src = fs.readFileSync(path.join(fsSafeDist, "pinned-open.js"), "utf-8");
  // 两次身份观测 lstat 的参数被映射（preOpen + 读前复核）
  const mapped = src.match(/ioFs\.lstatSync\(\/\* cryoclaw-asar-identity \*\/ asarIdentityPath\(ioFs, realPath\)/g) || [];
  assert.equal(mapped.length, 2, "两次 bigint lstat 都应映射");
  // openSync 与返回值保持 asar 虚拟路径（模块解析依赖 asar 内 node_modules）
  assert.match(src, /fd = ioFs\.openSync\(realPath, openReadFlags\)/);
  assert.match(src, /const opened = \{ ok: true, path: realPath, fd, stat: openedStat \}/);
  // helper 存在且幂等
  assert.match(src, /function asarIdentityPath\(ioFs, p\) \{/);
  const once = src;
  assert.equal(kdp.patchFsSafeAsarUnpacked(gatewayDir), 1);
  assert.equal(fs.readFileSync(path.join(fsSafeDist, "pinned-open.js"), "utf-8"), once);
});

test("v9 形态：R56 早期错误补丁形态被还原后重打（realPath 整体重映射 → lstat 映射）", (t) => {
  const { gatewayDir, fsSafeDist } = makeGatewayV9(t);
  const pinnedOpenPath = path.join(fsSafeDist, "pinned-open.js");
  // 手工构造旧版补丁产物：realPath 被 let + 整体重映射
  const legacyPatched = FS_SAFE_PINNED_OPEN.replace(
    "const realPath = params.resolvedPath ?? ioFs.realpathSync(params.filePath);",
    [
      "let realPath = params.resolvedPath ?? ioFs.realpathSync(params.filePath);",
      "\t\t/* cryoclaw-asar-unpacked */ realPath = mapAsarUnpackedPath(ioFs, realPath);",
    ].join("\n")
  ) + [
    "",
    "/* cryoclaw-asar-unpacked */",
    "function mapAsarUnpackedPath(ioFs, p) {",
    "\tif (!p || p.indexOf('.asar') === -1) return p;",
    "\treturn p;",
    "}",
    "",
  ].join("\n");
  fs.writeFileSync(pinnedOpenPath, legacyPatched);

  assert.equal(kdp.patchFsSafeAsarUnpacked(gatewayDir), 1);
  const src = fs.readFileSync(pinnedOpenPath, "utf-8");
  assert.ok(!src.includes("let realPath"), "旧版 let realPath 重映射必须被还原");
  assert.ok(!src.includes("mapAsarUnpackedPath"), "旧版 helper 必须被移除");
  assert.match(src, /const realPath = params\.resolvedPath \?\? ioFs\.realpathSync\(params\.filePath\);/);
  assert.match(src, /asarIdentityPath\(ioFs, realPath\)/);
});

test("assertAsarBoundaryCoverage：v9 形态 root-file 未补丁时抛错（R56 回归闸）", (t) => {
  const { gatewayDir } = makeGatewayV9(t);
  assert.throws(() => kdp.assertAsarBoundaryCoverage(gatewayDir), /root-file\.js 缺少 asar 快速通道补丁/);
  kdp.patchAsarBoundaryCheck(gatewayDir);
  kdp.assertAsarBoundaryCoverage(gatewayDir);
});

test("assertAsarBoundaryCoverage：v8 形态（无 fs-safe 包）走 chunk marker 检查", (t) => {
  const { gatewayDir } = makeGatewayDist(t, {
    "root-file-DJGGfXq8.js": "function openRootFileSync(params) {\n\treturn resolveRootFilePathGeneric(params);\n}",
  });
  assert.throws(() => kdp.assertAsarBoundaryCoverage(gatewayDir), /未命中任何模块/);
  kdp.patchAsarBoundaryCheck(gatewayDir);
  kdp.assertAsarBoundaryCoverage(gatewayDir);
});

test("patchFsSafeAsarUnpacked：无 fs-safe 包（v8 内核）返回 0", (t) => {
  const { gatewayDir } = makeGatewayDist(t, {
    "root-file-DJGGfXq8.js": "function openRootFileSync(params) {\n\treturn resolveRootFilePathGeneric(params);}",
  });
  assert.equal(kdp.patchFsSafeAsarUnpacked(gatewayDir), 0);
});

// ─── openclaw ≥2026.9.3 形态：dist 根 chunk .js → .mjs 翻转 ───
// peer-link 等函数迁入 .mjs chunk 后，扫描/断言必须同步覆盖 .mjs，
// 否则 asar 模式下 vendored 插件 peer 审计失败（R72）。

function makeGatewayV93(t) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-asar-patch-v93-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  const gatewayDir = path.join(tmpRoot, "gateway");
  const openclawDist = path.join(gatewayDir, "node_modules", "openclaw", "dist");
  const fsSafeDist = path.join(gatewayDir, "node_modules", "@openclaw", "fs-safe", "dist");
  fs.mkdirSync(openclawDist, { recursive: true });
  fs.mkdirSync(fsSafeDist, { recursive: true });
  fs.writeFileSync(path.join(openclawDist, "entry.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(fsSafeDist, "root-file.js"), FS_SAFE_ROOT_FILE);
  fs.writeFileSync(
    path.join(openclawDist, "plugin-peer-link-Xk9.mjs"),
    [
      "async function auditOpenClawPeerDependency(params) {",
      "\treturn null;",
      "}",
      "async function linkOpenClawPeerDependency(params) {",
      '\treturn "linked";',
      "}",
      "",
    ].join("\n")
  );
  return { gatewayDir, openclawDist, fsSafeDist };
}

test("v9.3 形态：peer-link 住 .mjs chunk 仍被补丁，marker/断言均识别", (t) => {
  const { gatewayDir, openclawDist, fsSafeDist } = makeGatewayV93(t);
  // 补丁前：root-file.js 未补丁 → 先抛 root-file 错
  assert.throws(() => kdp.assertAsarBoundaryCoverage(gatewayDir), /root-file\.js 缺少/);
  // 补丁前：单独构造 root-file 已补丁但 peer-link 漏打的形态 → 新断言必须兜出（R72 盲区）
  const peerLinkPath = path.join(openclawDist, "plugin-peer-link-Xk9.mjs");
  assert.throws(() => {
    const patchedRoot = fs.readFileSync(path.join(fsSafeDist, "root-file.js"), "utf-8");
    // 模拟「root-file 命中但 peer-link .mjs 被旧版只扫 .js 的扫描漏掉」
    // 直接调用内部断言路径：先补 root-file 再人为还原 peer-link
    kdp.patchAsarBoundaryCheck(gatewayDir);
    const patchedPeer = fs.readFileSync(peerLinkPath, "utf-8");
    fs.writeFileSync(peerLinkPath, patchedPeer.replace(/\/\* asar-bypass \*\/[^\n]*\n/g, ""));
    kdp.assertAsarBoundaryCoverage(gatewayDir);
  }, /peer-link 函数但缺少 asar 补丁/);

  // 正常流程：重新打全量补丁 → .mjs peer-link 命中 → 断言通过
  const { gatewayDir: gw2, openclawDist: dist2 } = makeGatewayV93(t);
  const patched = kdp.patchAsarBoundaryCheck(gw2);
  assert.equal(patched, 2, "root-file.js + plugin-peer-link .mjs 都应被补丁");
  const peerLink = fs.readFileSync(path.join(dist2, "plugin-peer-link-Xk9.mjs"), "utf-8");
  assert.match(peerLink, /params\.hostRoot && params\.hostRoot\.includes\('\.asar'\)/);
  assert.ok(kdp.hasAsarBoundaryPatchMarker(gw2));
  kdp.assertAsarBoundaryCoverage(gw2);
  // 幂等
  assert.equal(kdp.patchAsarBoundaryCheck(gw2), 0);
});

test("v9.3 形态：windowsHide 扫描覆盖 .mjs chunk", (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-wh-mjs-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  const distDir = path.join(tmpRoot, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  const spawnChunk = 'const child = spawn(cmd, args, { stdio: "ignore" });\n';
  fs.writeFileSync(path.join(distDir, "server-chat-AbC.mjs"), spawnChunk);
  fs.writeFileSync(path.join(distDir, "legacy-XYZ.js"), spawnChunk);
  const result = kdp.patchWindowsHideGlobal(distDir);
  assert.equal(result.scanned, 2, ".js 与 .mjs 都应被扫描");
  assert.equal(result.patched, 2, "两个文件的 spawn 都应注入 windowsHide");
  for (const name of ["server-chat-AbC.mjs", "legacy-XYZ.js"]) {
    const src = fs.readFileSync(path.join(distDir, name), "utf-8");
    assert.match(src, /windowsHide: true/, `${name} 应已注入`);
  }
  // 幂等
  const again = kdp.patchWindowsHideGlobal(distDir);
  assert.equal(again.patched, 0);
});
