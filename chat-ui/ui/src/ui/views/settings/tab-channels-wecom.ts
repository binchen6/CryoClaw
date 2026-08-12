/**
 * Settings: Channels — WeCom sub-panel.
 *
 * R4：读写改走内核 config.get 快照 + config.patch；凭据验证走主进程
 * settings:verify-key（wecom WebSocket 认证帧探测）；bundled 检测走
 * settings:get-channel-runtime-state（文件系统探测属主进程职责）。
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
import { extractWecomView, applyWecomSave } from "./tab-channels.lib.ts";
import { updateChannelEnabled, syncChannelEnabledFromSnapshot } from "./tab-channels.ts";
import { renderPairingPanel, loadPairingData, type PairingPanelState } from "./tab-channels-pairing-panel.ts";

// WeCom 面板状态必须可整体回滚，避免未保存表单和配对缓存跨会话残留。
function createWecomState() {
  return {
    enabled: false,
    botId: "",
    secret: "",
    dmPolicy: "pairing",
    groupPolicy: "disabled",
    groupAllowFrom: [] as string[],
    bundled: true,
    bundleMessage: "",
    saving: false,
    error: null as string | null,
    successMsg: null as string | null,
    hint: null as string | null,
    pairingPanel: { pairingRequests: [], approvedEntries: [], loading: false } as PairingPanelState,
    initialized: false,
    addGroupDialogOpen: false,
    addGroupInput: "",
    addGroupError: null as string | null,
  };
}

const s = createWecomState();

// 退出 Settings 时直接丢掉 WeCom 面板缓存，下次重新从 config 快照拉真配置。
export function resetWecomTab() {
  Object.assign(s, createWecomState());
}

async function init(state: AppViewState) {
  if (s.initialized) return;
  s.initialized = true;
  try {
    if (state.client && state.connected) {
      await getConfigSnapshot(state.client);
      const config = getCachedConfigSnapshot()?.config;
      if (config) {
        const view = extractWecomView(config);
        s.enabled = view.enabled;
        s.botId = view.botId;
        s.secret = view.secret;
        s.dmPolicy = view.dmPolicy;
        s.groupPolicy = view.groupPolicy;
        s.groupAllowFrom = view.groupAllowFrom;
      }
    }
    const runtime = await ipc.settingsGetChannelRuntimeState().catch(() => null);
    if (runtime) {
      s.bundled = runtime.bundled.wecom;
      s.bundleMessage = runtime.bundleMessages.wecom ?? "";
    }
    state.requestUpdate();
    refreshWecomPairing(state);
  } catch {}
}

export async function refreshWecomPairing(state: AppViewState) {
  s.pairingPanel = await loadPairingData("wecom");
  state.requestUpdate();
}

/** 统一保存：主进程验证凭据 → config.patch 写入。 */
async function saveWecom(state: AppViewState, enabled: boolean): Promise<boolean> {
  if (enabled) {
    if (!s.botId) { s.error = t("settings.channels.wecom.botIdRequired"); return false; }
    if (!s.secret) { s.error = t("settings.channels.wecom.secretRequired"); return false; }
    if (!s.bundled) { s.error = s.bundleMessage || t("settings.channels.wecom.notBundled"); return false; }
    const verifyResult = await ipc.settingsVerifyKey({ provider: "wecom", botId: s.botId, secret: s.secret });
    if (!verifyResult.success) {
      s.error = tWithDetail("settings.error.verifyFailed", verifyResult.message ?? verifyResult.error);
      return false;
    }
  }
  const outcome = await runConfigPatch(state, draft => {
    applyWecomSave(draft, {
      enabled,
      botId: s.botId,
      secret: s.secret,
      dmPolicy: s.dmPolicy,
      groupPolicy: s.groupPolicy,
      groupAllowFrom: s.groupAllowFrom,
    });
  });
  if (!outcome.ok) {
    s.error = tWithDetail("settings.error.saveFailed", outcome.error);
    return false;
  }
  updateChannelEnabled("wecom", enabled);
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
    // Disable -> save immediately
    s.saving = true; state.requestUpdate();
    const ok = await saveWecom(state, false);
    s.saving = false;
    if (!ok) s.enabled = prevEnabled;
    state.requestUpdate();
  } else {
    // Enable -> save with current config
    if (!s.botId || !s.secret) {
      state.requestUpdate();
      return;
    }
    s.saving = true; state.requestUpdate();
    const ok = await saveWecom(state, true);
    s.saving = false;
    if (!ok) s.enabled = prevEnabled;
    state.requestUpdate();
    if (ok) refreshWecomPairing(state);
  }
}

async function handleSave(state: AppViewState) {
  s.saving = true; s.error = null; s.successMsg = null; s.hint = null; state.requestUpdate();
  const ok = await saveWecom(state, s.enabled);
  s.saving = false;
  state.requestUpdate();
  if (ok) refreshWecomPairing(state);
}

function openAddGroupDialog(state: AppViewState) {
  s.addGroupDialogOpen = true;
  s.addGroupInput = "";
  s.addGroupError = null;
  state.requestUpdate();
}

function confirmAddGroup(state: AppViewState) {
  const id = s.addGroupInput.trim();
  if (!id) return;
  if (s.groupAllowFrom.includes(id)) {
    s.addGroupDialogOpen = false;
    s.addGroupError = null;
    state.requestUpdate();
    return;
  }
  s.groupAllowFrom = [...s.groupAllowFrom, id];
  s.addGroupDialogOpen = false;
  s.addGroupError = null;
  state.requestUpdate();
}

