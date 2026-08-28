import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function src(rel: string): string {
  return readFileSync(new URL(`../../../../src/ui/${rel}`, import.meta.url), "utf8");
}

test("views/tasks.ts：顶层双 tab 栏（运行记录/定时任务）", () => {
  const s = src("views/tasks.ts");
  assert.match(s, /"tasks\.runsTab"/, "缺少运行记录 tab 文案");
  assert.match(s, /"tasks\.cronTab"/, "缺少定时任务 tab 文案");
  assert.match(s, /props\.tab === "cron" \? props\.cronSlot/, "定时 tab 应渲染 cronSlot");
  assert.match(s, /props\.cronJobCount > 0/, "定时 tab 应有启用中任务数徽标");
});

test("views/tasks.ts：runtime==='cron' 任务卡显示来源并可跳定时 tab", () => {
  const s = src("views/tasks.ts");
  assert.match(s, /task\.runtime === "cron"/, "缺少 cron 运行时分支");
  assert.match(s, /props\.onOpenCronTab\(\)/, "任务卡缺少跳定时 tab 的点击接线");
  assert.match(s, /"tasks\.viewCronJob"/, "缺少「查看定时任务」文案");
  assert.match(s, /cronSourceName\(props, task\)/, "任务卡应反查来源定时任务名");
  assert.match(s, /"tasks\.cronSource"/, "缺少来源名文案");
});

test("app-tasks.ts：openTasksView 支持 tab 参数并预拉对应数据", () => {
  const s = src("app-tasks.ts");
  assert.match(s, /export function openTasksView\(state: AppViewState, tab: TasksViewTab = "runs"\)/, "openTasksView 应带 tab 参数");
  assert.match(s, /tab === "cron"/, "定时 tab 应预拉 loadCronJobs");
  assert.match(s, /loadCronJobs\(state\)/, "缺少 loadCronJobs 调用");
});

test("app-render.ts：onOpenCron 路由到任务页定时 tab", () => {
  const s = src("app-render.ts");
  assert.match(s, /onOpenCron: \(\) => openTasksView\(state, "cron"\)/, "onOpenCron 应打开任务页定时 tab");
});

test("app-cron.ts：onOpenRunsTab 不默认空函数（暂留视图不渲染无效按钮）", () => {
  const s = src("app-cron.ts");
  assert.match(s, /onOpenRunsTab: opts\?\.onOpenRunsTab,/, "不应有 ?? (() => {}) 兜底");
});

test("cron-manage：详情「最近运行」链回运行记录 tab", () => {
  const s = src("views/cron-manage.ts");
  assert.match(s, /onOpenRunsTab\?: \(\) => void/, "CronManageProps 应有 onOpenRunsTab");
  assert.match(s, /props\.onOpenRunsTab!\(\)/, "run 卡缺少跳运行记录 tab 接线");
  assert.match(s, /"cron\.viewRuns"/, "缺少「在运行记录中查看」文案");
});

test("i18n：新 key 双区齐全", () => {
  const zh = src("i18n/zh.ts");
  const en = src("i18n/en.ts");
  for (const key of ['"tasks.runsTab"', '"tasks.cronTab"', '"tasks.viewCronJob"', '"tasks.cronSource"', '"cron.viewRuns"']) {
    assert.ok(zh.includes(key), `zh.ts 缺少 ${key}`);
    assert.ok(en.includes(key), `en.ts 缺少 ${key}`);
  }
});
