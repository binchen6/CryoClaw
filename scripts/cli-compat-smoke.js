#!/usr/bin/env node
"use strict";
/**
 * cli-compat-smoke.js — OpenClaw CLI wrapper 全兼容冒烟（阶段三交付物）。
 *
 * 验证 CryoClaw 安装的 `openclaw` wrapper 是通用透传层：
 *   1. 命令矩阵：递归解析 --help（顶层 + 一级子命令），生成结构化命令树，
 *      可与参考内核入口（--kernel-entry，如 2026.9.2 tarball 解包入口）对比差异。
 *   2. 行为电池：版本/帮助/未知命令/全局参前后/退出码/stdout-stderr 分离/
 *      特殊字符参数与 cwd/gateway 未启动时的错误清晰度/输出脱敏扫描。
 *
 * wrapper 只做透传 + update/gateway 两个托管拦截，不维护子命令白名单——
 * 本脚本矩阵仅用于测试覆盖率与报告，不限制任何命令执行。
 *
 * 用法：
 *   node scripts/cli-compat-smoke.js [--wrapper <openclaw.cmd>] [--kernel-entry <openclaw.mjs>]
 *       [--matrix-only] [--timeout-ms 30000]
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const wrapper = arg("--wrapper", path.join(process.env.LOCALAPPDATA || os.homedir(), "CryoClaw", "bin", "openclaw.cmd"));
const kernelEntry = arg("--kernel-entry", null);
// 参考内核入口的运行时：默认 Electron 自带 Node（满足 2026.9.2 的 engine 要求，
// 系统 Node 24.14 < 24.15 会被内核 preinstall 守卫拒绝）
const nodeBin = arg("--node-bin", path.join(__dirname, "..", "node_modules", "electron", "dist", "electron.exe"));
const matrixOnly = process.argv.includes("--matrix-only");
const timeoutMs = Number(arg("--timeout-ms", "30000"));

if (!fs.existsSync(wrapper)) {
  console.error(`[cli-smoke] wrapper 不存在: ${wrapper}（先在设置页启用 CLI，或用 --wrapper 指定）`);
  process.exit(2);
}

// runner：通过 cmd.exe 执行 .cmd wrapper（与用户终端一致）；入口直跑用 node。
// Node 出于 CVE-2024-27980 加固不允许直接 spawn .cmd，必须经 cmd.exe；
// 引号策略：路径无空格用平铺拼接（cmd /c 原生稳定），有空格用 /s + 引号形态。
function runCli(cmd, args, opts = {}) {
  const isCmd = /\.cmd$/i.test(cmd);
  let finalCmd, finalArgs;
  if (isCmd) {
    const quoted = /\s/.test(cmd);
    finalCmd = "cmd.exe";
    finalArgs = quoted
      ? ["/d", "/s", "/c", `"${cmd}" ${args.join(" ")}`]
      : ["/d", "/c", `${cmd} ${args.join(" ")}`];
  } else if (opts.runtime === "electron-node") {
    finalCmd = nodeBin;
    finalArgs = [cmd, ...args];
  } else {
    finalCmd = process.execPath;
    finalArgs = [cmd, ...args];
  }
  const spawned = spawnSync(finalCmd, finalArgs, {
    cwd: opts.cwd,
    encoding: "buffer",
    timeout: opts.timeout ?? timeoutMs,
    windowsHide: true,
    input: opts.input,
    maxBuffer: 16 * 1024 * 1024,
    env: opts.runtime === "electron-node"
      ? { ...process.env, ELECTRON_RUN_AS_NODE: "1", OPENCLAW_STATE_DIR: path.join(os.tmpdir(), "cli-smoke-ref-state") }
      : process.env,
  });
  return {
    status: spawned.status,
    signal: spawned.signal,
    stdout: (spawned.stdout || Buffer.alloc(0)).toString("utf8"),
    stderr: (spawned.stderr || Buffer.alloc(0)).toString("utf8"),
    timedOut: !!(spawned.error && spawned.error.code === "ETIMEDOUT"),
  };
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** 从 --help 输出解析命令清单（Commands: 段，`*` 后缀表示有子命令） */
function parseCommands(helpText) {
  const text = stripAnsi(helpText);
  const idx = text.indexOf("Commands:");
  if (idx === -1) return [];
  const body = text.slice(idx);
  const commands = [];
  // 行形态：`  name [args]   description...`（描述可折行，折行不匹配命令头正则即忽略）
  const lineRe = /^ {2,}([a-z][a-z0-9:-]*)( \*| <[^>]+>|\.{3})* {2,}\S|^ {2,}([a-z][a-z0-9:-]*) \*/;
  for (const rawLine of body.split(/\r?\n/).slice(1)) {
    const m = rawLine.match(/^ {2,}([a-z][a-z0-9:-]*)((?: \*)|(?: <[^>]+>)*) {2,}\S/);
    if (m) commands.push({ name: m[1], hasSub: /\*$/.test((m[2] || "").trim()) });
  }
  return commands;
}

