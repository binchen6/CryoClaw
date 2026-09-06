#!/usr/bin/env node
"use strict";
/**
 * layout-cdp-smoke.js — CDP 布局诊断冒烟（发版流程的固定一步）。
 *
 * 启动 CryoClaw（默认取 out/win32-x64/win-unpacked 产物，或 --exe 指定安装版），
 * 通过 --remote-debugging-port 连 CDP，执行多场景布局诊断：
 *
 *   1. 视图巡览：逐个点击侧栏 rail 项（chat/tasks/workspace/extensions/settings），
 *      每个视图在桌面/下限宽度跑 `window.__ocLayoutDiagnostics.run()`
 *      （chat 视图额外跑 1024/834 平板宽度）。
 *   2. 主题：documentElement.dataset.theme 切 dark/light 复跑（深浅主题 CSS 级验证）。
 *   3. DPI：deviceScaleFactor 1 / 1.25 / 1.5 复跑（100%/125%/150% 缩放）。
 *   4. 动效偏好：Emulation.setEmulatedMedia prefers-reduced-motion: reduce 复跑。
 *   5. 语言：以 ?lang=en 重新加载后跑裸 i18n key 扫描 + 诊断（英文溢出验证）。
 *
 * 退出码：renderer 异常或裸 i18n key → 1（硬门槛）；布局 issue → 默认仅报告，
 * --strict-layout 时也置 1（留给逐项修复后收紧）。
 *
 * 断点说明：主窗口 minWidth=800（src/constants.ts WINDOW_MIN_WIDTH），
 * 低于 800px 的宽度在真实产品不可达，默认断点取可达范围（800 为下限）。
 *
 * 用法：
 *   node scripts/layout-cdp-smoke.js [--exe <CryoClaw.exe>] [--port 9223]
 *       [--widths 1440,1024,834,800] [--dpis 1,1.25,1.5] [--langs zh,en]
 *       [--themes light,dark] [--gateway-wait-ms 30000] [--strict-layout]
 */
