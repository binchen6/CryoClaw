#!/usr/bin/env node
"use strict";
/**
 * settings-cdp-smoke.js — 设置页全 tab 布局/异常冒烟（R63 起新增的发版固定一步）。
 *
 * 与 layout-cdp-smoke.js（主视图 rail 巡览）互补：逐个点击左侧 nav 的全部设置 tab，
 * 每个 tab 跑跨组件叶子元素重叠检测（同一自定义组件内部的有意覆盖不计），
 * 同时收集 renderer 异常、console error 与裸 i18n key。MCP tab 额外展开
 * 「添加服务器」表单复测（gotcha #92 回归钉）。
 *
 * 退出码：重叠 > 0 或 renderer 异常或裸 key → 1。
 *
 * 用法：node scripts/settings-cdp-smoke.js [--exe <CryoClaw.exe>] [--port 9224]
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const exe = arg("--exe", null) || path.join(root, "out", "win32-x64", "win-unpacked", "CryoClaw.exe");
const port = Number(arg("--port", "9224"));
if (!fs.existsSync(exe)) {
  console.error(`[settings-smoke] 未找到可执行文件: ${exe}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGetJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}
function killTree(child) {
  try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.nextId = 1; this.pending = new Map();
    this.exceptions = []; this.consoleErrors = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
        return;
      }
      if (msg.method === "Runtime.exceptionThrown") {
        this.exceptions.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || "unknown");
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
    if (res.exceptionDetails) throw new Error("evaluate failed: " + JSON.stringify(res.exceptionDetails.exception?.description || res.exceptionDetails.text));
    return res.result.value;
  }
}

async function main() {
  console.log(`[settings-smoke] 启动: ${exe}`);
  const child = spawn(exe, [`--remote-debugging-port=${port}`], { cwd: path.dirname(exe), windowsHide: true, stdio: "ignore" });
  const cleanup = () => killTree(child);
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });

  let page = null;
  for (let i = 0; i < 90; i++) {
    try {
      const list = await httpGetJson(`http://127.0.0.1:${port}/json/list`);
      page = (list || []).find((t) => t.type === "page" && t.url.startsWith("file://"));
      if (page) break;
    } catch {}
    await sleep(1000);
  }
  if (!page) { console.error("[settings-smoke] 90s 内未发现页面 target"); cleanup(); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  const cdp = new Cdp(ws);
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await sleep(8000);
  for (let i = 0; i < 20; i++) {
    const ok = await new Promise((r) => { const q = http.get("http://127.0.0.1:18789/", { timeout: 3000 }, (s) => { s.resume(); r(s.statusCode === 200); }); q.on("error", () => r(false)); });
    if (ok) break;
    await sleep(2000);
  }

  const settingsIdx = await cdp.evaluate(
    `[...document.querySelectorAll('.cc-rail__item')].findIndex(e => /settings|设置/i.test(e.getAttribute('aria-label')||e.title||e.textContent))`,
  );
  if (settingsIdx < 0) { console.error("[settings-smoke] 未找到设置入口"); cleanup(); process.exit(1); }
  await cdp.evaluate(`document.querySelectorAll('.cc-rail__item')[${settingsIdx}].click()`);
  await sleep(1500);

  // 跨组件叶子重叠检测（同一自定义组件内部的覆盖不算——如密码框眼睛图标悬浮输入框）
  const overlapExpr = `(() => {
    const customAncestor = (e) => { let n = e; while (n && n !== document.body) { if (n.tagName.includes('-')) return n; n = n.parentElement; } return null; };
    const els = [...document.querySelectorAll('.oc-settings-content *')].filter(e => {
      const r = e.getBoundingClientRect();
      if (r.width < 5 || r.height < 5) return false;
      if (e.children.length > 0) return false;
      const cs = getComputedStyle(e);
      if (cs.position === 'fixed' || cs.visibility === 'hidden' || cs.display === 'none') return false;
      return true;
    });
    const bad = [];
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        if (els[i].contains(els[j]) || els[j].contains(els[i])) continue;
        const ca = customAncestor(els[i]), cb = customAncestor(els[j]);
        if (ca && ca === cb) continue;
        const a = els[i].getBoundingClientRect(), b = els[j].getBoundingClientRect();
        const xo = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const yo = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (xo > 8 && yo > 6) bad.push(((els[i].className||els[i].tagName)+':'+(els[j].className||els[j].tagName)).slice(0,120));
      }
    }
    return JSON.stringify([...new Set(bad)].slice(0, 20));
  })()`;

  const bareKeyExpr = `(() => {
    const text = document.body.textContent || "";
    const re = /\\b(app|chat|settings|setup|common|workspace|tasks|extensions|sessions)\\.[a-zA-Z][a-zA-Z0-9_.]{2,}/g;
    const ext = /\\.(xml|json|md|png|jpe?g|gif|js|mjs|ts|html|css|txt|ya?ml|exe|asar|zip)$/i;
    return JSON.stringify([...new Set((text.match(re) || []).filter((k) => !ext.test(k)))]);
  })()`;

  const results = [];
  const tabCount = await cdp.evaluate("document.querySelectorAll('.oc-settings-nav-item').length");
  for (let i = 0; i < tabCount; i++) {
    const label = await cdp.evaluate(`document.querySelectorAll('.oc-settings-nav-item')[${i}].textContent.trim()`);
    await cdp.evaluate(`document.querySelectorAll('.oc-settings-nav-item')[${i}].click()`);
    await sleep(1200);
    let bad = JSON.parse((await cdp.evaluate(overlapExpr)) || "[]");
    results.push({ tab: label, overlaps: bad });
    console.log(`  tab[${label}]: 跨组件重叠 ${bad.length}${bad.length ? " :: " + bad.join(" | ") : ""}`);
    // MCP tab：额外展开添加服务器表单复测（gotcha #92 回归钉）
    if (/MCP/i.test(label)) {
      await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => /添加服务器|add/i.test(x.textContent)); if (b && !b.disabled) b.click(); })()`);
      await sleep(900);
      bad = JSON.parse((await cdp.evaluate(overlapExpr)) || "[]");
      results.push({ tab: label + "(表单展开)", overlaps: bad });
      console.log(`  tab[${label}+表单]: 跨组件重叠 ${bad.length}${bad.length ? " :: " + bad.join(" | ") : ""}`);
      await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => /取消|cancel/i.test(x.textContent) && getComputedStyle(x).display !== 'none'); if (b) b.click(); })()`);
      await sleep(400);
    }
  }

  const bare = JSON.parse((await cdp.evaluate(bareKeyExpr)) || "[]");
  const summary = {
    exe: path.basename(exe),
    rendererExceptions: cdp.exceptions.length,
    consoleErrors: cdp.consoleErrors.length,
    tabs: results.length,
    bareI18nKeys: bare,
    overlapTabs: results.filter((r) => r.overlaps.length > 0),
  };
  console.log("[settings-smoke] 摘要（脱敏）:");
  console.log(JSON.stringify(summary, null, 2));
  if (cdp.exceptions.length) {
    for (const e of [...new Set(cdp.exceptions)].slice(0, 10)) console.error("  renderer: " + e.split("\n")[0].slice(0, 300));
  }
  ws.close();
  cleanup();
  const fail = cdp.exceptions.length > 0 || bare.length > 0 || summary.overlapTabs.length > 0;
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error("[settings-smoke] 失败:", err.message);
  process.exit(1);
});
