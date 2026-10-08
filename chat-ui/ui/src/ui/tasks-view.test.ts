import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function src(rel: string): string {
  return readFileSync(new URL(`../../../../src/ui/${rel}`, import.meta.url), "utf8");
}

// 剥掉块注释与行注释：负向断言只针对真实代码，防注释中的字样误匹配
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// ── 2026.9.7 适配：运行记录 = cron.runs scope:"all" ────────────────────

test("registry：cron 视图 id 已删除（cron 能力收敛进 tasks 定时 tab）", () => {
  const code = stripComments(src("views/registry.ts"));
  assert.ok(!/"cron",/.test(code), "cron 视图 id 应已删除");
});

test("views/tasks.ts：顶层双 tab 栏（运行记录/定时任务）", () => {
  const s = src("views/tasks.ts");
  assert.match(s, /"tasks\.runsTab"/, "缺少运行记录 tab 文案");
  assert.match(s, /"tasks\.cronTab"/, "缺少定时任务 tab 文案");
  assert.match(s, /props\.tab === "cron" \? props\.cronSlot/, "定时 tab 应渲染 cronSlot");
  assert.match(s, /props\.cronJobCount > 0/, "定时 tab 应有启用中任务数徽标");
});

test("views/tasks.ts：任务页不得再调用已移除的 tasks.* 接口", () => {
  const s = stripComments(src("views/tasks.ts"));
  assert.ok(!/tasks\.list|tasks\.cancel/.test(s), "views/tasks.ts 不得引用 tasks.* RPC");
  assert.ok(!/props\.onCancel/.test(s), "取消按钮应随 tasks.cancel 一并移除");
});

test("controllers/tasks.ts：数据源为 cron.runs scope:all，且不得残留 tasks.* 调用", () => {
  const s = stripComments(src("controllers/tasks.ts"));
  assert.match(s, /"cron\.runs"/, "运行记录应走 cron.runs");
  assert.match(s, /scope: "all"/, "应使用 scope:all 拉全局运行历史");
  assert.ok(!/request(?:<[^>]*>)?\(\s*["']tasks\./.test(s), "不得残留 tasks.* RPC 调用");
  assert.ok(!/applyTaskEvent/.test(s), "task 事件合并逻辑应已删除");
});

test("views/tasks.ts：运行记录行显示任务名并可跳定时 tab / 打开会话", () => {
  const s = src("views/tasks.ts");
  assert.match(s, /props\.onOpenCronTab\(\)/, "记录行缺少跳定时 tab 的点击接线");
  assert.match(s, /"tasks\.viewCronJob"/, "缺少「查看定时任务」文案");
  assert.match(s, /props\.onOpenChat\(sessionKey\)/, "记录行缺少打开会话接线");
  assert.match(s, /run\.jobName/, "记录标题应使用内核附带的 jobName");
});

test("app-tasks.ts：openTasksView 支持 tab 参数并预拉对应数据", () => {
  const s = src("app-tasks.ts");
  assert.match(s, /export function openTasksView\(state: AppViewState, tab: TasksViewTab = "runs"\)/, "openTasksView 应带 tab 参数");
  assert.match(s, /loadCronJobs\(state\)/, "缺少 loadCronJobs 调用");
  assert.match(s, /loadRunHistory\(state\)/, "缺少 loadRunHistory 调用");
});

test("app-gateway.ts：task 事件分支已替换为 cron 事件分支", () => {
  const s = stripComments(src("app-gateway.ts"));
  assert.ok(!/evt\.event === "task"/.test(s), "task 事件分支应已删除");
  assert.match(s, /evt\.event === "cron"/, "应有 cron 事件分支");
  assert.match(s, /loadRunHistory\(/, "cron 事件应触发运行历史刷新");
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
  for (const key of [
    '"tasks.runsTab"',
    '"tasks.cronTab"',
    '"tasks.viewCronJob"',
    '"tasks.status.ok"',
    '"tasks.status.error"',
    '"tasks.status.skipped"',
    '"tasks.noRuns"',
    '"tasks.unknownJob"',
    '"tasks.stats.ok"',
    '"tasks.stats.error"',
    '"tasks.stats.skipped"',
    '"tasks.stats.other"',
    '"cron.viewRuns"',
  ]) {
    assert.ok(zh.includes(key), `zh.ts 缺少 ${key}`);
    assert.ok(en.includes(key), `en.ts 缺少 ${key}`);
  }
});

// ── R92：源码断言（接线完整性） ─────────────────────────────────────

test("R92 views/tasks.ts：统计条/搜索/状态筛选/自动刷新开关接线", () => {
  const s = stripComments(src("views/tasks.ts"));
  for (const key of [
    '"tasks.stats.ok"',
    '"tasks.stats.error"',
    '"tasks.stats.skipped"',
    '"tasks.stats.other"',
    '"tasks.searchPlaceholder"',
    '"tasks.autoRefresh"',
    '"tasks.retry"',
    '"tasks.expand"',
    '"tasks.collapse"',
    '"tasks.noMatch"',
  ]) {
    assert.ok(s.includes(key), `views/tasks.ts 缺少 ${key}`);
  }
  assert.match(s, /oc-toggle-switch/, "自动刷新应使用 oc-toggle-switch 组件");
  assert.match(s, /deriveRunStats\(/, "统计条应调用 deriveRunStats");
  assert.match(s, /filterRunsByQuery\(/, "搜索应走 filterRunsByQuery 纯函数");
  // 防抖：setTimeout 200ms（SEARCH_DEBOUNCE_MS），每键不直接 requestUpdate
  assert.match(s, /SEARCH_DEBOUNCE_MS = 200/, "搜索防抖应为 200ms");
  assert.match(s, /clearTimeout\(runsSearchTimer\)/, "重复输入应先清旧 timer");
  // 展开态：模块级 Set 记运行记录 key
  assert.match(s, /runsExpandedErrorKeys/, "失败详情展开态应记模块级 Set");
});

test("R92 app-tasks.ts：30s 自动刷新生命周期（start/stop + 离开钩子 + 可见性检查）", () => {
  const s = stripComments(src("app-tasks.ts"));
  assert.match(s, /export function startTasksAutoRefresh\(/, "应导出 startTasksAutoRefresh");
  assert.match(s, /export function stopTasksAutoRefresh\(/, "应导出 stopTasksAutoRefresh");
  assert.match(s, /registerViewLeaveHook\("tasks"/, "离开任务视图应挂 registerViewLeaveHook");
  assert.match(s, /TASKS_AUTO_REFRESH_MS = 30_000/, "自动刷新周期应为 30s");
  assert.match(s, /document\.visibilityState !== "visible"/, "tick 应检查页面可见性");
});

test("下游降级：侧边栏角标/删除守卫/子代理卡无数据源后不再引用 tasks 助手", () => {
  const render = stripComments(src("app-render.ts"));
  assert.ok(!/activeTaskSessionKeys|isActiveTask/.test(render), "app-render 不应再引用任务助手");
  assert.match(render, /NO_ACTIVE_TASK_SESSIONS/, "会话删除守卫应退化为恒空集");
  const sessionActions = stripComments(src("app-session-actions.ts"));
  assert.ok(!/findActiveTaskForSession/.test(sessionActions), "会话删除守卫应已移除");
  const worktrees = stripComments(src("app-worktrees.ts"));
  assert.ok(!/findActiveTaskForSession/.test(worktrees), "worktree 删除守卫应已移除");
  const chatProps = stripComments(src("app-chat-props.ts"));
  assert.ok(!/state\.tasks\b/.test(chatProps), "子代理状态卡数据源应恒为空数组");
});
