/**
 * 任务实时视图 —— 入口与 props 构建。
 * 从 app-render.ts 抽出（阶段 16 架构重构），逻辑未变。
 */

import { renderTasks } from "./views/tasks.ts";
import { loadTasks, cancelTask } from "./controllers/tasks.ts";
import { setCryoClawView } from "./app-view-switch.ts";
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
      state.tasksStatusFilter = status;
      state.requestUpdate();
      void loadTasks(state);
    },
    onRefresh: () => {
      void loadTasks(state);
    },
    onCancel: (taskId) => {
      void cancelTask(state, taskId);
    },
    onOpenChat: (sessionKey) => {
      setCryoClawView(state, "chat");
      state.applySettings({
        ...state.settings,
        sessionKey,
        cryoclawView: "chat",
      });
    },
  });
}
