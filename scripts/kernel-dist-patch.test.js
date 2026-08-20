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
