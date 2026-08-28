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
} from "./controllers/cron.ts";
import { DEFAULT_CRON_FORM } from "./app-defaults.ts";
import { handleSessionChange } from "./app-session-actions.ts";
import { showConfirm } from "./views/confirm-dialog.ts";
import { t } from "./i18n.ts";
import type { AppViewState } from "./app-view-state.ts";

// ── Cron 视图模块状态 ──
let cronExpandedJobId: string | null = null;
let cronRunsLoading = false;
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
      // 重复点击同一任务：收起，不重新拉取；同时清掉已加载的 runs，
      // 防止下次展开时在拉取完成前闪现旧数据
      if (cronExpandedJobId === jobId) {
        cronExpandedJobId = null;
        state.cronRunsJobId = null;
        state.cronRuns = [];
        state.requestUpdate();
        return;
      }
      cronExpandedJobId = jobId;
      cronShowForm = false;
      cronRunsLoading = true;
      state.requestUpdate();
      void loadCronRuns(state, jobId, () => cronExpandedJobId === jobId).finally(() => {
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
      }
    },
    onRun: (jobId: string) => {
      const job = state.cronJobs.find((j) => j.id === jobId);
      if (job) {
        void runCronJob(state, job).then(() => state.requestUpdate());
      }
    },
    onToggleForm: () => {
      cronShowForm = !cronShowForm;
      cronEditingJobId = null;
      if (cronShowForm) {
        cronExpandedJobId = null;
        state.cronForm = { ...DEFAULT_CRON_FORM };
      }
      state.requestUpdate();
    },
    onFormChange: (patch) => {
      state.cronForm = { ...state.cronForm, ...patch };
      state.requestUpdate();
    },
    onAddJob: () => {
      if (cronEditingJobId) {
        void updateCronJob(state, cronEditingJobId).then(() => {
          if (!state.cronError) {
            cronShowForm = false;
            cronEditingJobId = null;
          }
          state.requestUpdate();
        });
      } else {
        void addCronJob(state).then(() => {
          if (!state.cronError) {
            cronShowForm = false;
          }
          state.requestUpdate();
        });
      }
    },
    onEdit: (jobId: string) => {
      const job = state.cronJobs.find((j) => j.id === jobId);
      if (!job) return;
      cronEditingJobId = jobId;
      cronShowForm = true;
      cronExpandedJobId = null;
      // Detect daily pattern: "M H * * *" → convert to daily mode
      let editKind: string = job.schedule.kind;
      let editCronExpr = job.schedule.expr ?? "0 7 * * *";
      if (job.schedule.kind === "cron" && job.schedule.expr) {
        const dm = job.schedule.expr.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/);
        if (dm) {
          editKind = "daily";
          editCronExpr = `${dm[2].padStart(2, "0")}:${dm[1].padStart(2, "0")}`;
        }
      }
      // 间隔按量级换算单位：能整除天→days、小时→hours，否则 minutes（至少 1）
      const everyMs = job.schedule.everyMs ?? 0;
      let editEveryAmount = "30";
      let editEveryUnit = "minutes";
      if (everyMs > 0) {
        if (everyMs % 86400000 === 0) {
          editEveryUnit = "days";
          editEveryAmount = String(everyMs / 86400000);
        } else if (everyMs % 3600000 === 0) {
          editEveryUnit = "hours";
          editEveryAmount = String(everyMs / 3600000);
        } else {
          editEveryAmount = String(Math.max(1, Math.round(everyMs / 60000)));
        }
      }
      state.cronForm = {
        ...DEFAULT_CRON_FORM,
        name: job.name ?? "",
        scheduleKind: editKind as typeof state.cronForm.scheduleKind,
        scheduleAt: job.schedule.at ?? "",
        everyAmount: editEveryAmount,
        everyUnit: editEveryUnit,
        cronExpr: editCronExpr,
        cronTz: job.schedule.tz ?? "",
        payloadKind: job.payload.kind,
        payloadText: job.payload.message ?? job.payload.text ?? "",
        payloadModel: typeof job.payload.model === "string" ? job.payload.model : "",
        sessionTarget: typeof job.sessionTarget === "string" ? job.sessionTarget : "isolated",
        deliveryMode: job.delivery?.mode ?? "announce",
        deliveryChannel: job.delivery?.channel ?? "last",
        deliveryTo: job.delivery?.to ?? "",
      };
      state.requestUpdate();
    },
  });
}
