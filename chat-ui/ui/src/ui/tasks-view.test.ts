import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  collectAgentIds,
  deriveTaskStats,
  filterTasksByQuery,
  filterTasksByRuntime,
  taskGroupOfStatus,
} from "./controllers/tasks.ts";
import type { TaskSummary } from "./types.ts";

function src(rel: string): string {
  return readFileSync(new URL(`../../../../src/ui/${rel}`, import.meta.url), "utf8");
}

// 剥掉块注释与行注释：负向断言只针对真实代码，防注释中的字样误匹配
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// 构造最小任务行（仅填 id + 可选字段），供纯函数测试用
function task(partial: Partial<TaskSummary> & { id: string }): TaskSummary {
  return { ...partial };
}

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

// ── R92：纯函数功能测试 ─────────────────────────────────────────────

test("R92 deriveTaskStats：混合状态计数（active=queued+running / failed=failed+timed_out / other 含未知）", () => {
  const tasks: TaskSummary[] = [
    task({ id: "a", status: "queued" }),
    task({ id: "b", status: "running" }),
    task({ id: "c", status: "running" }),
    task({ id: "d", status: "completed" }),
    task({ id: "e", status: "completed" }),
    task({ id: "f", status: "failed" }),
    task({ id: "g", status: "timed_out" }),
    task({ id: "h", status: "cancelled" }),
    task({ id: "i" }), // status 缺省 → 按 queued 归进行中（与 isActiveTask 语义一致）
    task({ id: "j", status: "weird" as unknown as TaskSummary["status"] }), // 未知状态字符串 → other
  ];
  const stats = deriveTaskStats(tasks);
  assert.equal(stats.active, 4, "进行中应为 queued+running+缺省 共 4");
  assert.equal(stats.completed, 2);
  assert.equal(stats.failed, 2, "失败应为 failed+timed_out 共 2");
  assert.equal(stats.other, 2, "其他应为 cancelled+未知状态 共 2");
  assert.equal(stats.total, 10);
  // 分组归并辅助：单状态 → 分组
  assert.equal(taskGroupOfStatus("running"), "active");
  assert.equal(taskGroupOfStatus("timed_out"), "failed");
  assert.equal(taskGroupOfStatus("cancelled"), "other");
  assert.equal(taskGroupOfStatus(undefined), "active", "缺省状态按 queued 归进行中");
});

test("R92 filterTasksByQuery：title/kind/runtime/agentId/sessionKey 命中 + 大小写不敏感 + trim", () => {
  const tasks: TaskSummary[] = [
    task({ id: "1", title: "Deploy Nightly", kind: "deploy" }),
    task({ id: "2", agentId: "agent-ALPHA" }),
    task({ id: "3", sessionKey: "sess/beta/main" }),
    task({ id: "4", runtime: "cron", title: "housekeeping" }),
  ];
  assert.deepEqual(
    filterTasksByQuery(tasks, "  nightly  ").map((x) => x.id),
    ["1"],
    "title 命中且两侧 trim",
  );
  assert.deepEqual(
    filterTasksByQuery(tasks, "AGENT-alpha").map((x) => x.id),
    ["2"],
    "agentId 命中且大小写不敏感",
  );
  assert.deepEqual(
    filterTasksByQuery(tasks, "BETA").map((x) => x.id),
    ["3"],
    "sessionKey 命中",
  );
  assert.deepEqual(
    filterTasksByQuery(tasks, "cron").map((x) => x.id),
    ["4"],
    "runtime 命中",
  );
  assert.deepEqual(
    filterTasksByQuery(tasks, "deploy").map((x) => x.id),
    ["1"],
    "kind 命中",
  );
  // 空查询（含纯空白）原样返回，不做过滤
  assert.equal(filterTasksByQuery(tasks, "").length, 4);
  assert.equal(filterTasksByQuery(tasks, "   ").length, 4);
  // 无命中
  assert.deepEqual(filterTasksByQuery(tasks, "nonexistent"), []);
});

