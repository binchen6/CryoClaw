/**
 * Settings: Channels — QQ Bot sub-panel.
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
import { extractQqbotView, applyQqbotSave } from "./tab-channels.lib.ts";
import { markChannelSaved, renderChannelSaveFooter, runChannelToggle, runChannelSave } from "./tab-channels-shared.ts";

// QQ Bot 面板状态必须可整体回滚，避免未保存凭据残留到下次打开。
function createQqbotState() {
  return {
    enabled: false,
    appId: "",
    clientSecret: "",
    markdownSupport: false,
    bundled: true,
    bundleMessage: "",
    saving: false,
    error: null as string | null,
    successMsg: null as string | null,
    hint: null as string | null,
    initialized: false,
  };
}

const s = createQqbotState();

// 退出 Settings 时直接丢掉 QQ Bot 面板缓存，下次重新从 config 快照拉真配置。
export function resetQqbotTab() {
  Object.assign(s, createQqbotState());
}

async function init(state: AppViewState) {
  if (s.initialized) return;
  s.initialized = true;
  try {
    if (state.client && state.connected) {
      await getConfigSnapshot(state.client);
      const config = getCachedConfigSnapshot()?.config;
      if (config) {
        const view = extractQqbotView(config);
        s.enabled = view.enabled;
        s.appId = view.appId;
        s.clientSecret = view.clientSecret;
        s.markdownSupport = view.markdownSupport;
      }
    }
    const runtime = await ipc.settingsGetChannelRuntimeState().catch(() => null);
    if (runtime) {
      s.bundled = runtime.bundled.qqbot;
      s.bundleMessage = runtime.bundleMessages.qqbot ?? "";
    }
    state.requestUpdate();
  } catch {}
}

/** 统一保存：启用时先主进程验证凭据 → config.patch 写入。 */
async function saveQqbot(state: AppViewState): Promise<boolean> {
  if (s.enabled) {
    if (!s.appId) { s.error = t("settings.channels.qqbot.appIdRequired"); return false; }
    if (!s.clientSecret) { s.error = t("settings.channels.qqbot.clientSecretRequired"); return false; }
    if (!s.bundled) { s.error = s.bundleMessage || t("settings.channels.qqbot.notBundled"); return false; }
    const verifyResult = await ipc.settingsVerifyKey({ provider: "qqbot", appId: s.appId, clientSecret: s.clientSecret });
    if (!verifyResult.success) {
      s.error = tWithDetail("settings.error.verifyFailed", verifyResult.message ?? verifyResult.error);
      return false;
    }
  }
  const outcome = await runConfigPatch(state, draft => {
    applyQqbotSave(draft, {
      enabled: s.enabled,
      appId: s.appId,
      clientSecret: s.clientSecret,
      markdownSupport: s.markdownSupport,
    });
  });
  if (!outcome.ok) {
    s.error = tWithDetail("settings.error.saveFailed", outcome.error);
    return false;
  }
  markChannelSaved("qqbot", s.enabled, s, outcome.hint);
  return true;
}

async function handleToggle(state: AppViewState, checked: boolean) {
  // 启用时不立即保存，仅展开表单；关闭时立即保存
  await runChannelToggle(state, s, checked, { save: () => saveQqbot(state) });
}

async function handleSave(state: AppViewState) {
  await runChannelSave(state, s, () => saveQqbot(state));
}

export function renderChannelQqbot(state: AppViewState) {
  if (!s.initialized) init(state);

  return html`
    <div class="oc-settings__section">
      <div class="oc-flex oc-items-start oc-justify-end oc-mb-8">
        <div class="oc-flex oc-gap-12" style="flex-shrink:0">
          <a class="oc-settings__link" href="#" @click=${(e: Event) => { e.preventDefault(); ipc.openExternal("https://q.qq.com"); }}>${t("settings.channels.qqbot.openPlatform")} &rarr;</a>
        </div>
      </div>

      ${!s.bundled ? html`<oc-message-box .message=${s.bundleMessage || t("settings.channels.qqbot.notBundled")} .type=${"info"} .visible=${true}></oc-message-box>` : nothing}

      <div class="oc-settings__form-group">
        <oc-toggle-switch .label=${t("settings.channels.enable")} .checked=${s.enabled}
          @change=${(e: CustomEvent) => handleToggle(state, e.detail.checked)}
        ></oc-toggle-switch>
      </div>

      ${s.enabled ? html`
        <div class="oc-settings__form-group">
          <label class="oc-settings__label">${t("settings.channels.qqbot.appId")}</label>
          <input class="oc-settings__input" .value=${s.appId} @input=${(e: Event) => { s.appId = (e.target as HTMLInputElement).value; state.requestUpdate(); }} />
        </div>

        <div class="oc-settings__form-group">
          <label class="oc-settings__label">${t("settings.channels.qqbot.clientSecret")}</label>
          <oc-password-input .value=${s.clientSecret} @input=${(e: CustomEvent) => { s.clientSecret = e.detail.value; state.requestUpdate(); }}></oc-password-input>
        </div>

        <div class="oc-settings__form-group">
          <oc-toggle-switch .label=${t("settings.channels.qqbot.markdown")} .checked=${s.markdownSupport}
            @change=${(e: CustomEvent) => { s.markdownSupport = e.detail.checked; state.requestUpdate(); }}
          ></oc-toggle-switch>
        </div>

        ${renderChannelSaveFooter(s, () => handleSave(state))}
      ` : nothing}
    </div>
  `;
}
