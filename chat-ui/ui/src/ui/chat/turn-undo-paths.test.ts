import test from "node:test";
import assert from "node:assert/strict";

import { toRepoRelativePath, partitionUndoPaths } from "./turn-undo-paths.ts";
import type { FileChange } from "./file-changes.ts";

function file(path: string, kind: FileChange["kind"] = "modified"): FileChange {
  return { path, kind };
}

// ── toRepoRelativePath ──

test("相对路径原样返回（含 ./ 前缀剥离）", () => {
  assert.equal(toRepoRelativePath("src/a.ts", "C:\\ws"), "src/a.ts");
  assert.equal(toRepoRelativePath("./src/a.ts", "C:\\ws"), "src/a.ts");
  assert.equal(toRepoRelativePath("文档/设计.md", "/ws"), "文档/设计.md");
});

test("工作区内的绝对路径转相对（Windows 反斜杠 + 盘符大小写不敏感）", () => {
  assert.equal(toRepoRelativePath("C:\\ws\\src\\a.ts", "C:\\ws"), "src/a.ts");
  assert.equal(toRepoRelativePath("C:\\WS\\src\\a.ts", "c:\\ws"), "src/a.ts");
  assert.equal(toRepoRelativePath("C:/ws/src/a.ts", "C:\\ws\\"), "src/a.ts");
  assert.equal(toRepoRelativePath("/ws/src/a.ts", "/ws"), "src/a.ts");
});

test("工作区外 / 逃逸 / 空路径返回 null", () => {
  assert.equal(toRepoRelativePath("C:\\other\\a.ts", "C:\\ws"), null);
  assert.equal(toRepoRelativePath("../outside.ts", "C:\\ws"), null);
  assert.equal(toRepoRelativePath("a/../../b", "C:\\ws"), null);
  assert.equal(toRepoRelativePath("", "C:\\ws"), null);
  assert.equal(toRepoRelativePath("C:\\ws", "C:\\ws"), null, "工作区根本身不是文件");
});

// ── partitionUndoPaths ──

test("按未跟踪集合分流 discard / clean，工作区外进 skipped", () => {
  const files = [
    file("src/a.ts", "modified"),
    file("C:\\ws\\src\\new.ts", "added"),
    file("docs/b.md", "modified"),
    file("C:\\outside\\c.ts", "modified"),
  ];
  const partition = partitionUndoPaths(files, "C:\\ws", new Set(["src/new.ts"]));
  assert.deepEqual(partition.discard, ["src/a.ts", "docs/b.md"]);
  assert.deepEqual(partition.clean, ["src/new.ts"]);
  assert.deepEqual(partition.skipped, ["C:\\outside\\c.ts"]);
});

test("空列表/空未跟踪集合：全部走 discard", () => {
  const partition = partitionUndoPaths([file("a.ts")], "C:\\ws", new Set());
  assert.deepEqual(partition.discard, ["a.ts"]);
  assert.deepEqual(partition.clean, []);
  assert.deepEqual(partition.skipped, []);
});
