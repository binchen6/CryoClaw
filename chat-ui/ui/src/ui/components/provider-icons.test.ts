import { test } from "node:test";
import assert from "node:assert/strict";
import { CUSTOM_PRESETS, PROVIDERS } from "../views/setup/setup-constants.ts";
import { providerIcon, resolveProviderIcon } from "./provider-icons.ts";

test("every built-in provider preset has a distinct non-custom icon family", () => {
  const keys = [...Object.keys(PROVIDERS), ...Object.values(CUSTOM_PRESETS).map(preset => preset.providerKey)];
  const kinds = keys.map(key => resolveProviderIcon(key));
  for (const [index, key] of keys.entries()) {
    if (key !== "custom") assert.notEqual(kinds[index], "custom", `${key} must not use the generic icon`);
  }
  assert.deepEqual([...new Set(kinds)].sort(), [
    "anthropic", "custom", "deepseek", "google", "minimax", "moonshot",
    "ollama", "openai", "qwen", "volcengine", "xiaomi", "zai",
  ]);
});

test("provider aliases, suffixes and custom-host configurations resolve consistently", () => {
  assert.equal(resolveProviderIcon("kimi-coding"), "moonshot");
  assert.equal(resolveProviderIcon("moonshot-cn"), "moonshot");
  assert.equal(resolveProviderIcon("openai-coding"), "openai");
  assert.equal(resolveProviderIcon("deepseek-backup"), "deepseek");
  assert.equal(resolveProviderIcon("custom-host", "https://api.deepseek.com/v1"), "deepseek");
  assert.equal(resolveProviderIcon("custom-host", "https://open.bigmodel.cn/api/paas/v4"), "zai");
  assert.equal(resolveProviderIcon("custom-host", "http://127.0.0.1:11434/v1"), "ollama");
  assert.equal(resolveProviderIcon("custom-host", "https://example.com/v1"), "custom");
  assert.equal(resolveProviderIcon("custom-host", "not a url"), "custom");
});

test("custom providers use their display-name initial while the manual preset keeps its glyph", () => {
  const initial = providerIcon("custom-example", "", "自定义供应商") as unknown as { values: unknown[] };
  assert.deepEqual(initial.values, ["自"]);
  const manual = providerIcon("custom") as unknown as { values: unknown[] };
  assert.equal(manual.values.length, 1);
  assert.notDeepEqual(manual.values, ["C"]);
});

test("provider icons are Lit templates backed by the shared CryoIcons renderer", () => {
  const result = providerIcon("qwen") as unknown as { _$litType$: unknown; values: unknown[] };
  assert.ok(result._$litType$);
  assert.equal(result.values.length, 1);
});
