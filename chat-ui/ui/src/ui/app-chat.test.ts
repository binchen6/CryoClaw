import assert from "node:assert/strict";
import test from "node:test";
import { removeFailedSendArtifacts } from "./app-chat.ts";

// 发送失败残留清理：错误卡 + 带 cryoclawSendFailed 标记的本地乐观 user 气泡
// 一并移除；已落盘的 run 级 user 气泡（无标记）不受影响。

test("移除匹配错误卡及其前一条带标记的乐观 user 气泡", () => {
  const echo = { role: "user", cryoclawSendFailed: true };
  const card = { cryoclawError: true, resendText: "hello" };
  const kept = { role: "assistant" };
  const result = removeFailedSendArtifacts([kept, echo, card], "hello");
  assert.deepEqual(result, [kept]);
});

test("错误卡前一条无 cryoclawSendFailed 标记（已落盘 user 气泡）时只删卡", () => {
  const persistedUser = { role: "user" };
  const card = { cryoclawError: true, resendText: "hello" };
  const result = removeFailedSendArtifacts([persistedUser, card], "hello");
  assert.deepEqual(result, [persistedUser]);
});

test("resendText 不匹配时返回 null，原数组不动", () => {
  const card = { cryoclawError: true, resendText: "hello" };
  const messages = [card];
  assert.equal(removeFailedSendArtifacts(messages, "other"), null);
});

test("多张错误卡时只移除 resendText 匹配的最后一张", () => {
  const cardA = { cryoclawError: true, resendText: "a" };
  const echoB = { role: "user", cryoclawSendFailed: true };
  const cardB = { cryoclawError: true, resendText: "b" };
  const result = removeFailedSendArtifacts([cardA, echoB, cardB], "b");
  assert.deepEqual(result, [cardA]);
});
