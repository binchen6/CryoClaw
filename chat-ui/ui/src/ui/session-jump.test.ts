// session-jump：显式跳转到隐藏会话（已归档/被过滤）时的 reconcile 容忍。
// 守护回归：任务页「打开会话」跳到归档会话后，30s tick 的 reconcile 会把
// 不在可见列表里的当前会话强制弹回 main；显式跳转的会话必须豁免。
import test from "node:test";
import assert from "node:assert/strict";

import {
  clearToleratedHiddenSession,
  isToleratedHiddenSession,
  tolerateHiddenSession,
} from "./session-jump.ts";

test("容忍：记录后当前会话豁免 reconcile", () => {
  tolerateHiddenSession("agent:main:subagent:abc");
  assert.equal(isToleratedHiddenSession("agent:main:subagent:abc"), true);
  assert.equal(isToleratedHiddenSession("main"), false);
  assert.equal(isToleratedHiddenSession(null), false);
  assert.equal(isToleratedHiddenSession(""), false);
});

test("容忍：显式切走（记录新 key）后旧 key 不再豁免", () => {
  tolerateHiddenSession("session-a");
  tolerateHiddenSession("session-b");
  assert.equal(isToleratedHiddenSession("session-a"), false);
  assert.equal(isToleratedHiddenSession("session-b"), true);
});

test("容忍：会话被删除时清除，reconcile 恢复接管", () => {
  tolerateHiddenSession("session-a");
  clearToleratedHiddenSession("session-a");
  assert.equal(isToleratedHiddenSession("session-a"), false);
});

test("容忍：清除不匹配的 key 不影响当前容忍", () => {
  tolerateHiddenSession("session-a");
  clearToleratedHiddenSession("other");
  assert.equal(isToleratedHiddenSession("session-a"), true);
});

test("容忍：空 key 记录视为无容忍", () => {
  tolerateHiddenSession("session-a");
  tolerateHiddenSession("   ");
  assert.equal(isToleratedHiddenSession("session-a"), false);
  assert.equal(isToleratedHiddenSession("   "), false);
});
