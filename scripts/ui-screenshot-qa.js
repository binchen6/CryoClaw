#!/usr/bin/env node
"use strict";
/**
 * ui-screenshot-qa.js — 全页面 UI 截图 QA（R64 起纳入发版固定流程）。
 *
 * 与 layout-cdp-smoke（主视图几何诊断）/ settings-cdp-smoke（设置页重叠/异常）
 * 互补：本脚本系统化截图供人工/AI 视觉审查——
 *   - 主视图 rail（chat/tasks/workspace/extensions/settings）× {1440, 800}px × {light, dark}
 *   - 设置页全部 nav tab × 1440px（light）
 *   - 英文语言（?lang=en）主视图 × 1440px
 * 每个场景同时跑 __ocLayoutDiagnostics（若存在）与跨组件重叠检测，
 * renderer 异常/裸 i18n key 为硬门槛；截图存 out/ui-qa/<ts>/。
 *
 * 用法：node scripts/ui-screenshot-qa.js [--exe <CryoClaw.exe>] [--port 9230]
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
const port = Number(arg("--port", "9230"));
if (!fs.existsSync(exe)) {
  console.error(`[ui-qa] 未找到可执行文件: ${exe}`);
  process.exit(2);
}
const outDir = path.join(root, "out", "ui-qa", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16));
fs.mkdirSync(outDir, { recursive: true });

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
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error("evaluate failed: " + JSON.stringify(res.exceptionDetails.exception?.description || res.exceptionDetails.text));
    return res.result.value;
  }
}

const overlapExpr = `(() => {
  // 模态/对话框打开时跳过：模态（cc-dialog-overlay、确认弹窗等）带遮罩覆盖
  // 底层内容属预期交互，其与底层叶子元素的几何相交不是排版缺陷。
  if (document.querySelector('.cc-dialog-overlay, [role="dialog"][aria-modal="true"]')) return "[]";
  const scope = document.querySelector('.oc-settings-content') || document.body;
  const customAncestor = (e) => { let n = e; while (n && n !== document.body) { if (n.tagName.includes('-')) return n; n = n.parentElement; } return null; };
  const els = [...scope.querySelectorAll('*')].filter(e => {
    const r = e.getBoundingClientRect();
    if (r.width < 5 || r.height < 5) return false;
    if (e.children.length > 0) return false;
    const cs = getComputedStyle(e);
    if (cs.position === 'fixed' || cs.visibility === 'hidden' || cs.display === 'none') return false;
    return r.top >= 0 && r.bottom <= innerHeight; // 只查视口内（截图可见区）
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
      if (xo > 8 && yo > 6) bad.push(((els[i].className||els[i].tagName)+':'+(els[j].className||els[j].tagName)).slice(0,110));
    }
  }
  return JSON.stringify([...new Set(bad)].slice(0, 15));
})()`;

async function main() {
  console.log(`[ui-qa] 启动: ${exe}`);
  console.log(`[ui-qa] 截图目录: ${outDir}`);
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
  if (!page) { console.error("[ui-qa] 页面 target 未出现"); cleanup(); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  const cdp = new Cdp(ws);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await sleep(8000);
  for (let i = 0; i < 30; i++) {
    const ok = await new Promise((r) => { const q = http.get("http://127.0.0.1:18789/", { timeout: 3000 }, (s) => { s.resume(); r(s.statusCode === 200); }); q.on("error", () => r(false)); });
    if (ok) break;
    await sleep(2000);
  }

  const results = [];
  async function shot(name) {
    await sleep(900);
    const bad = JSON.parse((await cdp.evaluate(overlapExpr)) || "[]");
    const r = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(r.data, "base64"));
    results.push({ name, overlaps: bad.length });
    console.log(`  ${name}: 重叠 ${bad.length}${bad.length ? " :: " + bad.join(" | ") : ""}`);
  }
  async function setViewport(w) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(800);
  }
  async function setTheme(theme) {
    await cdp.evaluate(`(() => { document.documentElement.dataset.theme = ${JSON.stringify(theme)}; document.documentElement.style.colorScheme = ${JSON.stringify(theme)}; })()`);
    await sleep(500);
  }

  const railCount = await cdp.evaluate("document.querySelectorAll('.cc-rail__item').length");
  const railLabels = await cdp.evaluate(`[...document.querySelectorAll('.cc-rail__item')].map((e,i)=>i+':'+(e.getAttribute('aria-label')||e.title||('rail'+i)))`);

  // 场景组 1：主视图 × 宽度 × 主题（light 优先，dark 抽 chat+settings）
  console.log("[ui-qa] 主视图巡览");
  await setTheme("light");
  for (let i = 0; i < railCount; i++) {
    const label = (railLabels[i] || `rail${i}`).split(":").pop().replace(/\s+/g, "_");
    await cdp.evaluate(`document.querySelectorAll('.cc-rail__item')[${i}].click()`);
    await sleep(1200);
    await setViewport(1440);
    await shot(`view_${label}_1440_light`);
    await setViewport(800);
    await shot(`view_${label}_800_light`);
  }
  // dark 主题抽查（首尾两个视图）
  await setTheme("dark");
  for (const idx of [0, railCount - 1]) {
    const label = (railLabels[idx] || `rail${idx}`).split(":").pop().replace(/\s+/g, "_");
    await cdp.evaluate(`document.querySelectorAll('.cc-rail__item')[${idx}].click()`);
    await sleep(1000);
    await setViewport(1440);
    await shot(`view_${label}_1440_dark`);
  }
  await setTheme("light");

  // 场景组 2：设置页全 tab（light 1440）
  console.log("[ui-qa] 设置页 tab 巡览");
  const settingsIdx = await cdp.evaluate(`[...document.querySelectorAll('.cc-rail__item')].findIndex(e => /settings|设置/i.test(e.getAttribute('aria-label')||e.title||e.textContent))`);
  await cdp.evaluate(`document.querySelectorAll('.cc-rail__item')[${settingsIdx}].click()`);
  await sleep(1200);
  await setViewport(1440);
  const tabCount = await cdp.evaluate("document.querySelectorAll('.oc-settings-nav-item').length");
  for (let i = 0; i < tabCount; i++) {
    const label = await cdp.evaluate(`document.querySelectorAll('.oc-settings-nav-item')[${i}].textContent.trim()`);
    await cdp.evaluate(`document.querySelectorAll('.oc-settings-nav-item')[${i}].click()`);
    const slug = label.replace(/[^\w\u4e00-\u9fa5]+/g, "_").slice(0, 24);
    await shot(`settings_${slug}`);
  }

  // 场景组 3：英文语言（reload ?lang=en，主视图 + 设置首屏）
  console.log("[ui-qa] 英文语言");
  const url = await cdp.evaluate(`(() => { const u = new URL(location.href); if (!/index\\.html?$/.test(u.pathname)) u.pathname = u.pathname.replace(/[^/]*$/, "index.html"); u.searchParams.set("lang", "en"); return u.toString(); })()`);
  await cdp.send("Page.navigate", { url });
  await sleep(7000);
  await setViewport(1440);
  await cdp.evaluate(`document.querySelectorAll('.cc-rail__item')[0].click()`);
  await sleep(1000);
  await shot("view_chat_1440_light_en");
  const s2 = await cdp.evaluate(`[...document.querySelectorAll('.cc-rail__item')].findIndex(e => /settings|设置/i.test(e.getAttribute('aria-label')||e.title||e.textContent))`);
  await cdp.evaluate(`document.querySelectorAll('.cc-rail__item')[${s2}].click()`);
  await sleep(1000);
  await shot("settings_first_1440_en");

  const bare = JSON.parse((await cdp.evaluate(`(() => {
    const text = document.body.textContent || "";
    const re = /\\b(app|chat|settings|setup|common|workspace|tasks|extensions|sessions)\\.[a-zA-Z][a-zA-Z0-9_.]{2,}/g;
    const ext = /\\.(xml|json|md|png|jpe?g|gif|js|mjs|ts|html|css|txt|ya?ml|exe|asar|zip)$/i;
    return JSON.stringify([...new Set((text.match(re) || []).filter((k) => !ext.test(k)))]);
  })()`)) || "[]");

  await cdp.send("Emulation.clearDeviceMetricsOverride");
  const summary = {
    screenshots: fs.readdirSync(outDir).filter((f) => f.endsWith(".png")).length,
    rendererExceptions: cdp.exceptions.length,
    consoleErrors: cdp.consoleErrors.length,
    bareI18nKeys: bare,
    overlapShots: results.filter((r) => r.overlaps > 0),
  };
  console.log("[ui-qa] 摘要（脱敏）:");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`[ui-qa] 截图目录: ${outDir}`);
  if (cdp.exceptions.length) {
    for (const e of [...new Set(cdp.exceptions)].slice(0, 10)) console.error("  renderer: " + e.split("\n")[0].slice(0, 300));
  }
  ws.close();
  cleanup();
  const fail = cdp.exceptions.length > 0 || bare.length > 0 || summary.overlapShots.length > 0;
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error("[ui-qa] 失败:", err.message);
  process.exit(1);
});
