// tab-provider-memo.test.ts — T6：分组派生视图记忆化（WeakMap 键控 config 快照对象）
import test from "node:test";
import assert from "node:assert/strict";
import { deriveProviderView } from "./tab-provider.lib.ts";

function snapWith(models: Array<Record<string, unknown>>) {
  return {
    config: {
      models: { providers: { p1: { models } } },
    },
  } as unknown as { config: any };
}

test("deriveProviderView：同一快照对象返回同一派生结果（记忆化命中）", () => {
  const snap = snapWith([{ id: "m1", name: "M1" }]);
  const a = deriveProviderView(snap);
  const b = deriveProviderView(snap);
  assert.equal(a, b, "同快照应命中缓存（对象身份一致）");
  assert.equal(a.groups.length, 1);
  assert.equal(a.totalModels, 1);
});

test("deriveProviderView：不同快照对象独立派生", () => {
  const s1 = snapWith([{ id: "m1", name: "M1" }]);
  const s2 = snapWith([{ id: "m1", name: "M1" }, { id: "m2", name: "M2" }]);
  const a = deriveProviderView(s1);
  const b = deriveProviderView(s2);
  assert.notEqual(a, b);
  assert.equal(a.totalModels, 1);
  assert.equal(b.totalModels, 2);
});
