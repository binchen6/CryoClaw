import test from "node:test";
import assert from "node:assert/strict";
import {
  detectGit,
  detectGitCached,
  parseGitVersion,
  resetGitDetectionCacheForTest,
} from "./git-detector.ts";

test("parseGitVersion：标准输出提取版本号", () => {
  assert.equal(parseGitVersion("git version 2.43.0"), "2.43.0");
  assert.equal(parseGitVersion("git version 2.39.3 (Apple Git-146)\n"), "2.39.3");
  assert.equal(parseGitVersion("git version 2.43.0.windows.1"), "2.43.0.windows.1");
});

test("parseGitVersion：异常输出返回 null", () => {
  assert.equal(parseGitVersion(""), null);
  assert.equal(parseGitVersion("bash: git: command not found"), null);
  assert.equal(parseGitVersion("git"), null);
});

test("detectGit：runner 正常输出 → available", async () => {
  const result = await detectGit(async () => "git version 2.43.0\n");
  assert.deepEqual(result, { available: true, version: "2.43.0" });
});

test("detectGit：runner 抛错（git 不存在）→ 降级不可用，不抛出", async () => {
  const result = await detectGit(async () => {
    throw new Error("spawn git ENOENT");
  });
  assert.deepEqual(result, { available: false, version: null });
});

test("detectGit：runner 输出不可解析 → 不可用", async () => {
  const result = await detectGit(async () => "weird output");
  assert.deepEqual(result, { available: false, version: null });
});

test("detectGitCached：同一进程内只探测一次并复用缓存", async () => {
  resetGitDetectionCacheForTest();
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return "git version 9.9.9";
  };
  const first = await detectGitCached(runner);
  const second = await detectGitCached();
  assert.equal(calls, 1, "第二次调用不应再次执行 runner");
  assert.deepEqual(first, second);
  resetGitDetectionCacheForTest();
});
