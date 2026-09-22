// 编译并运行 node:test 单元测试（.test-dist/*.test.js）。
// 排除走 vitest 的文件（它们 import "vitest"，node:test 跑不了）。
"use strict";

const { readdirSync } = require("fs");
const { basename, join, resolve } = require("path");
const { spawnSync } = require("child_process");
const rmRecursive = require("./lib/rm-rec")();

// 与 vitest.config.ts 的 include 保持一致
const VITEST_FILES = new Set([
  "docker-check",
  "kimi-config",
  "kernel-updater",
  "cryoclaw-config",
  "openclaw-config-migration",
  "openclaw-health-state",
  "startup-ownership",
  "skill-store-registry",
  "skill-store",
  "provider-config-cache",
  "config-backup",
  "openclaw-state-archive",
  "openclaw-state-import-lifecycle",
  "gateway-lifecycle",
  "analytics",
  "memory-workspace",
  "wecom-config",
]);

const root = resolve(__dirname, "..");
const dir = join(root, ".test-dist");

// 1. 清空输出目录再编译，防止删除测试源码后残留产物仍被运行
// （Windows 上 fs.rmSync 偶发静默失败，改用 rm-rec 的手动递归 fallback）
rmRecursive(dir);
const tsc = spawnSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(root, "tsconfig.test.json")], { stdio: "inherit" });
if (tsc.status !== 0) {
  process.exit(tsc.status ?? 1);
}

// 2. 递归收集测试产物并运行（tsconfig.test.json rootDir: "src" 保留子目录结构，
//    如 .test-dist/settings/*.test.js，顶层扫描会静默漏跑）
function collect(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(full, acc);
    } else if (entry.name.endsWith(".test.js")) {
      acc.push(full);
    }
  }
  return acc;
}
const files = collect(dir)
  // VITEST_FILES 只按文件名匹配（不含目录）；当前 .test-dist 子目录
  // （settings/、test-support/）无 *.test.js 产物，无同名冲突
  .filter((f) => !VITEST_FILES.has(basename(f).replace(/\.test\.js$/, "")));

if (files.length === 0) {
  console.error("[run-node-tests] .test-dist/ 下没有测试文件，请检查 tsconfig.test.json");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
