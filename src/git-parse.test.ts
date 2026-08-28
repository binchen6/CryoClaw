import test from "node:test";
import assert from "node:assert/strict";
import {
  diffFileDisplayPath,
  isNotARepoError,
  isStagedEntry,
  isUnstagedEntry,
  normalizeCommitMessage,
  parsePorcelainV2Status,
  parseUnifiedDiff,
  sanitizeGitRelPaths,
  unquoteGitPath,
  type GitStatusEntry,
} from "./git-parse.ts";

// ── porcelain v2 status ─────────────────────────────────────────────

test("porcelain v2：branch header 完整解析（oid/head/upstream/ahead/behind）", () => {
  const out =
    "# branch.oid 8e5f3c1a2b3c\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n\0";
  const res = parsePorcelainV2Status(out);
  assert.deepEqual(res.branch, {
    oid: "8e5f3c1a2b3c",
    head: "main",
    upstream: "origin/main",
    ahead: 2,
    behind: 1,
  });
  assert.deepEqual(res.entries, []);
});

test("porcelain v2：空仓库（initial oid、无 upstream/ab）", () => {
  const out = "# branch.oid (initial)\n# branch.head main\n\0";
  const res = parsePorcelainV2Status(out);
  assert.equal(res.branch.oid, null);
  assert.equal(res.branch.head, "main");
  assert.equal(res.branch.upstream, null);
  assert.equal(res.branch.ahead, 0);
});

test("porcelain v2：detached HEAD", () => {
  const out = "# branch.oid abc123\n# branch.head (detached)\n\0";
  const res = parsePorcelainV2Status(out);
  assert.equal(res.branch.head, "(detached)");
});

test("porcelain v2：modified/added/deleted 条目（-z NUL 分隔）", () => {
  const out = [
    "# branch.oid abc",
    "# branch.head main",
    "",
  ].join("\n") + "\0"
    + "1 .M N... 100644 100644 100644 aaa bbb src/mod.ts\0"
    + "1 A. N... 000000 100644 100644 000 ccc src/added.ts\0"
    + "1 .D N... 100644 100644 000000 ddd 000 src/del.ts\0"
    + "1 MM N... 100644 100644 100644 eee fff src/both.ts\0";
  const res = parsePorcelainV2Status(out);
  assert.equal(res.entries.length, 4);
  assert.deepEqual(res.entries[0], { kind: "tracked", index: ".", worktree: "M", path: "src/mod.ts" });
  assert.deepEqual(res.entries[1], { kind: "tracked", index: "A", worktree: ".", path: "src/added.ts" });
  assert.deepEqual(res.entries[2], { kind: "tracked", index: ".", worktree: "D", path: "src/del.ts" });
  // MM：同时出现在 staged 与 unstaged
  assert.ok(isStagedEntry(res.entries[3]));
  assert.ok(isUnstagedEntry(res.entries[3]));
  assert.ok(!isStagedEntry(res.entries[0]));
  assert.ok(isUnstagedEntry(res.entries[0]));
});

test("porcelain v2：rename 条目（-z 下源路径占下一个 NUL 段，顺序为 to\\0from）", () => {
  const out = "# branch.oid abc\n# branch.head main\n\0"
    + "2 R. N... 100644 100644 100644 aaa bbb R100 src/new-name.ts\0src/old-name.ts\0";
  const res = parsePorcelainV2Status(out);
  assert.equal(res.entries.length, 1);
  assert.deepEqual(res.entries[0], {
    kind: "renamed",
    index: "R",
    worktree: ".",
    path: "src/new-name.ts",
    origPath: "src/old-name.ts",
  });
  assert.ok(isStagedEntry(res.entries[0]));
});

test("porcelain v2：untracked / ignored / unmerged", () => {
  const out = "# branch.oid abc\n# branch.head main\n\0"
    + "? 新增文件.txt\0"
    + "! build/output.log\0"
    + "u UU N... 100644 100644 100644 100644 h1 h2 h3 conflicted.ts\0";
  const res = parsePorcelainV2Status(out);
  assert.deepEqual(res.entries[0], { kind: "untracked", index: "?", worktree: "?", path: "新增文件.txt" });
  assert.deepEqual(res.entries[1], { kind: "ignored", index: "!", worktree: "!", path: "build/output.log" });
  assert.equal(res.entries[2].kind, "unmerged");
  assert.equal(res.entries[2].path, "conflicted.ts");
  // unmerged 归 unstaged 组，不进 staged 组
  assert.ok(isUnstagedEntry(res.entries[2]));
  assert.ok(!isStagedEntry(res.entries[2]));
});

