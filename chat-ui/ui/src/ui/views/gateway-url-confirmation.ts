import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.ts";
import { t } from "../i18n.ts";

export function renderGatewayUrlConfirmation(state: AppViewState) {
  const { pendingGatewayUrl } = state;
  if (!pendingGatewayUrl) {
    return nothing;
  }

  return html`
    <div class="cc-dialog-overlay" role="dialog" aria-modal="true" aria-live="polite">
      <div class="cc-dialog cc-dialog--sm">
        <div class="cc-dialog__head">
          <div class="cc-dialog__title">${t("gatewayUrl.title")}</div>
        </div>
        <div class="cc-dialog__body">
          <div>${t("gatewayUrl.subtitle")}</div>
          <div class="cc-dialog__code">${pendingGatewayUrl}</div>
          <div class="callout danger oc-mt-12">
            ${t("gatewayUrl.warning")}
          </div>
        </div>
        <div class="cc-dialog__foot">
          <button
            class="btn"
            @click=${() => state.handleGatewayUrlCancel()}
          >
            ${t("settings.cancel")}
          </button>
          <button
            class="btn primary"
            @click=${() => state.handleGatewayUrlConfirm()}
          >
            ${t("settings.confirm")}
          </button>
        </div>
      </div>
    </div>
  `;
}
