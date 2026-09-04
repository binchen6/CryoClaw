/**
 * 渠道子面板（feishu / wecom / dingtalk / qqbot）共享块：
 * 保存成功收尾、错误/成功消息 + 保存按钮尾部、添加群弹窗、配对面板区段。
 */
import { html, nothing } from "lit";
import type { TemplateResult } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { t, tWithDetail } from "../../i18n.ts";
import * as ipc from "../../data/ipc-bridge.ts";
import { getConfigSnapshot, getCachedConfigSnapshot } from "../../controllers/config.ts";
import { updateChannelEnabled, syncChannelEnabledFromSnapshot } from "./tab-channels.ts";
import { renderPairingPanel, type PairingPanelState } from "./tab-channels-pairing-panel.ts";

// 渠道/记忆子面板 init 公共骨架（dingtalk / qqbot / wecom / weixin / memory 共用）：
// 首次打开时从 config 快照填充表单，再做面板自定义的附加加载（runtime 探测、账号列表等）。
export async function initChannelTabOnce(
  state: AppViewState,
  st: { initialized: boolean },
  opts: {
    applyConfig?: (config: Record<string, unknown>) => void;
    loadExtra?: () => Promise<void>;
    after?: () => void;
  },
): Promise<void> {
  if (st.initialized) return;
  st.initialized = true;
  try {
    if (state.client && state.connected) {
      await getConfigSnapshot(state.client);
      const config = getCachedConfigSnapshot()?.config;
      if (config) opts.applyConfig?.(config);
    }
    await opts.loadExtra?.();
    state.requestUpdate();
    opts.after?.();
  } catch {}
}

// bundled 运行态探测（dingtalk / qqbot / wecom 共用）：未打包时携带主进程提示文案。
export async function loadBundledRuntimeState(
  platform: "dingtalk" | "qqbot" | "wecom",
  st: { bundled: boolean; bundleMessage: string },
): Promise<void> {
  const runtime = await ipc.settingsGetChannelRuntimeState().catch(() => null);
  if (runtime) {
    st.bundled = runtime.bundled[platform];
    st.bundleMessage = runtime.bundleMessages[platform] ?? "";
  }
}

// 保存前凭据验证（dingtalk / qqbot / wecom / feishu 共用）：失败时写入统一错误消息。
export async function verifyChannelCredentials(
  st: { error: string | null },
  params: Record<string, unknown>,
): Promise<boolean> {
  const verifyResult = await ipc.settingsVerifyKey(params);
  if (!verifyResult.success) {
    st.error = tWithDetail("settings.error.verifyFailed", verifyResult.message ?? verifyResult.error);
    return false;
  }
  return true;
}

export interface ChannelFeedbackState {
  enabled: boolean;
  saving: boolean;
  error: string | null;
  successMsg: string | null;
  hint: string | null;
}

