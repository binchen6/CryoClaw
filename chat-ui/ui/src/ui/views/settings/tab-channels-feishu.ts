/**
 * Settings: Channels — Feishu sub-panel.
 *
 * R4：读写改走内核 config.get 快照 + config.patch（controllers/config.ts），
 * 凭据验证仍走主进程 settings:verify-key（真实 HTTP 探测）；
 * pairing 审批/授权列表保留主进程 IPC（pairing store 属主进程职责）。
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
import { extractFeishuView, applyFeishuSave, looksLikeFeishuGroupId } from "./tab-channels.lib.ts";
import { loadPairingData, type PairingPanelState } from "./tab-channels-pairing-panel.ts";
import { markChannelSaved, renderChannelSaveFooter, renderAddGroupDialog, renderChannelPairingSection, createChannelPanelBaseState, runChannelToggle, runChannelSave, verifyChannelCredentials, loadBundledRuntimeState, openChannelAddGroupDialog, closeChannelAddGroupDialog, confirmChannelAddGroup, renderChannelEnableCard } from "./tab-channels-shared.ts";

// Feishu 面板状态必须可整体回滚，避免未保存表单和配对缓存跨会话残留。
function createFeishuState() {
  return {
    enabled: false,
    appId: "",
    appSecret: "",
    dmPolicy: "pairing",
    dmScope: "main",
    groupPolicy: "disabled",
    groupAllowFrom: [] as string[],
    // bundled 运行态（settings:get-channel-runtime-state）：默认按已打包处理，
    // 探测结果返回前不误显示「组件缺失」banner。
    bundled: true,
    bundleMessage: "",
    ...createChannelPanelBaseState(),
  };
}

const s = createFeishuState();

// 退出 Settings 时直接丢掉 Feishu 面板缓存，下次重新从 config 快照拉真配置。
export function resetFeishuTab() {
  Object.assign(s, createFeishuState());
}

function loadFromSnapshot(): boolean {
  const config = getCachedConfigSnapshot()?.config;
  if (!config) return false;
  const view = extractFeishuView(config);
  s.enabled = view.enabled;
  s.appId = view.appId;
  s.appSecret = view.appSecret;
  s.dmPolicy = view.dmPolicy;
  s.dmScope = view.dmScope;
  s.groupPolicy = view.groupPolicy;
  s.groupAllowFrom = view.groupAllowFrom;
  return true;
}

async function init(state: AppViewState) {
  if (s.initialized) return;
  s.initialized = true;
  try {
    if (state.client && state.connected) {
      await getConfigSnapshot(state.client);
      loadFromSnapshot();
      state.requestUpdate();
    }
    // bundled 运行态探测（T5）：主进程四根判定 + throttled reconcile 自愈，
    // 缺组件时渲染 banner 并阻断保存（同 wecom/dingtalk/qqbot 面板）。
    await loadBundledRuntimeState("feishu", s);
    state.requestUpdate();
    refreshFeishuPairing(state);
  } catch {}
}

export async function refreshFeishuPairing(state: AppViewState) {
  s.pairingPanel = await loadPairingData("feishu");
  state.requestUpdate();
}

/** 统一保存：主进程验证凭据 → config.patch 写入。 */
async function saveFeishu(state: AppViewState, enabled: boolean): Promise<boolean> {
  if (enabled) {
    if (!s.bundled) { s.error = s.bundleMessage || t("settings.channels.feishu.notBundled"); return false; }
    if (!(await verifyChannelCredentials(s, { provider: "feishu", appId: s.appId, appSecret: s.appSecret }))) return false;
  }
  let rejected = false;
  const outcome = await runConfigPatch(state, draft => {
    const ok = applyFeishuSave(draft, {
      enabled,
      appId: s.appId,
      appSecret: s.appSecret,
      dmPolicy: s.dmPolicy,
      dmScope: s.dmScope,
      groupPolicy: s.groupPolicy,
      groupAllowFrom: s.groupAllowFrom,
    });
    if (!ok) rejected = true;
  });
  if (rejected) {
    s.error = t("settings.channels.feishu.addGroupInvalidPrefix");
    return false;
  }
  if (!outcome.ok) {
    s.error = tWithDetail("settings.error.saveFailed", outcome.error);
    return false;
  }
  markChannelSaved("feishu", enabled, s, outcome.hint);
  return true;
}

async function handleToggle(state: AppViewState, checked: boolean) {
  await runChannelToggle(state, s, checked, {
    save: (enabled) => saveFeishu(state, enabled),
    saveOnEnable: true,
    // Enable -> validate credentials first, then save；无凭据时仅展开表单
    enableGate: () => !!(s.appId && s.appSecret),
    onEnabledSaved: () => refreshFeishuPairing(state),
  });
}

async function handleSave(state: AppViewState) {
  await runChannelSave(state, s, () => saveFeishu(state, s.enabled), () => refreshFeishuPairing(state));
}