async function buildMatrix(runFn, label) {
  const top = runFn(["--help"]);
  if (top.status !== 0) throw new Error(`${label} --help 退出码 ${top.status}`);
  const commands = parseCommands(top.stdout);
  const matrix = { label, version: stripAnsi(runFn(["--version"]).stdout).trim(), commands: {} };
  const skipHelp = new Set([
    // 交互式/长驻命令：--help 也可能进入交互（保守跳过，其存在性由顶层 --help 覆盖）
    "chat", "tui", "configure", "dashboard", "attach", "connect", "completion",
  ]);
  for (const cmd of commands) {
    if (cmd.hasSub && !skipHelp.has(cmd.name)) {
      const sub = runFn([cmd.name, "--help"]);
      matrix.commands[cmd.name] = {
        hasSubcommands: true,
        helpExit: sub.status,
        subcommands: sub.status === 0 ? parseCommands(sub.stdout).map((c) => c.name) : [],
      };
    } else {
      matrix.commands[cmd.name] = { hasSubcommands: cmd.hasSub, helpExit: null };
    }
  }
  return matrix;
}

function gatewayListening() {
  return new Promise((resolve) => {
    const req = http.get("http://127.0.0.1:18789/", { timeout: 2500 }, (res) => {
      res.resume();
      resolve(res.statusCode > 0);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// 输出脱敏：命令失败输出里不应出现 token/API key 形态
const SECRET_RE = /\b(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{20,}|(?:api[_-]?key|token|secret)["'=:\s]+[A-Za-z0-9_\-]{24,})\b/gi;
function scanSecrets(label, out) {
  const hits = [...new Set((out.match(SECRET_RE) || []))];
  if (hits.length) results.push({ check: "secret-leak", label, ok: false, detail: hits.length + " 处疑似凭据形态" });
  return hits.length === 0;
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ check: name, ok, detail: detail.slice(0, 300) });
  console.log(`  ${ok ? "✔" : "✖"} ${name}${detail && !ok ? " — " + detail.slice(0, 300) : ""}`);
}

async function main() {
  console.log(`[cli-smoke] wrapper: ${wrapper}`);

  // ---------- 命令矩阵 ----------
  console.log("[1] 命令矩阵（--help 树）");
  let wrapperMatrix;
  try {
    wrapperMatrix = await buildMatrix((args) => runCli(wrapper, args), "wrapper-2026.8.2");
  } catch (e) {
    console.error("[cli-smoke] 矩阵生成失败: " + e.message);
    process.exit(1);
  }
  const cmdNames = Object.keys(wrapperMatrix.commands);
  console.log(`  顶层命令 ${cmdNames.length} 个：${cmdNames.join(", ")}`);
  const noHelp = cmdNames.filter((c) => wrapperMatrix.commands[c].helpExit !== null && wrapperMatrix.commands[c].helpExit !== 0);
  check("全部一级子命令 --help 退出码 0", noHelp.length === 0, "失败: " + noHelp.join(", "));
  fs.writeFileSync(path.join(os.tmpdir(), "cli-matrix-wrapper.json"), JSON.stringify(wrapperMatrix, null, 2));

  if (kernelEntry) {
    const refMatrix = await buildMatrix((args) => runCli(kernelEntry, args, { runtime: "electron-node" }), "reference-kernel");
    const refNames = new Set(Object.keys(refMatrix.commands));
    const added = cmdNames.filter((c) => !refNames.has(c));
    const removed = [...refNames].filter((c) => !wrapperMatrix.commands[c]);
    console.log(`  对比参考内核 ${refMatrix.version}: 新增 ${added.length}（${added.join(",")}）/ 移除 ${removed.length}（${removed.join(",")}）`);
    fs.writeFileSync(path.join(os.tmpdir(), "cli-matrix-reference.json"), JSON.stringify(refMatrix, null, 2));
  }
  if (matrixOnly) {
    console.log(JSON.stringify({ version: wrapperMatrix.version, commands: cmdNames }, null, 2));
    process.exit(0);
  }

  // ---------- 行为电池 ----------
  console.log("[2] 版本与基础透传");
  const ver = runCli(wrapper, ["--version"]);
  check("--version 退出码 0 且输出含语义化版本", ver.status === 0 && /\d{4}\.\d+\.\d+/.test(ver.stdout), `status=${ver.status} out=${ver.stdout.trim()}`);
  check("--version 走 stdout 而非 stderr", ver.stdout.trim().length > 0 && ver.stderr.trim().length === 0);

  // wrapper 与入口直跑一致性（wrapper 不得改变输出）
  const nodeBin = null; // ASAR 形态入口必须用 CLI.exe，直跑一致性比较留给散文件形态
  const ver2 = runCli(wrapper, ["--version", "--no-color"]);
  check("重复调用输出稳定（无状态残留）", ver2.status === 0 && ver2.stdout.trim() === ver.stdout.trim());

  console.log("[3] 全局参数位置（子命令前 / 后）");
  const pre = runCli(wrapper, ["--no-color", "--version"]);
  const post = runCli(wrapper, ["--version", "--no-color"]);
  check("全局参数在子命令前后均可透传", pre.status === 0 && post.status === 0 && pre.stdout.trim() === post.stdout.trim(),
    `pre=${pre.status} post=${post.status}`);

  console.log("[4] 未知命令与退出码保持");
  const unknown = runCli(wrapper, ["definitely-not-a-command-xyz"]);
  check("未知命令透传给内核并返回非零退出码", unknown.status !== 0 && unknown.status !== null, `status=${unknown.status}`);
  check("未知命令错误写 stderr", unknown.stderr.trim().length > 0);
  scanSecrets("unknown-cmd-output", unknown.stderr + unknown.stdout);

  const unknown2 = runCli(wrapper, ["definitely-not-a-command-xyz"]);
  check("退出码可复现（稳定透传，非 wrapper 吞码）", unknown2.status === unknown.status, `${unknown.status} vs ${unknown2.status}`);

  console.log("[5] 特殊字符参数与 cwd");
  // cmd 对 %VAR% 有固有展开行为；断言聚焦未定义 % 序列与整词存活：
  // 内核 unknown-command 只回显首词（首词即命令名，其余是参数），断言首词逐字节往返。
  const weird = "we%25ird $x y";
  const weirdRun = runCli(wrapper, [weird]);
  const normalized = stripAnsi(weirdRun.stderr);
  check("含 % 的命令名逐字节透传（未被 cmd 展开）", weirdRun.status !== 0 && normalized.includes('"we%25ird"'),
    "stderr 未包含原样命令名: " + normalized.slice(-200));
  // cwd 含空格与中文
  const weirdDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli 目录 空格-"));
  const cwdRun = runCli(wrapper, ["--version"], { cwd: weirdDir });
  check("特殊字符 cwd 下正常运行", cwdRun.status === 0 && /\d{4}\.\d+\.\d+/.test(cwdRun.stdout), `status=${cwdRun.status}`);
  fs.rmSync(weirdDir, { recursive: true, force: true });

  console.log("[6] gateway 状态感知");
  const gatewayUp = await gatewayListening();
  console.log(`  gateway(18789): ${gatewayUp ? "运行中" : "未启动"}`);
  if (!gatewayUp) {
    // cron 明确标注 "via Gateway"：gateway 未启动时必须有清晰错误
    const gw = runCli(wrapper, ["cron", "list"]);
    check("gateway 依赖命令（cron list）给出明确错误", (gw.stderr + gw.stdout).trim().length > 0,
      "无任何输出");
    scanSecrets("gateway-down-output", gw.stderr + gw.stdout);
    // sessions list 走本地 sqlite 直读：gateway 未启动也必须可用（离线能力）
    const sess = runCli(wrapper, ["sessions", "list"]);
    check("sessions list 离线可用（本地 sqlite 直读）", sess.status === 0, `status=${sess.status}`);
    scanSecrets("sessions-list-output", sess.stdout + sess.stderr);
    const verDown = runCli(wrapper, ["--version"]);
    check("gateway 未启动不影响 --version", verDown.status === 0);
  } else {
    const sess = runCli(wrapper, ["sessions", "list", "--json"]);
    check("gateway 运行中 sessions list 可用", sess.status === 0, `status=${sess.status}`);
    scanSecrets("sessions-list-output", sess.stdout + sess.stderr);
  }

  console.log("[7] 输出脱敏总扫");
  const helpAll = runCli(wrapper, ["--help"]);
  scanSecrets("top-help-output", helpAll.stdout);

  // ---------- 汇总 ----------
  const failed = results.filter((r) => !r.ok);
  console.log(`[cli-smoke] 结果: ${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("[cli-smoke] 失败:", e.message);
  process.exit(1);
});
