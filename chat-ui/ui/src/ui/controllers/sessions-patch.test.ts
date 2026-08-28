import test from "node:test";
import assert from "node:assert/strict";
import { applySessionsChangedPatch } from "./sessions-patch.ts";
import type { GatewaySessionRow, SessionsListResult } from "../types.ts";

// 构造一个带常见行快照字段的会话行，字段取舍对齐 sessions.list 返回行。
function row(key: string, overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key,
    derivedTitle: "旧标题",
    updatedAt: 100,
    unread: false,
    pinned: false,
    archived: false,
    hasActiveRun: false,
    ...overrides,
  };
}

function result(sessions: GatewaySessionRow[]): SessionsListResult {
  return { path: "/tmp/sessions", sessions };
}

test("命中缓存行：返回合并后的新 sessionsResult，快照字段覆盖旧值", () => {
  const current = result([row("a"), row("b", { derivedTitle: "B" })]);
  const payload = {
    sessionKey: "b",
    derivedTitle: "新标题",
    updatedAt: 999,
    unread: true,
  };
  const next = applySessionsChangedPatch(current, payload);
  assert.ok(next, "应返回新对象");
  assert.notEqual(next, current, "顶层对象是新的");
  assert.notEqual(next!.sessions, current.sessions, "sessions 数组是新的");
  // 命中行是新对象且字段被覆盖
  assert.notEqual(next!.sessions[1], current.sessions[1], "命中行是新对象");
  assert.equal(next!.sessions[1].derivedTitle, "新标题");
  assert.equal(next!.sessions[1].updatedAt, 999);
  assert.equal(next!.sessions[1].unread, true);
  // 未命中行引用不变
  assert.equal(next!.sessions[0], current.sessions[0], "未命中行引用不变");
  assert.equal(next!.sessions[0].derivedTitle, "旧标题");
  // 原对象未被改动
  assert.equal(current.sessions[1].derivedTitle, "B");
});

test("命中行：顶层其他字段（path）透传", () => {
  const current = result([row("a")]);
  const next = applySessionsChangedPatch(current, { sessionKey: "a", unread: true });
  assert.ok(next);
  assert.equal(next!.path, "/tmp/sessions");
});

test("sessionKey 不在缓存行中：不追加、返回 null", () => {
  const current = result([row("a")]);
  const next = applySessionsChangedPatch(current, {
    sessionKey: "not-exist",
    derivedTitle: "X",
  });
  assert.equal(next, null);
  // 列表长度不因事件新增
  assert.equal(current.sessions.length, 1);
});

test("current 为 null / 无 sessions 数组 / 空数组：返回 null", () => {
  assert.equal(applySessionsChangedPatch(null, { sessionKey: "a" }), null);
  assert.equal(applySessionsChangedPatch(undefined, { sessionKey: "a" }), null);
  assert.equal(applySessionsChangedPatch({} as SessionsListResult, { sessionKey: "a" }), null);
  assert.equal(applySessionsChangedPatch(result([]), { sessionKey: "a" }), null);
});

test("事件缺 sessionKey 或非字符串：返回 null", () => {
  const current = result([row("a")]);
  assert.equal(applySessionsChangedPatch(current, {}), null);
  assert.equal(applySessionsChangedPatch(current, undefined), null);
  assert.equal(applySessionsChangedPatch(current, null), null);
  assert.equal(applySessionsChangedPatch(current, { sessionKey: 123 }), null);
  assert.equal(applySessionsChangedPatch(current, { sessionKey: "" }), null);
  assert.equal(applySessionsChangedPatch(current, "not-an-object"), null);
});

test("事件元字段（ts/phase/messageId/messageSeq/agentId）不写进行", () => {
  const current = result([row("a", { derivedTitle: "原题" })]);
  const next = applySessionsChangedPatch(current, {
    sessionKey: "a",
    ts: 999,
    phase: "message",
    messageId: "m1",
    messageSeq: 3,
    agentId: "agent-x",
    derivedTitle: "覆盖",
  });
  assert.ok(next);
  const merged = next!.sessions[0];
  assert.equal(merged.derivedTitle, "覆盖", "非元字段正常覆盖");
  // 行本身无 ts 等元字段，合并后也不应新增
  assert.ok(!("ts" in merged), "ts 不应写入行");
  assert.ok(!("phase" in merged), "phase 不应写入行");
  assert.ok(!("messageId" in merged), "messageId 不应写入行");
  assert.ok(!("messageSeq" in merged), "messageSeq 不应写入行");
  assert.ok(!("agentId" in merged), "agentId 不应写入行");
});

test("白名单：行已有字段被事件覆盖；行没有的字段不新增", () => {
  // 行已有 hasActiveRun → 覆盖
  const withField = result([row("a", { hasActiveRun: false })]);
  const patched = applySessionsChangedPatch(withField, {
    sessionKey: "a",
    hasActiveRun: true,
  });
  assert.ok(patched);
  assert.equal(patched!.sessions[0].hasActiveRun, true, "已有字段应被覆盖");

  // 行没有 eventOnly 字段 → 不新增（防事件特有字段污染行结构）
  const bare = result([row("b")]);
  const patched2 = applySessionsChangedPatch(bare, {
    sessionKey: "b",
    eventOnlyField: "should-not-appear",
    derivedTitle: "标题",
  });
  assert.ok(patched2);
  assert.ok(!("eventOnlyField" in patched2!.sessions[0]), "行无该字段时不新增");
  assert.equal(patched2!.sessions[0].derivedTitle, "标题");
});
