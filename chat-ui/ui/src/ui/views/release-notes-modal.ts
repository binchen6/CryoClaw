import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.ts";
import { t } from "../i18n.ts";
import { icons } from "../icons.ts";

// "What's New" 弹窗：展示自上次打开以来的所有版本更新内容
export function renderReleaseNotesModal(state: AppViewState) {
  if (!state.showReleaseNotesModal || !state.releaseNotesData) return nothing;
  const { currentVersion, entries, locale } = state.releaseNotesData;
  if (!entries.length) return nothing;

  // 按用户语言取 notes，fallback 到 en
  const lang = locale.startsWith("zh") ? "zh" : "en";

  const handleDismiss = () => {
    state.dismissReleaseNotes();
  };

  return html`
    <div class="cc-dialog-overlay" role="dialog" aria-modal="true" @click=${handleDismiss}>
      <div class="cc-dialog release-notes-dialog" @click=${(e: Event) => e.stopPropagation()}>
        <div class="cc-dialog__head">
          <div style="flex: 1; min-width: 0;">
            <div class="cc-dialog__title">${t("releaseNotes.title")}</div>
            <div class="cc-dialog__subtitle">${t("releaseNotes.currentVersion")} ${currentVersion}</div>
          </div>
          <button class="cc-dialog__close" type="button" @click=${handleDismiss} aria-label=${t("releaseNotes.close")}>
            ${icons.x}
          </button>
        </div>

        <div class="cc-dialog__body release-notes-dialog__body">
          ${entries.map((entry) => html`
            <div class="release-notes-entry">
              <div class="release-notes-entry-version">${entry.version}</div>
              <div class="release-notes-entry-content">${entry.notes[lang as "zh" | "en"] ?? entry.notes.en ?? ""}</div>
            </div>
          `)}
        </div>

        <div class="cc-dialog__foot">
          <button class="btn primary" type="button" @click=${handleDismiss}>
            ${t("releaseNotes.ok")}
          </button>
        </div>
      </div>
    </div>
  `;
}
