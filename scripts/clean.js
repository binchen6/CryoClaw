#!/usr/bin/env node
"use strict";
/**
 * clean.js — 清理全部生成文件（npm run clean 的实现）。
 *
 * 旧实现是 `rm -rf ...`：npm 在 Windows 上用 cmd.exe 跑脚本，rm 不存在导致
 * 开发机（Windows）上 clean 直接失败。改用 Node 实现，走 lib/rm-rec 的
 * Windows 健壮递归删除（Node 24 fs.rmSync 在 Windows 上偶发静默失败）。
 * 目标清单与旧脚本一致：dist / resources 运行时与内核 / 各 target / out。
 */
const path = require("path");
const rmRecursive = require("./lib/rm-rec")(require("fs"));

const root = path.resolve(__dirname, "..");
const targets = [
  "dist",
  "resources/runtime",
  "resources/gateway",
  "resources/targets",
  "out",
];

let failed = 0;
for (const rel of targets) {
  const target = path.join(root, rel);
  try {
    rmRecursive(target);
    console.log(`[clean] 已删除 ${rel}`);
  } catch (err) {
    failed++;
    console.error(`[clean] 删除 ${rel} 失败: ${err && err.message ? err.message : err}`);
  }
}

if (failed > 0) {
  process.exit(1);
}
