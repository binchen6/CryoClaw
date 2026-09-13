import assert from "node:assert/strict";
import { buildMergePatch } from "../../controllers/config.ts";
import { AUTH_PROXY_API_KEY_SENTINEL } from "../setup/setup-constants.ts";
import {
  KIMI_EMBEDDING_MODEL,
  extractMemoryView,
  applyMemorySave,
  kimiEmbeddingBaseUrl,
  type MemorySettingsView,
} from "./tab-memory.lib.ts";

/* ── 提取 ── */

function testExtractDefaults() {
  const view = extractMemoryView(null);
  assert.equal(view.sessionMemory.enabled, true, "session-memory 未配置视为开启");
  assert.equal(view.sessionMemory.messages, 15);
  assert.equal(view.sessionMemory.llmSlug, false);
  assert.equal(view.search.enabled, true);
  assert.equal(view.search.provider, "openai");
  assert.deepEqual(view.search.sources, ["memory"]);
  assert.equal(view.search.maxResults, 6);
  assert.equal(view.search.minScore, 0.35);
  assert.equal(view.citations, "auto");
  assert.equal(view.dreaming.enabled, true);
  assert.equal(view.dreaming.frequency, "0 3 * * *");
  assert.equal(view.dreaming.storageMode, "");
  assert.equal(view.dreaming.light.enabled, true);
  assert.equal(view.activeMemory, null, "无 active-memory entry 时为 null");
  assert.equal(view.kimiProxy.isKimiCodeConfigured, false);
  assert.equal(view.kimiProxy.embeddingActive, false);
}

function testExtractRootPathPreferredOverLegacy() {
  const config = {
    memory: {
      citations: "on",
      search: { enabled: true, provider: "gemini", model: "embed-1", sources: ["sessions"], query: { maxResults: 10, minScore: 0.5 } },
    },
    agents: { defaults: { memorySearch: { enabled: false, provider: "ollama", model: "legacy" } } },
  };
  const view = extractMemoryView(config as any);
  assert.equal(view.search.provider, "gemini", "根级 memory.search 优先");
  assert.equal(view.search.model, "embed-1");
  assert.deepEqual(view.search.sources, ["sessions"]);
  assert.equal(view.search.maxResults, 10);
  assert.equal(view.search.minScore, 0.5);
  assert.equal(view.citations, "on");
}

function testExtractLegacyPathFallback() {
  // 旧路径 agents.defaults.memorySearch 仅做读兜底（显示迁移）
  const config = {
    agents: { defaults: { memorySearch: { enabled: true, provider: "openai", model: KIMI_EMBEDDING_MODEL } } },
  };
  const view = extractMemoryView(config as any);
  assert.equal(view.search.enabled, true);
  assert.equal(view.search.provider, "openai");
  assert.equal(view.search.model, KIMI_EMBEDDING_MODEL);
}

function testExtractKimiProxyFlag() {
  const config = {
    memory: { search: {
      provider: "openai",
      model: KIMI_EMBEDDING_MODEL,
      remote: { baseUrl: "http://127.0.0.1:9090/coding/v1/", apiKey: AUTH_PROXY_API_KEY_SENTINEL },
    } },
    models: { providers: { "kimi-coding": { apiKey: AUTH_PROXY_API_KEY_SENTINEL } } },
  };
  const view = extractMemoryView(config as any);
  assert.equal(view.kimiProxy.isKimiCodeConfigured, true);
  assert.equal(view.kimiProxy.embeddingActive, true, "指向本地代理的 openai+bge 配置识别为 Kimi 代理");
  assert.equal(view.search.baseUrl, "http://127.0.0.1:9090/coding/v1/");
}

