/**
 * 任务实时视图 —— 入口与 props 构建。
 * 从 app-render.ts 抽出（阶段 16 架构重构），逻辑未变。
 * R92：新增 30s 自动刷新生命周期（startTasksAutoRefresh/stopTasksAutoRefresh）
 * 与 R92 视图 props（autoRefresh/onAutoRefreshChange/requestUpdate）装配。
 */

import { html } from "lit";
import { renderTasks, type TasksViewTab } from "./views/tasks.ts";
import { loadTasks, cancelTask } from "./controllers/tasks.ts";
import { loadCronJobs } from "./controllers/cron.ts";
import { isExpiredOneShot } from "./presenter.ts";
import { renderCronView } from "./app-cron.ts";
import { setCryoClawView, registerViewLeaveHook } from "./app-view-switch.ts";
import { handleSessionChange } from "./app-session-actions.ts";
import type { AppViewState } from "./app-view-state.ts";

// 任务页 tab 模块态（对齐 app-skills 的 skillsSubTab 模式；视图切走不重置，
// 仅「在运行记录中查看」等内部跳转会改写；侧边栏任务入口每次打开固定回 runs）
let tasksViewTab: TasksViewTab = "runs";

// ── R92：30s 自动刷新 ──────────────────────────────────────────────────
// 触发条件 a)：任务视图是当前活跃视图 —— 用生命周期保证：进入视图起 ticker，
// 离开视图（registerViewLeaveHook，见文件底部）即停，ticker 不可能在视图
// 不活跃时存活；条件 b) document.visibilityState === "visible" 在 tick 内检查。
// 开关本身是视图私有偏好（模块级，默认开），不入 AppViewState/settings。
const TASKS_AUTO_REFRESH_MS = 30_000;

let tasksAutoRefreshEnabled = true; // 用户开关（默认开）
let tasksAutoRefreshTimer: number | null = null;
let tasksAutoRefreshState: AppViewState | null = null; // 总是记住最新 state 引用

function runTasksAutoRefreshTick() {
  // 条件 b)：页面不可见时跳过本轮（后台标签页不空转打网关；恢复可见后由
  // 下一轮 tick 或手动刷新补齐），重渲染也一并跳过（隐藏页无更新意义）
  if (document.visibilityState !== "visible") {
    return;
  }
  const state = tasksAutoRefreshState;
  if (!state) {
    return;
  }
  // 条件 a) 自愈复核（R91 三审）：applySettings 直写视图（bindAppNavigation /
  // URL 注入）不经过 setCryoClawView，leave hook 不会触发——ticker 在此
  // 自查当前视图，已切走即自停，防 30s 轮询泄漏为常驻
  if (state.settings.cryoclawView !== "tasks") {
    stopTasksAutoRefresh();
    return;
  }
  void loadTasks(state); // 与 onRefresh 同一数据路径（tasks.list 全量拉取）
  // tick 顺带 requestUpdate 一次：进行中任务耗时（taskDurationMs 基于
  // Date.now()）随 tick 滚动，不另开 1s 定时器
  state.requestUpdate();
}

/** 启动任务自动刷新（幂等）：开关关闭或 ticker 已在跑时只更新 state 引用 */
export function startTasksAutoRefresh(state: AppViewState) {
  tasksAutoRefreshState = state;
  if (!tasksAutoRefreshEnabled || tasksAutoRefreshTimer != null) {
    return;
  }
  tasksAutoRefreshTimer = window.setInterval(runTasksAutoRefreshTick, TASKS_AUTO_REFRESH_MS);
}

/** 停止任务自动刷新（幂等）：离开任务视图 / 用户关闭开关时调用 */
export function stopTasksAutoRefresh() {
  if (tasksAutoRefreshTimer == null) {
    return;
  }
  window.clearInterval(tasksAutoRefreshTimer);
  tasksAutoRefreshTimer = null;
}

// 离开任务视图即停 ticker（条件 a) 的离开半边；进入半边在
// openTasksView / renderTasksView 调 startTasksAutoRefresh）
registerViewLeaveHook("tasks", () => stopTasksAutoRefresh());

// 打开任务实时视图（tab 缺省 runs；cron 时预拉定时任务列表）
export function openTasksView(state: AppViewState, tab: TasksViewTab = "runs") {
  tasksViewTab = tab;
  setCryoClawView(state, "tasks");
  void loadTasks(state);
  if (tab === "cron") {
    void loadCronJobs(state);
  }
  startTasksAutoRefresh(state);
}

export function renderTasksView(state: AppViewState) {
  // 幂等兜底：设置里持久化的 cryoclawView 可能在不经过 openTasksView 的情况
  // 下直接渲染任务视图（如启动恢复），渲染期顺手确保 ticker 与开关一致
  startTasksAutoRefresh(state);
  return renderTasks({
    loading: state.tasksLoading,
    error: state.tasksError,
    tasks: state.tasks,
    cronJobs: state.cronJobs,
    statusFilter: state.tasksStatusFilter,
    cancellingIds: state.tasksCancellingIds,
    connected: state.connected,
    tab: tasksViewTab,
    autoRefresh: tasksAutoRefreshEnabled,
    cronJobCount: state.cronJobs.filter((j) => j.enabled !== false && !isExpiredOneShot(j)).length,
    // 仅定时 tab 活跃时才构建 cron 内容（runs tab 每帧渲染不白花成本）
    cronSlot: tasksViewTab === "cron"
      ? renderCronView(state, {
          onOpenRunsTab: () => {
            tasksViewTab = "runs";
            state.requestUpdate();
          },
        })
      : html``,
    onTabChange: (tab) => {
      tasksViewTab = tab;
      if (tab === "cron") {
        void loadCronJobs(state);
      }
      state.requestUpdate();
    },
    onOpenCronTab: () => {
      tasksViewTab = "cron";
      void loadCronJobs(state);
      state.requestUpdate();
    },
    onStatusFilterChange: (status) => {
      // 状态过滤是纯客户端筛选（views/tasks 内 filter），无需重新拉取
      state.tasksStatusFilter = status;
      state.requestUpdate();
    },
    onRefresh: () => {
      void loadTasks(state);
    },
    onCancel: (taskId) => {
      void cancelTask(state, taskId);
    },
    onOpenChat: (sessionKey) => {
      // 走完整会话切换（重置流态/拉历史/同步 URL），与侧边栏点击一致
      handleSessionChange(state, sessionKey);
    },
    onAutoRefreshChange: (enabled) => {
      tasksAutoRefreshEnabled = enabled;
      if (enabled) {
        startTasksAutoRefresh(state);
      } else {
        stopTasksAutoRefresh();
      }
      state.requestUpdate();
    },
    requestUpdate: () => state.requestUpdate(),
  });
}
