import assert from "node:assert/strict";
import {
  applyCapabilityOverrides,
  applyIdOrder,
  deriveOverridesFromEntry,
  groupProvidersFromConfig,
  readFallbacks,
  reorderIds,
  resolveGroupId,
} from "./tab-provider.lib.ts";

const CONFIG = {
  agents: { defaults: { model: { primary: "moonshot/kimi-k2.6", fallbacks: ["deepseek/deepseek-v4-pro", "openai/gpt-5.4"] } } },
  models: {
    providers: {
      deepseek: {
        apiKey: "__OPENCLAW_REDACTED__",
        models: [{ id: "deepseek-v4-pro", name: "V4 Pro", input: ["text"] }],
      },
      "kimi-coding": {
        apiKey: "proxy-managed",
        baseUrl: "http://127.0.0.1:9090/coding",
        models: [{ id: "kimi-for-coding", name: "Kimi for Coding", input: ["text", "image"] }],
      },
      moonshot: {
        apiKey: "__OPENCLAW_REDACTED__",
        models: [
          { id: "kimi-k2.6", name: "K2.6", input: ["text", "image"] },
          { id: "kimi-k2.5", name: "kimi-k2.5", input: ["text"] },
        ],
      },
      "custom-api-x-com": {
        baseUrl: "https://api.x.com/v1",
        api: "openai-completions",
        models: [{ id: "m1" }],
      },
      openai: { apiKey: "__OPENCLAW_REDACTED__", models: [{ id: "gpt-5.4", name: "GPT" }] },
    },
  },
};

function testResolveGroupId() {
  assert.equal(resolveGroupId("kimi-coding"), "moonshot");
  assert.equal(resolveGroupId("moonshot"), "moonshot");
  assert.equal(resolveGroupId("anthropic"), "anthropic");
  assert.equal(resolveGroupId("deepseek"), "custom");
  assert.equal(resolveGroupId("custom-foo"), "custom");
}

function testGroupProvidersFromConfig() {
  const groups = groupProvidersFromConfig(CONFIG as any);
  assert.deepEqual(groups.map((g) => g.groupId), ["moonshot", "openai", "custom"], "组按固定顺序");
  const moonshot = groups[0];
  assert.deepEqual(moonshot.providers.map((p) => p.providerKey), ["kimi-coding", "moonshot"], "组内保持配置 key 顺序");
  assert.equal(moonshot.providers[0].proxyManaged, true);
  assert.equal(moonshot.providers[1].proxyManaged, false);
  assert.equal(moonshot.providers[1].hasApiKey, true);
  const kimi25 = moonshot.providers[1].models[1];
  assert.equal(kimi25.name, "kimi-k2.5", "空 name 回退到 id");
  assert.equal(moonshot.providers[1].models[0].isDefault, true);
  assert.equal(moonshot.providers[1].models[0].supportsImage, true);
  assert.equal(moonshot.providers[1].models[1].supportsImage, false);
  const custom = groups.find((g) => g.groupId === "custom");
  assert.deepEqual(custom?.providers.map((p) => p.providerKey), ["deepseek", "custom-api-x-com"]);
  assert.equal(custom?.providers[1].displayName, "api.x.com", "custom 显示 hostname");
  assert.equal(custom?.providers[1].hasApiKey, false, "无 apiKey");
}

function testGroupProvidersEmpty() {
  assert.deepEqual(groupProvidersFromConfig(null), []);
  assert.deepEqual(groupProvidersFromConfig({} as any), []);
}

function testReadFallbacks() {
  assert.deepEqual(readFallbacks(CONFIG as any), ["deepseek/deepseek-v4-pro", "openai/gpt-5.4"]);
  assert.deepEqual(readFallbacks({} as any), []);
  assert.deepEqual(readFallbacks({ agents: { defaults: { model: { fallbacks: "x" } } } } as any), []);
}

function testReorderIds() {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(reorderIds(ids, "a", "c", "after"), ["b", "c", "a", "d"]);
  assert.deepEqual(reorderIds(ids, "d", "a", "before"), ["d", "a", "b", "c"]);
  assert.deepEqual(reorderIds(ids, "b", "c", "before"), ["a", "b", "c", "d"], "原地不动");
  assert.equal(reorderIds(ids, "b", "c", "before"), ids, "无变化返回原引用");
  assert.equal(reorderIds(ids, "x", "a", "before"), ids, "未知 id 返回原引用");
  assert.equal(reorderIds(ids, "a", "a", "after"), ids, "自身忽略");
  // 向后移动再插入 after 目标：下标以移除后数组为准
  assert.deepEqual(reorderIds(ids, "a", "b", "after"), ["b", "a", "c", "d"]);
}

