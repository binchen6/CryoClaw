#!/usr/bin/env node
"use strict";
/**
 * silent-install.js — Windows 安装包的可靠静默安装（发版 E2E 验证用）。
 *
 * 为什么必须用本脚本、而不能在 shell 里直接 `installer.exe /S`：
 * Git Bash (MSYS2) 会对以 `/` 开头的参数做路径改写（`/S` 可能变成 `S:\`
 * 之类的 Windows 路径），NSIS 收不到静默开关就会弹出交互向导——此前每次
 * 「静默」发版验证实际都是人工点完的。Node 的 spawn 原样传参、不经 MSYS
 * 转换，本脚本是绕开该问题的永久办法（gotcha #91）。
 *
 * 流程：杀残留进程（免触发安装器的等待/占用分支）→ 运行 installer /S 并
 * 等待退出 → 读安装位置 app.asar 的 package.json 校验版本。
 *
 * 用法：node scripts/silent-install.js <installer.exe> [expectedVersion]
 */
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const installer = process.argv[2];
const expectedVersion = process.argv[3];
if (!installer || !fs.existsSync(installer)) {
  console.error("usage: node scripts/silent-install.js <installer.exe> [expectedVersion]");
  process.exit(1);
}

// 1) 杀残留进程：安装器 customInit 也会杀，这里提前杀可让其跳过 2s 等待分支
for (const image of ["CryoClaw.exe", "CryoClaw Helper.exe", "CryoClaw-CLI.exe"]) {
  spawnSync("taskkill", ["/IM", image, "/F"], { stdio: "ignore" });
}

// 2) 静默安装：spawn 原样传 "/S"；shell:false 确保不经 cmd/MSYS 改写
const child = spawn(path.resolve(installer), ["/S"], { stdio: "ignore", shell: false });
const timeout = setTimeout(() => {
  console.error("[silent-install] 超时（5 分钟）未完成");
  child.kill();
  process.exit(1);
}, 5 * 60_000).unref();

child.on("error", (err) => {
  clearTimeout(timeout);
  console.error("[silent-install] 启动失败:", err.message);
  process.exit(1);
});

child.on("exit", (code) => {
  clearTimeout(timeout);
  if (code !== 0) {
    console.error("[silent-install] 安装器退出码:", code);
    process.exit(1);
  }
  // 3) 版本校验：读安装位置 app.asar 内的 package.json
  try {
    const asar = require("@electron/asar");
    const target = path.join(
      process.env.LOCALAPPDATA || "",
      "Programs", "CryoClaw", "resources", "app.asar",
    );
    const pkg = JSON.parse(asar.extractFile(target, "package.json").toString("utf8"));
    if (expectedVersion && pkg.version !== expectedVersion) {
      console.error(`[silent-install] 版本不符: installed=${pkg.version} expected=${expectedVersion}`);
      process.exit(1);
    }
    console.log("[silent-install] OK, installed version:", pkg.version);
    process.exit(0);
  } catch (err) {
    console.error("[silent-install] 版本校验失败:", err.message);
    process.exit(1);
  }
});
