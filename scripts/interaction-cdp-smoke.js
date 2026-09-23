/**
 * interaction-cdp-smoke.js — 交互级冒烟（发版固定步骤，R70 新增）。
 *
 * 与 layout/settings/UI-screenshot 三个冒烟的差别：那些是"看"（几何/截图/文本），本脚本是"动"——
 * 逐视图点击 rail、逐设置 tab 巡视、触发一个危险确认弹窗并用 Escape 取消，全程追踪 renderer 异常。
 * 它发现的真实缺陷示例：通用确认弹窗遮罩不响应点击，导致 Escape 关闭对「重置配置并重启」这类
 * 危险确认框失效（R70 修复）。
 *
 * 退出码：renderer 异常 > 0 或任一硬断言失败 → 1。
 * 用法：node scripts/interaction-cdp-smoke.js [--exe <CryoClaw.exe>] [--port 9330]
 */
const fs = require("fs");
const path = require("path");
const {
  arg, sleep, launch, waitForPageTarget, waitForGateway, connect,
  waitForAppReady, waitForSettle, setViewport, uniqueExceptionLines,
} = require("./lib/cdp-harness.js");

const root = path.resolve(__dirname, "..");
const exe = arg(process.argv, "--exe", null) || path.join(root, "out", "win32-x64", "win-unpacked", "CryoClaw.exe");
const debugPort = Number(arg(process.argv, "--port", "9330"));
if (!fs.existsSync(exe)) {
  console.error(`[interaction-smoke] 未找到可执行文件: ${exe}`);
  process.exit(2);
}

(async () => {
  const { cleanup } = launch(exe, debugPort);
  const page = await waitForPageTarget(debugPort, 90_000);
  if (!page) { console.error("no page target"); cleanup(); process.exit(1); }
  const { ws, cdp } = await connect(page);
  await waitForAppReady(cdp);
  // 等网关就绪（冷启动约 12s），否则「连接失败」弹窗会挡住审查
  const gatewayOk0 = await waitForGateway("http://127.0.0.1:18789/", 60_000, 3000);
  if (!gatewayOk0) console.log("WARN  网关 60s 未就绪，后续步骤可能受连接弹窗干扰");
  await setViewport(cdp, 1440);
  await waitForSettle(cdp, 600);

  const steps = [];
  const step = (name, ok, detail = "") => { steps.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };
  const dialogCount = () => cdp.evaluate(`document.querySelectorAll('[role="dialog"][aria-modal="true"]').length`);

  // 逐视图：点击 rail 项 + 视图内安全交互
  const railCount = await cdp.evaluate("document.querySelectorAll('.oc-rail__item').length");
  for (let i = 0; i < railCount; i++) {
    const label = await cdp.evaluate(`(document.querySelectorAll('.oc-rail__item')[${i}].getAttribute('aria-label') || 'rail-'+${i})`);
    await cdp.evaluate(`document.querySelectorAll('.oc-rail__item')[${i}].click()`);
    await waitForSettle(cdp, 800);
    const before = await dialogCount();
    // 侧栏会话行 / 工作区节点 / git 行的键盘可达性：统计 role=button 行数
    const rows = await cdp.evaluate(`document.querySelectorAll('[role="button"][tabindex="0"]').length`);
    step(`view ${label}: 渲染 + ${rows} 个键盘可达行 (${before} 弹窗)`, cdp.exceptions.length === 0, `exceptions=${cdp.exceptions.length}`);
  }

  // 设置页：全 tab 巡览后，验证「恢复出厂」确认框的 Escape 语义
  const settingsIdx = await cdp.evaluate(`[...document.querySelectorAll('.oc-rail__item')].findIndex(e => /settings|设置/i.test(e.getAttribute('aria-label')||e.title||e.textContent))`);
  await cdp.evaluate(`document.querySelectorAll('.oc-rail__item')[${settingsIdx}].click()`);
  await waitForSettle(cdp, 1000);
  const tabCount = await cdp.evaluate("document.querySelectorAll('.oc-settings-nav-item').length");
  for (let i = 0; i < tabCount; i++) {
    const label = await cdp.evaluate(`document.querySelectorAll('.oc-settings-nav-item')[${i}].textContent.trim()`);
    await cdp.evaluate(`document.querySelectorAll('.oc-settings-nav-item')[${i}].click()`);
    await waitForSettle(cdp, 500);
    if (cdp.exceptions.length > 0) step(`settings tab ${label}`, false, cdp.exceptions[0].slice(0, 80));
  }
  step(`settings: ${tabCount} 个 tab 巡览无渲染异常`, cdp.exceptions.length === 0, `exceptions=${cdp.exceptions.length}`);

  // 打开「恢复出厂」确认框（危险操作有 await showConfirm 守卫，点开不会执行）
  // 必须先切到「备份恢复」tab——tab 循环结束时停在最后一个 tab，其内容里没有该按钮
  await cdp.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.oc-settings-nav-item')];
    const t = tabs.find(x => /备份|backup/i.test(x.textContent || ''));
    if (t) t.click();
    return !!t;
  })()`);
  await waitForSettle(cdp, 800);
  const opened = await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const target = btns.find(b => /重置配置|恢复出厂|reset config|factory reset/i.test(b.textContent || '') && !b.disabled);
    if (!target) return { clicked: false };
    target.click();
    return { clicked: true };
  })()`);
  const dialogBefore = await dialogCount();
  if (!opened || opened.clicked !== true) {
    console.log("SKIP  确认框 Escape 检查（设置页未找到重置按钮，跳过）");
  } else {
    step("打开确认框（危险操作前置守卫）", dialogBefore >= 1, `dialogs=${dialogBefore}`);
  }

  await cdp.pressEscape();
  await sleep(700);
  const dialogAfter = await dialogCount();
  if (opened && opened.clicked === true) {
    step("Escape 关闭确认框", dialogBefore >= 1 && dialogAfter < dialogBefore, `before=${dialogBefore} after=${dialogAfter}`);
  }

  // 确认危险操作未执行：应用仍在运行、网关仍在线（页面未重载）
  const stillAlive = await cdp.evaluate("document.querySelectorAll('.oc-rail__item').length >= 5");
  // 设置页「搜索」tab 会触发热应用重启（by design）；轮询等网关恢复，最多 30s
  const gatewayOk = await waitForGateway("http://127.0.0.1:18789/", 30_000, 3000);
  step("取消后应用与网关均未受影响", stillAlive && gatewayOk, `rail=${stillAlive} gateway200=${gatewayOk}`);

  const failed = steps.filter((x) => !x.ok);
  console.log("\n摘要:", JSON.stringify({ steps: steps.length, failed: failed.map((f) => f.name), rendererExceptions: cdp.exceptions.length, consoleErrors: cdp.consoleErrors.length }, null, 1));
  if (cdp.exceptions.length) {
    for (const line of uniqueExceptionLines(cdp)) console.error("  renderer: " + line);
  }
  ws.close();
  cleanup();
  process.exit(failed.length === 0 && cdp.exceptions.length === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