function testExtractFullConfig() {
  const config = {
    hooks: { internal: { entries: { "session-memory": { enabled: false, messages: 30, llmSlug: true, model: "kimi-k2" } } } },
    memory: { citations: "off" },
    plugins: { entries: {
      "memory-core": { config: { dreaming: {
        enabled: false, frequency: "30 4 * * *", model: "m1", storage: { mode: "separate" },
        phases: { light: { enabled: false }, deep: { enabled: false }, rem: { enabled: false } },
      } } },
      "active-memory": { enabled: true, config: { enabled: true, mode: "always", model: "m2" } },
    } },
  };
  const view = extractMemoryView(config as any);
  assert.equal(view.sessionMemory.enabled, false);
  assert.equal(view.sessionMemory.messages, 30);
  assert.equal(view.sessionMemory.llmSlug, true);
  assert.equal(view.sessionMemory.model, "kimi-k2");
  assert.equal(view.citations, "off");
  assert.equal(view.dreaming.enabled, false);
  assert.equal(view.dreaming.frequency, "30 4 * * *");
  assert.equal(view.dreaming.storageMode, "separate");
  assert.equal(view.dreaming.light.enabled, false);
  assert.equal(view.dreaming.rem.enabled, false);
  assert.equal(view.activeMemory?.enabled, true);
  assert.equal(view.activeMemory?.mode, "always");
  assert.equal(view.activeMemory?.model, "m2");
}

/* ── 应用 ── */

function baseView(overrides?: Partial<MemorySettingsView>): MemorySettingsView {
  const view = extractMemoryView(null);
  return overrides ? { ...view, ...overrides } : view;
}

function testApplyWritesRootPathOnly() {
  const draft: Record<string, unknown> = {
    agents: { defaults: { memorySearch: { enabled: true, provider: "openai", model: "legacy" } } },
  };
  applyMemorySave(draft, baseView({ citations: "on" }));
  const ms = (draft.memory as any).search;
  assert.equal((draft.memory as any).citations, "on");
  assert.equal(ms.enabled, true);
  assert.equal(ms.provider, "openai");
  assert.deepEqual(ms.sources, ["memory"]);
  assert.equal(ms.query.maxResults, 6);
  assert.equal(ms.query.minScore, 0.35);
  // 写侧不再触碰旧路径：legacy 记录原样保留（清理交给主进程迁移）
  assert.deepEqual(
    (draft.agents as any).defaults.memorySearch,
    { enabled: true, provider: "openai", model: "legacy" },
  );
}

function testApplyKimiProxyInjection() {
  const draft: Record<string, unknown> = {};
  const view = baseView();
  view.search.provider = "none";
  view.search.model = "";
  applyMemorySave(draft, view, { kimiProxyPort: 9090 });
  const ms = (draft.memory as any).search;
  assert.equal(ms.enabled, true);
  assert.equal(ms.provider, "openai");
  assert.equal(ms.model, KIMI_EMBEDDING_MODEL);
  assert.equal(ms.remote.baseUrl, kimiEmbeddingBaseUrl(9090));
  assert.equal(ms.remote.apiKey, AUTH_PROXY_API_KEY_SENTINEL);
}

function testApplyKimiProxyMergesExistingRemote() {
  const draft: Record<string, unknown> = {
    memory: { search: { remote: { baseUrl: "http://old/x/", apiKey: "old", headers: { x: "1" } } } },
  };
  applyMemorySave(draft, baseView(), { kimiProxyPort: 8080 });
  const remote = (draft.memory as any).search.remote;
  assert.equal(remote.baseUrl, kimiEmbeddingBaseUrl(8080), "端口更新");
  assert.equal(remote.apiKey, AUTH_PROXY_API_KEY_SENTINEL);
  assert.deepEqual(remote.headers, { x: "1" }, "remote 其他字段保留");
}

function testApplyManualProviderKeepsUserValues() {
  const draft: Record<string, unknown> = {};
  const view = baseView();
  view.search.provider = "openai-compatible";
  view.search.model = "my-embed";
  view.search.baseUrl = "http://127.0.0.1:11434/v1";
  view.search.rememberAcrossConversations = true;
  view.search.sources = ["memory", "sessions"];
  view.search.maxResults = 12;
  view.search.minScore = 0.6;
  applyMemorySave(draft, view);
  const ms = (draft.memory as any).search;
  assert.equal(ms.provider, "openai-compatible");
  assert.equal(ms.model, "my-embed");
  assert.equal(ms.remote.baseUrl, "http://127.0.0.1:11434/v1", "显式输入的 baseUrl 写入");
  assert.equal("apiKey" in ms.remote, false, "未用 Kimi 一键不写 apiKey");
  assert.equal(ms.rememberAcrossConversations, true);
  assert.deepEqual(ms.sources, ["memory", "sessions"]);
  assert.equal(ms.query.maxResults, 12);
  assert.equal(ms.query.minScore, 0.6);
}

