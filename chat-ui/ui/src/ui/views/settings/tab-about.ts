/**
 * Settings: About Tab.
 */
import { html } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { getLocale, t, tWithDetail } from "../../i18n.ts";
import * as ipc from "../../data/ipc-bridge.ts";
import { showConfirm } from "../confirm-dialog.ts";
import { showToast } from "../../app-toast.ts";
import type {
  AppUpdateState,
  KernelUpdateProgress,
  KernelUpdateResult,
  KernelUpdateState,
} from "../../data/ipc-bridge.ts";

const s = {
  cryoClawVersion: "",
  openClawVersion: "",
  // 内核升级卡片状态
  kernelState: null as KernelUpdateState | null,
  progress: null as KernelUpdateProgress | null,
  busy: false,
  resultMsg: null as { ok: boolean; text: string } | null,
  // App 自动更新卡片状态
  appUpdate: null as AppUpdateState | null,
  appUpdateMsg: null as { ok: boolean; text: string } | null,
  initialized: false,
};

// 进度推送回调需要触发重渲染，缓存当前 state 引用
let currentState: AppViewState | null = null;
let unsubscribeProgress: (() => void) | null = null;
let unsubscribeAppUpdate: (() => void) | null = null;

async function init(state: AppViewState) {
  if (s.initialized) return;
  s.initialized = true;
  try {
    const about = await ipc.settingsGetAboutInfo();
    s.cryoClawVersion = about.cryoClawVersion ?? "";
    s.openClawVersion = about.openClawVersion ?? "";
    state.requestUpdate();
  } catch {}
  try {
    s.kernelState = await ipc.kernelGetUpdateState();
    state.requestUpdate();
  } catch {}
  // 订阅升级/回退进度（由主进程编排，可能耗时数分钟）
  unsubscribeProgress = ipc.onKernelUpdateProgress((p) => {
    s.progress = p;
    currentState?.requestUpdate();
  });
  // App 自动更新：首屏拉一次快照 + 订阅主进程状态推送
  try {
    s.appUpdate = await ipc.appUpdateGetState();
    state.requestUpdate();
  } catch {}
  unsubscribeAppUpdate = ipc.onAppUpdateState((st) => {
    s.appUpdate = st;
    currentState?.requestUpdate();
  });
}

export function cleanupAboutTab() {
  unsubscribeProgress?.();
  unsubscribeProgress = null;
  unsubscribeAppUpdate?.();
  unsubscribeAppUpdate = null;
  s.initialized = false;
  s.kernelState = null;
  s.progress = null;
  s.busy = false;
  s.resultMsg = null;
  s.appUpdate = null;
  s.appUpdateMsg = null;
}

async function handleKernelCheck(state: AppViewState) {
  if (s.busy) return;
  s.busy = true;
  s.resultMsg = null;
  state.requestUpdate();
  try {
    s.kernelState = await ipc.kernelCheckUpdate();
  } catch (e) {
    s.resultMsg = { ok: false, text: String(e) };
  } finally {
    s.busy = false;
    state.requestUpdate();
  }
}

async function runKernelAction(state: AppViewState, action: () => Promise<KernelUpdateResult>) {
  if (s.busy) return;
  s.busy = true;
  s.resultMsg = null;
  s.progress = null;
  state.requestUpdate();
  try {
    const result = await action();
    if (result.ok) {
      const key =
        result.action === "update"
          ? "settings.about.kernelUpdateSuccess"
          : "settings.about.kernelRollbackSuccess";
      s.resultMsg = { ok: true, text: t(key).replace("{from}", result.from).replace("{to}", result.to) };
    } else {
      s.resultMsg = { ok: false, text: result.error };
    }
  } catch (e) {
    s.resultMsg = { ok: false, text: String(e) };
  } finally {
    s.busy = false;
    s.progress = null;
    // 完成后刷新状态（版本号 / 可回退标记会变化）
    try {
      s.kernelState = await ipc.kernelGetUpdateState();
    } catch {}
    state.requestUpdate();
  }
}

async function handleKernelUpdate(state: AppViewState) {
  if (!(await showConfirm(state, t("settings.about.kernelUpdateConfirm")))) return;
  void runKernelAction(state, () => ipc.kernelUpdate());
}

async function handleKernelRollback(state: AppViewState) {
  if (!(await showConfirm(state, t("settings.about.kernelRollbackConfirm"), { danger: true }))) return;
  void runKernelAction(state, () => ipc.kernelRollback());
}

