import test from "node:test";
import assert from "node:assert/strict";
import {
  ENV_KEY_CANDIDATES,
  MIN_ENV_KEY_LENGTH,
  detectEnvProviderKeys,
  maskApiKey,
  resolveEnvCandidate,
  buildEnvProviderConfig,
} from "./setup-env-detect.ts";

test("detectEnvProviderKeys：命中映射表内的环境变量", () => {
  const out = detectEnvProviderKeys({ OPENAI_API_KEY: "sk-openai-1234567890abcdef" });
  assert.equal(out.length, 1);
  assert.equal(out[0].providerKey, "openai");
  assert.equal(out[0].envVar, "OPENAI_API_KEY");
  // 掩码不含明文中段
  assert.ok(!out[0].maskedKey.includes("openai-123456"), "掩码不应泄漏明文中段");
  assert.equal(out[0].maskedKey, "sk-…****…cdef");
});

test("detectEnvProviderKeys：缺失/空白/短值一律跳过", () => {
  assert.deepEqual(detectEnvProviderKeys({}), []);
  assert.deepEqual(detectEnvProviderKeys({ ANTHROPIC_API_KEY: "   " }), []);
  assert.deepEqual(
    detectEnvProviderKeys({ OPENAI_API_KEY: "x".repeat(MIN_ENV_KEY_LENGTH - 1) }),
    [],
    "短于最小长度的值应跳过",
  );
  assert.deepEqual(detectEnvProviderKeys({ OPENAI_API_KEY: undefined }), []);
});

test("detectEnvProviderKeys：同 provider 多环境变量去重（先到先得）", () => {
  const out = detectEnvProviderKeys({
    GEMINI_API_KEY: "gemini-key-123456",
    GOOGLE_API_KEY: "google-key-123456",
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].providerKey, "google");
  // ENV_KEY_CANDIDATES 中 GOOGLE_API_KEY 排在 GEMINI_API_KEY 前
  assert.equal(out[0].envVar, "GOOGLE_API_KEY");
});

test("detectEnvProviderKeys：多 provider 输出顺序与映射表一致（稳定）", () => {
  const out = detectEnvProviderKeys({
    GEMINI_API_KEY: "gemini-key-123456",
    DEEPSEEK_API_KEY: "deepseek-key-123456",
    MOONSHOT_API_KEY: "moonshot-key-123456",
    OPENAI_API_KEY: "openai-key-123456",
  });
  assert.deepEqual(
    out.map((c) => c.providerKey),
    ["openai", "moonshot", "deepseek", "google"],
  );
});

test("ENV_KEY_CANDIDATES：moonshot/deepseek 端点与 provider-config 预设对齐", () => {
  const moonshot = ENV_KEY_CANDIDATES.find((c) => c.envVar === "MOONSHOT_API_KEY")!;
  assert.equal(moonshot.providerKey, "moonshot");
  assert.equal(moonshot.verifyProvider, "moonshot");
  assert.equal(moonshot.verifySubPlatform, "moonshot-cn");
  assert.equal(moonshot.baseUrl, "https://api.moonshot.cn/v1");
  assert.equal(moonshot.api, "openai-completions");

  const deepseek = ENV_KEY_CANDIDATES.find((c) => c.envVar === "DEEPSEEK_API_KEY")!;
  assert.equal(deepseek.providerKey, "deepseek");
  assert.equal(deepseek.verifyProvider, "custom");
  assert.equal(deepseek.verifyCustomPreset, "deepseek");
  assert.equal(deepseek.baseUrl, "https://api.deepseek.com");
  assert.equal(deepseek.defaultModel, "deepseek-v4-pro");
});

test("maskApiKey：保留前 3 后 4，中段固定掩码", () => {
  assert.equal(maskApiKey("sk-abcdefghijklmnop"), "sk-…****…mnop");
  assert.equal(maskApiKey("12345678"), "123…****…5678");
});

test("maskApiKey：短 key / 空串全掩码", () => {
  assert.equal(maskApiKey(""), "****");
  assert.equal(maskApiKey("short"), "****");
  assert.equal(maskApiKey("x".repeat(MIN_ENV_KEY_LENGTH - 1)), "****");
});

test("resolveEnvCandidate：只允许映射表内的 (providerKey, envVar) 组合", () => {
  assert.ok(resolveEnvCandidate("openai", "OPENAI_API_KEY"));
  assert.ok(resolveEnvCandidate("google", "GEMINI_API_KEY"));
  // 渲染层任意指定环境变量名 → 拒绝
  assert.equal(resolveEnvCandidate("openai", "AWS_SECRET_ACCESS_KEY"), null);
  assert.equal(resolveEnvCandidate("not-a-provider", "OPENAI_API_KEY"), null);
  assert.equal(resolveEnvCandidate("", ""), null);
});

test("buildEnvProviderConfig：结构与前端 buildProviderConfigForAdd 一致", () => {
  const candidate = resolveEnvCandidate("anthropic", "ANTHROPIC_API_KEY")!;
  const cfg = buildEnvProviderConfig(candidate, "sk-ant-key-123456", true) as any;
  assert.equal(cfg.apiKey, "sk-ant-key-123456");
  assert.equal(cfg.baseUrl, "https://api.anthropic.com/v1");
  assert.equal(cfg.api, "anthropic-messages");
  assert.deepEqual(cfg.models, [
    { id: "claude-sonnet-4-5", name: "claude-sonnet-4-5", input: ["text", "image"] },
  ]);
  // 无图片能力时 input 仅 text
  const cfgText = buildEnvProviderConfig(candidate, "sk-ant-key-123456", false) as any;
  assert.deepEqual(cfgText.models[0].input, ["text"]);
});