function testApplyEmptyBaseUrlAndModelClearFields() {
  const draft: Record<string, unknown> = {
    memory: { search: { provider: "openai", model: "old-model", remote: { baseUrl: "http://old/v1" } } },
  };
  const view = baseView();
  view.search.model = "";
  view.search.baseUrl = "";
  applyMemorySave(draft, view);
  const ms = (draft.memory as any).search;
  assert.equal("model" in ms, false, "空 model 删除字段");
  assert.equal("baseUrl" in ms.remote, false, "空 baseUrl 删除字段");
}

function testApplyDisabledSearchKeepsEmbeddingConfig() {
  const config = {
    memory: { search: { enabled: true, provider: "openai", model: KIMI_EMBEDDING_MODEL } },
  };
  const view = extractMemoryView(config as any);
  view.search.enabled = false;
  const draft: Record<string, unknown> = structuredClone(config);
  applyMemorySave(draft, view);
  const ms = (draft.memory as any).search;
  assert.equal(ms.enabled, false, "关闭语义检索只写 enabled=false");
  assert.equal(ms.provider, "openai", "provider/model 保留（关键词检索仍可用）");
  assert.equal(ms.model, KIMI_EMBEDDING_MODEL);
}

function testApplySessionMemoryPassthrough() {
  const draft: Record<string, unknown> = {
    hooks: { internal: { entries: { "session-memory": { enabled: true, extraFlag: 1 } } } },
  };
  const view = baseView();
  view.sessionMemory = { enabled: false, messages: 40, llmSlug: true, model: "m" };
  applyMemorySave(draft, view);
  const hook = (draft.hooks as any).internal.entries["session-memory"];
  assert.equal(hook.enabled, false);
  assert.equal(hook.messages, 40);
  assert.equal(hook.llmSlug, true);
  assert.equal(hook.model, "m");
  assert.equal(hook.extraFlag, 1, "透传键保留未知字段");

  // 空 model 删除（回落默认模型）
  const draft2: Record<string, unknown> = {};
  const view2 = baseView();
  view2.sessionMemory = { enabled: true, messages: 15, llmSlug: false, model: "" };
  applyMemorySave(draft2, view2);
  assert.equal("model" in (draft2.hooks as any).internal.entries["session-memory"], false);
}

function testApplyDreamingPreservesAndWrites() {
  const draft: Record<string, unknown> = {
    plugins: { entries: { "memory-core": { config: { dreaming: {
      frequency: "0 3 * * *", verboseLogging: true, deep: { custom: 1 },
      phases: { deep: { enabled: true, limit: 5 } },
    } } } } },
  };
  const view = baseView();
  view.dreaming = {
    enabled: false, frequency: "15 5 * * *", model: "", storageMode: "both",
    light: { enabled: true }, deep: { enabled: false }, rem: { enabled: true },
  };
  applyMemorySave(draft, view);
  const dreaming = (draft.plugins as any).entries["memory-core"].config.dreaming;
  assert.equal(dreaming.enabled, false);
  assert.equal(dreaming.frequency, "15 5 * * *");
  assert.equal("model" in dreaming, false, "空固化 model 删除");
  assert.equal(dreaming.storage.mode, "both");
  assert.equal(dreaming.phases.light.enabled, true);
  assert.equal(dreaming.phases.deep.enabled, false);
  assert.equal(dreaming.phases.deep.limit, 5, "phase 未知字段保留");
  assert.equal(dreaming.phases.rem.enabled, true);
  assert.equal(dreaming.verboseLogging, true, "dreaming 未知字段保留");
  assert.deepEqual(dreaming.deep, { custom: 1 }, "顶层 deep（非 phases.deep）不动");
}

function testApplyActiveMemoryOnlyWhenPresent() {
  // entry 不存在：不创建
  const draft: Record<string, unknown> = {};
  applyMemorySave(draft, baseView({ activeMemory: null }));
  assert.equal((draft.plugins as any)?.entries?.["active-memory"], undefined, "无 entry 不写 active-memory");

  // entry 存在：合并写 config，保留插件层字段
  const draft2: Record<string, unknown> = {
    plugins: { entries: { "active-memory": { enabled: true, config: { mode: "escalate", timeoutMs: 20000 } } } },
  };
  const view = baseView();
  view.activeMemory = { enabled: true, mode: "always", model: "m3" };
  applyMemorySave(draft2, view);
  const entry = (draft2.plugins as any).entries["active-memory"];
  assert.equal(entry.enabled, true, "插件层 enabled 保留");
  assert.equal(entry.config.enabled, true);
  assert.equal(entry.config.mode, "always");
  assert.equal(entry.config.model, "m3");
  assert.equal(entry.config.timeoutMs, 20000, "config 未知字段保留");
}

