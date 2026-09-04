import test from "node:test";
import assert from "node:assert/strict";

import { groupSidebarSessions } from "./sidebar-grouping.ts";
import type { SessionPanelSessionOption } from "./components/cc-session-panel.ts";

// 固定参考时间：2026-08-03 15:00 本地时间
const NOW = new Date(2026, 7, 3, 15, 0, 0).getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

function opt(key: string, extra: Partial<SessionPanelSessionOption> = {}): SessionPanelSessionOption {
  return { key, label: key, ...extra };
}

test("sidebar grouping：置顶会话独立成组且优先于时间组", () => {
  const groups = groupSidebarSessions(
    [
      opt("a", { updatedAt: NOW - 10 * DAY_MS, pinned: true }),
      opt("b", { updatedAt: NOW - 1000 }),
    ],
    NOW,
  );

  assert.deepEqual(
    groups.map((g) => [g.labelKey, g.items.map((s) => s.key)]),
    [
      ["sidebar.groupPinned", ["a"]],
      ["sidebar.groupToday", ["b"]],
    ],
  );
});

test("sidebar grouping：今天 / 昨天 / 最近 7 天 / 更早按本地零点切分", () => {
  const groups = groupSidebarSessions(
    [
      opt("today", { updatedAt: NOW - 60 * 1000 }), // 15:00 前 1 分钟
      opt("yesterday", { updatedAt: NOW - DAY_MS }), // 昨天 15:00
      opt("last7", { updatedAt: NOW - 3 * DAY_MS }),
      opt("older", { updatedAt: NOW - 30 * DAY_MS }),
    ],
    NOW,
  );

  assert.deepEqual(
    groups.map((g) => g.labelKey),
    [
      "sidebar.groupToday",
      "sidebar.groupYesterday",
      "sidebar.groupLast7Days",
      "sidebar.groupOlder",
    ],
  );
});

test("sidebar grouping：缺 updatedAt 的会话归入更早", () => {
  const groups = groupSidebarSessions([opt("no-ts")], NOW);
  assert.deepEqual(
    groups.map((g) => [g.labelKey, g.items.map((s) => s.key)]),
    [["sidebar.groupOlder", ["no-ts"]]],
  );
});

test("sidebar grouping：组内保留输入顺序，空组不产生", () => {
  const groups = groupSidebarSessions(
    [
      opt("t1", { updatedAt: NOW - 1000 }),
      opt("t2", { updatedAt: NOW - 2000 }),
    ],
    NOW,
  );
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].items.map((s) => s.key), ["t1", "t2"]);
});

test("sidebar grouping：空输入返回空分组", () => {
  assert.deepEqual(groupSidebarSessions([], NOW), []);
});

test("sidebar grouping：跨零点边界（昨天 23:59 不进入今天）", () => {
  const justBeforeMidnight = new Date(2026, 7, 3, 0, 0, 0).getTime() - 1; // 8-2 23:59:59.999
  const groups = groupSidebarSessions([opt("edge", { updatedAt: justBeforeMidnight })], NOW);
  assert.deepEqual(groups.map((g) => g.labelKey), ["sidebar.groupYesterday"]);
});
