/**
 * Settings: Backup & Restore Tab.
 */
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { t, tWithDetail } from "../../i18n.ts";
import * as ipc from "../../data/ipc-bridge.ts";
import type { BackupEntry, GatewayState } from "../../data/ipc-bridge.ts";
import { showConfirm } from "../confirm-dialog.ts";
import { registerTickHandler, unregisterTickHandler } from "../../client-ticker.ts";
import "../../components/message-box.ts";
import { invalidateAllSettings } from "./settings-view.ts";
import { runOpenclawStateImport } from "./tab-backup-openclaw-state.lib.ts";

const s = {
  backups: [] as BackupEntry[],
  hasLastKnownGood: false,
  lastKnownGoodUpdatedAt: "",
  gatewayState: "stopped" as GatewayState,
  restoring: false,
  resetting: false,
  openclawStateBusy: false,
  error: null as string | null,
  successMsg: null as string | null,
  initialized: false,
  refreshTimers: [] as ReturnType<typeof setTimeout>[],
  stateRef: null as AppViewState | null,
};

const TICK_HANDLER_NAME = "settings-backup-gateway";

async function init(state: AppViewState) {
  if (s.initialized) return;
  s.initialized = true;
  s.stateRef = state;
  try {
    const [backup, gw] = await Promise.all([ipc.settingsListConfigBackups(), ipc.getGatewayState()]);
    s.backups = backup.backups ?? [];
    s.hasLastKnownGood = backup.hasLastKnownGood ?? false;
    s.lastKnownGoodUpdatedAt = backup.lastKnownGoodUpdatedAt ?? "";
    s.gatewayState = gw;
    state.requestUpdate();
  } catch {}

  // Steady-state gateway polling via tick handler
  registerTickHandler(TICK_HANDLER_NAME, async () => {
    try {
      const gw = await ipc.getGatewayState();
      if (gw !== s.gatewayState) {
        s.gatewayState = gw;
        s.stateRef?.requestUpdate();
      }
    } catch {}
  });
}

