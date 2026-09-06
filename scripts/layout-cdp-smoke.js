#!/usr/bin/env node
"use strict";
/**
 * layout-cdp-smoke.js — CDP 布局诊断冒烟（发版流程的固定一步）。
 *
 * 启动 CryoClaw（默认取 out/win32-x64/win-unpacked 产物，或 --exe 指定安装版），
 * 通过 --remote-debugging-port 连 CDP，在多个断点宽度下执行渲染进程内
 * `window.__ocLayoutDiagnostics.run()`（chat-ui/src/ui/layout-diagnostics.ts），
 * 输出每个断点的结构化布局报告，并统计 renderer 异常与裸 i18n key。
 *
 * 退出码：renderer 异常或裸 i18n key → 1（硬门槛）；布局 issue → 默认仅报告，
 * --strict-layout 时也置 1（留给逐项修复后收紧）。
 *
 * 用法：
 *   node scripts/layout-cdp-smoke.js [--exe <CryoClaw.exe>] [--port 9223]
 *       [--widths 1440,1024,834,800] [--gateway-wait-ms 30000] [--strict-layout]
 *
 * 断点说明：主窗口 minWidth=800（src/constants.ts WINDOW_MIN_WIDTH），
 * 低于 800px 的宽度在真实产品不可达，默认断点取可达范围（800 为下限）。
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execSync } = require("child_process");

const root = path.resolve(__dirname, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const exe =
  arg("--exe", null) ||
  path.join(root, "out", "win32-x64", "win-unpacked", "CryoClaw.exe");
const debugPort = Number(arg("--port", "9223"));
const widths = arg("--widths", "1440,1024,834,800").split(",").map(Number);
const gatewayWaitMs = Number(arg("--gateway-wait-ms", "30000"));
const strictLayout = process.argv.includes("--strict-layout");

if (!fs.existsSync(exe)) {
  console.error(`[layout-cdp-smoke] 未找到可执行文件: ${exe}（先跑 npm run dist:win 或用 --exe 指定）`);
  process.exit(2);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpGetJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body: null });
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function httpCheckOk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 4000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
  });
}

function killTree(child) {
  try {
    execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
  } catch {}
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.exceptions = [];
    this.consoleErrors = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const detail = msg.params.exceptionDetails;
        this.exceptions.push(
          (detail.exception && detail.exception.description) ||
            detail.text ||
            "unknown exception",
        );
      } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        this.consoleErrors.push(
          (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" "),
        );
      } else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
        this.consoleErrors.push(msg.params.entry.text);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function waitForPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { body } = await httpGetJson(`http://127.0.0.1:${port}/json/list`);
      const page = (body || []).find((t) => t.type === "page" && t.url.startsWith("file://"));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(1000);
  }
  return null;
}

async function main() {
  console.log(`[layout-cdp-smoke] 启动: ${exe}`);
  const child = spawn(
    exe,
    [`--remote-debugging-port=${debugPort}`],
    { cwd: path.dirname(exe), windowsHide: true, stdio: "ignore" },
  );
  const cleanup = () => killTree(child);
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  const page = await waitForPageTarget(debugPort, 90_000);
  if (!page) {
    console.error(`[layout-cdp-smoke] ${90_000}ms 内未发现 file:// 页面 target（CDP 端口 ${debugPort}）`);
    cleanup();
    process.exit(1);
  }
  console.log(`[layout-cdp-smoke] 已连接页面: ${page.url}`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  const cdp = new Cdp(ws);
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");

  // 等首屏渲染稳定（Electron 冷启动 + 首次 gateway 握手）
  await sleep(8000);

  const gatewayOk = await httpCheckOk("http://127.0.0.1:18789/");
  if (!gatewayOk) {
    // gateway 首启 20s+ 属正常，再等一轮
    await sleep(gatewayWaitMs);
  }
  const gatewayOkFinal = gatewayOk || (await httpCheckOk("http://127.0.0.1:18789/"));
  console.log(`[layout-cdp-smoke] gateway GET / : ${gatewayOkFinal ? "200 OK" : "未就绪（不阻断布局诊断）"}`);

  const reports = [];
  for (const width of widths) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width < 500,
    });
    await sleep(1500);
    const evalRes = await cdp.send("Runtime.evaluate", {
      expression:
        "JSON.stringify((window.__ocLayoutDiagnostics ? window.__ocLayoutDiagnostics.run() : null))",
      returnByValue: true,
    });
    const report = evalRes.result.value ? JSON.parse(evalRes.result.value) : null;
    if (!report) {
      console.error(`[layout-cdp-smoke] @${width}px 渲染进程缺少 __ocLayoutDiagnostics hook`);
      continue;
    }
    reports.push({ width, ...report });
    const issueLines = report.issues
      .map((i) => `    - [${i.code}] ${i.target}: ${i.detail}`)
      .join("\n");
    console.log(
      `@${width}px 检查 ${report.checked} 个元素，issue ${report.issues.length}${issueLines ? "\n" + issueLines : ""}`,
    );
  }

  // 裸 i18n key 扫描（namespace.key 形态出现在正文即视为漏翻；
  // 尾段为常见文件扩展名的（如消息里提到的 app.xml）是正文内容，排除）
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await sleep(500);
  const i18nRes = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const text = document.body.textContent || "";
      const re = /\\b(app|chat|settings|setup|common|workspace|tasks|extensions|sessions)\\.[a-zA-Z][a-zA-Z0-9_.]{2,}/g;
      const ext = /\\.(xml|json|md|png|jpe?g|gif|js|mjs|ts|html|css|txt|ya?ml|exe|asar|zip)$/i;
      return JSON.stringify([...new Set((text.match(re) || []).filter((k) => !ext.test(k)))]);
    })()`,
    returnByValue: true,
  });
  const bareKeys = JSON.parse(i18nRes.result.value || "[]");

  // 断言窗口关闭前的诊断结论汇总（脱敏：仅布局元数据与 key 名）
  const summary = {
    exe: path.basename(exe),
    widths,
    gatewayOk: gatewayOkFinal,
    rendererExceptions: cdp.exceptions.length,
    consoleErrors: cdp.consoleErrors.length,
    bareI18nKeys: bareKeys,
    layoutIssuesByWidth: Object.fromEntries(
      reports.map((r) => [r.width + "px", r.issues.map((i) => i.code + ":" + i.target)]),
    ),
  };
  console.log("[layout-cdp-smoke] 诊断摘要（脱敏）:");
  console.log(JSON.stringify(summary, null, 2));
  if (cdp.exceptions.length > 0) {
    console.error("[layout-cdp-smoke] renderer 异常:");
    for (const e of cdp.exceptions.slice(0, 10)) console.error("  " + e.split("\n")[0].slice(0, 300));
  }
  if (bareKeys.length > 0) {
    console.error(`[layout-cdp-smoke] 裸 i18n key: ${bareKeys.join(", ")}`);
  }

  ws.close();
  cleanup();
  const hardFail = cdp.exceptions.length > 0 || bareKeys.length > 0;
  const layoutFail = strictLayout && reports.some((r) => r.issues.length > 0);
  process.exit(hardFail || layoutFail ? 1 : 0);
}

main().catch((err) => {
  console.error("[layout-cdp-smoke] 失败:", err.message);
  process.exit(1);
});
