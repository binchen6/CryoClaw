import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.ts";
import { t } from "../i18n.ts";

// 重启 Gateway 确认弹窗
export function renderRestartGatewayDialog(state: AppViewState) {
  if (!state.showRestartGatewayDialog) return nothing;

  const handleRestart = () => {
    state.showRestartGatewayDialog = false;
    window.cryoclaw?.restartGateway?.();
  };

  const handleDismiss = () => {
    state.showRestartGatewayDialog = false;
  };

  return html`
    <div class="cc-dialog-overlay" role="dialog" aria-modal="true">
      <div class="cc-dialog cc-dialog--sm">
        <div class="cc-dialog__head">
          <div class="cc-dialog__title">${t("restartDialog.title")}</div>
        </div>
        <div class="cc-dialog__body">${t("restartDialog.subtitle")}</div>
        <div class="cc-dialog__foot">
          <button class="btn" @click=${handleDismiss}>
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
