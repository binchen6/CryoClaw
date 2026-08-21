/**
 * Settings: Channels — Weixin sub-panel.
 *
 * R4：enabled 开关改走 config.patch（写前经主进程 settings:ensure-weixin-plugin
 * 做插件 reconcile 守卫）；扫码登录/账号清除保留主进程 IPC（凭据文件属主进程职责）。
 */
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { t, tWithDetail } from "../../i18n.ts";
import * as ipc from "../../data/ipc-bridge.ts";
import "../../components/toggle-switch.ts";
import "../../components/message-box.ts";
import { getConfigSnapshot, getCachedConfigSnapshot } from "../../controllers/config.ts";
import { runConfigPatch } from "./tab-patch.ts";
import { extractWeixinEnabled, applyWeixinSave } from "./tab-channels.lib.ts";
import { updateChannelEnabled, syncChannelEnabledFromSnapshot } from "./tab-channels.ts";
import { showConfirm } from "../confirm-dialog.ts";

// Weixin 面板状态必须可整体回滚，避免二维码和账号缓存残留到下次打开。
function createWeixinState() {
  return {
    enabled: false,
    accounts: [] as string[],
    qrDataUrl: "",
    qrcode: "",
    loginStatus: "" as "" | "waiting" | "scaned" | "confirmed" | "expired",
    pollTimer: null as ReturnType<typeof setTimeout> | null,
    // 轮询代际：cleanup 自增，setTimeout 回调内 await 返回后先校验代际，失效即退出
    pollGeneration: 0,
    saving: false,
    disconnecting: false,
    error: null as string | null,
    hint: null as string | null,
    initialized: false,
  };
}

const s = createWeixinState();

async function refreshAccounts(): Promise<void> {
  const runtime = await ipc.settingsGetChannelRuntimeState().catch(() => null);
  if (runtime) s.accounts = runtime.weixinAccounts ?? [];
}

async function init(state: AppViewState) {
  if (s.initialized) return;
  s.initialized = true;
  try {
    if (state.client && state.connected) {
      await getConfigSnapshot(state.client);
      const config = getCachedConfigSnapshot()?.config;
      if (config) s.enabled = extractWeixinEnabled(config);
    }
    await refreshAccounts();
    state.requestUpdate();
  } catch {}
}

async function startLogin(state: AppViewState) {
  s.error = null;
  const generation = s.pollGeneration;
  try {
    const result = await ipc.settingsWeixinLoginStart();
    // await 期间 tab 可能已 cleanup，代际失效则丢弃结果、不再启动轮询
    if (generation !== s.pollGeneration) return;
    s.qrDataUrl = result.qrDataUrl ?? "";
    s.qrcode = result.qrcode ?? "";
    s.loginStatus = "waiting";
    state.requestUpdate();
    pollLogin(state);
  } catch (e: any) {
    s.error = tWithDetail("settings.error.loginFailed", e?.message);
    state.requestUpdate();
  }
}

function pollLogin(state: AppViewState) {
  if (s.pollTimer) clearTimeout(s.pollTimer);
  const generation = s.pollGeneration;
  s.pollTimer = setTimeout(async () => {
    // cleanup 后代际已自增：此时 state 可能已切走，旧轮询直接作废，不再挂新 timer
    if (generation !== s.pollGeneration) return;
    try {
      const result = await ipc.settingsWeixinLoginWait({ qrcode: s.qrcode });
      s.loginStatus = result.status ?? "";
      if (result.connected) {
        s.pollTimer = null;
        await refreshAccounts();
        // 登录成功主进程已写 enabled=true + 重启 gateway；快照失效后重拉同步开关
        if (state.client) {
          try {
            await getConfigSnapshot(state.client, { force: true });
            const config = getCachedConfigSnapshot()?.config;
            if (config) {
              s.enabled = extractWeixinEnabled(config);
              updateChannelEnabled("weixin", s.enabled);
            }
          } catch {}
        }
        state.requestUpdate();
        return;
      }
      if (result.status === "expired") {
        startLogin(state);
        return;
      }
      state.requestUpdate();
      pollLogin(state);
    } catch {
      s.loginStatus = "";
      state.requestUpdate();
    }
  }, 1000);
}

