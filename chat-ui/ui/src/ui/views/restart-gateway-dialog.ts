import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.ts";
import { t } from "../i18n.ts";
import { runExitAnimation } from "../utils/exit-anim.ts";

// 重启 Gateway 确认弹窗
export function renderRestartGatewayDialog(state: AppViewState) {
  if (!state.showRestartGatewayDialog) return nothing;

  // 重启立即触发不等退场动画；弹窗沿来路淡出后再移除 DOM
  const handleRestart = () => {
    window.cryoclaw?.restartGateway?.();
    handleDismiss();
  };

  const handleDismiss = () => {
    runExitAnimation(document.querySelector(".cc-dialog-overlay"), () => {
      state.showRestartGatewayDialog = false;
    });
  };

  return html`
    <div class="cc-dialog-overlay" role="dialog" aria-modal="true" tabindex="-1">
      <div class="cc-dialog cc-dialog--sm">
        <div class="cc-dialog__head">
          <div class="cc-dialog__title">${t("restartDialog.title")}</div>
        </div>
        <div class="cc-dialog__body">${t("restartDialog.subtitle")}</div>
        <div class="cc-dialog__foot">
          <button class="btn" data-dialog-dismiss @click=${handleDismiss}>
            ${t("restartDialog.dismiss")}
          </button>
          <button class="btn primary" @click=${handleRestart}>
            ${t("restartDialog.restart")}
          </button>
        </div>
      </div>
    </div>
  `;
}
