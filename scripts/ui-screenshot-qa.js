#!/usr/bin/env node
"use strict";
/**
 * ui-screenshot-qa.js — 全页面 UI 截图 QA（发版固定流程）。
 *
 * 与 layout-cdp-smoke（主视图几何诊断）/ settings-cdp-smoke（设置页重叠/异常）
 * 互补：本脚本系统化截图供人工/AI 视觉审查——
 *   - 主视图 rail（chat/tasks/workspace/extensions/settings）× {1440, 800}px × {light, dark}
 *   - 设置页全部 nav tab × 1440px（light）
 *   - 英文语言（?lang=en）主视图 × 1440px
 * 每个场景同时跑跨组件重叠检测 + 文本截断/横向溢出扫描（text-quality-scan），
 * 对比度启发式结果进报告。截图与机器可读 report.json 存 out/ui-qa/<ts>/。
 *
 * 硬门槛（退出码 1）：renderer 异常 / 裸 i18n key / 跨组件重叠 / body 级横向滚动条。
 * 软告警（只进报告）：文本裁切（非 ellipsis）、低对比度。
 *
 * 用法：node scripts/ui-screenshot-qa.js [--exe <CryoClaw.exe>] [--port 9230]
 */
const fs = require("fs");
const path = require("path");
// 裸 i18n key 扫描（排除用户/模型内容容器，见模块注释）
const { bareI18nScanExpr } = require("./lib/bare-i18n-scan.js");
// 跨组件重叠检测（含祖先裁剪感知，见模块注释）
const { overlapCheckExpr } = require("./lib/overlap-scan.js");
// 文本截断/横向溢出 + 对比度启发式（见模块注释）
const { textOverflowScanExpr, contrastScanExpr } = require("./lib/text-quality-scan.js");
const {
  arg, launch, waitForPageTarget, waitForGateway, connect,
  waitForAppReady, waitForSettle, setViewport, setTheme, uniqueExceptionLines,
} = require("./lib/cdp-harness.js");

const root = path.resolve(__dirname, "..");
const exe = arg(process.argv, "--exe", null) || path.join(root, "out", "win32-x64", "win-unpacked", "CryoClaw.exe");
const port = Number(arg(process.argv, "--port", "9230"));
if (!fs.existsSync(exe)) {
  console.error(`[ui-qa] 未找到可执行文件: ${exe}`);
  process.exit(2);
}
const outDir = path.join(root, "out", "ui-qa", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16));
fs.mkdirSync(outDir, { recursive: true });

