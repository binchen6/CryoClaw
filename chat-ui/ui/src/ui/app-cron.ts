/**
 * Cron 管理视图 —— 模块状态与 props 构建。
 * 从 app-render.ts 抽出（阶段 16 架构重构），逻辑未变。
 */

import { renderCronManage } from "./views/cron-manage.ts";
import {
  loadCronRuns,
  removeCronJob,
  toggleCronJob,
  runCronJob,
  addCronJob,
  updateCronJob,
  normalizeScheduleKindChange,
  cronJobToForm,
} from "./controllers/cron.ts";
import { DEFAULT_CRON_FORM } from "./app-defaults.ts";
import { handleSessionChange } from "./app-session-actions.ts";
import { showConfirm } from "./views/confirm-dialog.ts";
import { showToast } from "./app-toast.ts";
import { t } from "./i18n.ts";
import type { AppViewState } from "./app-view-state.ts";

// ── Cron 视图模块状态 ──
let cronExpandedJobId: string | null = null;
let cronRunsLoading = false;
let cronRunsLoadToken = 0;
let cronShowForm = false;
let cronEditingJobId: string | null = null;

export function renderCronView(state: AppViewState, opts?: { onOpenRunsTab?: () => void }) {
  return renderCronManage({
    jobs: state.cronJobs,
    loading: state.cronLoading,
    error: state.cronError,
    expandedJobId: cronExpandedJobId,
    runs: state.cronRuns,
    runsLoading: cronRunsLoading,
    busy: state.cronBusy,
    showForm: cronShowForm,
    editingJobId: cronEditingJobId,
    form: state.cronForm,
    channelMeta: state.channelsSnapshot?.channelMeta ?? [],
    models: state.configuredModels,
    onToggleExpand: (jobId: string) => {
      if (state.cronBusy) return;
      const token = ++cronRunsLoadToken;
      // 重复点击同一任务：收起，不重新拉取；同时清掉已加载的 runs，
      // 防止下次展开时在拉取完成前闪现旧数据
      if (cronExpandedJobId === jobId) {
        cronExpandedJobId = null;
        cronRunsLoading = false;
        state.cronRunsJobId = null;
        state.cronRuns = [];
        state.requestUpdate();
        return;
      }
      cronExpandedJobId = jobId;
      state.cronRunsJobId = null;
      state.cronRuns = [];
      state.cronError = null;
      cronShowForm = false;
      cronRunsLoading = true;
      state.requestUpdate();
      void loadCronRuns(state, jobId, () => cronExpandedJobId === jobId && token === cronRunsLoadToken).finally(() => {
        if (token !== cronRunsLoadToken) return;
        cronRunsLoading = false;
        state.requestUpdate();
      });
    },
    onNavigateToSession: (sessionKey: string) => {
      // 走完整会话切换（重置流态/拉历史/同步 URL），与侧边栏点击一致
      handleSessionChange(state, sessionKey);
    },
    onOpenRunsTab: opts?.onOpenRunsTab,
    onRemove: (jobId: string) => {
      const job = state.cronJobs.find((j) => j.id === jobId);
      if (job) {
        void (async () => {
          if (!(await showConfirm(state, t("cron.removeConfirm"), { danger: true }))) return;
          await removeCronJob(state, job);
          state.requestUpdate();
        })();
      }
    },
    onToggle: (jobId: string, enabled: boolean) => {
      const job = state.cronJobs.find((j) => j.id === jobId);
      if (job) {
        void toggleCronJob(state, job, enabled).then(() => state.requestUpdate());
        state.requestUpdate();
      }
    },
    onRun: (jobId: string) => {
      const job = state.cronJobs.find((j) => j.id === jobId);
      if (job) {
        // stale 守卫：Run-now 在途期间展开项可能已切换——仅当仍无展开项或展开的
        // 就是本任务时才落地刷新结果（对齐 onToggleExpand 的 isCurrent 语义）
        void runCronJob(state, job, () => cronExpandedJobId === null || cronExpandedJobId === jobId)
          .then(() => state.requestUpdate());
      }
      state.requestUpdate();
    },
    onToggleForm: () => {
      if (state.cronBusy) return;
      ++cronRunsLoadToken;
      cronRunsLoading = false;
      state.cronError = null;
      cronShowForm = !cronShowForm;
      cronEditingJobId = null;
      if (cronShowForm) {
        cronExpandedJobId = null;
        state.cronForm = { ...DEFAULT_CRON_FORM };
      }
      state.requestUpdate();
    },
    onFormChange: (patch) => {
      if (state.cronBusy) return;
      // 切换调度类型时归一化 cronExpr 语义（daily="HH:MM" ↔ cron 表达式）；
      // 见 controllers/cron.ts normalizeScheduleKindChange 的说明与用例。
      state.cronForm = normalizeScheduleKindChange(state.cronForm, patch);
      state.requestUpdate();
    },
    onAddJob: () => {
      if (state.cronBusy) return;
      if (cronEditingJobId) {
        void updateCronJob(state, cronEditingJobId).then((saved) => {
          if (saved && !state.cronError) {
            showToast(state, t("settings.saved"), undefined, "success");
            cronShowForm = false;
            cronEditingJobId = null;
          }
          state.requestUpdate();
        });
      } else {
        void addCronJob(state).then((saved) => {
          if (saved && !state.cronError) {
            showToast(state, t("settings.saved"), undefined, "success");
            cronShowForm = false;
          }
          state.requestUpdate();
        });
      }
      state.requestUpdate();
    },
    onEdit: (jobId: string) => {
      if (state.cronBusy) return;
      ++cronRunsLoadToken;
      cronRunsLoading = false;
      const job = state.cronJobs.find((j) => j.id === jobId);
      if (!job) return;
      state.cronError = null;
      cronEditingJobId = jobId;
      cronShowForm = true;
      cronExpandedJobId = null;
      state.cronForm = cronJobToForm(job, DEFAULT_CRON_FORM);
      state.requestUpdate();
    },
  });
}
