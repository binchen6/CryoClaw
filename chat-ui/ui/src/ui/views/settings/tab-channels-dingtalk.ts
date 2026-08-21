/**
 * Settings: Channels — DingTalk sub-panel.
 *
 * R4：读写改走内核 config.get 快照 + config.patch；凭据验证走主进程
 * settings:verify-key；bundled 检测走 settings:get-channel-runtime-state。
 */
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { t, tWithDetail } from "../../i18n.ts";
import * as ipc from "../../data/ipc-bridge.ts";
import "../../components/toggle-switch.ts";
import "../../components/password-input.ts";
import "../../components/message-box.ts";
import { getConfigSnapshot, getCachedConfigSnapshot } from "../../controllers/config.ts";
import { runConfigPatch } from "./tab-patch.ts";
import { extractDingtalkView, applyDingtalkSave } from "./tab-channels.lib.ts";
import { updateChannelEnabled, syncChannelEnabledFromSnapshot } from "./tab-channels.ts";

// DingTalk 面板状态必须可整体回滚，避免未保存凭据残留到下次打开。
function createDingtalkState() {
  return {
    enabled: false,
    clientId: "",
    clientSecret: "",
    sessionTimeout: 1800000,
    bundled: true,
    bundleMessage: "",
    saving: false,
    error: null as string | null,
    successMsg: null as string | null,
    hint: null as string | null,
    initialized: false,
  };
}

const s = createDingtalkState();

// 退出 Settings 时直接丢掉 DingTalk 面板缓存，下次重新从 config 快照拉真配置。
export function resetDingtalkTab() {
  Object.assign(s, createDingtalkState());
}

async function init(state: AppViewState) {
  if (s.initialized) return;
  s.initialized = true;
  try {
    if (state.client && state.connected) {
      await getConfigSnapshot(state.client);
      const config = getCachedConfigSnapshot()?.config;
      if (config) {
        const view = extractDingtalkView(config);
        s.enabled = view.enabled;
        s.clientId = view.clientId;
        s.clientSecret = view.clientSecret;
        s.sessionTimeout = view.sessionTimeout;
      }
    }
    const runtime = await ipc.settingsGetChannelRuntimeState().catch(() => null);
    if (runtime) {
      s.bundled = runtime.bundled.dingtalk;
      s.bundleMessage = runtime.bundleMessages.dingtalk ?? "";
    }
    state.requestUpdate();
  } catch {}
}

/** 统一保存：启用时先主进程验证凭据 → config.patch 写入。 */
async function saveDingtalk(state: AppViewState): Promise<boolean> {
  if (s.enabled) {
    if (!s.clientId) { s.error = t("settings.channels.dingtalk.clientIdRequired"); return false; }
    if (!s.clientSecret) { s.error = t("settings.channels.dingtalk.clientSecretRequired"); return false; }
    if (!s.bundled) { s.error = s.bundleMessage || t("settings.channels.dingtalk.notBundled"); return false; }
    const verifyResult = await ipc.settingsVerifyKey({ provider: "dingtalk", clientId: s.clientId, clientSecret: s.clientSecret });
    if (!verifyResult.success) {
      s.error = tWithDetail("settings.error.verifyFailed", verifyResult.message ?? verifyResult.error);
      return false;
    }
  }
  const outcome = await runConfigPatch(state, draft => {
    applyDingtalkSave(draft, { enabled: s.enabled, clientId: s.clientId, clientSecret: s.clientSecret });
  });
  if (!outcome.ok) {
    s.error = tWithDetail("settings.error.saveFailed", outcome.error);
    return false;
  }
  updateChannelEnabled("dingtalk", s.enabled);
  syncChannelEnabledFromSnapshot();
  s.successMsg = t("settings.saved");
  s.hint = outcome.hint ?? null;
  return true;
}

async function handleToggle(state: AppViewState, checked: boolean) {
  const prevEnabled = s.enabled;
  s.enabled = checked;
  s.error = null;
  s.successMsg = null;
  s.hint = null;
  if (!checked) {
    s.saving = true; state.requestUpdate();
    const ok = await saveDingtalk(state);
    s.saving = false;
    if (!ok) s.enabled = prevEnabled;
    state.requestUpdate();
  } else {
    state.requestUpdate();
  }
}

async function handleSave(state: AppViewState) {
  s.saving = true; s.error = null; s.successMsg = null; s.hint = null; state.requestUpdate();
  await saveDingtalk(state);
  s.saving = false;
  state.requestUpdate();
}

export function renderChannelDingtalk(state: AppViewState) {
  if (!s.initialized) init(state);

  return html`
    <div class="oc-settings__section">
      <div style="display:flex;align-items:flex-start;justify-content:flex-end;margin-bottom:8px">
        <div style="display:flex;gap:12px;flex-shrink:0">
          <a class="oc-settings__link" href="#" @click=${(e: Event) => { e.preventDefault(); ipc.openExternal("https://oneclaw.cn/docs/tutorials/dingtalk.html"); }}>${t("settings.channels.dingtalk.setupGuide")} &rarr;</a>
          <a class="oc-settings__link" href="#" @click=${(e: Event) => { e.preventDefault(); ipc.openExternal("https://open-dev.dingtalk.com/fe/app"); }}>${t("settings.channels.dingtalk.openConsole")} &rarr;</a>
        </div>
      </div>

      ${!s.bundled ? html`<oc-message-box .message=${s.bundleMessage || t("settings.channels.dingtalk.notBundled")} .type=${"info"} .visible=${true}></oc-message-box>` : nothing}

      <div class="oc-settings__form-group">
        <oc-toggle-switch .label=${t("settings.channels.enable")} .checked=${s.enabled}
          @change=${(e: CustomEvent) => handleToggle(state, e.detail.checked)}
        ></oc-toggle-switch>
      </div>

      ${s.enabled ? html`
        <div class="oc-settings__form-group">
          <label class="oc-settings__label">${t("settings.channels.dingtalk.clientId")}</label>
          <input class="oc-settings__input" .value=${s.clientId} @input=${(e: Event) => { s.clientId = (e.target as HTMLInputElement).value; state.requestUpdate(); }} />
        </div>

        <div class="oc-settings__form-group">
          <label class="oc-settings__label">${t("settings.channels.dingtalk.clientSecret")}</label>
          <oc-password-input .value=${s.clientSecret} @input=${(e: CustomEvent) => { s.clientSecret = e.detail.value; state.requestUpdate(); }}></oc-password-input>
        </div>

        <div class="oc-settings__field-hint" style="margin-bottom:8px">${t("settings.channels.dingtalk.gatewayTokenHint")}</div>

        <oc-message-box .message=${s.error ?? ""} .type=${"error"} .visible=${!!s.error}></oc-message-box>
        <oc-message-box .message=${s.successMsg ?? ""} .type=${"success"} .visible=${!!s.successMsg}></oc-message-box>
        ${s.hint ? html`<div class="oc-settings__field-hint">${s.hint}</div>` : nothing}

        <div class="oc-settings__btn-row">
          <button class="oc-settings__btn oc-settings__btn--primary" ?disabled=${s.saving} @click=${() => handleSave(state)}>${t("settings.save")}</button>
        </div>
      ` : nothing}
    </div>
  `;
}
