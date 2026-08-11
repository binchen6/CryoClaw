/**
 * 计划悬浮面板视图（update_plan 工具事件 → 聊天页右侧悬浮窗）。
 * 折叠态：胶囊（进度 + 当前步骤 + 状态点）；:hover / :focus-within 展开完整步骤列表。
 * 状态数据见 ../plan-stream.ts；样式见 styles/plan.css。
 */
import { html, nothing } from "lit";
import type { PlanStepStatus, PlanStreamState } from "../plan-stream.ts";
import { icons } from "../icons.ts";
import { t } from "../i18n.ts";

const STEP_STATUS_ICON: Record<PlanStepStatus, string> = {
  completed: "✓",
  in_progress: "▶",
  pending: "○",
};

export type PlanPanelProps = {
  sessionKey: string;
  onDismiss?: () => void;
};

export function renderPlanPanel(plan: PlanStreamState | null | undefined, props: PlanPanelProps) {
  if (!plan || plan.dismissed || plan.steps.length === 0) {
    return nothing;
  }
  // 会话隔离兜底：状态归属其它会话时不渲染（session-transition 也会清空）
  if (plan.sessionKey && plan.sessionKey !== props.sessionKey) {
    return nothing;
  }

  const total = plan.steps.length;
  const done = plan.steps.filter((step) => step.status === "completed").length;
  const allDone = done === total;
  const current = plan.steps.find((step) => step.status === "in_progress");

  return html`
    <div
      class="plan-panel ${allDone ? "plan-panel--done" : ""}"
      tabindex="0"
      role="region"
      aria-label=${t("plan.title")}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          props.onDismiss?.();
        }
      }}
    >
      <div class="plan-panel__pill">
        <span
          class="plan-panel__dot ${allDone ? "plan-panel__dot--done" : current ? "plan-panel__dot--active" : ""}"
          aria-hidden="true"
        ></span>
        <span class="plan-panel__progress">${done}/${total}${allDone ? " ✓" : ""}</span>
        ${current
          ? html`<span class="plan-panel__current">${current.step}</span>`
          : nothing}
      </div>
      <div class="plan-panel__body">
        <div class="plan-panel__header">
          <span class="plan-panel__title">${t("plan.title")}</span>
          <span class="plan-panel__count">${done}/${total}</span>
          <button
            class="plan-panel__close"
            type="button"
            aria-label=${t("plan.dismiss")}
            @click=${(e: Event) => {
              e.stopPropagation();
              props.onDismiss?.();
            }}
          >
            ${icons.x}
          </button>
        </div>
        ${plan.explanation
          ? html`<div class="plan-panel__explanation">${plan.explanation}</div>`
          : nothing}
        <ol class="plan-panel__steps">
          ${plan.steps.map(
            (step) => html`
              <li class="plan-panel__step plan-panel__step--${step.status}">
                <span class="plan-panel__step-icon" aria-hidden="true">${STEP_STATUS_ICON[step.status]}</span>
                <span class="plan-panel__step-text">${step.step}</span>
              </li>
            `,
          )}
        </ol>
      </div>
    </div>
  `;
}