test("porcelain v2：-z 模式下中文路径不转义（原文保留）", () => {
  const out = "# branch.oid abc\n# branch.head main\n\0"
    + "1 .M N... 100644 100644 100644 aaa bbb 文档/设计 稿.md\0";
  const res = parsePorcelainV2Status(out);
  assert.equal(res.entries[0].path, "文档/设计 稿.md");
});

test("porcelain v2：容错（空输出 / 未知行跳过）", () => {
  assert.deepEqual(parsePorcelainV2Status(""), { branch: { head: null, oid: null, upstream: null, ahead: 0, behind: 0 }, entries: [] });
  const res = parsePorcelainV2Status("garbage line\0# branch.head dev\n\0");
  assert.equal(res.branch.head, "dev");
  assert.equal(res.entries.length, 0);
});

// ── C 引用路径反转义 ─────────────────────────────────────────────────

test("unquoteGitPath：普通路径原样返回", () => {
  assert.equal(unquoteGitPath("src/a.ts"), "src/a.ts");
  assert.equal(unquoteGitPath("a/src/a.ts"), "a/src/a.ts");
});

test("unquoteGitPath：八进制转义的中文路径（\\303\\244 等）按 UTF-8 重组", () => {
  // "中" = E4 B8 AD → \344\270\255
  assert.equal(unquoteGitPath('"a/\\344\\270\\255\\346\\226\\207.ts"'), "a/中文.ts");
  assert.equal(unquoteGitPath('"\\303\\244.txt"'), "ä.txt");
});

test("unquoteGitPath：转义符号（\\\\ \\\" \\n \\t）", () => {
  assert.equal(unquoteGitPath('"a\\\\b"'), "a\\b");
  assert.equal(unquoteGitPath('"say \\"hi\\""'), 'say "hi"');
  assert.equal(unquoteGitPath('"a\\tb"'), "a\tb");
});

// ── unified diff ─────────────────────────────────────────────────────

test("unified diff：多文件 + context/added/removed 行", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,4 @@ export function a()",
    " const x = 1;",
    "-const y = 2;",
    "+const y = 3;",
    "+const z = 4;",
    "diff --git a/src/b.ts b/src/b.ts",
    "index 333..444 100644",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -10,1 +10,1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");
  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 2);
  assert.equal(files[0].oldPath, "src/a.ts");
  assert.equal(files[0].newPath, "src/a.ts");
  assert.equal(files[0].hunks.length, 1);
  assert.equal(files[0].hunks[0].header, "@@ -1,3 +1,4 @@ export function a()");
  assert.deepEqual(
    files[0].hunks[0].lines.map((l) => [l.kind, l.text]),
    [
      ["context", "const x = 1;"],
      ["removed", "const y = 2;"],
      ["added", "const y = 3;"],
      ["added", "const z = 4;"],
    ],
  );
  assert.equal(files[1].hunks[0].oldStart, 10);
  assert.equal(files[1].hunks[0].newLines, 1);
});

test("unified diff：rename（similarity + rename from/to）", () => {
  const diff = [
    "diff --git a/old.ts b/new.ts",
    "similarity index 92%",
    "rename from old.ts",
    "rename to new.ts",
    "index 111..222 100644",
    "--- a/old.ts",
    "+++ b/new.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "",
  ].join("\n");
  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 1);
  assert.ok(files[0].isRename);
  assert.equal(files[0].oldPath, "old.ts");
  assert.equal(files[0].newPath, "new.ts");
});

test("unified diff：二进制文件（Binary files ... differ，无 hunk）", () => {
  const diff = [
    "diff --git a/assets/logo.png b/assets/logo.png",
    "index 111..222 100644",
    "Binary files a/assets/logo.png and b/assets/logo.png differ",
    "",
  ].join("\n");
  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 1);
  assert.ok(files[0].isBinary);
  assert.equal(files[0].hunks.length, 0);
  assert.equal(diffFileDisplayPath(files[0]), "assets/logo.png");
});

