#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const {
  arg,
  launch,
  quitLaunchedApp,
  waitForPageTarget,
  connect,
  waitForAppReady,
  dismissReleaseNotes,
  sleep,
} = require("./lib/cdp-harness");

const hydrationBatch = Number(arg(process.argv, "--hydration-batch", "10"));

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const bootObserver = `
(() => {
  const boot = window.__frontendBoot = { readyAt: null, longTasks: [] };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) boot.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  const check = () => {
    if (document.readyState === "complete" && document.querySelectorAll(".oc-rail__item").length >= 4) {
      boot.readyAt = performance.now();
      return;
    }
    requestAnimationFrame(check);
  };
  requestAnimationFrame(check);
})()`;

const chatBenchmark = `(async () => {
  const app = document.querySelector("openclaw-app");
  const history = () => document.querySelector("oc-chat-history");
  const settle = async () => {
    await app.updateComplete;
    await history()?.updateComplete;
  };
  const original = {
    view: app.settings.cryoclawView,
    messages: app.chatMessages,
    tools: app.chatToolMessages,
    visible: app.chatVisibleMessageCount,
  };
  const restoreView = () => {
    const props = document.querySelector("oc-rail")?.props;
    const handlers = {
      chat: props?.onOpenChat,
      dashboard: props?.onOpenDashboard,
      tasks: props?.onOpenTasks,
      workspace: props?.onOpenWorkspace,
      extensions: props?.onOpenExtensions,
      settings: props?.onOpenSettings,
    };
    handlers[original.view]?.();
  };
  try {
    document.querySelector("oc-rail")?.props?.onOpenChat();
    await app.updateComplete;
    if (app.chatRunId) throw new Error("Frontend benchmark requires an idle chat");
    const ticks = String.fromCharCode(96).repeat(3);
    const base = Array.from({ length: 200 }, (_, index) => {
      const assistant = index % 2 === 1;
      const code = assistant
        ? "\\n\\n" + ticks + "ts\\ninterface Turn" + index + " { id: string; latency: number }\\nconst turn" + index + ": Turn" + index + " = { id: 'turn-" + index + "', latency: " + (12 + index) + " };\\nconsole.table(turn" + index + ");\\n" + ticks
        : "";
      return {
        id: "frontend-benchmark-" + index,
        role: assistant ? "assistant" : "user",
        timestamp: 1792800000000 + index * 1000,
        content: (assistant
          ? "### 分析 " + index + "\\n\\n这一段包含 **关键结论**、行内公式 $E=mc^2$，以及用于触发完整 Markdown 管线的[本地说明](https://example.com/" + index + ")。"
          : "请检查第 " + index + " 轮实现，保留交互、键盘导航和无障碍语义，并给出可验证的结果。") + code,
      };
    });
    app.chatToolMessages = [];
    app.chatVisibleMessageCount = 200;
    const coldStarted = performance.now();
    app.chatMessages = base;
    await settle();
    const coldMs = performance.now() - coldStarted;
    await new Promise((resolve) => setTimeout(resolve, 150));
    app.chatVisibleMessageCount = 20;
    app.chatMessages = base;
    await settle();
    const hydrationBatches = [];
    const hydrationCounts = [];
    for (let count = 20 + ${hydrationBatch}; count < 200; count += ${hydrationBatch}) hydrationCounts.push(count);
    hydrationCounts.push(200);
    for (const count of hydrationCounts) {
      const started = performance.now();
      app.chatVisibleMessageCount = count;
      await settle();
      hydrationBatches.push(performance.now() - started);
    }
    const hydrationMs = hydrationBatches.reduce((sum, value) => sum + value, 0);
    const samples = [];
    for (let index = 0; index < 15; index++) {
      app.chatMessages = base;
      await settle();
      const appended = {
        id: "frontend-benchmark-append-" + index,
        role: "user",
        timestamp: 1792801000000 + index * 1000,
        content: "追加消息 " + index + "：只应更新新消息与必要的线程状态。",
      };
      const started = performance.now();
      app.chatMessages = [...base, appended];
      await settle();
      samples.push(performance.now() - started);
    }
    const result = {
      messages: 201,
      groups: document.querySelectorAll(".chat-group").length,
      coldMs,
      hydrationBatch: ${hydrationBatch},
      hydrationMs,
      hydrationBatches,
      appendMs: samples,
      heapUsed: performance.memory?.usedJSHeapSize ?? null,
    };
    app.chatMessages = original.messages;
    app.chatToolMessages = original.tools;
    app.chatVisibleMessageCount = original.visible;
    restoreView();
    await app.updateComplete;
    return result;
  } catch (error) {
    app.chatMessages = original.messages;
    app.chatToolMessages = original.tools;
    app.chatVisibleMessageCount = original.visible;
    restoreView();
    await app.updateComplete;
    throw error;
  }
})()`;

