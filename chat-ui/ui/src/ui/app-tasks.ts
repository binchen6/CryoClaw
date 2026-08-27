/**
 * 任务实时视图 —— 入口与 props 构建。
 * 从 app-render.ts 抽出（阶段 16 架构重构），逻辑未变。
 */

import { renderTasks } from "./views/tasks.ts";
import { loadTasks, cancelTask } from "./controllers/tasks.ts";
import { setCryoClawView } from "./app-view-switch.ts";
import { handleSessionChange } from "./app-session-actions.ts";
import type { AppViewState } from "./app-view-state.ts";

// 打开任务实时视图
export function openTasksView(state: AppViewState) {
  setCryoClawView(state, "tasks");
  void loadTasks(state);
}

export function renderTasksView(state: AppViewState) {
  return renderTasks({
    loading: state.tasksLoading,
    error: state.tasksError,
    tasks: state.tasks,
    statusFilter: state.tasksStatusFilter,
    cancellingIds: state.tasksCancellingIds,
    connected: state.connected,
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
