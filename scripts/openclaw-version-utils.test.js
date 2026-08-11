// openclaw-version-utils.test.js — 内核版本解析/比较/远端查询的兼容性护栏
// 覆盖 openclaw 日历版本号（2026.7.1-2 / 2026.10.1）的解析边界，防止上游
// 新版本格式（如月份 ≥10、v 前缀、prerelease）在打包与内核升级链上被误判。
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  normalizeSemverText,
  compareSemver,
  readRemoteLatestVersion,
} = require("./lib/openclaw-version-utils");

test("normalizeSemverText: 去 v 前缀与空白，空输入返回空串", () => {
  assert.equal(normalizeSemverText("2026.7.1-2"), "2026.7.1-2");
  assert.equal(normalizeSemverText("v2026.7.1-2"), "2026.7.1-2");
  assert.equal(normalizeSemverText("  V2026.7.1 "), "2026.7.1");
  assert.equal(normalizeSemverText(""), "");
  assert.equal(normalizeSemverText(undefined), "");
  assert.equal(normalizeSemverText(null), "");
  assert.equal(normalizeSemverText(2026), "2026");
});

test("compareSemver: 日历版本号 major/minor/patch 排序", () => {
  assert.equal(compareSemver("2026.7.1", "2026.7.0"), 1);
  assert.equal(compareSemver("2026.7.1", "2026.8.0"), -1);
  assert.equal(compareSemver("2026.10.1", "2026.9.9"), 1, "月份 10 > 9（按数值比较，非字典序）");
  assert.equal(compareSemver("2026.7.1-2", "2026.7.1"), -1, "pre-release 小于正式版");
  assert.equal(compareSemver("2026.7.1-rc.3", "2026.7.1-rc.2"), 1);
  assert.equal(compareSemver("2026.7.1+build.5", "2026.7.1"), 0, "build metadata 不参与比较");
  assert.equal(compareSemver("2026.7.1", "2026.7.1"), 0);
});

test("compareSemver: 非法输入返回 null（不可比较）", () => {
  assert.equal(compareSemver("latest", "2026.7.1"), null);
  assert.equal(compareSemver("2026.7.1", ""), null);
  assert.equal(compareSemver("not-a-version", "also-not"), null);
});

test("readRemoteLatestVersion: 走 PATH 内假 npm，解析 JSON 版本字段", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ovu-test-"));
  const isWin = process.platform === "win32";
  const npmName = isWin ? "npm.cmd" : "npm";
  // npm view <pkg> version --json 在真实 registry 上输出 JSON 字符串；
  // 假 npm 输出对象形态同样可被解析（取 .version）
  const script = isWin
    ? "@echo off\r\necho {\"version\":\"2026.10.1\"}\r\n"
    : "#!/bin/sh\necho '{\"version\":\"2026.10.1\"}'\n";
  fs.writeFileSync(path.join(tmp, npmName), script, isWin ? "utf-8" : "utf-8");
  if (!isWin) {
    fs.chmodSync(path.join(tmp, npmName), 0o755);
  }

  const oldPath = process.env.PATH;
  try {
    process.env.PATH = path.join(tmp) + path.delimiter + (oldPath ?? "");
    const version = readRemoteLatestVersion("openclaw", { cwd: tmp, logError: () => {} });
    assert.equal(version, "2026.10.1");
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("readRemoteLatestVersion: 假 npm 失败时返回空串并走 logError", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ovu-test-"));
  const isWin = process.platform === "win32";
  const npmName = isWin ? "npm.cmd" : "npm";
  const script = isWin ? "@echo off\r\nexit /b 1\r\n" : "#!/bin/sh\nexit 1\n";
  fs.writeFileSync(path.join(tmp, npmName), script, "utf-8");
  if (!isWin) {
    fs.chmodSync(path.join(tmp, npmName), 0o755);
  }

  const oldPath = process.env.PATH;
  let logged = "";
  try {
    process.env.PATH = path.join(tmp) + path.delimiter + (oldPath ?? "");
    const version = readRemoteLatestVersion("openclaw", {
      cwd: tmp,
      logError: (msg) => { logged = msg; },
    });
    assert.equal(version, "");
    assert.ok(logged.includes("远端版本检查失败"), `应调用 logError: ${logged}`);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