/* ── 往返 & 单 patch 合并多域 ── */

function testRoundTrip() {
  const config = {
    hooks: { internal: { entries: { "session-memory": { enabled: false, messages: 25, llmSlug: true, model: "m0" } } } },
    memory: { citations: "off", search: {
      enabled: true, provider: "voyage", model: "v3", rememberAcrossConversations: true,
      sources: ["sessions"], remote: { baseUrl: "https://api.example.com/v1" },
      query: { maxResults: 20, minScore: 0.7 },
    } },
    plugins: { entries: { "memory-core": { config: { dreaming: { frequency: "0 5 * * 1" } } } } },
  };
  const view = extractMemoryView(config as any);
  const draft: Record<string, unknown> = structuredClone(config);
  applyMemorySave(draft, view);

  // 语义等价：apply 后再 extract 得到相同视图（未配置字段允许补默认值，已配置值不得漂移）
  const viewAfter = extractMemoryView(draft);
  assert.deepEqual(viewAfter, view, "extract → apply → extract 往返无值漂移");

  // 破坏性检查：diff patch 不得含 null 删除（往返不允许删掉任何已有配置）
  const { patch } = buildMergePatch(config as any, draft);
  const json = JSON.stringify(patch);
  assert.ok(!json.includes(":null"), `往返 patch 不得含删除：${json}`);
}

function testSinglePatchMergesDomains() {
  const snapshot = {
    hooks: { internal: { entries: {} } },
    memory: { citations: "auto" },
    plugins: { entries: {} },
  };
  const view = baseView();
  view.sessionMemory.enabled = false;
  view.sessionMemory.messages = 42;
  view.citations = "on";
  view.search.provider = "gemini";
  view.search.model = "text-embedding";
  view.dreaming.enabled = false;
  const draft: Record<string, unknown> = structuredClone(snapshot);
  applyMemorySave(draft, view);

  const { patch } = buildMergePatch(snapshot as any, draft);
  // 三域（memory + hooks.internal + plugins.entries）出现在同一次 patch 里
  assert.equal((patch.memory as any).citations, "on");
  assert.equal((patch.memory as any).search.provider, "gemini");
  assert.equal((patch.hooks as any).internal.entries["session-memory"].enabled, false);
  assert.equal((patch.hooks as any).internal.entries["session-memory"].messages, 42);
  assert.equal((patch.plugins as any).entries["memory-core"].config.dreaming.enabled, false);
  assert.equal(Object.keys(patch).length, 3, "一次 patch 只含 memory/hooks/plugins 三域");
}

function testSourcesNormalizeGuards() {
  const view = baseView();
  view.search.sources = [] as any;
  const draft: Record<string, unknown> = {};
  applyMemorySave(draft, view);
  assert.deepEqual((draft.memory as any).search.sources, ["memory"], "空 sources 兜底 memory");

  view.search.sources = ["sessions", "bogus", "sessions"] as any;
  const draft2: Record<string, unknown> = {};
  applyMemorySave(draft2, view);
  assert.deepEqual((draft2.memory as any).search.sources, ["sessions"], "非法项剔除 + 去重");
}

function main() {
  testExtractDefaults();
  testExtractRootPathPreferredOverLegacy();
  testExtractLegacyPathFallback();
  testExtractKimiProxyFlag();
  testExtractFullConfig();
  testApplyWritesRootPathOnly();
  testApplyKimiProxyInjection();
  testApplyKimiProxyMergesExistingRemote();
  testApplyManualProviderKeepsUserValues();
  testApplyEmptyBaseUrlAndModelClearFields();
  testApplyDisabledSearchKeepsEmbeddingConfig();
  testApplySessionMemoryPassthrough();
  testApplyDreamingPreservesAndWrites();
  testApplyActiveMemoryOnlyWhenPresent();
  testRoundTrip();
  testSinglePatchMergesDomains();
  testSourcesNormalizeGuards();
  console.log("tab-memory lib tests passed");
}

main();
