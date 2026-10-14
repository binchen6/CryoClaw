// 固定工作区纯函数测试（阶段5）：addWorkspace/removeWorkspace/bindSessionToWorkspace/
// splitSessionsByWorkspace 的契约——空工作区恒有 section、脏绑定回落未分组、
// 删除工作区同步清理绑定。
import test from "node:test";
import assert from "node:assert/strict";
import {
  addWorkspace,
  bindSessionToWorkspace,
  removeWorkspace,
  splitSessionsByWorkspace,
} from "./workspace-pinning.ts";
import type { PinnedWorkspace } from "./storage.ts";

type SessionItem = { key: string; label: string; updatedAt?: number };

const ws = (id: string, name = id, path = `/${id}`): PinnedWorkspace => ({
  id,
  name,
  icon: "📁",
  path,
});

const s = (key: string): SessionItem => ({ key, label: key });

test("addWorkspace 追加新工作区；icon 缺省 📁；name/path 为空时原样返回", () => {
  const added = addWorkspace([], { name: "前端", path: "/repo/fe" });
  assert.equal(added.length, 1);
  assert.equal(added[0].name, "前端");
  assert.equal(added[0].icon, "📁");
  assert.ok(added[0].id.startsWith("ws-"));

  const withIcon = addWorkspace([], { name: "x", icon: "🚀", path: "/p" });
  assert.equal(withIcon[0].icon, "🚀");

  const before: PinnedWorkspace[] = [ws("a")];
  assert.deepEqual(addWorkspace(before, { name: "", path: "/p" }), before);
  assert.deepEqual(addWorkspace(before, { name: "n", path: "  " }), before);
});

test("removeWorkspace 删除工作区并丢弃其全部会话绑定", () => {
  const list = [ws("a"), ws("b")];
  const map = { s1: "a", s2: "b", s3: "a" };
  const { workspaces, map: nextMap } = removeWorkspace(list, map, "a");
  assert.deepEqual(workspaces.map((w) => w.id), ["b"]);
  assert.deepEqual(nextMap, { s2: "b" });
});

test("bindSessionToWorkspace 绑定与解绑（null 解绑），不改动原 map", () => {
  const map = { s1: "a" };
  const bound = bindSessionToWorkspace(map, "s2", "b");
  assert.deepEqual(bound, { s1: "a", s2: "b" });
  assert.deepEqual(map, { s1: "a" });
  const unbound = bindSessionToWorkspace(bound, "s1", null);
  assert.deepEqual(unbound, { s2: "b" });
});

test("splitSessionsByWorkspace：绑定会话进对应 section（顺序=工作区顺序），空工作区恒有 section", () => {
  const list = [ws("a"), ws("b"), ws("empty")];
  const sessions = [s("s1"), s("s2"), s("s3"), s("s4")];
  const map = { s2: "b", s1: "a", s3: "a" };
  const { sections, unbound } = splitSessionsByWorkspace(sessions, list, map);
  assert.deepEqual(sections.map((sec) => sec.workspace.id), ["a", "b", "empty"]);
  assert.deepEqual(sections[0].items.map((x) => x.key), ["s1", "s3"]);
  assert.deepEqual(sections[1].items.map((x) => x.key), ["s2"]);
  assert.deepEqual(sections[2].items, []);
  assert.deepEqual(unbound.map((x) => x.key), ["s4"]);
});

test("splitSessionsByWorkspace：绑定到不存在的工作区 id 视为未绑定（脏数据兜底）", () => {
  const { sections, unbound } = splitSessionsByWorkspace(
    [s("s1")],
    [ws("a")],
    { s1: "ghost" },
  );
  assert.deepEqual(sections[0].items, []);
  assert.deepEqual(unbound.map((x) => x.key), ["s1"]);
});