function testApplyIdOrder() {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(applyIdOrder(items, ["c", "a"], (i) => i.id).map((i) => i.id), ["c", "a", "b"], "未列入的追加在尾");
}

function testGroupProvidersCapabilities() {
  const groups = groupProvidersFromConfig({
    models: {
      providers: {
        p: {
          apiKey: "k",
          models: [
            { id: "m1", name: "M1", input: ["text", "image", "video"], contextWindow: 262144, contextTokens: 200000, maxTokens: 8192 },
            { id: "m2", name: "M2", input: ["text", "audio"] },
          ],
        },
      },
    },
  } as any);
  const [m1, m2] = groups[0].providers[0].models;
  assert.equal(m1.supportsImage, true);
  assert.equal(m1.supportsVideo, true);
  assert.equal(m1.supportsAudio, false);
  assert.equal(m1.contextWindow, 262144);
  assert.equal(m1.contextTokens, 200000);
  assert.equal(m1.maxTokens, 8192);
  assert.equal(m2.supportsAudio, true);
  assert.equal(m2.maxTokens, undefined);
}

function testApplyCapabilityOverrides() {
  const base = { id: "m", name: "M", input: ["text", "image"], contextWindow: 128000, compat: { supportsTools: true, supportedReasoningEfforts: ["low", "high"] } };

  // 数值覆盖与删除
  let out = applyCapabilityOverrides(base, { contextWindow: 262144, maxTokens: 4096 });
  assert.equal(out.contextWindow, 262144);
  assert.equal(out.maxTokens, 4096);
  assert.equal((base as any).maxTokens, undefined, "不改原对象");
  out = applyCapabilityOverrides(base, { contextWindow: null });
  assert.equal("contextWindow" in out, false, "null = 删除字段");

  // 模态：恒含 text
  out = applyCapabilityOverrides(base, { modalities: { image: false, video: true, audio: true } });
  assert.deepEqual(out.input, ["text", "video", "audio"]);
  out = applyCapabilityOverrides(base, { modalities: null });
  assert.equal("input" in out, false);

  // reasoning
  out = applyCapabilityOverrides(base, { reasoning: true });
  assert.equal(out.reasoning, true);
  out = applyCapabilityOverrides({ ...base, reasoning: true }, { reasoning: null });
  assert.equal("reasoning" in out, false);

  // thinkingLevels：写 compat.supportedReasoningEfforts，保留 compat 其他键
  out = applyCapabilityOverrides(base, { thinkingLevels: ["low", "medium", "high", "off"] });
  assert.deepEqual((out.compat as any).supportedReasoningEfforts, ["low", "medium", "high"], "off 被过滤");
  assert.equal((out.compat as any).supportsTools, true, "compat 其他键保留");
  // 空数组删除 supportedReasoningEfforts；compat 只剩其他键
  out = applyCapabilityOverrides(base, { thinkingLevels: [] });
  assert.equal("supportedReasoningEfforts" in (out.compat as any), false);
  assert.equal((out.compat as any).supportsTools, true);
  // compat 原本只有 supportedReasoningEfforts 时清空则整体删除
  out = applyCapabilityOverrides({ id: "m", name: "M", compat: { supportedReasoningEfforts: ["low"] } }, { thinkingLevels: [] });
  assert.equal("compat" in out, false);

  // 白名单外字段被剔除
  out = applyCapabilityOverrides({ id: "m", name: "M", bogusField: 1 } as any, {});
  assert.equal("bogusField" in out, false);

  // undefined 一律不触碰
  out = applyCapabilityOverrides(base, {});
  assert.deepEqual(out.input, ["text", "image"]);
  assert.equal(out.contextWindow, 128000);
}

function testDeriveOverridesFromEntry() {
  const v = deriveOverridesFromEntry({ id: "m", name: "M", input: ["text", "image", "audio"], contextWindow: 262144, reasoning: true, compat: { supportedReasoningEfforts: ["low", "high", "off"] } });
  assert.equal(v.contextWindow, "262144");
  assert.equal(v.image, true);
  assert.equal(v.video, false);
  assert.equal(v.audio, true);
  assert.equal(v.reasoning, true);
  assert.deepEqual(v.thinkingLevels, ["low", "high"], "off 不入选");
  const bare = deriveOverridesFromEntry("just-a-string");
  assert.equal(bare.contextWindow, "");
  assert.equal(bare.image, false);
  assert.deepEqual(bare.thinkingLevels, []);
}

function main() {
  testResolveGroupId();
  testGroupProvidersFromConfig();
  testGroupProvidersEmpty();
  testReadFallbacks();
  testReorderIds();
  testApplyIdOrder();
  testGroupProvidersCapabilities();
  testApplyCapabilityOverrides();
  testDeriveOverridesFromEntry();
  console.log("tab-provider lib tests passed");
}

main();
