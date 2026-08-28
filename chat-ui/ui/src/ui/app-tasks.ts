/**
 * 任务实时视图 —— 入口与 props 构建。
 * 从 app-render.ts 抽出（阶段 16 架构重构），逻辑未变。
 */

import { html } from "lit";
import { renderTasks, type TasksViewTab } from "./views/tasks.ts";
import { loadTasks, cancelTask } from "./controllers/tasks.ts";
import { loadCronJobs } from "./controllers/cron.ts";
import { isExpiredOneShot } from "./presenter.ts";
import { renderCronView } from "./app-cron.ts";
import { setCryoClawView } from "./app-view-switch.ts";
import { handleSessionChange } from "./app-session-actions.ts";
import type { AppViewState } from "./app-view-state.ts";

// 任务页 tab 模块态（对齐 app-skills 的 skillsSubTab 模式；视图切走不重置，
// 下次打开保留上次 tab）
let tasksViewTab: TasksViewTab = "runs";

// 打开任务实时视图（tab 缺省 runs；cron 时预拉定时任务列表）
export function openTasksView(state: AppViewState, tab: TasksViewTab = "runs") {
  tasksViewTab = tab;
  setCryoClawView(state, "tasks");
  void loadTasks(state);
  if (tab === "cron") {
    void loadCronJobs(state);
  }
}

export function renderTasksView(state: AppViewState) {
  return renderTasks({
    loading: state.tasksLoading,
    error: state.tasksError,
    tasks: state.tasks,
    statusFilter: state.tasksStatusFilter,
    cancellingIds: state.tasksCancellingIds,
    connected: state.connected,
    tab: tasksViewTab,
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
  });
}
