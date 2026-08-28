import test from "node:test";
import assert from "node:assert/strict";
import { runGit, type GitRunner } from "./git-run.ts";

const MB = 1024 * 1024;

test("runGit：正常退出透传退出码与输出", async () => {
  const runner: GitRunner = (_args, cb) => cb(null, "out", "");
  const res = await runGit("/tmp", ["status"], 1000, MB, runner);
  assert.deepEqual(res, { code: 0, stdout: "out", stderr: "", truncated: false });

  const failing: GitRunner = (_args, cb) =>
    cb(Object.assign(new Error("exit 128"), { code: 128 }), "", "fatal: boom");
  const res2 = await runGit("/tmp", ["status"], 1000, MB, failing);
  assert.equal(res2.code, 128);
  assert.equal(res2.stderr, "fatal: boom");
  assert.equal(res2.truncated, false);
});

test("runGit：maxBuffer 截断（Node ≥22 字符串 code）→ code 0 + truncated", async () => {
  const runner: GitRunner = (_args, cb) =>
    cb(
      Object.assign(new Error("maxBuffer"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
      "partial",
      "",
    );
  const res = await runGit("/tmp", ["diff"], 1000, MB, runner);
  assert.equal(res.code, 0, "截断按成功处理");
  assert.equal(res.truncated, true);
  assert.equal(res.stdout, "partial");
});

test("runGit：旧版截断 code（ENOBUFS/ERR_OUT_OF_RANGE）兼容", async () => {
  for (const code of ["ENOBUFS", "ERR_OUT_OF_RANGE"]) {
    const runner: GitRunner = (_args, cb) =>
      cb(Object.assign(new Error("x"), { code }), "", "");
    const res = await runGit("/tmp", ["diff"], 1000, MB, runner);
    assert.equal(res.truncated, true, code);
    assert.equal(res.code, 0);
  }
});

test("runGit：err.code 非数字非截断（如信号杀死 code:null）→ 归失败 code 1，不得静默按成功", async () => {
  const runner: GitRunner = (_args, cb) =>
    cb(Object.assign(new Error("killed by signal"), { code: null }), "partial-out", "");
  const res = await runGit("/tmp", ["status"], 1000, MB, runner);
  assert.equal(res.code, 1);
  assert.equal(res.truncated, false);
});

test("runGit：killed（超时）→ reject timeout；ENOENT → reject 原错误", async () => {
  const killed: GitRunner = (_args, cb) =>
    cb(Object.assign(new Error("timeout"), { killed: true }), "", "");
  await assert.rejects(runGit("/tmp", ["status"], 1000, MB, killed), /timed out/);

  const enoent: GitRunner = (_args, cb) =>
    cb(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }), "", "");
  await assert.rejects(runGit("/tmp", ["status"], 1000, MB, enoent), /ENOENT/);
});
