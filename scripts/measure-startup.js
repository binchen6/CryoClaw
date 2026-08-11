#!/usr/bin/env node
"use strict";
/**
 * measure-startup.js — 测量 CryoClaw 启动时间：
 *   进程启动 → gateway HTTP 200 → 主窗口显示（~/.openclaw/app.log 新条目 "主窗口显示"）
 * 用法：node scripts/measure-startup.js [exePath] [port]
 */
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const exe = process.argv[2] || (process.env.LOCALAPPDATA + "\\Programs\\CryoClaw\\CryoClaw.exe");
const port = Number(process.argv[3] || 18789);
const logPath = path.join(process.env.USERPROFILE || "", ".openclaw", "app.log");

const t0 = Date.now();
const beforeLen = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;

const child = spawn(exe, [], { detached: false, stdio: "ignore" });
console.log(`launched pid=${child.pid} at ${new Date(t0).toISOString()}`);

let gwMs = null;
let winMs = null;
let appReadyMs = null;

function checkGateway() {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

function scanLog() {
  if (!fs.existsSync(logPath)) return;
  const len = fs.statSync(logPath).size;
  if (len <= beforeLen) return;
  // 读新增部分
  const fd = fs.openSync(logPath, "r");
  const buf = Buffer.alloc(len - beforeLen);
  fs.readSync(fd, buf, 0, buf.length, beforeLen);
  fs.closeSync(fd);
  const text = buf.toString("utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
    if (!m) continue;
    const ts = Date.parse(m[1]);
    if (!Number.isFinite(ts)) continue;
    const rel = ts - t0;
    if (rel < 0) continue;
    if (line.includes("主窗口显示") && winMs === null) winMs = rel;
    if (line.includes("app ready") && appReadyMs === null) appReadyMs = rel;
  }
}

(async () => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (gwMs === null) {
      if (await checkGateway()) gwMs = Date.now() - t0;
    }
    scanLog();
    if (gwMs !== null && winMs !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`RESULT gateway200Ms=${gwMs} windowShownMs=${winMs} appReadyMs=${appReadyMs}`);
  // 清理验证实例
  try { process.kill(child.pid); } catch {}
  setTimeout(() => {
    try {
      const { execFileSync } = require("child_process");
      execFileSync("taskkill", ["/F", "/IM", "CryoClaw.exe", "/T"], { stdio: "ignore" });
    } catch {}
    process.exit(0);
  }, 2000);
})();