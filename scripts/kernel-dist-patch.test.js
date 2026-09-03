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
  assert.match(identity, /Number\(left\.dev\) === 1 && Number\(right\.dev\) === 1/);
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
