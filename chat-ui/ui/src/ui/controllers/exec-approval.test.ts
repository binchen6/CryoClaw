import test from "node:test";
import assert from "node:assert/strict";
import {
  addExecApproval,
  parseExecApprovalRequested,
  parseExecApprovalResolved,
  parsePluginApprovalRequested,
  pruneExecApprovalQueue,
  removeExecApproval,
} from "./exec-approval.ts";

const NOW = Date.now();

test("parseExecApprovalRequested 解析 exec 审批并标记 kind=exec", () => {
  const entry = parseExecApprovalRequested({
    id: "exec:1",
    request: { command: "ls -la", cwd: "/tmp" },
    createdAtMs: NOW,
    expiresAtMs: NOW + 60_000,
  });
  assert.ok(entry);
  assert.equal(entry.kind, "exec");
  assert.equal(entry.request.command, "ls -la");
  assert.equal(entry.allowedDecisions, undefined);
});

test("parseExecApprovalRequested 拒绝空 command", () => {
  assert.equal(
    parseExecApprovalRequested({
      id: "exec:1",
      request: { command: "  " },
      createdAtMs: NOW,
      expiresAtMs: NOW + 60_000,
    }),
    null,
  );
});

test("parsePluginApprovalRequested 解析 skill proposal 审批（内核 payload 形状）", () => {
  const entry = parsePluginApprovalRequested({
    id: "plugin:abc",
    request: {
      pluginId: "skills",
      title: "Apply workspace skill proposal",
      description: "Proposal ID: p1\nTarget skill: foo\nBody size: 2 KB",
      severity: "warning",
      toolName: "skill_workshop",
      toolCallId: "tc1",
      allowedDecisions: ["allow-once", "deny"],
      agentId: "main",
      sessionKey: "s1",
    },
    createdAtMs: NOW,
    expiresAtMs: NOW + 70_000,
  });
  assert.ok(entry);
  assert.equal(entry.kind, "plugin");
  assert.equal(entry.title, "Apply workspace skill proposal");
  assert.match(entry.description ?? "", /Target skill: foo/);
  assert.deepEqual(entry.allowedDecisions, ["allow-once", "deny"]);
  assert.equal(entry.request.command, "");
  assert.equal(entry.request.sessionKey, "s1");
});

test("parsePluginApprovalRequested 缺 title 或时间戳时拒绝", () => {
  assert.equal(parsePluginApprovalRequested({ id: "p:1", request: {}, createdAtMs: NOW, expiresAtMs: NOW }), null);
  assert.equal(
    parsePluginApprovalRequested({
      id: "p:1",
      request: { title: "t" },
      createdAtMs: 0,
      expiresAtMs: NOW + 1000,
    }),
    null,
  );
});

test("parsePluginApprovalRequested allowedDecisions 缺失或为空时归一为 null", () => {
  const base = {
    id: "p:1",
    request: { title: "t" },
    createdAtMs: NOW,
    expiresAtMs: NOW + 1000,
  };
  assert.equal(parsePluginApprovalRequested(base)?.allowedDecisions, null);
  const empty = parsePluginApprovalRequested({
    ...base,
    request: { title: "t", allowedDecisions: [] },
  });
  assert.equal(empty?.allowedDecisions, null);
});

test("parseExecApprovalResolved 同时适用于 exec 与 plugin 的 resolved 事件", () => {
  const resolved = parseExecApprovalResolved({ id: "plugin:abc", decision: "allow-once" });
  assert.ok(resolved);
  assert.equal(resolved.id, "plugin:abc");
  assert.equal(resolved.decision, "allow-once");
});

test("addExecApproval 同 id 去重并保持队尾追加", () => {
  const mk = (id: string) => ({
    id,
    kind: "exec" as const,
    request: { command: "x" },
    createdAtMs: NOW,
    expiresAtMs: NOW + 60_000,
  });
  let queue = addExecApproval([], mk("a"));
  queue = addExecApproval(queue, mk("b"));
  queue = addExecApproval(queue, mk("a"));
  assert.deepEqual(
    queue.map((e) => e.id),
    ["b", "a"],
  );
});

test("pruneExecApprovalQueue / removeExecApproval 剔除过期与指定条目", () => {
  const mk = (id: string, expiresAtMs: number) => ({
    id,
    kind: "plugin" as const,
    request: { command: "" },
    title: "t",
    createdAtMs: NOW,
    expiresAtMs,
  });
  const queue = [mk("expired", NOW - 1), mk("live", NOW + 60_000)];
  assert.deepEqual(pruneExecApprovalQueue(queue).map((e) => e.id), ["live"]);
  assert.deepEqual(removeExecApproval(queue, "live").map((e) => e.id), []);
});