async function runOnce({ exe, port, withChat, attached = false }) {
  const running = attached ? null : launch(exe, port);
  let ws, cdp;
  const result = { exceptions: [], consoleErrors: [] };
  try {
    const page = await waitForPageTarget(port, 120000);
    assert.ok(page, "Application page target");
    ({ ws, cdp } = await connect(page));
    await cdp.send("Page.bringToFront");
    if (withChat) {
      assert.ok(await waitForAppReady(cdp, { timeoutMs: 240000 }), "Initial app readiness");
      await dismissReleaseNotes(cdp);
      result.chat = await cdp.evaluate(chatBenchmark, { timeoutMs: 120000 });
    }
    await cdp.send("Performance.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: bootObserver });
    await cdp.send("Page.reload", { ignoreCache: true });
    const deadline = Date.now() + 30000;
    while (!await cdp.evaluate("window.__frontendBoot?.readyAt > 0")) {
      assert.ok(Date.now() < deadline, "Renderer readiness mark");
      await sleep(25);
    }
    await sleep(100);
    const metrics = await cdp.send("Performance.getMetrics");
    const values = Object.fromEntries(metrics.metrics.map((metric) => [metric.name, metric.value]));
    const row = await cdp.evaluate(`(() => {
      const navigation = performance.getEntriesByType("navigation")[0];
      const boot = window.__frontendBoot;
      const beforeReady = boot.longTasks.filter((entry) => entry.startTime < boot.readyAt);
      return {
        readyMs: boot.readyAt,
        domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? null,
        loadMs: navigation?.loadEventEnd ?? null,
        longTaskCount: beforeReady.length,
        longTaskTotalMs: beforeReady.reduce((sum, entry) => sum + entry.duration, 0),
        longestTaskMs: Math.max(0, ...beforeReady.map((entry) => entry.duration)),
      };
    })()`);
    row.performance = Object.fromEntries(["ScriptDuration", "TaskDuration", "LayoutDuration", "RecalcStyleDuration", "JSHeapUsedSize", "Nodes"].map((name) => [name, values[name] ?? 0]));
    result.boot = row;
    result.exceptions = cdp.exceptions;
    result.consoleErrors = cdp.consoleErrors;
    assert.deepEqual(result.exceptions, [], "Renderer exceptions");
    return result;
  } catch (error) {
    result.error = String(error.stack || error);
    if (cdp) result.debug = await cdp.evaluate(`({
      readyState: document.readyState,
      railItems: document.querySelectorAll(".oc-rail__item").length,
      text: document.body.innerText.slice(0, 500),
      url: location.href.replace(/([?&]token=)[^&]+/, "$1[redacted]"),
    })`).catch(() => null);
    throw error;
  } finally {
    if (running) await quitLaunchedApp(running, cdp);
    ws?.close();
  }
}

async function main() {
  const exe = path.resolve(arg(process.argv, "--exe", "C:/Users/binchen/AppData/Local/Programs/CryoClaw/CryoClaw.exe"));
  const runs = Number(arg(process.argv, "--runs", "3"));
  const attachedPort = arg(process.argv, "--attach-port", null);
  const attached = attachedPort !== null;
  const out = path.resolve(arg(process.argv, "--out", path.join("out", "frontend-performance", new Date().toISOString().replace(/[:.]/g, "-"))));
  if (!attached) assert.ok(fs.existsSync(exe), `Application does not exist: ${exe}`);
  assert.ok(Number.isInteger(runs) && runs >= 1 && runs <= 10, "--runs must be between 1 and 10");
  assert.ok(Number.isInteger(hydrationBatch) && hydrationBatch >= 1 && hydrationBatch <= 180, "--hydration-batch must be between 1 and 180");
  assert.ok(!attached || runs === 1, "--attach-port supports exactly one run");
  fs.mkdirSync(out, { recursive: true });
  const port = Number(attachedPort ?? arg(process.argv, "--port", "9294"));
  const report = { exe: attached ? `attach:${port}` : exe, label: arg(process.argv, "--label", "unlabeled"), runs: [], chat: null };
  try {
    for (let index = 0; index < runs; index++) {
      const result = await runOnce({ exe, port: attached ? port : port + index, withChat: index === 0, attached });
      report.runs.push(result.boot);
      if (result.chat) report.chat = result.chat;
      console.log(JSON.stringify({ run: index + 1, readyMs: result.boot.readyMs, scriptMs: result.boot.performance.ScriptDuration * 1000 }));
      fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
    }
    report.summary = {
      readyMedianMs: median(report.runs.map((row) => row.readyMs)),
      scriptMedianMs: median(report.runs.map((row) => row.performance.ScriptDuration * 1000)),
      longTaskTotalMedianMs: median(report.runs.map((row) => row.longTaskTotalMs)),
      chatColdMs: report.chat.coldMs,
      chatHydrationMs: report.chat.hydrationMs,
      chatAppendMedianMs: median(report.chat.appendMs),
    };
    assert.equal(report.chat.messages, 201);
    assert.ok(report.chat.groups >= 100, "Benchmark must render the full synthetic history");
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.error = String(error.stack || error);
    console.error(error);
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, summary: report.summary, out }));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