test("R92 filterTasksByRuntime：unknown 匹配缺省/未知来源，all 原样返回", () => {
  const tasks: TaskSummary[] = [
    task({ id: "1", runtime: "subagent" }),
    task({ id: "2", runtime: "cron" }),
    task({ id: "3" }), // runtime 缺省 → unknown
    task({ id: "4", runtime: "weird" as unknown as TaskSummary["runtime"] }), // 未知字符串 → unknown
  ];
  assert.equal(filterTasksByRuntime(tasks, "all").length, 4);
  assert.deepEqual(
    filterTasksByRuntime(tasks, "cron").map((x) => x.id),
    ["2"],
  );
  assert.deepEqual(
    filterTasksByRuntime(tasks, "unknown").map((x) => x.id),
    ["3", "4"],
    "unknown 应匹配缺省与未知来源",
  );
});

test("R92 collectAgentIds：trim 去空、去重、字典序排序", () => {
  const tasks: TaskSummary[] = [
    task({ id: "1", agentId: "beta" }),
    task({ id: "2", agentId: "alpha" }),
    task({ id: "3", agentId: "beta " }), // trim 后与 "beta" 重复
    task({ id: "4", agentId: "   " }), // 纯空白 → 丢弃
    task({ id: "5" }), // 缺省 → 丢弃
  ];
  assert.deepEqual(collectAgentIds(tasks), ["alpha", "beta"]);
  assert.deepEqual(collectAgentIds([]), []);
});

// ── R92：源码断言（接线完整性） ─────────────────────────────────────

test("R92 views/tasks.ts：统计条/搜索/来源与 Agent 筛选/自动刷新开关接线", () => {
  const s = stripComments(src("views/tasks.ts"));
  for (const key of [
    '"tasks.stats.active"',
    '"tasks.stats.completed"',
    '"tasks.stats.failed"',
    '"tasks.stats.other"',
    '"tasks.searchPlaceholder"',
    '"tasks.runtimeAll"',
    '"tasks.agentAll"',
    '"tasks.autoRefresh"',
    '"tasks.retry"',
    '"tasks.expand"',
    '"tasks.collapse"',
    '"tasks.noMatch"',
    '"tasks.showAll"',
  ]) {
    assert.ok(s.includes(key), `views/tasks.ts 缺少 ${key}`);
  }
  assert.match(s, /oc-toggle-switch/, "自动刷新应使用 oc-toggle-switch 组件");
  assert.match(s, /deriveTaskStats\(/, "统计条应调用 deriveTaskStats");
  assert.match(s, /filterTasksByQuery\(/, "搜索应走 filterTasksByQuery 纯函数");
  assert.match(s, /filterTasksByRuntime\(/, "来源筛选应走 filterTasksByRuntime 纯函数");
  assert.match(s, /collectAgentIds\(/, "Agent 选项应走 collectAgentIds 纯函数");
  // 防抖：setTimeout 200ms（SEARCH_DEBOUNCE_MS），每键不直接 requestUpdate
  assert.match(s, /SEARCH_DEBOUNCE_MS = 200/, "搜索防抖应为 200ms");
  assert.match(s, /clearTimeout\(tasksSearchTimer\)/, "重复输入应先清旧 timer");
  // 展开态：模块级 Set 记 task.id
  assert.match(s, /tasksExpandedErrorIds/, "失败详情展开态应记模块级 Set");
});

test("R92 app-tasks.ts：30s 自动刷新生命周期（start/stop + 离开钩子 + 可见性检查）", () => {
  const s = stripComments(src("app-tasks.ts"));
  assert.match(s, /export function startTasksAutoRefresh\(/, "应导出 startTasksAutoRefresh");
  assert.match(s, /export function stopTasksAutoRefresh\(/, "应导出 stopTasksAutoRefresh");
  assert.match(s, /registerViewLeaveHook\("tasks"/, "离开任务视图应挂 registerViewLeaveHook");
  assert.match(s, /TASKS_AUTO_REFRESH_MS = 30_000/, "自动刷新周期应为 30s");
  assert.match(s, /document\.visibilityState !== "visible"/, "tick 应检查页面可见性");
  assert.match(s, /state\.requestUpdate\(\);/, "tick 应 requestUpdate 滚动耗时显示");
});