function formatDateTime(iso: string): string {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1048576) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1048576).toFixed(1)} MB`;
}

// 恢复操作统一流程（备份文件 / LKG 共用）：执行恢复 → 重启 gateway → 失效全部设置页重拉。
async function runRestore(state: AppViewState, restore: () => Promise<unknown>) {
  s.restoring = true; state.requestUpdate();
  try {
    await restore();
    ipc.restartGateway();
    scheduleGatewayRefresh(state);
    // Invalidate all settings tabs so they re-fetch from disk on next render
    invalidateAllSettings();
    s.restoring = false;
    s.successMsg = t("settings.saved");
    // Re-init backup tab itself after invalidation
    s.initialized = false;
    init(state);
    state.requestUpdate();
  } catch (e: any) { s.restoring = false; s.error = tWithDetail("settings.error.restoreFailed", e?.message); state.requestUpdate(); }
}

async function handleRestoreBackup(state: AppViewState, fileName: string) {
  if (!(await showConfirm(state, t("settings.backup.confirmRestore").replace("{fileName}", fileName), { danger: true }))) return;
  await runRestore(state, () => ipc.settingsRestoreConfigBackup({ fileName }));
}

async function handleRestoreLKG(state: AppViewState) {
  if (!(await showConfirm(state, t("settings.backup.confirmRestoreLKG"), { danger: true }))) return;
  await runRestore(state, () => ipc.settingsRestoreLastKnownGood());
}

async function handleResetConfig(state: AppViewState) {
  if (!(await showConfirm(state, t("settings.backup.resetConfirm"), { danger: true }))) return;
  s.resetting = true; state.requestUpdate();
  try { await ipc.settingsResetConfigAndRelaunch(); } catch (e: any) { s.error = tWithDetail("settings.error.resetFailed", e?.message); }
  s.resetting = false; state.requestUpdate();
}

async function handleExportOpenclawState(state: AppViewState) {
  if (s.openclawStateBusy) return;
  s.openclawStateBusy = true;
  s.error = null;
  s.successMsg = null;
  state.requestUpdate();
  try {
    const result = await ipc.settingsExportOpenclawState();
    if (!result.canceled && result.filePath) {
      s.successMsg = t("settings.backup.openclawStateExportSuccess").replace("{path}", result.filePath);
    }
  } catch (e: any) {
    s.error = tWithDetail("settings.backup.openclawStateExportFailed", e?.message);
  } finally {
    s.openclawStateBusy = false;
    state.requestUpdate();
  }
}

async function handleImportOpenclawState(state: AppViewState) {
  if (s.openclawStateBusy) return;

  s.openclawStateBusy = true;
  s.error = null;
  s.successMsg = null;
  state.requestUpdate();

  try {
    const result = await runOpenclawStateImport({
      selectArchive: ipc.settingsSelectOpenclawStateArchive,
      confirmImport: () => showConfirm(state, t("settings.backup.openclawStateImportConfirm"), { danger: true }),
      importArchive: (filePath) => ipc.settingsImportOpenclawState({ filePath }),
    });
    if (result === "canceled") return;

    invalidateAllSettings();
    s.successMsg = t("settings.backup.openclawStateImportSuccess");
    scheduleGatewayRefresh(state);
  } catch (e: any) {
    s.error = tWithDetail("settings.backup.openclawStateImportFailed", e?.message);
  } finally {
    s.openclawStateBusy = false;
    state.requestUpdate();
  }
}

async function handleGatewayAction(state: AppViewState, action: "restart" | "start" | "stop") {
  if (action === "restart") ipc.restartGateway();
  else if (action === "start") ipc.startGateway();
  else void ipc.stopGateway();
  scheduleGatewayRefresh(state);
}

function scheduleGatewayRefresh(state: AppViewState) {
  // Clear any pending refresh timers
  for (const t of s.refreshTimers) clearTimeout(t);
  s.refreshTimers = [];
  for (const delay of [200, 1200, 3000]) {
    s.refreshTimers.push(setTimeout(async () => {
      // gateway 重启窗口期 getGatewayState 可能 reject：吞掉等下一次刷新/60s ticker，
      // 对齐稳态轮询的防御，避免 unhandled rejection。
      try {
        s.gatewayState = await ipc.getGatewayState();
        state.requestUpdate();
      } catch {}
    }, delay));
  }
}

export function cleanupBackupTab() {
  unregisterTickHandler(TICK_HANDLER_NAME);
  for (const t of s.refreshTimers) clearTimeout(t);
  s.refreshTimers = [];
  s.stateRef = null;
  s.initialized = false;
}

function gwStatusKey(gw: GatewayState): string {
  return t(`settings.backup.gatewayStatus.${gw}`);
}

function mapRecoveryNotice(notice: string): string {
  const map: Record<string, string> = {
    "config-invalid-json": t("settings.backup.noticeInvalidJson"),
    "gateway-start-failed": t("settings.backup.noticeGatewayFailed"),
    "gateway-recovery-failed": t("settings.backup.noticeGatewayRecoverFailed"),
    "gateway-recovery-exception": t("settings.backup.noticeGatewayRecoverFailed"),
  };
  return map[notice] ?? notice;
}

export function renderTabBackup(state: AppViewState, notice: string | null) {
  if (!s.initialized) init(state);
  const gw = s.gatewayState;
  const actionDisabled = s.openclawStateBusy || s.restoring || s.resetting;

  return html`
    <div class="oc-settings__section">
      <h2 class="oc-settings__section-title">${t("settings.backup.pageTitle")}</h2>
      <p class="oc-settings__hint">${t("settings.backup.pageDesc")}</p>

      ${notice ? html`<oc-message-box .message=${mapRecoveryNotice(notice)} .type=${"error"} .visible=${true}></oc-message-box>` : nothing}

      <!-- Backup History -->
      <div class="oc-settings__card">
        <div class="oc-settings__card-title">${t("settings.backup.title")}</div>
        ${s.hasLastKnownGood ? html`
          <div class="oc-settings-backup__lkg-row">
            <span class="oc-settings-backup__meta">${t("settings.backup.lastKnownGood")}: ${formatDateTime(s.lastKnownGoodUpdatedAt)}</span>
            <button class="oc-settings__btn oc-settings__btn--primary oc-settings__btn--compact" ?disabled=${actionDisabled} @click=${() => handleRestoreLKG(state)}>${t("settings.backup.restoreLastKnownGood")}</button>
          </div>
        ` : nothing}
        ${s.backups.length ? html`
          <div class="oc-settings-backup__list">
            ${s.backups.map(b => html`
              <div class="oc-settings-backup__item">
                <span class="oc-settings-backup__item-time">${formatDateTime(b.createdAt)} · ${formatBytes(b.size)}</span>
                <button class="oc-settings-backup__restore-link" ?disabled=${actionDisabled} @click=${() => handleRestoreBackup(state, b.fileName)}>${t("settings.backup.restoreBackup")}</button>
              </div>
            `)}
          </div>
        ` : html`<div class="oc-settings-backup__empty">${t("settings.backup.noBackups")}</div>`}
      </div>

      <!-- Gateway Control -->
      <div class="oc-settings__card">
        <div class="oc-settings-backup__card-header">
          <div>
            <div class="oc-settings__card-title">${t("settings.backup.gateway")}</div>
            <span class="oc-settings-backup__meta">${gwStatusKey(gw)}</span>
          </div>
          <div class="oc-flex oc-gap-8">
            ${gw === "running" ? html`
              <button class="oc-settings__btn oc-settings__btn--primary oc-settings__btn--compact" ?disabled=${actionDisabled} @click=${() => handleGatewayAction(state, "restart")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                ${t("settings.backup.restart")}
              </button>
              <button class="oc-settings__btn oc-settings__btn--primary oc-settings__btn--compact" ?disabled=${actionDisabled} @click=${() => handleGatewayAction(state, "stop")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
                ${t("settings.backup.stop")}
              </button>
            ` : nothing}
            ${gw === "stopped" ? html`
              <button class="oc-settings__btn oc-settings__btn--primary oc-settings__btn--compact" ?disabled=${actionDisabled} @click=${() => handleGatewayAction(state, "start")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                ${t("settings.backup.start")}
              </button>
            ` : nothing}
          </div>
        </div>
      </div>

      <!-- .openclaw Import / Export -->
      <div class="oc-settings__card">
        <div class="oc-settings-backup__card-header">
          <div>
            <div class="oc-settings__card-title">${t("settings.backup.openclawStateTitle")}</div>
            <p class="oc-settings-backup__reset-desc">${t("settings.backup.openclawStateDescription")}</p>
          </div>
          <div class="oc-settings-backup__openclaw-state-actions">
            <button class="oc-settings__btn oc-settings__btn--primary oc-settings__btn--compact" ?disabled=${actionDisabled} @click=${() => handleExportOpenclawState(state)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14v6h16v-6"/><path d="m8 7 4-4 4 4"/><path d="M12 3v9"/></svg>
              ${t("settings.backup.openclawStateExport")}
            </button>
            <button class="oc-settings__btn oc-settings__btn--primary oc-settings__btn--compact" ?disabled=${actionDisabled} @click=${() => handleImportOpenclawState(state)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14v6h16v-6"/><path d="M12 3v9"/><path d="m8 8 4 4 4-4"/></svg>
              ${t("settings.backup.openclawStateImport")}
            </button>
          </div>
        </div>
      </div>

      <!-- Reset -->
      <div class="oc-settings__card">
        <div class="oc-settings-backup__card-header">
          <div>
            <div class="oc-settings__card-title">${t("settings.backup.resetTitle")}</div>
            <p class="oc-settings-backup__reset-desc">${t("settings.backup.resetDescription")}</p>
          </div>
          <button class="oc-settings__btn oc-settings__btn--danger oc-settings__btn--compact" ?disabled=${actionDisabled} @click=${() => handleResetConfig(state)}>
            ${t("settings.backup.resetButton")}
          </button>
        </div>
      </div>

      <oc-message-box .message=${s.error ?? ""} .type=${"error"} .visible=${!!s.error}></oc-message-box>
      <oc-message-box .message=${s.successMsg ?? ""} .type=${"success"} .visible=${!!s.successMsg}></oc-message-box>
    </div>
  `;
}
