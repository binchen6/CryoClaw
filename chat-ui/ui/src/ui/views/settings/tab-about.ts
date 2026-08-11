/**
 * Settings: About Tab.
 */
import { html } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { t, tWithDetail } from "../../i18n.ts";
import * as ipc from "../../data/ipc-bridge.ts";
import { showConfirm } from "../confirm-dialog.ts";
import type {
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
  initialized: false,
};

// 进度推送回调需要触发重渲染，缓存当前 state 引用
let currentState: AppViewState | null = null;
let unsubscribeProgress: (() => void) | null = null;

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
}

export function cleanupAboutTab() {
  unsubscribeProgress?.();
  unsubscribeProgress = null;
  s.initialized = false;
  s.kernelState = null;
  s.progress = null;
  s.busy = false;
  s.resultMsg = null;
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

function renderKernelCard(state: AppViewState) {
  const ks = s.kernelState;
  // 状态未取到（IPC 失败）时不渲染卡片
  if (!ks) return html``;
  if (!ks.available) {
    return html`
      <div class="oc-settings__card">
        <div class="oc-settings__card-title">${t("settings.about.kernel")}</div>
        <div style="font-size:13px;color:var(--text-secondary)">${t("settings.about.kernelNotSupported")}</div>
      </div>
    `;
  }
  const disabled = s.busy || ks.running;
  return html`
    <div class="oc-settings__card">
      <div class="oc-settings__card-title">${t("settings.about.kernel")}</div>
      <div style="font-size:13px;display:flex;flex-direction:column;gap:6px">
        <div><strong>${t("settings.about.kernelCurrent")}</strong>: ${ks.current ?? "-"}</div>
        <div><strong>${t("settings.about.kernelLatest")}</strong>: ${ks.latest ?? t("settings.about.kernelLatestNotChecked")}</div>
        ${ks.checkError
          ? html`<div style="color:var(--danger)">${tWithDetail("settings.about.kernelCheckFailed", ks.checkError)}</div>`
          : ""}
        <div style="display:flex;gap:8px;margin-top:4px">
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
                <div style="height:6px;border-radius:3px;background:var(--border);overflow:hidden">
                  <div style="height:100%;width:${s.progress.pct}%;background:var(--accent);transition:width .2s"></div>
                </div>
                <div style="margin-top:4px;color:var(--text-secondary)">${s.progress.pct}% · ${s.progress.msg}</div>
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
        <div style="font-size:13px;display:flex;flex-direction:column;gap:6px">
          <div><strong>${t("settings.about.cryoclaw")}</strong>: ${s.cryoClawVersion}</div>
          <div><strong>${t("settings.about.openclaw")}</strong>: ${s.openClawVersion}</div>
        </div>
      </div>

      <!-- Kernel -->
      ${renderKernelCard(state)}
    </div>
  `;
}
