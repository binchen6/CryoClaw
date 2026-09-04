import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.ts";
import { t } from "../i18n.ts";
import { icons } from "../icons.ts";

export function renderSharePrompt(state: AppViewState) {
  if (!state.sharePromptVisible) {
    return nothing;
  }

  const handleInput = (event: Event) => {
    const target = event.target as HTMLTextAreaElement | null;
    if (!target) {
      return;
    }
    state.sharePromptText = target.value;
    state.sharePromptCopied = false;
    state.sharePromptCopyError = null;
  };

  return html`
    <div class="cc-dialog-overlay" role="dialog" aria-modal="true" aria-live="polite">
      <div class="cc-dialog cc-dialog--lg">
        <div class="cc-dialog__head">
          <div style="flex: 1; min-width: 0;">
            <div class="cc-dialog__title">${state.sharePromptTitle}</div>
            <div class="cc-dialog__subtitle">${state.sharePromptSubtitle}</div>
          </div>
          <button
            class="cc-dialog__close"
            type="button"
            aria-label=${t("sharePrompt.close")}
            data-tooltip=${t("sharePrompt.close")}
            @click=${() => state.dismissSharePrompt()}
          >
            ${icons.x}
          </button>
        </div>
        <div class="cc-dialog__body">
          <textarea
            class="cc-dialog__textarea"
            .value=${state.sharePromptText}
            @input=${handleInput}
            spellcheck="false"
            aria-label=${state.sharePromptTitle || t("sharePrompt.title")}
          ></textarea>
          ${state.sharePromptCopyError
            ? html`<div class="callout danger oc-mt-12">${state.sharePromptCopyError}</div>`
            : nothing}
        </div>
        <div class="cc-dialog__foot">
          <button
            class="btn primary"
            @click=${() => state.handleSharePromptCopy()}
          >
            ${state.sharePromptCopied ? t("sharePrompt.copied") : t("sharePrompt.copy")}
          </button>
        </div>
      </div>
    </div>
  `;
}
