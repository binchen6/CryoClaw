#!/usr/bin/env node
"use strict";
/**
 * settings-cdp-smoke.js — 设置页全 tab 布局/异常冒烟（发版固定一步）。
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
// 裸 i18n key 扫描（排除用户/模型内容容器，见模块注释）
const { bareI18nScanExpr } = require("./lib/bare-i18n-scan.js");
// 跨组件重叠检测（含祖先裁剪感知，见模块注释）
const { overlapCheckExpr } = require("./lib/overlap-scan.js");
const {
  arg, launch, waitForPageTarget, waitForGateway, connect,
  waitForAppReady, waitForSettle, uniqueExceptionLines,
} = require("./lib/cdp-harness.js");

const root = path.resolve(__dirname, "..");
const exe = arg(process.argv, "--exe", null) || path.join(root, "out", "win32-x64", "win-unpacked", "CryoClaw.exe");
const port = Number(arg(process.argv, "--port", "9224"));
if (!fs.existsSync(exe)) {
  console.error(`[settings-smoke] 未找到可执行文件: ${exe}`);
  process.exit(2);
}

async function main() {
  console.log(`[settings-smoke] 启动: ${exe}`);
  const { cleanup } = launch(exe, port);

  const page = await waitForPageTarget(port, 90_000);
  if (!page) { console.error("[settings-smoke] 90s 内未发现页面 target"); cleanup(); process.exit(1); }
  const { ws, cdp } = await connect(page);
  await waitForAppReady(cdp);
  await waitForGateway("http://127.0.0.1:18789/", 40_000);

  const settingsIdx = await cdp.evaluate(
    `[...document.querySelectorAll('.oc-rail__item')].findIndex(e => /settings|设置/i.test(e.getAttribute('aria-label')||e.title||e.textContent))`,
  );
  if (settingsIdx < 0) { console.error("[settings-smoke] 未找到设置入口"); cleanup(); process.exit(1); }
  await cdp.evaluate(`document.querySelectorAll('.oc-rail__item')[${settingsIdx}].click()`);
  await waitForSettle(cdp, 900);

  // 跨组件叶子重叠检测（同一自定义组件内部的覆盖不算——如密码框眼睛图标悬浮输入框；
  // 含祖先裁剪感知与诊断详情，见 scripts/lib/overlap-scan.js）
  const overlapExpr = overlapCheckExpr({ viewportOnly: false });
  const bareKeyExpr = bareI18nScanExpr();

  const results = [];
  const tabCount = await cdp.evaluate("document.querySelectorAll('.oc-settings-nav-item').length");
  for (let i = 0; i < tabCount; i++) {
    const label = await cdp.evaluate(`document.querySelectorAll('.oc-settings-nav-item')[${i}].textContent.trim()`);
    await cdp.evaluate(`document.querySelectorAll('.oc-settings-nav-item')[${i}].click()`);
    await waitForSettle(cdp, 600);
    let bad = JSON.parse((await cdp.evaluate(overlapExpr)) || "[]");
    results.push({ tab: label, overlaps: bad });
    console.log(`  tab[${label}]: 跨组件重叠 ${bad.length}${bad.length ? " :: " + bad.join(" | ") : ""}`);
    // MCP tab：额外展开添加服务器表单复测（gotcha #92 回归钉）
    if (/MCP/i.test(label)) {
      await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => /添加服务器|add/i.test(x.textContent)); if (b && !b.disabled) b.click(); })()`);
      await waitForSettle(cdp, 500);
      bad = JSON.parse((await cdp.evaluate(overlapExpr)) || "[]");
      results.push({ tab: label + "(表单展开)", overlaps: bad });
      console.log(`  tab[${label}+表单]: 跨组件重叠 ${bad.length}${bad.length ? " :: " + bad.join(" | ") : ""}`);
      await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => /取消|cancel/i.test(x.textContent) && getComputedStyle(x).display !== 'none'); if (b) b.click(); })()`);
      await waitForSettle(cdp, 300);
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
    for (const line of uniqueExceptionLines(cdp)) console.error("  renderer: " + line);
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
