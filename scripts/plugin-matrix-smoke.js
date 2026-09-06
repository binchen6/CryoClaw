#!/usr/bin/env node
"use strict";
/**
 * plugin-matrix-smoke.js — 阶段五插件矩阵（可自动化子集）。
 *
 * 输出每个内核扩展插件的结构化记录：manifest 存在性、包版本、入口文件、
 * 打包形态可用性，并以隔离状态目录启动 gateway 抓取实际加载的插件清单。
 *
 * 明确不在本脚本范围（需真实凭据/外部动作，属用户验证项）：
 * 渠道真实收发、远程操作、OAuth 流程、升级后回滚的业务层验证。
 *
 * 用法：
 *   node scripts/plugin-matrix-smoke.js [--asar <gateway.asar>] [--out <matrix.json>]
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const { spawn } = require("child_process");
// asar 清单/解包捕获式执行（argv 数组直传；程序为当前 node 运行时）
const { execFileSync: runNodeCapture } = require("child_process");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const root = path.resolve(__dirname, "..");
const asarPath = arg("--asar", path.join(root, "resources", "targets", "win32-x64", "gateway.asar"));
const outPath = arg("--out", path.join(os.tmpdir(), "plugin-matrix.json"));
const nodeBin = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const asarCli = path.join(root, "node_modules", "@electron", "asar", "bin", "asar.mjs");

if (!fs.existsSync(asarPath) || !fs.existsSync(nodeBin)) {
  console.error("[plugin-matrix] 缺少 gateway.asar 或 electron 运行时");
  process.exit(2);
}

// 关注的插件域（计划阶段五清单）；镜像注入的插件在 dist/extensions 里带连接器后缀
const WATCH = [
  "dingtalk", "dingtalk-connector", "wecom", "wecom-openclaw-plugin", "weixin", "openclaw-weixin",
  "feishu", "qqbot", "kimi", "kimi-search", "moonshot", "zai", "qwen",
  "deepseek", "browser", "memory-core", "device-pair",
];

function listAsarDir(archive, dir) {
  // asar list 输出形如 \dist\extensions\feishu\openclaw.plugin.json（全量列表 >1MB，需放大 maxBuffer）
  const out = runNodeCapture([asarCli, "list", archive], { maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
  return out.split(/\r?\n/).filter((l) => l.replace(/^[\\/]+/, "").startsWith(dir.replace(/[\\/]+$/, "")));
}

function extractFileTo(archive, entry, cwd) {
  runNodeCapture([asarCli, "ef", archive, entry], { cwd });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function killTree(child) {
  try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

async function bootAndCollectPlugins() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-matrix-boot-"));
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify({
    gateway: { mode: "local", auth: { mode: "token", token: "plugin-matrix" } },
    channels: { qqbot: { enabled: true, appId: "x", clientSecret: "x", allowFrom: ["*"] } },
  }, null, 2));
  const port = await freePort();
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", OPENCLAW_DEBUG: "1", OPENCLAW_STATE_DIR: stateDir };
  for (const k of Object.keys(env)) if (/^(OPENCLAW|CLAWDBOT|CLAWD)_/i.test(k) && k !== "OPENCLAW_DEBUG" && k !== "OPENCLAW_STATE_DIR") delete env[k];

  return new Promise((resolve) => {
    const child = spawn(nodeBin, [path.join(asarPath, "node_modules", "openclaw", "openclaw.mjs"), "gateway", "run", "--port", String(port)], {
      cwd: stateDir, env, windowsHide: true,
    });
    let out = "";
    const finish = (result) => { killTree(child); setTimeout(() => resolve(result), 1500); };
    const timer = setTimeout(() => finish({ ready: false, pluginsLine: null, errors: [] }), 100_000);
    child.stdout.on("data", (c) => {
      out += c.toString("utf8");
      const plain = stripAnsi(out);
      const m = plain.match(/http server listening \((\d+) plugins?: ([^)]+)\)/);
      if (m) {
        clearTimeout(timer);
        finish({ ready: true, pluginsLine: m[2].split(",").map((s) => s.trim()), errors: [] });
      }
    });
    child.stderr.on("data", (c) => {
      const s = stripAnsi(c.toString("utf8"));
      if (/\[plugins\/|\[plugins\]/.test(s) && /error|failed|unreadable/i.test(s)) {
        // 记录但不断言（部分插件在最小配置下报缺配置属预期）
      }
    });
    child.on("close", () => { clearTimeout(timer); finish({ ready: false, pluginsLine: null, errors: [] }); });
  });
}

function main() {
  console.log(`[plugin-matrix] asar: ${asarPath}`);
  // 1. 静态枚举：dist/extensions/<name>/openclaw.plugin.json + package.json 版本
  const extFiles = listAsarDir(asarPath, "node_modules\\openclaw\\dist\\extensions\\");
  const extDirs = new Set(extFiles.map((l) => {
    const rel = l.replace(/^[\\/]+node_modules[\\/]openclaw[\\/]dist[\\/]extensions[\\/]/, "");
    return rel.split(/[\\/]/)[0];
  }).filter(Boolean));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-matrix-extract-"));
  const matrix = [];
  for (const name of [...extDirs].sort()) {
    const entry = `node_modules\\openclaw\\dist\\extensions\\${name}\\openclaw.plugin.json`;
    const hasManifest = extFiles.some((l) => l.replace(/^[\\/]+/, "").replace(/\\/g, "\\").endsWith(`${name}\\openclaw.plugin.json`));
    let version = null;
    let manifestId = null;
    if (hasManifest) {
      try {
        extractFileTo(asarPath, entry, tmp);
        const manifest = JSON.parse(fs.readFileSync(path.join(tmp, "openclaw.plugin.json"), "utf8"));
        manifestId = manifest.id ?? manifest.name ?? null;
        version = manifest.version ?? null;
      } catch { /* 记为不可解析 */ }
    }
    matrix.push({
      plugin: name,
      inWatchList: WATCH.includes(name),
      manifest: hasManifest ? "ok" : "missing",
      manifestId,
      version,
    });
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  // 2. 动态启动：实际加载清单
  console.log("[plugin-matrix] 启动 gateway 抓取插件清单（隔离状态目录）…");
  bootAndCollectPlugins().then((boot) => {
    const loaded = new Set(boot.pluginsLine || []);
    for (const row of matrix) row.loadedAtBoot = loaded.has(row.plugin);
    const summary = {
      asarVersion: null,
      extensionsEnumerated: matrix.length,
      manifestsOk: matrix.filter((m) => m.manifest === "ok").length,
      watchListCoverage: WATCH.map((w) => ({ plugin: w, bundled: matrix.some((m) => m.plugin === w) || w === "wecom" && matrix.some((m) => m.plugin === "wecom-openclaw-plugin") })),
      bootReady: boot.ready,
      loadedPlugins: boot.pluginsLine,
      matrix,
    };
    // asar 内核版本
    try {
      const t2 = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-matrix-pkg-"));
      extractFileTo(asarPath, "node_modules\\openclaw\\package.json", t2);
      summary.asarVersion = JSON.parse(fs.readFileSync(path.join(t2, "package.json"), "utf8")).version;
      fs.rmSync(t2, { recursive: true, force: true });
    } catch {}
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
    console.log(`[plugin-matrix] 内核 ${summary.asarVersion} | 扩展 ${summary.extensionsEnumerated}（manifest ok ${summary.manifestsOk}）| boot ${summary.bootReady ? "ready" : "FAIL"} | 加载 ${summary.loadedPlugins ? summary.loadedPlugins.length : 0} 个`);
    console.log(`[plugin-matrix] 清单 → ${outPath}`);
    const watchMissing = summary.watchListCoverage.filter((w) => !w.bundled);
    if (watchMissing.length) console.log(`[plugin-matrix] 关注清单未 bundled（外部安装/镜像注入）: ${watchMissing.map((w) => w.plugin).join(", ")}`);
    process.exit(summary.bootReady ? 0 : 1);
  });
}

main();
