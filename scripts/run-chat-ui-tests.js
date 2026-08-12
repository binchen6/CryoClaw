// 运行 chat-ui 测试：tsc 编译（.test-dist）→ node --test。
// chat-ui 测试用 node:test 风格，产物为 ESM（.js），需 .test-dist/package.json 标 type:module。
"use strict";
const { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } = require("fs");
const { join, resolve } = require("path");
const { spawnSync } = require("child_process");

const root = resolve(__dirname, "..");
const chatRoot = join(root, "chat-ui");
const outDir = join(chatRoot, "ui", ".test-dist");

// 1. 清空输出目录再编译，防止删除测试源码后残留产物仍被运行
rmSync(outDir, { recursive: true, force: true });
const tsc = spawnSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(chatRoot, "tsconfig.test.json")], { stdio: "inherit" });
if (tsc.status !== 0) {
  process.exit(tsc.status ?? 1);
}

// 2. 标记产物为 ESM（tsc 输出 import 语法，node 需要 type:module）
if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}
writeFileSync(join(outDir, "package.json"), JSON.stringify({ type: "module" }), "utf8");

// 3. 递归收集测试产物并运行
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
const files = collect(outDir);
if (files.length === 0) {
  console.error("[run-chat-ui-tests] 没有测试产物，请检查 chat-ui/tsconfig.test.json");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