// ── App 自动更新 ──

// 「查看更新日志」：拉全部条目（all=true，不触碰 lastShown 标记）重开 What's New 弹窗
async function handleViewReleaseNotes(state: AppViewState) {
  try {
    const data = await ipc.getReleaseNotes({ all: true });
    if (data && Array.isArray(data.entries) && data.entries.length > 0) {
      state.releaseNotesData = data;
      state.showReleaseNotesModal = true;
    } else {
      showToast(state, t("settings.about.releaseNotesEmpty"));
    }
  } catch {
    showToast(state, t("settings.about.releaseNotesEmpty"));
  }
  state.requestUpdate();
}

// release-notes.json 的 notes 按当前 UI 语言取值，fallback en（与 release-notes-modal 一致）
function localizedNotes(notes: { zh?: string; en?: string }): string {
  return notes[getLocale()] ?? notes.en ?? "";
}

async function handleAppUpdateCheck(state: AppViewState) {
  if (s.appUpdate?.status === "checking" || s.appUpdate?.status === "downloading") return;
  s.appUpdateMsg = null;
  try {
    s.appUpdate = await ipc.appUpdateCheck();
  } catch (e) {
    s.appUpdateMsg = { ok: false, text: String(e) };
  }
  state.requestUpdate();
}

async function handleAppUpdateRestart(state: AppViewState) {
  if (!(await showConfirm(state, t("settings.about.appUpdateRestartConfirm")))) return;
  s.appUpdateMsg = null;
  try {
    await ipc.appUpdateQuitAndInstall();
    // quitAndInstall 后应用随即退出，通常不会走到这里
  } catch (e) {
    s.appUpdateMsg = { ok: false, text: String(e) };
    state.requestUpdate();
  }
}

function renderAppUpdateCard(state: AppViewState) {
  const us = s.appUpdate;
  if (!us) return html``;
  if (!us.supported) {
    return html`
      <div class="oc-settings__card">
        <div class="oc-settings__card-title">${t("settings.about.appUpdate")}</div>
        <div class="oc-settings__meta">${t("settings.about.appUpdateNotSupported")}</div>
      </div>
    `;
  }
  const checking = us.status === "checking";
  const downloading = us.status === "downloading";
  // available/downloaded 态渲染新版本的更新说明（release-notes.json 采进状态，可能缺失）
  const showReleaseNotes =
    (us.status === "available" || us.status === "downloaded") && us.releaseNotes;
  return html`
    <div class="oc-settings__card">
      <div class="oc-settings__card-title">${t("settings.about.appUpdate")}</div>
      <div class="oc-flex-col oc-gap-6 oc-settings__meta">
        <div><strong>${t("settings.about.appUpdateCurrent")}</strong>: ${us.currentVersion || s.cryoClawVersion || "-"}</div>
        ${us.status === "available"
          ? html`<div><strong>${tWithDetail("settings.about.appUpdateAvailable", us.version ?? "")}</strong></div>`
          : ""}
        ${us.status === "not-available" ? html`<div>${t("settings.about.appUpdateUpToDate")}</div>` : ""}
        ${us.status === "downloaded" ? html`<div>${t("settings.about.appUpdateDownloaded")}</div>` : ""}
        ${showReleaseNotes
          ? html`<div class="oc-settings-release-notes">
              <div class="oc-settings-release-notes__title">${t("settings.about.appUpdateReleaseNotes")}</div>
              <div class="oc-settings-release-notes__body">${localizedNotes(us.releaseNotes!)}</div>
            </div>`
          : ""}
        ${us.status === "error"
          ? html`<div style="color:var(--danger)">${tWithDetail("settings.about.appUpdateError", us.error)}</div>`
          : ""}
        <div class="oc-flex oc-gap-8 oc-mt-4">
          <button class="oc-settings__btn oc-settings__btn--compact" ?disabled=${checking || downloading} @click=${() => handleAppUpdateCheck(state)}>${checking ? t("settings.about.appUpdateChecking") : us.status === "error" ? t("settings.about.appUpdateRetry") : t("settings.about.appUpdateCheck")}</button>
          ${us.status === "downloaded"
            ? html`<button class="oc-settings__btn oc-settings__btn--primary oc-settings__btn--compact" @click=${() => handleAppUpdateRestart(state)}>${t("settings.about.appUpdateRestart")}</button>`
            : ""}
        </div>
        ${downloading && us.progress
          ? html`
              <div>
                <div class="oc-settings-progress">
                  <div class="oc-settings-progress__bar" style="width:${us.progress.percent}%"></div>
                </div>
                <div class="oc-mt-4" style="color:var(--text-secondary)">${tWithDetail("settings.about.appUpdateDownloading", us.progress.percent.toFixed(1))}%</div>
              </div>
            `
          : ""}
        ${s.appUpdateMsg
          ? html`<div style="${s.appUpdateMsg.ok ? "" : "color:var(--danger)"}">${s.appUpdateMsg.text}</div>`
          : ""}
      </div>
    </div>
  `;
}

