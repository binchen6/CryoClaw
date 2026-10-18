import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  MAX_CHANGE_STAT_PATHS,
  clampDiffPaths,
  collectRepoChanges,
  computeGitChangeStats,
  countUntrackedFileLines,
  matchChangePath,
  parseNumstatZ,
  sanitizeChangeStatPaths,
  type ChangeStatsDeps,
  type ChangeStatsRunGit,
  type RepoChange,
} from "./git-change-stats.ts";
import type { GitRunResult } from "./git-run.ts";

function gitResult(stdout = "", code = 0, stderr = "", truncated = false): GitRunResult {
  return { code, stdout, stderr, truncated };
}

/** 按 git 参数组装假 runner（未预期调用直接抛错，避免静默通过） */
function fakeRunner(
  handler: (args: string[]) => GitRunResult,
): { run: ChangeStatsRunGit; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args) => {
      calls.push(args);
      return handler(args);
    },
  };
}

// ── sanitizeChangeStatPaths ─────────────────────────────────────────

test("入参校验：合法路径去空去重并保留原始写法", () => {
  assert.deepEqual(
    sanitizeChangeStatPaths(["src/a.ts", " src/b.ts ", "", "src/a.ts", "src\\c.ts"]),
    { paths: ["src/a.ts", "src/b.ts", "src\\c.ts"], truncated: false },
  );
});

test("入参校验：非数组 / 非字符串 / NUL 路径一律拒绝", () => {
  assert.equal(sanitizeChangeStatPaths("src/a.ts"), null);
  assert.equal(sanitizeChangeStatPaths([1]), null);
  assert.equal(sanitizeChangeStatPaths(["a\0b"]), null);
});

test("入参校验：超过数量上限截断并标记 truncated", () => {
  const many = Array.from({ length: MAX_CHANGE_STAT_PATHS + 3 }, (_, i) => `f${i}.ts`);
  const res = sanitizeChangeStatPaths(many);
  assert.ok(res);
  assert.equal(res.paths.length, MAX_CHANGE_STAT_PATHS);
  assert.equal(res.truncated, true);
});

// ── parseNumstatZ ───────────────────────────────────────────────────

test("numstat -z：普通记录 / 二进制 / 含空格路径", () => {
  const out = "3\t1\tsrc/a.ts\0-\t-\tassets/logo.png\0" + "7\t0\tsrc/with space.ts\0";
  assert.deepEqual(parseNumstatZ(out), [
    { path: "src/a.ts", additions: 3, deletions: 1, binary: false },
    { path: "assets/logo.png", additions: 0, deletions: 0, binary: true },
    { path: "src/with space.ts", additions: 7, deletions: 0, binary: false },
  ]);
});

test("numstat -z：rename 双路径记录（old 在前 new 在后）", () => {
  const out = "2\t1\t\0src/old.ts\0src/new.ts\0";
  assert.deepEqual(parseNumstatZ(out), [
    { path: "src/new.ts", origPath: "src/old.ts", additions: 2, deletions: 1, binary: false },
  ]);
});

test("numstat -z：空输出与噪声段容错", () => {
  assert.deepEqual(parseNumstatZ(""), []);
  assert.deepEqual(parseNumstatZ("\0\0garbage\0"), []);
});

// ── 路径匹配 ───────────────────────────────────────────────────────

const changes: RepoChange[] = [
  { kind: "tracked", repoPath: "src/a.ts" },
  { kind: "renamed", repoPath: "dst/renamed.ts", origPath: "src/old.ts" },
  { kind: "tracked", repoPath: "web/src/a.ts" },
  { kind: "untracked", repoPath: "notes.txt" },
];

const repoRoot = path.resolve("fake-repo-root");

test("匹配：仓库相对路径精确命中", () => {
  const hit = matchChangePath("src/a.ts", repoRoot, repoRoot, changes);
  assert.equal(hit?.repoPath, "src/a.ts");
});

test("匹配：Windows 反斜杠相对路径等价", () => {
  const hit = matchChangePath("src\\a.ts", repoRoot, repoRoot, changes);
  assert.equal(hit?.repoPath, "src/a.ts");
});

