// cdp-harness.js — CDP 冒烟脚本共用底座（layout / settings / interaction / ui-screenshot-qa）。
//
// 收敛前四个脚本各自复制了同一份 Cdp 类、httpGetJson、killTree、waitForPageTarget
// 与启动/清理样板（jscpd 报 ~150 行重复），且漂移已久：有的收 Log 域错误、有的不收；
// 有的 evaluate 带 awaitPromise、有的不带。这里合并为一份"取各家之长"的实现：
//   - Cdp：异常 + console error + Log 域 error 全收；evaluate 默认 awaitPromise
//   - launch/connect/waitForPageTarget/waitForGateway：启动清理一条龙
//   - waitForAppReady：就绪轮询（readyState + rail 出现 + 字体加载完），替代固定 sleep(8000)
//   - setViewport/setTheme/pressEscape：各脚本通用的仿真操作
"use strict";

const http = require("http");
const { spawn, execFileSync } = require("child_process");

/** 解析 --flag value 形式的命令行参数。 */
function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
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

/** GET 是否 200（用于 gateway 就绪探测）。 */
function httpCheckOk(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
  });
}

function killTree(child) {
  try {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
}

/**
 * 启动被测应用并注册退出清理。返回 { child, cleanup }。
 * cleanup 幂等；进程退出 / SIGINT 时自动调用。
 */
function launch(exe, port) {
  const child = spawn(exe, [`--remote-debugging-port=${port}`], {
    cwd: require("path").dirname(exe),
    windowsHide: true,
    stdio: "ignore",
  });
  const cleanup = () => killTree(child);
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  return { child, cleanup };
}

/** 轮询 CDP /json/list 直到出现 file:// 页面 target。 */
async function waitForPageTarget(port, timeoutMs = 90_000) {
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

/** 轮询 gateway 直到 200 或超时；返回是否就绪（超时不抛，由各脚本决定阻断与否）。 */
async function waitForGateway(url = "http://127.0.0.1:18789/", timeoutMs = 60_000, intervalMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await httpCheckOk(url)) return true;
    await sleep(intervalMs);
  }
  return httpCheckOk(url);
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
        this.exceptions.push(detail?.exception?.description || detail?.text || "unknown exception");
      } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        this.consoleErrors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" "));
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
    const res = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      throw new Error("evaluate failed: " + JSON.stringify(res.exceptionDetails.exception?.description || res.exceptionDetails.text));
    }
    return res.result.value;
  }

  async pressEscape() {
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  }
}

/** 连上页面 target 并启用 Runtime/Log/Page 域。 */
async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  const cdp = new Cdp(ws);
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.enable");
  return { ws, cdp };
}

/**
 * 应用首屏就绪轮询：readyState complete + 主 rail 渲染 + 字体加载完。
 * 替代各脚本的固定 sleep(8000~20000)——冷启动快时提前开跑，慢时等到超时。
 * 返回 true=就绪；超时返回 false（调用方自行决定是否继续）。
 */
async function waitForAppReady(cdp, { timeoutMs = 30_000, minRailItems = 4 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready = await cdp.evaluate(`(async () => {
        if (document.readyState !== "complete") return false;
        if (document.querySelectorAll(".oc-rail__item").length < ${minRailItems}) return false;
        await document.fonts.ready;
        return true;
      })()`);
      if (ready) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

/** 视图切换后等待内容稳定：字体就绪 + 短暂排版缓冲。 */
async function waitForSettle(cdp, bufferMs = 400) {
  try {
    await cdp.evaluate("document.fonts.ready.then(() => true)");
  } catch {}
  await sleep(bufferMs);
}

async function setViewport(cdp, width, { height = 900, dsf = 1 } = {}) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dsf, mobile: false });
}

/** CSS 级主题切换（不动设置存储，仿真结束后由调用方恢复）。 */
async function setTheme(cdp, theme) {
  await cdp.evaluate(`(() => {
    document.documentElement.dataset.theme = ${JSON.stringify(theme)};
    document.documentElement.style.colorScheme = ${JSON.stringify(theme)};
  })()`);
}

/** 去重后的 renderer 异常首行列表（摘要打印用）。 */
function uniqueExceptionLines(cdp, limit = 10) {
  return [...new Set(cdp.exceptions)].slice(0, limit).map((e) => e.split("\n")[0].slice(0, 300));
}

module.exports = {
  Cdp,
  arg,
  sleep,
  httpGetJson,
  httpCheckOk,
  killTree,
  launch,
  waitForPageTarget,
  waitForGateway,
  connect,
  waitForAppReady,
  waitForSettle,
  setViewport,
  setTheme,
  uniqueExceptionLines,
};