function openAddGroupDialog(state: AppViewState) {
  openChannelAddGroupDialog(state, s);
}

function confirmAddGroup(state: AppViewState) {
  confirmChannelAddGroup(state, s, (id) =>
    looksLikeFeishuGroupId(id) ? null : t("settings.channels.feishu.addGroupInvalidPrefix"),
  );
}

function cancelAddGroup(state: AppViewState) {
  closeChannelAddGroupDialog(state, s);
}

export function renderChannelFeishu(state: AppViewState) {
  if (!s.initialized) init(state);

  return html`
    <div class="oc-settings__section">
      <div class="oc-flex oc-items-start oc-justify-end oc-mb-8">
        <div class="oc-flex oc-flex-shrink-0 oc-gap-12">
          <a class="oc-settings__link" href="#" @click=${(e: Event) => { e.preventDefault(); ipc.openExternal("https://oneclaw.cn/docs/tutorials/feishu-bot.html"); }}>${t("settings.channels.feishu.setupGuide")} &rarr;</a>
          <a class="oc-settings__link" href="#" @click=${(e: Event) => { e.preventDefault(); ipc.openExternal("https://open.feishu.cn/page/launcher?from=backend_oneclick"); }}>${t("settings.channels.feishu.openConsole")} &rarr;</a>
        </div>
      </div>

      ${!s.bundled ? html`<oc-message-box .message=${s.bundleMessage || t("settings.channels.feishu.notBundled")} .type=${"info"} .visible=${true}></oc-message-box>` : nothing}

      ${renderChannelEnableCard("feishu", s.enabled, (checked) => void handleToggle(state, checked))}

      ${s.enabled ? html`
        <div class="oc-settings__form-group">
          <label class="oc-settings__label">${t("settings.channels.feishu.appId")}</label>
          <input class="oc-settings__input" .value=${s.appId} @input=${(e: Event) => { s.appId = (e.target as HTMLInputElement).value; state.requestUpdate(); }} />
        </div>

        <div class="oc-settings__form-group">
          <label class="oc-settings__label">${t("settings.channels.feishu.appSecret")}</label>
          <oc-password-input .value=${s.appSecret}
            @input=${(e: CustomEvent) => { s.appSecret = e.detail.value; state.requestUpdate(); }}
          ></oc-password-input>
        </div>

        <div class="oc-settings__form-group">
          <label class="oc-settings__label">${t("settings.channels.feishu.dmPolicy")}</label>
          <select class="oc-settings__select" .value=${s.dmPolicy} @change=${(e: Event) => { s.dmPolicy = (e.target as HTMLSelectElement).value; state.requestUpdate(); }}>
            <option value="pairing">${t("settings.channels.feishu.dmPairing")}</option>
            <option value="open">${t("settings.channels.feishu.dmOpen")}</option>
          </select>
        </div>

        <div class="oc-settings__form-group">
          <label class="oc-settings__label">${t("settings.channels.feishu.dmScope")}</label>
          <select class="oc-settings__select" .value=${s.dmScope} @change=${(e: Event) => { s.dmScope = (e.target as HTMLSelectElement).value; state.requestUpdate(); }}>
            <option value="main">${t("settings.channels.feishu.dmScopeMain")}</option>
            <option value="per-peer">${t("settings.channels.feishu.dmScopePerPeer")}</option>
            <option value="per-channel-peer">${t("settings.channels.feishu.dmScopePerChannelPeer")}</option>
            <option value="per-account-channel-peer">${t("settings.channels.feishu.dmScopePerAccountChannelPeer")}</option>
          </select>
        </div>

        <div class="oc-settings__form-group">
          <label class="oc-settings__label">${t("settings.channels.feishu.groupPolicy")}</label>
          <select class="oc-settings__select" .value=${s.groupPolicy} @change=${(e: Event) => { s.groupPolicy = (e.target as HTMLSelectElement).value; state.requestUpdate(); }}>
            <option value="disabled">${t("settings.channels.feishu.groupDisabled")}</option>
            <option value="allowlist">${t("settings.channels.feishu.groupAllowlist")}</option>
            <option value="open">${t("settings.channels.feishu.groupOpen")}</option>
          </select>
        </div>

        ${s.groupPolicy === "allowlist" && s.addGroupDialogOpen ? renderAddGroupDialog(state, s, {
          promptLabel: t("settings.channels.feishu.addGroupPrompt"),
          placeholder: "oc_...",
          onConfirm: () => confirmAddGroup(state),
          onCancel: () => cancelAddGroup(state),
        }) : nothing}

        ${renderChannelPairingSection(state, "feishu", s, () => refreshFeishuPairing(state), () => openAddGroupDialog(state))}

        ${renderChannelSaveFooter(s, () => handleSave(state))}
      ` : nothing}
    </div>
  `;
}