function renderKernelCard(state: AppViewState) {
  const ks = s.kernelState;
  // 状态未取到（IPC 失败）时不渲染卡片
  if (!ks) return html``;
  if (!ks.available) {
    return html`
      <div class="oc-settings__card">
        <div class="oc-settings__card-title">${t("settings.about.kernel")}</div>
        <div class="oc-settings__meta">${t("settings.about.kernelNotSupported")}</div>
      </div>
    `;
  }
  const disabled = s.busy || ks.running;
  return html`
    <div class="oc-settings__card">
      <div class="oc-settings__card-title">${t("settings.about.kernel")}</div>
      <div class="oc-flex-col oc-gap-6 oc-settings__meta">
        <div><strong>${t("settings.about.kernelCurrent")}</strong>: ${ks.current ?? "-"}</div>
        <div><strong>${t("settings.about.kernelLatest")}</strong>: ${ks.latest ?? t("settings.about.kernelLatestNotChecked")}</div>
        ${ks.checkError
          ? html`<div style="color:var(--danger)">${tWithDetail("settings.about.kernelCheckFailed", ks.checkError)}</div>`
          : ""}
        <div class="oc-flex oc-gap-8 oc-mt-4">
          <button class="oc-settings__btn oc-settings__btn--compact" ?disabled=${disabled} @click=${() => handleKernelCheck(state)}>${t("settings.about.kernelCheck")}</button>
          ${ks.updateAvailable
            ? html`<button class="oc-settings__btn oc-settings__btn--primary oc-settings__btn--compact" ?disabled=${disabled} @click=${() => handleKernelUpdate(state)}>${t("settings.about.kernelUpdate")}</button>`
            : ""}
          ${ks.rollbackAvailable
            ? html`<button class="oc-settings__btn oc-settings__btn--compact" ?disabled=${disabled} @click=${() => handleKernelRollback(state)}>${t("settings.about.kernelRollback")}</button>`
            : ""}
        </div>
        ${s.progress
          ? html`
              <div>
                <div class="oc-settings-progress">
                  <div class="oc-settings-progress__bar" style="width:${s.progress.pct}%"></div>
                </div>
                <div class="oc-mt-4" style="color:var(--text-secondary)">${s.progress.pct}% · ${s.progress.msg}</div>
              </div>
            `
          : ""}
        ${s.resultMsg
          ? html`<div style="${s.resultMsg.ok ? "" : "color:var(--danger)"}">${s.resultMsg.text}</div>`
          : ""}
      </div>
    </div>
  `;
}

export function renderTabAbout(state: AppViewState) {
  currentState = state;
  if (!s.initialized) init(state);

  return html`
    <div class="oc-settings__section">
      <h2 class="oc-settings__section-title">${t("settings.nav.about")}</h2>

      <!-- Version -->
      <div class="oc-settings__card">
        <div class="oc-settings__card-title">${t("settings.about.version")}</div>
        <div class="oc-flex-col oc-gap-6 oc-settings__meta">
          <div><strong>${t("settings.about.cryoclaw")}</strong>: ${s.cryoClawVersion}</div>
          <div><strong>${t("settings.about.openclaw")}</strong>: ${s.openClawVersion}</div>
          <div class="oc-flex oc-gap-8 oc-mt-4">
            <button class="oc-settings__btn oc-settings__btn--compact" @click=${() => handleViewReleaseNotes(state)}>${t("settings.about.viewReleaseNotes")}</button>
          </div>
        </div>
      </div>

      <!-- App Update -->
      ${renderAppUpdateCard(state)}

      <!-- Kernel -->
      ${renderKernelCard(state)}
    </div>
  `;
}
