import assert from "node:assert/strict";
import {
  addOrgGroup,
  assignModelToGroup,
  bucketModelsByOrg,
  emptyModelOrg,
  parseModelOrg,
  pruneModelOrgAssignments,
  removeOrgGroup,
  renameOrgGroup,
  reorderOrgGroups,
  serializeModelOrg,
} from "./model-org.lib.ts";

function testParseRobust() {
  assert.deepEqual(parseModelOrg(null), emptyModelOrg(), "null → 空状态");
  assert.deepEqual(parseModelOrg(""), emptyModelOrg(), "空串 → 空状态");
  assert.deepEqual(parseModelOrg("{not json"), emptyModelOrg(), "畸形 JSON → 空状态");
  assert.deepEqual(parseModelOrg('"str"'), emptyModelOrg(), "非对象 → 空状态");
  // 指派指向不存在的组 → 丢弃；空名组/重复 id → 丢弃
  const org = parseModelOrg(JSON.stringify({
    version: 1,
    groups: [{ id: "g1", name: "工作" }, { id: "g1", name: "重复" }, { id: "g2", name: "  " }],
    assignments: { "a/m1": "g1", "a/m2": "ghost", "a/m3": "" },
  }));
  assert.deepEqual(org.groups, [{ id: "g1", name: "工作" }]);
  assert.deepEqual(org.assignments, { "a/m1": "g1" });
}

function testRoundTrip() {
  const base = emptyModelOrg();
  const r1 = addOrgGroup(base, " 工作 ", "g1");
  const r2 = addOrgGroup(r1.org, "实验", "g2");
  const assigned = assignModelToGroup(r2.org, "moonshot/k2", "g1");
  assert.equal(serializeModelOrg(parseModelOrg(serializeModelOrg(assigned))), serializeModelOrg(assigned));
}

function testAddGroup() {
  const base = emptyModelOrg();
  const noop = addOrgGroup(base, "   ");
  assert.equal(noop.org, base, "空名不加组");
  assert.equal(noop.id, "");
  const r = addOrgGroup(base, " 工作 ", "g1");
  assert.deepEqual(r.org.groups, [{ id: "g1", name: "工作" }], "trim 后入组");
  assert.equal(r.id, "g1");
  assert.notEqual(r.org, base, "不可变更新");
}

function testRenameRemoveGroup() {
  let org = addOrgGroup(emptyModelOrg(), "A", "g1").org;
  org = addOrgGroup(org, "B", "g2").org;
  org = assignModelToGroup(org, "p/m1", "g1");
  org = assignModelToGroup(org, "p/m2", "g2");

  assert.equal(renameOrgGroup(org, "ghost", "X"), org, "未知组不变");
  assert.equal(renameOrgGroup(org, "g1", "  "), org, "空名不变");
  const renamed = renameOrgGroup(org, "g1", " A2 ");
  assert.deepEqual(renamed.groups[0], { id: "g1", name: "A2" });

  const removed = removeOrgGroup(org, "g1");
  assert.deepEqual(removed.groups.map((g) => g.id), ["g2"]);
  assert.deepEqual(removed.assignments, { "p/m2": "g2" }, "删除组同步清指派");
  assert.equal(removeOrgGroup(org, "ghost"), org, "删未知组不变");
}

function testReorderGroups() {
  let org = addOrgGroup(emptyModelOrg(), "A", "g1").org;
  org = addOrgGroup(org, "B", "g2").org;
  org = addOrgGroup(org, "C", "g3").org;
  const moved = reorderOrgGroups(org, "g3", "g1", "before");
  assert.deepEqual(moved.groups.map((g) => g.id), ["g3", "g1", "g2"]);
  assert.equal(reorderOrgGroups(org, "g1", "g1", "after"), org, "自身忽略");
  const after = reorderOrgGroups(org, "g1", "g3", "after");
  assert.deepEqual(after.groups.map((g) => g.id), ["g2", "g3", "g1"]);
}

function testAssignAndPrune() {
  let org = addOrgGroup(emptyModelOrg(), "A", "g1").org;
  org = assignModelToGroup(org, "p/m1", "g1");
  org = assignModelToGroup(org, "p/m2", "ghost");
  assert.deepEqual(org.assignments, { "p/m1": "g1" }, "指派到不存在的组 = 不指派");
  const unassigned = assignModelToGroup(org, "p/m1", null);
  assert.deepEqual(unassigned.assignments, {}, "null = 取消指派");

  const pruned = pruneModelOrgAssignments(org, ["p/m9"]);
  assert.deepEqual(pruned.assignments, {}, "失效指派被清");
  const kept = pruneModelOrgAssignments(org, ["p/m1"]);
  assert.equal(kept, org, "无失效返回原引用");
}

function testBucketModels() {
  let org = addOrgGroup(emptyModelOrg(), "工作", "g1").org;
  org = addOrgGroup(org, "实验", "g2").org;
  org = assignModelToGroup(org, "p/work", "g1");
  org = assignModelToGroup(org, "p/lab", "g2");
  const models = [
    { key: "p/free1" }, { key: "p/work" }, { key: "p/free2" }, { key: "p/lab" }, { key: "p/free3" },
  ];
  const buckets = bucketModelsByOrg(models, org);
  assert.deepEqual(buckets.map((b) => b.group?.id ?? null), ["g1", "g2", null], "组序 = org 序，未分组收尾");
  assert.deepEqual(buckets[0].models.map((m) => m.key), ["p/work"]);
  assert.deepEqual(buckets[2].models.map((m) => m.key), ["p/free1", "p/free2", "p/free3"], "桶内保持入参顺序");

  // 空桶跳过：g2 无模型时不出现
  const org2 = assignModelToGroup(org, "p/lab", null);
  const buckets2 = bucketModelsByOrg(models, org2);
  assert.deepEqual(buckets2.map((b) => b.group?.id ?? null), ["g1", null]);

  // 无分组：单桶未分组
  const buckets3 = bucketModelsByOrg(models, emptyModelOrg());
  assert.equal(buckets3.length, 1);
  assert.equal(buckets3[0].group, null);
  assert.equal(buckets3[0].models.length, 5);

  // 全部分组且无未分组：不出 null 桶
  const org3 = assignModelToGroup(assignModelToGroup(org2, "p/free1", "g1"), "p/free2", "g1");
  const buckets4 = bucketModelsByOrg(models.slice(0, 3), org3);
  assert.deepEqual(buckets4.map((b) => b.group?.id), ["g1"]);
}

function main() {
  testParseRobust();
  testRoundTrip();
  testAddGroup();
  testRenameRemoveGroup();
  testReorderGroups();
  testAssignAndPrune();
  testBucketModels();
  console.log("model-org lib tests passed");
}

main();
