// provider-live 纯函数单测：models URL 拼接 + 三种 api 形态的响应解析 + 用量归一化的入参规则。
// 网络层（fetchProviderModels/fetchProviderUsage）不做直测：jsonRequestBody 已有 provider-config 行为覆盖。
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { buildModelsUrl, parseModelsResponse } from "./provider-live";

test("buildModelsUrl：openai 兼容形态直接拼 /models", () => {
  assert.equal(
    buildModelsUrl({ baseUrl: "https://api.openai.com/v1", api: "openai-completions", apiKey: "sk" }),
    "https://api.openai.com/v1/models",
  );
  assert.equal(
    buildModelsUrl({ baseUrl: "https://api.deepseek.com/", api: "openai-completions", apiKey: "sk" }),
    "https://api.deepseek.com/models",
  );
  assert.equal(
    buildModelsUrl({ baseUrl: "https://open.bigmodel.cn/api/paas/v4", api: "openai-completions", apiKey: "k" }),
    "https://open.bigmodel.cn/api/paas/v4/models",
  );
});

test("buildModelsUrl：anthropic 形态按 base 是否含 /vN 决定是否补 /v1", () => {
  // 官方 base 已含 /v1
  assert.equal(
    buildModelsUrl({ baseUrl: "https://api.anthropic.com/v1", api: "anthropic-messages", apiKey: "k" }),
    "https://api.anthropic.com/v1/models?limit=1000",
  );
  // minimax / volcengine-coding / kimi 代理 base 不含 /v1 → 补 /v1/models
  assert.equal(
    buildModelsUrl({ baseUrl: "https://api.minimax.io/anthropic", api: "anthropic-messages", apiKey: "k" }),
    "https://api.minimax.io/anthropic/v1/models?limit=1000",
  );
  assert.equal(
    buildModelsUrl({ baseUrl: "http://127.0.0.1:18790/coding", api: "anthropic-messages", apiKey: "" }),
    "http://127.0.0.1:18790/coding/v1/models?limit=1000",
  );
});

test("buildModelsUrl：google 形态 key 进 query + pageSize=1000", () => {
  const url = buildModelsUrl({ baseUrl: "https://generativelanguage.googleapis.com/v1beta", api: "google-generative-ai", apiKey: "AIz key&1" });
  assert.ok(url.startsWith("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key="));
  assert.ok(url.includes(encodeURIComponent("AIz key&1")), "key 必须编码");
});

test("parseModelsResponse：openai 兼容 {data:[{id}]}，display_name 优先于 name", () => {
  const out = parseModelsResponse("openai-completions", {
    data: [
      { id: "deepseek-v4-pro" },
      { id: "glm-5.1", display_name: "GLM 5.1" },
      { id: "glm-5.1-name-fallback", name: "By Name" },
      { id: "both", display_name: "Display Wins", name: "By Name" },
      { id: "deepseek-v4-pro" },
      { not_id: true },
      "junk",
    ],
  });
  assert.deepEqual(out, [
    { id: "deepseek-v4-pro" },
    { id: "glm-5.1", name: "GLM 5.1" },
    { id: "glm-5.1-name-fallback", name: "By Name" },
    { id: "both", name: "Display Wins" },
  ]);
});

test("parseModelsResponse：anthropic {data:[{id,display_name}]}", () => {
  const out = parseModelsResponse("anthropic-messages", {
    data: [{ id: "claude-opus-4-6", display_name: "Claude Opus 4.6" }],
  });
  assert.deepEqual(out, [{ id: "claude-opus-4-6", name: "Claude Opus 4.6" }]);
});

test("parseModelsResponse：google {models:[{name}]} 剥前缀 + 过滤非 generateContent", () => {
  const out = parseModelsResponse("google-generative-ai", {
    models: [
      { name: "models/gemini-3-pro", displayName: "Gemini 3 Pro", supportedGenerationMethods: ["generateContent"] },
      { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
      { name: "models/gemini-3-flash", supportedGenerationMethods: ["generateContent", "countTokens"] },
      { broken: true },
    ],
  });
  assert.deepEqual(out, [
    { id: "gemini-3-pro", name: "Gemini 3 Pro" },
    { id: "gemini-3-flash" },
  ]);
});

test("parseModelsResponse：未知结构返回空数组（不抛错）", () => {
  assert.deepEqual(parseModelsResponse("openai-completions", { foo: 1 }), []);
  assert.deepEqual(parseModelsResponse("openai-completions", null), []);
  assert.deepEqual(parseModelsResponse("openai-completions", { data: "not-array" }), []);
});