async function handleToggle(state: AppViewState, checked: boolean) {
  const prevEnabled = s.enabled;
  s.enabled = checked;
  s.saving = true;
  s.error = null;
  s.hint = null;
  state.requestUpdate();
  try {
    if (checked) {
      // 启用前主进程守卫：先把 mirror reconcile 到 external plugin 目录
      const ensure = await ipc.settingsEnsureWeixinPlugin();
      if (!ensure.ok) {
        throw new Error(ensure.message ?? t("settings.error.saveFailed"));
      }
    }
    const outcome = await runConfigPatch(state, draft => {
      applyWeixinSave(draft, checked);
    });
    if (!outcome.ok) {
      throw new Error(outcome.error ?? t("settings.error.saveFailed"));
    }
    updateChannelEnabled("weixin", checked);
    syncChannelEnabledFromSnapshot();
    s.hint = outcome.hint ?? null;
    if (checked && s.accounts.length === 0) startLogin(state);
    s.saving = false;
    state.requestUpdate();
  } catch (e: any) {
    s.saving = false;
    s.enabled = prevEnabled;
    s.error = tWithDetail("settings.error.saveFailed", e?.message);
    state.requestUpdate();
  }
}

async function handleDisconnect(state: AppViewState) {
  if (s.disconnecting) return;
  if (!(await showConfirm(state, t("settings.channels.weixin.disconnectConfirm"), { danger: true }))) return;
  s.disconnecting = true;
  state.requestUpdate();
  try {
    await ipc.settingsWeixinClearAccounts();
    s.accounts = [];
    state.requestUpdate();
    startLogin(state);
  } catch {} finally {
    s.disconnecting = false;
    state.requestUpdate();
  }
}

export function cleanupWeixinTab() {
  if (s.pollTimer) {
    clearTimeout(s.pollTimer);
  }
  // 先记下旧代际，重置状态后再自增：已进 setTimeout 回调、正挂在 await 上的旧轮询
  // 回来时发现代际不一致直接 return，不会在重置后的 state 上继续挂 timer
  const generation = s.pollGeneration;
  Object.assign(s, createWeixinState());
  s.pollGeneration = generation + 1;
}

export function renderChannelWeixin(state: AppViewState) {
  if (!s.initialized) init(state);

  const connected = s.accounts.length > 0;

  return html`
    <div class="oc-settings__section">
      <div class="oc-settings__form-group">
        <oc-toggle-switch .label=${t("settings.channels.enable")} .checked=${s.enabled}
          @change=${(e: CustomEvent) => handleToggle(state, e.detail.checked)}
        ></oc-toggle-switch>
      </div>

      ${s.enabled ? html`
        ${connected ? html`
          <div class="oc-weixin-connected">
            <span class="oc-weixin-badge">✓</span>
            <span class="oc-weixin-account-id">${s.accounts[0] ?? ""}</span>
            <button class="oc-weixin-remove-btn" ?disabled=${s.disconnecting} @click=${() => handleDisconnect(state)}
              data-tooltip=${t("settings.channels.weixin.disconnect")}
              data-tooltip-pos="left"
              aria-label=${t("settings.channels.weixin.disconnect")}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
            </button>
          </div>
        ` : html`
          ${s.qrDataUrl ? html`
            <div class="oc-weixin-qr-section">
              <div class="oc-weixin-qr-container">
                <img class="oc-weixin-qr-image" src=${s.qrDataUrl} />
                <div class="oc-weixin-qr-status">
                  ${s.loginStatus === "scaned" ? t("settings.channels.weixin.scanned") : t("settings.channels.weixin.scanQr")}
                </div>
              </div>
            </div>
          ` : html`
            <button class="oc-settings__btn oc-settings__btn--primary" @click=${() => startLogin(state)}>
              ${t("settings.channels.weixin.startLogin")}
            </button>
          `}
        `}
      ` : nothing}

      <oc-message-box .message=${s.error ?? ""} .type=${"error"} .visible=${!!s.error}></oc-message-box>
      ${s.hint ? html`<div class="oc-settings__field-hint">${s.hint}</div>` : nothing}
    </div>
  `;
}
