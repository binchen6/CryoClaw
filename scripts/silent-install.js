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

// 2) Stage outside a Low-labelled build directory before launching the installer.
async function main(){
  const {stageInstaller}=require("./lib/stage-installer");
  const staged=await stageInstaller(path.resolve(installer));
  try{
    console.log("[silent-install] 已暂存安装包，避免继承构建目录的低完整性标签");
    await new Promise((resolve,reject)=>{
      const child=spawn(staged.target,["/S"],{stdio:"ignore",shell:false,windowsHide:true,env:{...process.env,TEMP:staged.tempRoot,TMP:staged.tempRoot}});
      const timer=setTimeout(()=>{child.kill();reject(Error("安装超时（15 分钟）"));},15*60_000);
      const progress=setInterval(()=>console.log("[silent-install] 安装进行中…"),30_000);
      const clear=()=>{clearTimeout(timer);clearInterval(progress);};
      child.on("error",error=>{clear();reject(error);});
      child.on("exit",code=>{clear();code===0?resolve():reject(Error("安装器退出码: "+code));});
    });
    const asar=require("@electron/asar");
    const target=path.join(process.env.LOCALAPPDATA||"","Programs","CryoClaw","resources","app.asar");
    const pkg=JSON.parse(asar.extractFile(target,"package.json").toString("utf8"));
    if(expectedVersion && pkg.version!==expectedVersion)throw Error("版本不符: installed="+pkg.version+" expected="+expectedVersion);
    console.log("[silent-install] OK, installed version:",pkg.version);
  }finally{await staged.cleanup().catch(error=>console.warn("[silent-install] 临时安装包清理失败:",error.message));}
}
main().catch(error=>{console.error("[silent-install] 失败:",error.message);process.exitCode=1;});