async function main() {
  console.log(`[ui-qa] 启动: ${exe}`);
  console.log(`[ui-qa] 截图目录: ${outDir}`);
  const { cleanup } = launch(exe, port);

  const page = await waitForPageTarget(port, 90_000);
  if (!page) { console.error("[ui-qa] 页面 target 未出现"); cleanup(); process.exit(1); }
  const { ws, cdp } = await connect(page);
  await waitForAppReady(cdp);
  await waitForGateway("http://127.0.0.1:18789/", 60_000);

  const overlapExpr = overlapCheckExpr();
  const overflowExpr = textOverflowScanExpr();
  const results = [];
  const clippedAll = [];
  let pageHOverflowShots = [];

  async function shot(name) {
    await waitForSettle(cdp, 500);
    const bad = JSON.parse((await cdp.evaluate(overlapExpr)) || "[]");
    const tq = JSON.parse((await cdp.evaluate(overflowExpr)) || "{}");
    const r = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(r.data, "base64"));
    results.push({ name, overlaps: bad });
    if (tq.clipped && tq.clipped.length) clippedAll.push({ shot: name, clipped: tq.clipped });
    if (tq.pageHOverflow) pageHOverflowShots.push(name);
    console.log(`  ${name}: 重叠 ${bad.length}${bad.length ? " :: " + bad.join(" | ") : ""}${tq.pageHOverflow ? " ⚠ 横向滚动条" : ""}${tq.clipped && tq.clipped.length ? ` · 文本裁切 ${tq.clipped.length}` : ""}`);
  }

  const railCount = await cdp.evaluate("document.querySelectorAll('.oc-rail__item').length");
  const railLabels = await cdp.evaluate(`[...document.querySelectorAll('.oc-rail__item')].map((e,i)=>i+':'+(e.getAttribute('aria-label')||e.title||('rail'+i)))`);
  const railSlug = (i) => (railLabels[i] || `rail${i}`).split(":").pop().replace(/\s+/g, "_");

  // 场景组 1：主视图 × 宽度 × 主题（light 全宽度，dark 全视图 @1440）
  console.log("[ui-qa] 主视图巡览");
  await setTheme(cdp, "light");
  for (let i = 0; i < railCount; i++) {
    await cdp.evaluate(`document.querySelectorAll('.oc-rail__item')[${i}].click()`);
    await waitForSettle(cdp, 800);
    await setViewport(cdp, 1440);
    await shot(`view_${railSlug(i)}_1440_light`);
    await setViewport(cdp, 800);
    await shot(`view_${railSlug(i)}_800_light`);
  }
  await setViewport(cdp, 1440);
  await setTheme(cdp, "dark");
  for (let i = 0; i < railCount; i++) {
    await cdp.evaluate(`document.querySelectorAll('.oc-rail__item')[${i}].click()`);
    await waitForSettle(cdp, 700);
    await shot(`view_${railSlug(i)}_1440_dark`);
  }
  await setTheme(cdp, "light");

  // 场景组 2：设置页全 tab（light 1440）+ dark 首屏抽查
  console.log("[ui-qa] 设置页 tab 巡览");
  const settingsIdx = await cdp.evaluate(`[...document.querySelectorAll('.oc-rail__item')].findIndex(e => /settings|设置/i.test(e.getAttribute('aria-label')||e.title||e.textContent))`);
  await cdp.evaluate(`document.querySelectorAll('.oc-rail__item')[${settingsIdx}].click()`);
  await waitForSettle(cdp, 900);
  await setViewport(cdp, 1440);
  const tabCount = await cdp.evaluate("document.querySelectorAll('.oc-settings-nav-item').length");
  for (let i = 0; i < tabCount; i++) {
    const label = await cdp.evaluate(`document.querySelectorAll('.oc-settings-nav-item')[${i}].textContent.trim()`);
    await cdp.evaluate(`document.querySelectorAll('.oc-settings-nav-item')[${i}].click()`);
    const slug = label.replace(/[^\w一-龥]+/g, "_").slice(0, 24);
    await shot(`settings_${slug}`);
    // 首个 tab 额外拍 dark，抽查设置页深色观感
    if (i === 0) {
      await setTheme(cdp, "dark");
      await shot(`settings_${slug}_dark`);
      await setTheme(cdp, "light");
    }
  }

  // 场景组 3：英文语言（reload ?lang=en，主视图 + 设置首屏）
  console.log("[ui-qa] 英文语言");
  const url = await cdp.evaluate(`(() => { const u = new URL(location.href); if (!/index\\.html?$/.test(u.pathname)) u.pathname = u.pathname.replace(/[^/]*$/, "index.html"); u.searchParams.set("lang", "en"); return u.toString(); })()`);
  await cdp.send("Page.navigate", { url });
  await waitForAppReady(cdp, { timeoutMs: 20_000 });
  await setViewport(cdp, 1440);
  await cdp.evaluate(`document.querySelectorAll('.oc-rail__item')[0].click()`);
  await waitForSettle(cdp, 700);
  await shot("view_chat_1440_light_en");
  const s2 = await cdp.evaluate(`[...document.querySelectorAll('.oc-rail__item')].findIndex(e => /settings|设置/i.test(e.getAttribute('aria-label')||e.title||e.textContent))`);
  await cdp.evaluate(`document.querySelectorAll('.oc-rail__item')[${s2}].click()`);
  await waitForSettle(cdp, 700);
  await shot("settings_first_1440_en");

  const bare = JSON.parse((await cdp.evaluate(bareI18nScanExpr())) || "[]");
  const lowContrast = JSON.parse((await cdp.evaluate(contrastScanExpr())) || "[]");

  await cdp.send("Emulation.clearDeviceMetricsOverride");
  const summary = {
    screenshots: fs.readdirSync(outDir).filter((f) => f.endsWith(".png")).length,
    rendererExceptions: cdp.exceptions.length,
    consoleErrors: cdp.consoleErrors.length,
    bareI18nKeys: bare,
    overlapShots: results.filter((r) => r.overlaps.length > 0),
    pageHOverflowShots,
    textClipped: clippedAll,
    lowContrast,
  };
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ ...summary, exe: path.basename(exe), ts: new Date().toISOString() }, null, 2));
  console.log("[ui-qa] 摘要（脱敏）:");
  console.log(JSON.stringify({ ...summary, textClipped: `${clippedAll.length} 个场景`, lowContrast: `${lowContrast.length} 项` }, null, 2));
  console.log(`[ui-qa] 截图目录: ${outDir}`);
  if (cdp.exceptions.length) {
    for (const line of uniqueExceptionLines(cdp)) console.error("  renderer: " + line);
  }
  ws.close();
  cleanup();
  const fail = cdp.exceptions.length > 0 || bare.length > 0 || summary.overlapShots.length > 0 || pageHOverflowShots.length > 0;
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error("[ui-qa] 失败:", err.message);
  process.exit(1);
});
