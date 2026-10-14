import test from "node:test";
import assert from "node:assert/strict";

import { isFailedSubagentStatus, selectSubagentCards } from "./subagent-status.ts";
import type { GatewaySessionRow } from "../types.ts";

const SESSION = "agent:main:main";
const NOW = Date.now();

function makeRow(overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key: "agent:main:sub:1",
    spawnedBy: SESSION,
    status: "running",
    hasActiveSubagentRun: true,
    label: "研究任务",
    ...overrides,
  };
}

test("subagent：活跃子会话被投影为卡片（含 lastMessagePreview）", () => {
  const cards = selectSubagentCards(
    [makeRow({ lastMessagePreview: "正在检索资料" })],
    SESSION,
    NOW,
  );
  assert.equal(cards.length, 1);
  assert.equal(cards[0].active, true);
  assert.equal(cards[0].title, "研究任务");
  assert.equal(cards[0].progress, "正在检索资料");
  assert.equal(cards[0].sessionKey, "agent:main:sub:1", "卡片携带子会话 key 供点击跳转");
});

test("subagent：跨会话 / 非派生会话不显示", () => {
  const cards = selectSubagentCards(
    [
      makeRow({ key: "agent:main:sub:2", spawnedBy: "agent:main:other" }),
      makeRow({ key: "agent:main:root", spawnedBy: undefined }),
    ],
    SESSION,
    NOW,
  );
  assert.equal(cards.length, 0, "其他会话的子会话与普通会话都不投影");
});

test("subagent：controlOwnerSessionKey 兜底关联（spawnedBy 缺省）", () => {
  const cards = selectSubagentCards(
    [makeRow({ spawnedBy: undefined, controlOwnerSessionKey: SESSION })],
    SESSION,
    NOW,
  );
  assert.equal(cards.length, 1);
});

test("subagent：终态子会话定格窗口内显示、过期隐藏", () => {
  const fresh = makeRow({
    hasActiveSubagentRun: undefined,
    status: "done",
    endedAt: NOW - 5_000,
  });
  const stale = makeRow({
    key: "agent:main:sub:2",
    hasActiveSubagentRun: undefined,
    status: "done",
    endedAt: NOW - 60_000,
  });
  const cards = selectSubagentCards([fresh, stale], SESSION, NOW);
  assert.equal(cards.length, 1, "仅定格窗口内的终态子会话显示");
  assert.equal(cards[0].id, "agent:main:sub:1");
  assert.equal(cards[0].active, false);
});

test("subagent：终态无时间戳时不显示（防僵尸卡）", () => {
  const cards = selectSubagentCards(
    [
      makeRow({
        hasActiveSubagentRun: undefined,
        status: "done",
        endedAt: undefined,
        updatedAt: undefined,
      }),
    ],
    SESSION,
    NOW,
  );
  assert.equal(cards.length, 0);
});

test("subagent：空列表 / 空会话键安全返回空", () => {
  assert.deepEqual(selectSubagentCards([], SESSION, NOW), []);
  assert.deepEqual(selectSubagentCards([makeRow()], "", NOW), []);
  assert.deepEqual(selectSubagentCards(null, SESSION, NOW), []);
});

test("subagent：hasActiveSubagentRun 优先于 status 判定活跃", () => {
  // status 非 queued/running 但内核标记仍有活跃后代 run → 活跃
  const cards = selectSubagentCards(
    [makeRow({ status: "done", hasActiveSubagentRun: true })],
    SESSION,
    NOW,
  );
  assert.equal(cards.length, 1);
  assert.equal(cards[0].active, true);
});

test("subagent：活跃卡排在终态卡之前", () => {
  const done = makeRow({
    key: "agent:main:sub:done",
    hasActiveSubagentRun: undefined,
    status: "done",
    endedAt: NOW - 1_000,
  });
  const running = makeRow({ key: "agent:main:sub:run", status: "running" });
  const cards = selectSubagentCards([done, running], SESSION, NOW);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].sessionKey, "agent:main:sub:run");
  assert.equal(cards[1].sessionKey, "agent:main:sub:done");
});

test("subagent：失败类状态判定（含 2026.10.3 killed/timeout/interrupted）", () => {
  assert.equal(isFailedSubagentStatus("failed"), true);
  assert.equal(isFailedSubagentStatus("cancelled"), true);
  assert.equal(isFailedSubagentStatus("timed_out"), true);
  assert.equal(isFailedSubagentStatus("timeout"), true);
  assert.equal(isFailedSubagentStatus("killed"), true);
  assert.equal(isFailedSubagentStatus("interrupted"), true);
  assert.equal(isFailedSubagentStatus("done"), false);
  assert.equal(isFailedSubagentStatus("completed"), false);
  assert.equal(isFailedSubagentStatus("running"), false);
});
