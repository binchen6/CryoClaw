import test from "node:test";
import assert from "node:assert/strict";

import { collectGroupFileChanges, computeSessionFileChanges } from "./file-changes.ts";
import type { MessageGroup } from "../types/chat-types.ts";

function toolCall(name: string, args: unknown): unknown {
  return { role: "assistant", content: [{ type: "toolcall", name, arguments: args }] };
}

function group(key: string, messages: unknown[]): MessageGroup {
  return {
    kind: "group",
    key,
    role: "assistant",
    messages: messages.map((message, i) => ({ message, key: `${key}:${i}` })),
    timestamp: 0,
    isStreaming: false,
  };
}

// ── collectGroupFileChanges ──

test("file changes：write 到新路径判 added", () => {
  const touched = new Set<string>();
  const changes = collectGroupFileChanges(
    [toolCall("write", { path: "src/new.ts" })],
    touched,
  );
  assert.deepEqual(changes, [{ path: "src/new.ts", kind: "added" }]);
});

test("file changes：同会话先 read 再 write 判 modified", () => {
  const touched = new Set<string>();
  collectGroupFileChanges([toolCall("read", { path: "src/a.ts" })], touched);
  const changes = collectGroupFileChanges(
    [toolCall("write", { path: "src/a.ts" })],
    touched,
  );
  assert.deepEqual(changes, [{ path: "src/a.ts", kind: "modified" }]);
});

test("file changes：edit 恒判 modified，read 不产生改动", () => {
  const touched = new Set<string>();
  const changes = collectGroupFileChanges(
    [toolCall("read", { path: "src/a.ts" }), toolCall("edit", { path: "src/b.ts" })],
    touched,
  );
  assert.deepEqual(changes, [{ path: "src/b.ts", kind: "modified" }]);
});

test("file changes：兼容 file_path/filePath 参数键", () => {
  const touched = new Set<string>();
  const changes = collectGroupFileChanges(
    [toolCall("write", { file_path: "a.ts" }), toolCall("edit", { filePath: "b.ts" })],
    touched,
  );
  assert.deepEqual(changes, [
    { path: "a.ts", kind: "added" },
    { path: "b.ts", kind: "modified" },
  ]);
});

test("file changes：apply_patch 文本补丁解析增/删/改", () => {
  const touched = new Set<string>();
  const input = [
    "*** Begin Patch",
    "*** Add File: src/added.ts",
    "+hello",
    "*** Delete File: src/old.ts",
    "*** Update File: src/mod.ts",
    "@@",
    "-a",
    "+b",
    "*** End Patch",
  ].join("\n");
  const changes = collectGroupFileChanges([toolCall("apply_patch", { input })], touched);
  assert.deepEqual(changes, [
    { path: "src/added.ts", kind: "added" },
    { path: "src/old.ts", kind: "deleted" },
    { path: "src/mod.ts", kind: "modified" },
  ]);
});

test("file changes：apply_patch Move to 拆成旧删新加", () => {
  const touched = new Set<string>();
  const input = [
    "*** Begin Patch",
    "*** Update File: src/before.ts",
    "*** Move to: src/after.ts",
    "@@",
    "*** End Patch",
  ].join("\n");
  const changes = collectGroupFileChanges([toolCall("apply_patch", { input })], touched);
  assert.deepEqual(changes, [
    { path: "src/before.ts", kind: "deleted" },
    { path: "src/after.ts", kind: "added" },
  ]);
});

test("file changes：apply_patch 结构化 changes 解析", () => {
  const touched = new Set<string>();
  const changes = collectGroupFileChanges(
    [
      toolCall("apply_patch", {
        changes: [
          { path: "a.ts", kind: "add" },
          { path: "b.ts", kind: "delete" },
          { path: "c.ts", kind: "update" },
        ],
      }),
    ],
    touched,
  );
  assert.deepEqual(changes, [
    { path: "a.ts", kind: "added" },
    { path: "b.ts", kind: "deleted" },
    { path: "c.ts", kind: "modified" },
  ]);
});

test("file changes：同组同路径合并，delete 优先", () => {
  const touched = new Set<string>();
  const changes = collectGroupFileChanges(
    [
      toolCall("write", { path: "a.ts" }),
      toolCall("edit", { path: "a.ts" }),
      toolCall("apply_patch", { input: "*** Delete File: a.ts" }),
    ],
    touched,
  );
  assert.deepEqual(changes, [{ path: "a.ts", kind: "deleted" }]);
});

test("file changes：无文件工具时返回空", () => {
  const touched = new Set<string>();
  const changes = collectGroupFileChanges(
    [toolCall("exec", { command: "ls" }), { role: "assistant", content: "hi" }],
    touched,
  );
  assert.deepEqual(changes, []);
});

// ── computeSessionFileChanges ──

test("file changes：跨组 touched 共享，第二组 write 同路径判 modified", () => {
  const groups = [
    group("g1", [toolCall("write", { path: "a.ts" })]),
    group("g2", [toolCall("write", { path: "a.ts" })]),
  ];
  const byGroup = computeSessionFileChanges(groups);
  assert.deepEqual(byGroup.get("g1"), [{ path: "a.ts", kind: "added" }]);
  assert.deepEqual(byGroup.get("g2"), [{ path: "a.ts", kind: "modified" }]);
});

test("file changes：无改动的组不进 Map", () => {
  const groups = [group("g1", [toolCall("exec", { command: "ls" })])];
  const byGroup = computeSessionFileChanges(groups);
  assert.equal(byGroup.size, 0);
});
