import test from "node:test";
import assert from "node:assert/strict";

import { groupSidebarSessions } from "./sidebar-grouping.ts";
import type { SessionPanelSessionOption } from "./components/oc-session-panel.ts";

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

// ── 2026.10.3 子会话谱系嵌套 ──

test("sidebar grouping：子会话嵌套在同组父会话之后并标 depth=1", () => {
  const groups = groupSidebarSessions(
    [
      opt("parent", { updatedAt: NOW - 1000 }),
      opt("other", { updatedAt: NOW - 1500 }),
      opt("child", { updatedAt: NOW - 2000, spawnedBy: "parent" }),
    ],
    NOW,
  );
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].items.map((s) => [s.key, s.depth ?? 0]),
    [
      ["parent", 0],
      ["child", 1],
      ["other", 0],
    ],
    "子会话紧随父会话，其余保持原顺序",
  );
});

test("sidebar grouping：父会话不在同组时子会话保持顶层（可达性兜底）", () => {
  const groups = groupSidebarSessions(
    [
      opt("child", { updatedAt: NOW - 1000, spawnedBy: "parent" }),
      opt("parent", { updatedAt: NOW - 30 * DAY_MS }),
    ],
    NOW,
  );
  assert.deepEqual(
    groups.map((g) => [g.labelKey, g.items.map((s) => [s.key, s.depth ?? 0])]),
    [
      ["sidebar.groupToday", [["child", 0]]],
      ["sidebar.groupOlder", [["parent", 0]]],
    ],
    "跨组不嵌套，子会话不丢",
  );
});

test("sidebar grouping：置顶组内同样嵌套；父置顶子不置顶时子留时间组顶层", () => {
  const groups = groupSidebarSessions(
    [
      opt("pinned-parent", { updatedAt: NOW - 1000, pinned: true }),
      opt("pinned-child", { updatedAt: NOW - 2000, pinned: true, spawnedBy: "pinned-parent" }),
      opt("plain-child", { updatedAt: NOW - 3000, spawnedBy: "pinned-parent" }),
    ],
    NOW,
  );
  assert.deepEqual(
    groups.map((g) => [g.labelKey, g.items.map((s) => [s.key, s.depth ?? 0])]),
    [
      ["sidebar.groupPinned", [["pinned-parent", 0], ["pinned-child", 1]]],
      ["sidebar.groupToday", [["plain-child", 0]]],
    ],
  );
});

test("sidebar grouping：自引用 spawnedBy 不产生嵌套（防环）", () => {
  const groups = groupSidebarSessions(
    [opt("self", { updatedAt: NOW - 1000, spawnedBy: "self" })],
    NOW,
  );
  assert.deepEqual(groups[0].items.map((s) => [s.key, s.depth ?? 0]), [["self", 0]]);
});

test("sidebar grouping：多级派生链递归展开，孙会话不丢（可达性回归）", () => {
  const groups = groupSidebarSessions(
    [
      opt("gp", { updatedAt: NOW - 1000 }),
      opt("p", { updatedAt: NOW - 2000, spawnedBy: "gp" }),
      opt("c", { updatedAt: NOW - 3000, spawnedBy: "p" }),
      opt("other", { updatedAt: NOW - 4000 }),
    ],
    NOW,
  );
  assert.deepEqual(
    groups[0].items.map((s) => [s.key, s.depth ?? 0]),
    [
      ["gp", 0],
      ["p", 1],
      ["c", 2],
      ["other", 0],
    ],
    "孙会话须紧随其父，此前单层展开会把 depth≥2 的会话整条丢弃",
  );
});

test("sidebar grouping：谱系互指成环时全部会话保持顶层可达（不死循环不丢项）", () => {
  const groups = groupSidebarSessions(
    [
      opt("a", { updatedAt: NOW - 1000, spawnedBy: "b" }),
      opt("b", { updatedAt: NOW - 2000, spawnedBy: "a" }),
    ],
    NOW,
  );
  assert.deepEqual(groups[0].items.map((s) => [s.key, s.depth ?? 0]), [["a", 0], ["b", 0]]);
});

