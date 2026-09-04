import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.ts";
import { getLocale, t, tWithDetail } from "../i18n.ts";
import { icons } from "../icons.ts";

// 「发现新版本」弹窗：启动自动检查发现新版本时弹出（暂缓期内主进程不检查，不会到这）。
// 状态流转（同一弹窗内完成）：
//   available   → 更新日志 + [立即更新] [暂缓 ▾]
//   downloading → 进度条（下载由「立即更新」触发，autoDownload=false）
//   downloaded  → [重启安装]（安装器带进度条窗口，非静默）
// 点 X / overlay = 本次会话稍后提醒（同版本不再自动弹；主进程启动检查仍会按暂缓跳过）。
export function renderUpdateAvailableDialog(state: AppViewState) {
  if (!state.showUpdateDialog) return nothing;
  const us = state.appUpdateDialog;
  if (!us || !us.version) return nothing;
  const lang = getLocale().startsWith("zh") ? "zh" : "en";
  const notes = us.releaseNotes ? (us.releaseNotes[lang as "zh" | "en"] ?? us.releaseNotes.en ?? "") : "";

  const close = () => state.closeUpdateDialog();
  const downloading = us.status === "downloading";
  const downloaded = us.status === "downloaded";
  const failed = us.status === "error";

  const fmtMB = (n: number) => (n / 1048576).toFixed(1);
  const progressLine = us.progress
    ? `${us.progress.percent.toFixed(0)}% · ${fmtMB(us.progress.transferred)} / ${fmtMB(us.progress.total)} MB`
    : "";

  return html`
    <div class="cc-dialog-overlay" role="dialog" aria-modal="true" @click=${() => !downloading && close()}>
      <div class="cc-dialog release-notes-dialog update-available-dialog" @click=${(e: Event) => e.stopPropagation()}>
        <div class="cc-dialog__head">
          <div style="flex: 1; min-width: 0;">
            <div class="cc-dialog__title">${t("appUpdate.dialogTitle")}</div>
            <div class="cc-dialog__subtitle">v${us.currentVersion} → v${us.version}</div>
          </div>
          ${!downloading
            ? html`<button class="cc-dialog__close" type="button" @click=${close} aria-label=${t("releaseNotes.close")}>${icons.x}</button>`
            : nothing}
        </div>

        <div class="cc-dialog__body release-notes-dialog__body">
          ${notes && !downloading && !downloaded
            ? html`<div class="release-notes-entry"><div class="release-notes-entry-content">${notes}</div></div>`
            : nothing}
          ${downloading
            ? html`
                <div class="oc-settings-progress">
                  <div class="oc-settings-progress__bar" style="width:${us.progress?.percent ?? 0}%"></div>
                </div>
                <div class="oc-mt-4" style="color:var(--text-secondary)">${t("appUpdate.downloading")} ${progressLine}</div>
              `
            : nothing}
          ${downloaded
            ? html`<div class="release-notes-entry"><div class="release-notes-entry-content">${t("appUpdate.downloadedHint")}</div></div>`
            : nothing}
          ${failed
            ? html`<div style="color:var(--danger)">${tWithDetail("settings.about.appUpdateError", us.error ?? "")}</div>`
            : nothing}
          ${state.updateSnoozeOpen
            ? html`
                <div class="update-snooze-panel">
                  <div class="update-snooze-panel__title">${t("appUpdate.snoozeTitle")}</div>
                  <div class="update-snooze-panel__options">
                    <button class="btn" type="button" @click=${() => state.snoozeUpdate({ days: 7 })}>${t("appUpdate.snooze7d")}</button>
                    <button class="btn" type="button" @click=${() => state.snoozeUpdate({ days: 30 })}>${t("appUpdate.snooze1m")}</button>
                    <button class="btn" type="button" @click=${() => state.snoozeUpdate({ days: 90 })}>${t("appUpdate.snooze3m")}</button>
                    <button class="btn" type="button" @click=${() => state.snoozeUpdate({ forever: true })}>${t("appUpdate.snoozeForever")}</button>
                  </div>
                  <div class="update-snooze-panel__custom">
                    <input
                      class="update-snooze-panel__input"
                      type="number"
                      min="1"
                      max="3650"
                      .value=${state.updateSnoozeDays}
                      @input=${(e: Event) => state.setUpdateSnoozeDays((e.target as HTMLInputElement).value)}
                      placeholder=${t("appUpdate.snoozeCustomPlaceholder")}
                    />
                    <button class="btn" type="button" @click=${() => state.snoozeUpdateCustom()}>${t("appUpdate.snoozeCustomConfirm")}</button>
                  </div>
                </div>
              `
            : nothing}
        </div>

        <div class="cc-dialog__foot">
          ${us.status === "available" || failed
            ? html`
                <button class="btn primary" type="button" @click=${() => state.startUpdateDownload()}>
                  ${failed ? t("appUpdate.retryDownload") : t("appUpdate.updateNow")}
                </button>
                <button class="btn" type="button" @click=${() => (state.updateSnoozeOpen = !state.updateSnoozeOpen)}>
                  ${t("appUpdate.snooze")}
                </button>
              `
            : nothing}
          ${downloaded
            ? html`<button class="btn primary" type="button" @click=${() => void state.restartToApplyUpdate()}>${t("appUpdate.restartInstall")}</button>`
            : nothing}
        </div>
      </div>
    </div>
  `;
}