test("匹配：绝对路径按 repoRoot / cwd 归一（cwd 可为子目录）", () => {
  const subdirCwd = path.join(repoRoot, "packages", "app");
  const abs = path.join(subdirCwd, "src", "a.ts");
  const repoChanges: RepoChange[] = [{ kind: "tracked", repoPath: "packages/app/src/a.ts" }];
  const hit = matchChangePath(abs, subdirCwd, repoRoot, repoChanges);
  assert.equal(hit?.repoPath, "packages/app/src/a.ts");
});

test("匹配：最长后缀优先（绝对路径跨仓库根时取更具体的改动项）", () => {
  const hit = matchChangePath("C:/work/web/src/a.ts", "C:/work", "C:/work", changes);
  assert.equal(hit?.repoPath, "web/src/a.ts");
});

test("匹配：rename 的源路径也能命中（返回 rename 改动项）", () => {
  const hit = matchChangePath("src/old.ts", repoRoot, repoRoot, changes);
  assert.equal(hit?.repoPath, "dst/renamed.ts");
  assert.equal(hit?.kind, "renamed");
});

test("匹配：未收录路径返回 null（渲染层退回文件数）", () => {
  assert.equal(matchChangePath("other/zzz.ts", repoRoot, repoRoot, changes), null);
});

test("collectRepoChanges：忽略 ignored 条目并保留 rename 源路径", () => {
  const list = collectRepoChanges([
    { kind: "tracked", path: "src/a.ts", index: ".", worktree: "M" },
    { kind: "renamed", path: "dst/b.ts", origPath: "src/b.ts", index: "R", worktree: "." },
    { kind: "ignored", path: "dist/bundle.js", index: "!", worktree: "!" },
    { kind: "untracked", path: "new.txt", index: "?", worktree: "?" },
  ]);
  assert.deepEqual(list, [
    { kind: "tracked", repoPath: "src/a.ts" },
    { kind: "renamed", repoPath: "dst/b.ts", origPath: "src/b.ts" },
    { kind: "untracked", repoPath: "new.txt" },
  ]);
});

// ── argv 截断 ──────────────────────────────────────────────────────

test("clampDiffPaths：去重、超长截断标记", () => {
  assert.deepEqual(clampDiffPaths(["a.ts", "b.ts", "a.ts"]), {
    paths: ["a.ts", "b.ts"],
    truncated: false,
  });
  const clamped = clampDiffPaths(["aaaa.ts", "bbbb.ts"], 8);
  assert.deepEqual(clamped, { paths: ["aaaa.ts"], truncated: true });
});

// ── 未跟踪文件行数 ─────────────────────────────────────────────────

function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-gitstat-"));
  return run(dir).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test("未跟踪文件：文本按行数计（含最后一行无换行）", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "one\ntwo\nthree");
    const res = await countUntrackedFileLines(file);
    assert.equal(res?.additions, 3);
    assert.equal(res?.binary, false);
    fs.writeFileSync(file, "one\r\ntwo\r\n");
    assert.equal((await countUntrackedFileLines(file))?.additions, 2);
  });
});

test("未跟踪文件：空文件 0 行；含 NUL 视为二进制", async () => {
  await withTempDir(async (dir) => {
    const empty = path.join(dir, "empty.txt");
    fs.writeFileSync(empty, "");
    assert.equal((await countUntrackedFileLines(empty))?.additions, 0);
    const binary = path.join(dir, "bin.dat");
    fs.writeFileSync(binary, Buffer.from([0x61, 0x00, 0x62]));
    const res = await countUntrackedFileLines(binary);
    assert.equal(res?.binary, true);
    assert.equal(res?.additions, 0);
  });
});

test("未跟踪文件：超过大小上限按二进制处理；缺失文件返回 null", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "big.txt");
    fs.writeFileSync(file, "0123456789");
    const res = await countUntrackedFileLines(file, 4);
    assert.equal(res?.binary, true);
    assert.equal(res?.additions, 0);
    assert.equal(await countUntrackedFileLines(path.join(dir, "missing.txt")), null);
  });
});

