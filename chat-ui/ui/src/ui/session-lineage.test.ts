import test from "node:test";
import assert from "node:assert/strict";
import { collectSessionLineageKeys, findActiveLineageSessions } from "./session-lineage.ts";
import type { GatewaySessionRow } from "./types.ts";

const rows: GatewaySessionRow[] = [
  { key: "root" },
  { key: "child-a", spawnedBy: "root", status: "done" },
  { key: "child-b", controlOwnerSessionKey: "root", status: "running" },
  { key: "grandchild", spawnedBy: "child-a", status: "done" },
  { key: "other" },
];

test("session lineage：按 spawnedBy/controlOwnerSessionKey 递归收集且不含旁支", () => {
  assert.deepEqual(collectSessionLineageKeys(rows, "root"), ["root", "child-a", "grandchild", "child-b"]);
  assert.deepEqual(collectSessionLineageKeys(rows, "child-a"), ["child-a", "grandchild"]);
  assert.deepEqual(collectSessionLineageKeys(rows, "other"), ["other"]);
});

test("session lineage：谱系成环不递归溢出且每项只出现一次", () => {
  const cyclic: GatewaySessionRow[] = [
    { key: "a", spawnedBy: "b" },
    { key: "b", spawnedBy: "a" },
  ];
  assert.deepEqual(collectSessionLineageKeys(cyclic, "a"), ["a", "b"]);
});

test("session lineage：任一后代活跃都阻止整组删除", () => {
  assert.deepEqual(findActiveLineageSessions(rows, "root").map((row) => row.key), ["child-b"]);
  assert.deepEqual(findActiveLineageSessions(rows, "child-a"), []);
});
