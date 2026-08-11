import test from "node:test";
import assert from "node:assert/strict";

import {
  extractKernelThinkingLevelIds,
  resolveThinkingCapabilities,
} from "./thinking-levels.ts";

// ── extractKernelThinkingLevelIds ──

test("thinking levels：[{id,label}] 形状提取 id 并去重", () => {
  assert.deepEqual(
    extractKernelThinkingLevelIds([
      { id: "off", label: "Off" },
      { id: "low" },
      { id: "low" },
      { id: "high" },
    ]),
    ["off", "low", "high"],
  );
});

test("thinking levels：string[] 形状兼容", () => {
  assert.deepEqual(extractKernelThinkingLevelIds(["off", "on"]), ["off", "on"]);
});

test("thinking levels：非数组/空项容错", () => {
  assert.deepEqual(extractKernelThinkingLevelIds(undefined), []);
  assert.deepEqual(extractKernelThinkingLevelIds("high"), []);
  assert.deepEqual(extractKernelThinkingLevelIds([null, {}, { id: " " }, ""]), []);
});

// ── resolveThinkingCapabilities：内核下发优先 ──

test("thinking caps：内核 thinkingLevels 优先于 provider 回退", () => {
  const caps = resolveThinkingCapabilities({
    provider: "kimi-coding",
    modelKey: "kimi-coding/kimi-k2.7",
    sessionThinkingLevels: [{ id: "off" }, { id: "on" }],
  });
  assert.deepEqual(caps.levels, ["off", "on"]);
  assert.equal(caps.isBinary, true);
});

test("thinking caps：内核列表缺 off 时自动补首位", () => {
  const caps = resolveThinkingCapabilities({
    provider: "anthropic",
    modelKey: "anthropic/claude-sonnet-4",
    sessionThinkingLevels: ["low", "medium", "high"],
  });
  assert.deepEqual(caps.levels, ["off", "low", "medium", "high"]);
});

test("thinking caps：内核 thinkingDefault 生效（合法时）", () => {
  const caps = resolveThinkingCapabilities({
    provider: "kimi-coding",
    modelKey: "kimi-coding/kimi-k2.7",
    sessionThinkingLevels: ["off", "low", "high", "max"],
    sessionThinkingDefault: "max",
  });
  assert.equal(caps.defaultLevel, "max");
});

test("thinking caps：内核 thinkingDefault 非法时回退 provider 推荐档", () => {
  const caps = resolveThinkingCapabilities({
    provider: "kimi-coding",
    modelKey: "kimi-coding/kimi-k2.7",
    sessionThinkingLevels: ["off", "low", "high"],
    sessionThinkingDefault: "ultra",
  });
  assert.equal(caps.defaultLevel, "high");
});

// ── resolveThinkingCapabilities：provider 回退 ──

test("thinking caps：zai 二元开关", () => {
  const caps = resolveThinkingCapabilities({ provider: "z.ai", modelKey: "zai/glm-5" });
  assert.deepEqual(caps.levels, ["off", "on"]);
  assert.equal(caps.isBinary, true);
  assert.equal(caps.defaultLevel, "on");
});

test("thinking caps：kimi-coding 三档 + off，默认 high", () => {
  const caps = resolveThinkingCapabilities({
    provider: "kimi-coding",
    modelKey: "kimi-coding/kimi-k2.7-code",
  });
  assert.deepEqual(caps.levels, ["off", "low", "high", "max"]);
  assert.equal(caps.isBinary, false);
  assert.equal(caps.defaultLevel, "high");
});

test("thinking caps：Claude 4 追加 adaptive 档", () => {
  const caps = resolveThinkingCapabilities({
    provider: "anthropic",
    modelKey: "anthropic/claude-sonnet-4-5",
  });
  assert.deepEqual(caps.levels, ["off", "low", "medium", "high", "adaptive"]);
  assert.equal(caps.defaultLevel, "adaptive");
});

test("thinking caps：无模型信息时返回空档位", () => {
  const caps = resolveThinkingCapabilities({});
  assert.deepEqual(caps.levels, []);
  assert.equal(caps.defaultLevel, "off");
});