// ── computeGitChangeStats ──────────────────────────────────────────

const STATUS_MIXED = [
  "1 .M N... 100644 100644 100644 aaa bbb src/a.ts\0",
  "2 R. N... 100644 100644 100644 ccc ddd R100 dst/renamed.ts\0src/old.ts\0",
  "? new.txt\0",
].join("");

function baseDeps(handler: (args: string[]) => GitRunResult, extra?: Partial<ChangeStatsDeps>) {
  const fake = fakeRunner(handler);
  return {
    calls: fake.calls,
    deps: {
      runGit: fake.run,
      readUntrackedFile: async (absolutePath: string) =>
        absolutePath.endsWith("new.txt")
          ? { additions: 5, binary: false, bytes: 20 }
          : null,
      ...extra,
    } satisfies ChangeStatsDeps,
  };
}

test("统计：tracked / renamed / 未跟踪一次请求全部返回", async () => {
  const { deps } = baseDeps((args) => {
    if (args[0] === "rev-parse") return gitResult("C:/repo\n");
    if (args[0] === "status") return gitResult(STATUS_MIXED);
    if (args[0] === "diff") {
      assert.deepEqual(args.slice(0, 5), ["diff", "HEAD", "--numstat", "-z", "--"]);
      assert.deepEqual(args.slice(5), ["src/a.ts", "dst/renamed.ts", "src/old.ts"]);
      return gitResult("2\t1\tsrc/a.ts\0" + "2\t3\t\0src/old.ts\0dst/renamed.ts\0");
    }
    throw new Error(`unexpected args: ${args.join(" ")}`);
  });
  const outcome = await computeGitChangeStats(
    "C:/repo",
    ["src/a.ts", "dst/renamed.ts", "new.txt"],
    deps,
  );
  assert.deepEqual(outcome, {
    ok: true,
    data: {
      stats: [
        { path: "src/a.ts", additions: 2, deletions: 1 },
        { path: "dst/renamed.ts", additions: 2, deletions: 3 },
        { path: "new.txt", additions: 5, deletions: 0 },
      ],
    },
  });
});

test("统计：rename 未被识别时旧路径删除 + 新路径新增合计", async () => {
  const { deps } = baseDeps((args) => {
    if (args[0] === "rev-parse") return gitResult("C:/repo\n");
    if (args[0] === "status") return gitResult(STATUS_MIXED);
    if (args[0] === "diff") {
      return gitResult("6\t0\tdst/renamed.ts\0" + "0\t4\tsrc/old.ts\0");
    }
    throw new Error(`unexpected args: ${args.join(" ")}`);
  });
  const outcome = await computeGitChangeStats("C:/repo", ["dst/renamed.ts"], deps);
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.data.stats, [
    { path: "dst/renamed.ts", additions: 6, deletions: 4 },
  ]);
});

test("统计：二进制文件标记 binary 且不计行数", async () => {
  const status = "1 .M N... 100644 100644 100644 aaa bbb assets/logo.png\0";
  const { deps } = baseDeps((args) => {
    if (args[0] === "rev-parse") return gitResult("C:/repo\n");
    if (args[0] === "status") return gitResult(status);
    if (args[0] === "diff") return gitResult("-\t-\tassets/logo.png\0");
    throw new Error(`unexpected args: ${args.join(" ")}`);
  });
  const outcome = await computeGitChangeStats("C:/repo", ["assets/logo.png"], deps);
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.data.stats, [
    { path: "assets/logo.png", additions: 0, deletions: 0, binary: true },
  ]);
});

test("统计：非 git 仓库返回 not-a-repo", async () => {
  const { deps } = baseDeps(() =>
    gitResult("", 128, "fatal: not a git repository (or any of the parent directories): .git\n"),
  );
  const outcome = await computeGitChangeStats("C:/repo", ["src/a.ts"], deps);
  assert.deepEqual(outcome, { ok: false, error: "not-a-repo" });
});