// 带配对面板的渠道（feishu / wecom）面板状态公共尾部字段。
export function createChannelPanelBaseState() {
  return {
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

// 渠道开关统一流程（四个渠道子面板共用）：
//   disable → 立即保存；enable → 可选凭据门槛 + 可选保存 + 保存成功后回调。
export async function runChannelToggle(
  state: AppViewState,
  st: ChannelFeedbackState,
  checked: boolean,
  opts: {
    save: (enabled: boolean) => Promise<boolean>;
    saveOnEnable?: boolean;      // dingtalk/qqbot 启用时不立即保存，仅展开表单
    enableGate?: () => boolean;  // false → 无凭据，仅显示表单不保存
    onEnabledSaved?: () => void; // 启用保存成功后回调（如刷新 pairing）
  },
): Promise<void> {
  const prevEnabled = st.enabled;
  st.enabled = checked;
  st.error = null;
  st.successMsg = null;
  st.hint = null;
  if (!checked) {
    // Disable -> save immediately
    st.saving = true; state.requestUpdate();
    const ok = await opts.save(false);
    st.saving = false;
    if (!ok) st.enabled = prevEnabled;
    state.requestUpdate();
    return;
  }
  state.requestUpdate();
  if (!opts.saveOnEnable) return;
  if (opts.enableGate && !opts.enableGate()) return;
  st.saving = true; state.requestUpdate();
  const ok = await opts.save(true);
  st.saving = false;
  if (!ok) st.enabled = prevEnabled;
  state.requestUpdate();
  if (ok) opts.onEnabledSaved?.();
}

// 渠道保存按钮统一流程：重置反馈 → 保存 → 成功后可选回调。
export async function runChannelSave(
  state: AppViewState,
  st: ChannelFeedbackState,
  save: () => Promise<boolean>,
  onSaved?: () => void,
): Promise<void> {
  st.saving = true; st.error = null; st.successMsg = null; st.hint = null; state.requestUpdate();
  const ok = await save();
  st.saving = false;
  state.requestUpdate();
  if (ok) onSaved?.();
}

// 保存成功后的统一收尾：同步导航栏启用状态点 + 写成功反馈。
export function markChannelSaved(
  platform: string,
  enabled: boolean,
  st: Pick<ChannelFeedbackState, "successMsg" | "hint">,
  hint: string | null | undefined,
): void {
  updateChannelEnabled(platform, enabled);
  syncChannelEnabledFromSnapshot();
  st.successMsg = t("settings.saved");
  st.hint = hint ?? null;
}

// 启用态统一尾部：错误/成功消息盒 + hint + 保存按钮。
export function renderChannelSaveFooter(
  st: ChannelFeedbackState,
  onSave: () => void,
): TemplateResult {
  return html`
    <oc-message-box .message=${st.error ?? ""} .type=${"error"} .visible=${!!st.error}></oc-message-box>
    <oc-message-box .message=${st.successMsg ?? ""} .type=${"success"} .visible=${!!st.successMsg}></oc-message-box>
    ${st.hint ? html`<div class="oc-settings__field-hint">${st.hint}</div>` : nothing}

    <div class="oc-settings__btn-row">
      <button class="oc-settings__btn oc-settings__btn--primary" ?disabled=${st.saving} @click=${onSave}>${t("settings.save")}</button>
    </div>
  `;
}

export interface AddGroupDialogState {
  addGroupInput: string;
  addGroupError: string | null;
}

// 添加群弹窗完整状态（feishu / wecom 白名单模式共用）：含开关与白名单草稿。
export interface AddGroupDialogFullState extends AddGroupDialogState {
  addGroupDialogOpen: boolean;
  groupAllowFrom: string[];
}

// 打开添加群弹窗（清空上次输入）
export function openChannelAddGroupDialog(state: AppViewState, st: AddGroupDialogFullState) {
  st.addGroupDialogOpen = true;
  st.addGroupInput = "";
  st.addGroupError = null;
  state.requestUpdate();
}

// 关闭添加群弹窗（取消/确认后共用）
export function closeChannelAddGroupDialog(state: AppViewState, st: AddGroupDialogFullState) {
  st.addGroupDialogOpen = false;
  st.addGroupError = null;
  state.requestUpdate();
}

// 确认添加群：feishu 传 validate 做群号前缀校验，wecom 不校验。
// 只改本地草稿，随「保存」一起 config.patch 落盘。
export function confirmChannelAddGroup(
  state: AppViewState,
  st: AddGroupDialogFullState,
  validate?: (id: string) => string | null,
) {
  const id = st.addGroupInput.trim();
  if (!id) return;
  const invalidMsg = validate?.(id) ?? null;
  if (invalidMsg) {
    st.addGroupError = invalidMsg;
    state.requestUpdate();
    return;
  }
  if (!st.groupAllowFrom.includes(id)) {
    st.groupAllowFrom = [...st.groupAllowFrom, id];
  }
  closeChannelAddGroupDialog(state, st);
}

// 添加群弹窗（feishu / wecom 白名单模式共用）。
export function renderAddGroupDialog(
  state: AppViewState,
  st: AddGroupDialogState,
  opts: {
    promptLabel: string;
    placeholder: string;
    onConfirm: () => void;
    onCancel: () => void;
  },
): TemplateResult {
  return html`
    <div class="oc-modal-overlay" @click=${(e: Event) => { if (e.target === e.currentTarget) opts.onCancel(); }}>
      <div class="oc-modal-dialog">
        <label class="oc-settings__label">${opts.promptLabel}</label>
        <input class="oc-settings__input" .value=${st.addGroupInput} placeholder=${opts.placeholder}
          @input=${(e: Event) => { st.addGroupInput = (e.target as HTMLInputElement).value; state.requestUpdate(); }}
          @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" && !e.isComposing) opts.onConfirm(); if (e.key === "Escape") opts.onCancel(); }} />
        ${st.addGroupError ? html`<div class="oc-settings__field-hint oc-settings__field-hint--danger oc-mt-4">${st.addGroupError}</div>` : nothing}
        <div class="oc-flex oc-gap-8 oc-justify-end oc-mt-12">
          <button class="oc-settings__btn" @click=${() => opts.onCancel()}>${t("settings.cancel")}</button>
          <button class="oc-settings__btn oc-settings__btn--primary" @click=${() => opts.onConfirm()}>${t("settings.confirm")}</button>
        </div>
      </div>
    </div>
  `;
}

// 配对面板区段（feishu / wecom 共用）：DM 配对或群白名单开启时显示，
// 白名单模式下把群允许列表作为 extraApproved 挂进配对面板。
export function renderChannelPairingSection(
  state: AppViewState,
  platform: "feishu" | "wecom",
  st: {
    dmPolicy: string;
    groupPolicy: string;
    groupAllowFrom: string[];
    pairingPanel: PairingPanelState;
  },
  refresh: () => void,
  openAddGroup: () => void,
) {
  if (st.dmPolicy !== "pairing" && st.groupPolicy !== "allowlist") return nothing;
  const allowlist = st.groupPolicy === "allowlist";
  return renderPairingPanel(state, platform, st.pairingPanel, refresh, {
    onAddGroup: allowlist ? openAddGroup : undefined,
    extraApproved: allowlist ? st.groupAllowFrom.map(id => ({
      kind: "group", id,
      onRemove: () => { st.groupAllowFrom = st.groupAllowFrom.filter(g => g !== id); state.requestUpdate(); },
    })) : undefined,
  });
}