test("unified diff：新文件 / 删除文件（/dev/null 端）", () => {
  const added = [
    "diff --git a/new.ts b/new.ts",
    "new file mode 100644",
    "index 000..111",
    "--- /dev/null",
    "+++ b/new.ts",
    "@@ -0,0 +1,2 @@",
    "+line1",
    "+line2",
    "",
  ].join("\n");
  const filesA = parseUnifiedDiff(added);
  assert.ok(filesA[0].isNew);
  assert.equal(filesA[0].oldPath, null);
  assert.equal(filesA[0].newPath, "new.ts");

  const deleted = [
    "diff --git a/gone.ts b/gone.ts",
    "deleted file mode 100644",
    "index 111..000",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "",
  ].join("\n");
  const filesD = parseUnifiedDiff(deleted);
  assert.ok(filesD[0].isDeleted);
  assert.equal(filesD[0].newPath, null);
  assert.equal(diffFileDisplayPath(filesD[0]), "gone.ts");
});

test("unified diff：quoted 中文路径（diff --git 与 ---/+++ 均转义）", () => {
  const diff = [
    'diff --git "a/\\346\\226\\207\\346\\241\\243.md" "b/\\346\\226\\207\\346\\241\\243.md"',
    "index 111..222 100644",
    '--- "a/\\346\\226\\207\\346\\241\\243.md"',
    '+++ "b/\\346\\226\\207\\346\\241\\243.md"',
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");
  const files = parseUnifiedDiff(diff);
  assert.equal(files[0].oldPath, "文档.md");
  assert.equal(files[0].newPath, "文档.md");
});

test("unified diff：\\ No newline at end of file 挂到上一条内容行", () => {
  const diff = [
    "diff --git a/a.txt b/a.txt",
    "index 111..222 100644",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-tail",
    "\\ No newline at end of file",
    "+tail2",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  const files = parseUnifiedDiff(diff);
  const lines = files[0].hunks[0].lines;
  assert.equal(lines.length, 2);
  assert.ok(lines[0].noNewlineAfter);
  assert.equal(lines[0].kind, "removed");
  assert.ok(lines[1].noNewlineAfter);
  assert.equal(lines[1].kind, "added");
});

test("unified diff：空 diff / 纯噪声输入 → 空数组", () => {
  assert.deepEqual(parseUnifiedDiff(""), []);
  assert.deepEqual(parseUnifiedDiff("\n\n"), []);
  assert.deepEqual(parseUnifiedDiff("warning: something\n"), []);
});

// ── IPC 入参校验 ─────────────────────────────────────────────────────

test("sanitizeGitRelPaths：合法相对路径原样返回（含中文/子目录）", () => {
  assert.deepEqual(sanitizeGitRelPaths(["src/a.ts", "文档/设计.md"]), ["src/a.ts", "文档/设计.md"]);
});

test("sanitizeGitRelPaths：拒绝绝对路径 / .. 逃逸 / NUL / 空 / 非数组", () => {
  assert.equal(sanitizeGitRelPaths(["/etc/passwd"]), null);
  assert.equal(sanitizeGitRelPaths(["C:\\Windows\\x"]), null);
  assert.equal(sanitizeGitRelPaths(["../outside.ts"]), null);
  assert.equal(sanitizeGitRelPaths(["a/../../b"]), null);
  assert.equal(sanitizeGitRelPaths(["a\0b"]), null);
  assert.equal(sanitizeGitRelPaths([]), null);
  assert.equal(sanitizeGitRelPaths("src/a.ts"), null);
  assert.equal(sanitizeGitRelPaths([""]), null);
  assert.equal(sanitizeGitRelPaths(new Array(501).fill("a")), null);
});

test("normalizeCommitMessage：trim 后非空、上限 10_000", () => {
  assert.equal(normalizeCommitMessage("  fix: thing  "), "fix: thing");
  assert.equal(normalizeCommitMessage(""), null);
  assert.equal(normalizeCommitMessage("   \n  "), null);
  assert.equal(normalizeCommitMessage(42), null);
  assert.equal(normalizeCommitMessage("x".repeat(10_001)), null);
});

test("isNotARepoError：识别 git 128 的典型 stderr", () => {
  assert.ok(isNotARepoError("fatal: not a git repository (or any of the parent directories): .git"));
  assert.ok(!isNotARepoError("fatal: pathspec 'x' did not match any files"));
});

// staged/unstaged 分类边界（ignored/untracked 不进任何组）
test("isStagedEntry/isUnstagedEntry：untracked 与 ignored 不进 staged/unstaged 组", () => {
  const untracked: GitStatusEntry = { kind: "untracked", index: "?", worktree: "?", path: "x" };
  const ignored: GitStatusEntry = { kind: "ignored", index: "!", worktree: "!", path: "y" };
  assert.ok(!isStagedEntry(untracked) && !isUnstagedEntry(untracked));
  assert.ok(!isStagedEntry(ignored) && !isUnstagedEntry(ignored));
});