test("统计：空仓库（unborn HEAD）退回 --cached 统计", async () => {
  const status = "1 A. N... 000000 100644 100644 aaa bbb new-tracked.ts\0";
  const diffCalls: string[][] = [];
  const { deps } = baseDeps((args) => {
    if (args[0] === "rev-parse") return gitResult("C:/repo\n");
    if (args[0] === "status") return gitResult(status);
    if (args[0] === "diff") {
      diffCalls.push(args);
      if (args[1] === "HEAD") {
        return gitResult(
          "",
          128,
          "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.\n",
        );
      }
      return gitResult("3\t0\tnew-tracked.ts\0");
    }
    throw new Error(`unexpected args: ${args.join(" ")}`);
  });
  const outcome = await computeGitChangeStats("C:/repo", ["new-tracked.ts"], deps);
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.data.stats, [
    { path: "new-tracked.ts", additions: 3, deletions: 0 },
  ]);
  assert.equal(diffCalls.length, 2);
  assert.deepEqual(diffCalls[1].slice(0, 2), ["diff", "--cached"]);
});

test("统计：未跟踪读取超预算 → truncated（渲染层退回文件数）", async () => {
  const status = "? a.txt\0? b.txt\0";
  const { deps } = baseDeps(
    (args) => {
      if (args[0] === "rev-parse") return gitResult("C:/repo\n");
      if (args[0] === "status") return gitResult(status);
      throw new Error(`unexpected args: ${args.join(" ")}`);
    },
    {
      maxUntrackedTotalBytes: 5,
      readUntrackedFile: async () => ({ additions: 2, binary: false, bytes: 50 }),
    },
  );
  const outcome = await computeGitChangeStats("C:/repo", ["a.txt", "b.txt"], deps);
  assert.ok(outcome.ok);
  assert.equal(outcome.data.truncated, true);
  assert.deepEqual(outcome.data.stats, [{ path: "a.txt", additions: 2, deletions: 0 }]);
});

test("统计：未匹配到任何改动时返回空 stats（静默降级）", async () => {
  const { deps, calls } = baseDeps((args) => {
    if (args[0] === "rev-parse") return gitResult("C:/repo\n");
    if (args[0] === "status") return gitResult(STATUS_MIXED);
    throw new Error(`unexpected args: ${args.join(" ")}`);
  });
  const outcome = await computeGitChangeStats("C:/repo", ["nowhere/zzz.ts"], deps);
  assert.deepEqual(outcome, { ok: true, data: { stats: [] } });
  // 没有任何匹配就不跑 diff
  assert.equal(calls.some((args) => args[0] === "diff"), false);
});

test("统计：非法入参返回 invalid-input（不触碰 git）", async () => {
  let called = false;
  const { deps } = baseDeps(() => {
    called = true;
    return gitResult();
  });
  assert.deepEqual(await computeGitChangeStats("C:/repo", "not-an-array", deps), {
    ok: false,
    error: "invalid-input",
  });
  assert.equal(called, false);
});

// ── 接线守护（源码审计，防止 IPC/preload 漏配） ────────────────────

test("接线：git-ipc 注册 git:change-stats 并复用 guardGitOp 白名单", () => {
  // 编译产物在 <root>/.test-dist*/，源码在 <root>/src/（与 run-node-tests 的 outDir 约定一致）
  const source = fs.readFileSync(path.join(__dirname, "../src/git-ipc.ts"), "utf8");
  assert.match(source, /ipcMain\.handle\("git:change-stats"/);
  assert.match(source, /guardGitOp\(event, "git:change-stats", cwd\)/);
  assert.match(source, /computeGitChangeStats\(g\.dir, rawPaths/);
});

test("接线：preload 暴露 gitChangeStats 方法", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/preload.ts"), "utf8");
  assert.match(source, /gitChangeStats: \(cwd: string, paths: string\[\]\)/);
  assert.match(source, /ipcRenderer\.invoke\("git:change-stats", cwd, paths\)/);
});