function cancelAddGroup(state: AppViewState) {
  s.addGroupDialogOpen = false;
  s.addGroupError = null;
  state.requestUpdate();
}

export function renderChannelWecom(state: AppViewState) {
  if (!s.initialized) init(state);

  return html`
    <div class="oc-settings__section">
      <div style="display:flex;align-items:flex-start;justify-content:flex-end;margin-bottom:8px">
        <div style="display:flex;gap:12px;flex-shrink:0">
          <a class="oc-settings__link" href="#" @click=${(e: Event) => { e.preventDefault(); ipc.openExternal("https://doc.weixin.qq.com/doc/w3_AFYA1wY6ACoCNRxfnyGRJQaSa6jjJ?scode=AJEAIQdfAAo0RJmzxLAFYA1wY6ACo"); }}>${t("settings.channels.wecom.pluginReadme")} &rarr;</a>
          <a class="oc-settings__link" href="#" @click=${(e: Event) => { e.preventDefault(); ipc.openExternal("https://work.weixin.qq.com/wework_admin/frame"); }}>${t("settings.channels.wecom.openConsole")} &rarr;</a>
        </div>
      </div>

      ${!s.bundled ? html`<oc-message-box .message=${s.bundleMessage || t("settings.channels.wecom.notBundled")} .type=${"info"} .visible=${true}></oc-message-box>` : nothing}

      <div class="oc-settings__form-group">
        <oc-toggle-switch .label=${t("settings.channels.enable")} .checked=${s.enabled}
          @change=${(e: CustomEvent) => handleToggle(state, e.detail.checked)}
        ></oc-toggle-switch>
      </div>

      ${s.enabled ? html`
        <div class="oc-settings__form-group">
          <label class="oc-settings__label">${t("settings.channels.wecom.botId")}</label>
          <input class="oc-settings__input" .value=${s.botId} @input=${(e: Event) => { s.botId = (e.target as HTMLInputElement).value; }} />
        </div>

        <div class="oc-settings__form-group">
          <label class="oc-settings__label">${t("settings.channels.wecom.secret")}</label>
          <oc-password-input .value=${s.secret} @input=${(e: CustomEvent) => { s.secret = e.detail.value; }}></oc-password-input>
        </div>

        <div class="oc-settings__form-group">
          <label class="oc-settings__label">${t("settings.channels.wecom.dmPolicy")}</label>
          <select class="oc-settings__select" .value=${s.dmPolicy} @change=${(e: Event) => { s.dmPolicy = (e.target as HTMLSelectElement).value; state.requestUpdate(); }}>
            <option value="pairing">${t("settings.channels.wecom.dmPairing")}</option>
            <option value="open">${t("settings.channels.wecom.dmOpen")}</option>
          </select>
        </div>

        <div class="oc-settings__form-group">
          <label class="oc-settings__label">${t("settings.channels.wecom.groupPolicy")}</label>
          <select class="oc-settings__select" .value=${s.groupPolicy} @change=${(e: Event) => { s.groupPolicy = (e.target as HTMLSelectElement).value; state.requestUpdate(); }}>
            <option value="disabled">${t("settings.channels.wecom.groupDisabled")}</option>
            <option value="open">${t("settings.channels.wecom.groupOpen")}</option>
            <option value="allowlist">${t("settings.channels.wecom.groupAllowlist")}</option>
          </select>
        </div>

        ${s.groupPolicy === "allowlist" && s.addGroupDialogOpen ? html`
          <div class="oc-modal-overlay" @click=${(e: Event) => { if (e.target === e.currentTarget) cancelAddGroup(state); }}>
            <div class="oc-modal-dialog">
              <label class="oc-settings__label">${t("settings.channels.wecom.addGroupPrompt")}</label>
              <input class="oc-settings__input" .value=${s.addGroupInput} placeholder=${t("settings.channels.wecom.addGroupPlaceholder")}
                @input=${(e: Event) => { s.addGroupInput = (e.target as HTMLInputElement).value; }}
                @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") confirmAddGroup(state); if (e.key === "Escape") cancelAddGroup(state); }} />
              ${s.addGroupError ? html`<div style="color:var(--accent);font-size:12px;margin-top:4px">${s.addGroupError}</div>` : nothing}
              <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
                <button class="oc-settings__btn" @click=${() => cancelAddGroup(state)}>${t("settings.cancel")}</button>
                <button class="oc-settings__btn oc-settings__btn--primary" @click=${() => confirmAddGroup(state)}>${t("settings.confirm")}</button>
              </div>
            </div>
          </div>
        ` : nothing}

        ${s.dmPolicy === "pairing" || s.groupPolicy === "allowlist" ? renderPairingPanel(state, "wecom", s.pairingPanel, () => refreshWecomPairing(state), {
          onAddGroup: s.groupPolicy === "allowlist" ? () => openAddGroupDialog(state) : undefined,
          extraApproved: s.groupPolicy === "allowlist" ? s.groupAllowFrom.map(id => ({
            kind: "group", id,
            onRemove: () => { s.groupAllowFrom = s.groupAllowFrom.filter(g => g !== id); state.requestUpdate(); },
          })) : undefined,
        }) : nothing}

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
