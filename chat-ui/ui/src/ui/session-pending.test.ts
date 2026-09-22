// F7：session-pending 的 pendingSessionResets 纯函数语义测试。
// hasPendingSessionReset 是只读探测（重连路径用，不得消费标记——消费仍归
// 终态事件/发送失败回滚的 consumePendingSessionReset），这里钉住两个 API 的
// 交互：peek 不影响 consume，consume 清除后 peek 为假。
import test from "node:test";
import assert from "node:assert/strict";
import {
  consumePendingSessionReset,
  hasPendingSessionReset,
  pendingSessionResets,
} from "./session-pending.ts";

test("hasPendingSessionReset：只读探测，不消费标记", () => {
  pendingSessionResets.clear();
  pendingSessionResets.add("agent:main:main");
  assert.equal(hasPendingSessionReset("agent:main:main"), true, "首次探测应为真");
  assert.equal(
    hasPendingSessionReset("agent:main:main"),
    true,
    "重复探测仍应为真（peek 不得消费）",
  );
  assert.equal(hasPendingSessionReset("agent:other:main"), false, "未置位的 key 应为假");
  pendingSessionResets.clear();
});

test("consumePendingSessionReset：消费后 peek 为假（终态路径语义不变）", () => {
  pendingSessionResets.clear();
  pendingSessionResets.add("agent:main:main");
  assert.equal(consumePendingSessionReset("agent:main:main"), true, "首次消费应命中");
  assert.equal(hasPendingSessionReset("agent:main:main"), false, "消费后探测应为假");
  assert.equal(consumePendingSessionReset("agent:main:main"), false, "重复消费不命中");
  pendingSessionResets.clear();
});