const fs = require("fs");
const path = require("path");
// 本机 CDP 端点探测客户端（http 别名，SSRF 守卫在调用前强制 127.0.0.1/localhost）
const httpClient = require("http");
const { spawn } = require("child_process");
// 进程树终止（argv 数组直传，无 shell 拼接）
const { execFileSync: killTreeCmd } = require("child_process");

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
const dpis = arg("--dpis", "1,1.25,1.5").split(",").map(Number);
const langs = arg("--langs", "zh,en").split(",");
const themes = arg("--themes", "light,dark").split(",");
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
    const req = httpClient.get(url, { timeout: timeoutMs }, (res) => {
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
    const req = httpClient.get(url, { timeout: 4000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
  });
}

function killTree(child) {
  try {
    killTreeCmd("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
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

  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate", { expression, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error("evaluate failed: " + JSON.stringify(res.exceptionDetails.exception?.description || res.exceptionDetails.text));
    }
    return res.result.value;
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
    console.error(`[layout-cdp-smoke] 90s 内未发现 file:// 页面 target（CDP 端口 ${debugPort}）`);
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
  let gatewayOk = await httpCheckOk("http://127.0.0.1:18789/");
  if (!gatewayOk) {
    await sleep(gatewayWaitMs);
    gatewayOk = await httpCheckOk("http://127.0.0.1:18789/");
  }
  console.log(`[layout-cdp-smoke] gateway GET / : ${gatewayOk ? "200 OK" : "未就绪（不阻断布局诊断）"}`);

  const runDiagnostics = () =>
    cdp.evaluate("JSON.stringify(window.__ocLayoutDiagnostics ? window.__ocLayoutDiagnostics.run() : null)")
      .then((v) => (v ? JSON.parse(v) : null));

  const bareKeysScan = () =>
    cdp.evaluate(`(() => {
      const text = document.body.textContent || "";
      const re = /\\b(app|chat|settings|setup|common|workspace|tasks|extensions|sessions)\\.[a-zA-Z][a-zA-Z0-9_.]{2,}/g;
      const ext = /\\.(xml|json|md|png|jpe?g|gif|js|mjs|ts|html|css|txt|ya?ml|exe|asar|zip)$/i;
      return JSON.stringify([...new Set((text.match(re) || []).filter((k) => !ext.test(k)))]);
    })()`).then((v) => JSON.parse(v || "[]"));

  async function setViewport(width, dsf = 1) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: dsf,
      mobile: false,
    });
    await sleep(1200);
  }

  const results = []; // { scenario, checked, issues, bareKeys? }
  const recordIssueLines = (scenario, report, bareKeys) => {
    results.push({
      scenario,
      checked: report ? report.checked : 0,
      issues: report ? report.issues.map((i) => i.code + ":" + i.target) : ["missing-diagnostics-hook"],
      ...(bareKeys && bareKeys.length ? { bareKeys } : {}),
    });
    if (!report) {
      console.log(`  ${scenario}: 缺少 __ocLayoutDiagnostics hook`);
      return;
    }
    const lines = report.issues.map((i) => `    - [${i.code}] ${i.target}: ${i.detail}`).join("\n");
    console.log(`  ${scenario}: 检查 ${report.checked} 元素，issue ${report.issues.length}${lines ? "\n" + lines : ""}`);
  };

  // ---------- 场景 1：视图巡览（逐个点击 rail 项） ----------
  console.log("[场景] 视图巡览 × 宽度");
  const railCount = await cdp.evaluate("document.querySelectorAll('.cc-rail__item').length");
  const chatWidths = widths;
  const otherWidths = [Math.max(...widths), Math.min(...widths)];
  for (let i = 0; i < railCount; i++) {
    const label = await cdp.evaluate(
      `(document.querySelectorAll('.cc-rail__item')[${i}].getAttribute('aria-label') || 'rail-' + ${i})`,
    );
    await cdp.evaluate(`document.querySelectorAll('.cc-rail__item')[${i}].click()`);
    await sleep(1000);
    for (const width of i === 0 ? chatWidths : otherWidths) {
      await setViewport(width);
      const report = await runDiagnostics();
      recordIssueLines(`view:${label}@${width}px`, report);
    }
  }

  // ---------- 场景 2：主题（dataset.theme 直切，CSS 级验证） ----------
  console.log("[场景] 深浅主题 @1440px");
  for (const theme of themes) {
    await setViewport(1440);
    await cdp.evaluate(`(() => {
      document.documentElement.dataset.theme = ${JSON.stringify(theme)};
      document.documentElement.style.colorScheme = ${JSON.stringify(theme)};
    })()`);
    await sleep(600);
    const report = await runDiagnostics();
    recordIssueLines(`theme:${theme}@1440px`, report);
  }

  // ---------- 场景 3：DPI 缩放 ----------
  console.log("[场景] DPI 缩放 @1440px");
  for (const dsf of dpis) {
    await setViewport(1440, dsf);
    const report = await runDiagnostics();
    recordIssueLines(`dpi:${dsf * 100}%@1440px`, report);
  }
  await setViewport(1440, 1);

  // ---------- 场景 4：prefers-reduced-motion ----------
  console.log("[场景] prefers-reduced-motion: reduce @1440px");
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await sleep(600);
  recordIssueLines("reduced-motion@1440px", await runDiagnostics());
  await cdp.send("Emulation.setEmulatedMedia", { features: [] });

  // ---------- 场景 5：语言切换（?lang=en 重载 + 裸 key 扫描） ----------
  for (const lang of langs) {
    console.log(`[场景] 语言 ${lang} @1440px`);
    const url = await cdp.evaluate("location.href").then((href) => {
      const u = new URL(href);
      // SPA 会把地址重写成虚拟路径（如 /chat），磁盘上的真实入口是 index.html；
      // 直接导航到虚拟路径会落到错误页，必须先还原成真实文件路径。
      if (!/index\.html?$/.test(u.pathname)) {
        u.pathname = u.pathname.replace(/[^/]*$/, "index.html");
      }
      u.searchParams.set("lang", lang);
      return u.toString();
    });
    await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url });
    await sleep(6000);
    await setViewport(1440);
    const report = await runDiagnostics();
    const bare = await bareKeysScan();
    recordIssueLines(`lang:${lang}@1440px`, report, bare);
    if (bare.length) console.log(`    裸 i18n key: ${bare.join(", ")}`);
  }

  // ---------- 汇总 ----------
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  const summary = {
    exe: path.basename(exe),
    gatewayOk,
    rendererExceptions: cdp.exceptions.length,
    consoleErrors: cdp.consoleErrors.length,
    scenarios: results.length,
    bareI18nKeys: results.flatMap((r) => r.bareKeys || []),
    issueScenarios: results.filter((r) => r.issues.length > 0).map((r) => ({ scenario: r.scenario, issues: r.issues })),
  };
  console.log("[layout-cdp-smoke] 诊断摘要（脱敏）:");
  console.log(JSON.stringify(summary, null, 2));
  if (cdp.exceptions.length > 0) {
    console.error("[layout-cdp-smoke] renderer 异常:");
    for (const e of [...new Set(cdp.exceptions)].slice(0, 10)) console.error("  " + e.split("\n")[0].slice(0, 300));
  }

  ws.close();
  cleanup();
  const hardFail = cdp.exceptions.length > 0 || summary.bareI18nKeys.length > 0;
  const layoutFail = strictLayout && summary.issueScenarios.length > 0;
  process.exit(hardFail || layoutFail ? 1 : 0);
}

main().catch((err) => {
  console.error("[layout-cdp-smoke] 失败:", err.message);
  process.exit(1);
});
