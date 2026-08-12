// 编译并运行 node:test 单元测试（.test-dist/*.test.js）。
// 排除走 vitest 的文件（它们 import "vitest"，node:test 跑不了）。
"use strict";

const { readdirSync, rmSync } = require("fs");
const { join, resolve } = require("path");
const { spawnSync } = require("child_process");

// 与 vitest.config.ts 的 include 保持一致
const VITEST_FILES = new Set([
  "docker-check",
  "kimi-config",
  "kernel-updater",
  "cryoclaw-config",
  "openclaw-config-migration",
  "openclaw-health-state",
  "startup-ownership",
]);

const root = resolve(__dirname, "..");
const dir = join(root, ".test-dist");

// 1. 清空输出目录再编译，防止删除测试源码后残留产物仍被运行
rmSync(dir, { recursive: true, force: true });
const tsc = spawnSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(root, "tsconfig.test.json")], { stdio: "inherit" });
if (tsc.status !== 0) {
  process.exit(tsc.status ?? 1);
}

// 2. 收集测试产物并运行
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.js"))
  .filter((f) => !VITEST_FILES.has(f.replace(/\.test\.js$/, "")))
  .map((f) => join(dir, f));

if (files.length === 0) {
  console.error("[run-node-tests] .test-dist/ 下没有测试文件，请检查 tsconfig.test.json");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
