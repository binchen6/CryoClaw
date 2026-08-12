/**
 * Settings: Search Tab — Kimi Search configuration.
 *
 * R4：enabled/serviceBaseUrl 改走 config.get 快照 + config.patch；
 * 专属 API key 的 sidecar 读写保留主进程 IPC（credentials 文件属主进程职责）。
 */
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { t, tWithDetail } from "../../i18n.ts";
import * as ipc from "../../data/ipc-bridge.ts";
import "../../components/toggle-switch.ts";
import "../../components/password-input.ts";
import "../../components/message-box.ts";
import "../../components/provider-segment.ts";
import { getConfigSnapshot, getCachedConfigSnapshot } from "../../controllers/config.ts";
import { runConfigPatch } from "./tab-patch.ts";
import { extractKimiSearchView, applyKimiSearchSave } from "./tab-channels.lib.ts";

// Search 页状态必须可重建，避免未保存的 API key 草稿残留到下次打开。
function createSearchState() {
  return {
    enabled: false,
    apiKey: "",
    serviceBaseUrl: "",
    isKimiCodeConfigured: false,
    bundled: true,
    bundleMessage: "",
    saving: false,
    error: null as string | null,
    successMsg: null as string | null,
    hint: null as string | null,
    initialized: false,
  };
}

const s = createSearchState();

// 离开 Settings 时直接丢掉 Search 页缓存，下次重新从 config 快照拉真配置。
function resetSearchState() {
  Object.assign(s, createSearchState());
}

// 统一回填 Search 页真实配置，避免初始化和保存后各写一套状态同步逻辑。
async function refreshSearchConfig(state: AppViewState) {
  if (state.client && state.connected) {
    await getConfigSnapshot(state.client, { force: true });
    const config = getCachedConfigSnapshot()?.config;
    if (config) {
      const view = extractKimiSearchView(config);
      s.enabled = view.enabled;
      s.serviceBaseUrl = view.serviceBaseUrl;
      s.isKimiCodeConfigured = view.isKimiCodeConfigured;
    }
  }
  // 专属 key 存 sidecar 文件（主进程读取），不随 config 快照走
  const key = await ipc.settingsGetKimiSearchKey().catch(() => null);
  if (key) s.apiKey = key.apiKey ?? "";
  const runtime = await ipc.settingsGetChannelRuntimeState().catch(() => null);
  if (runtime) {
    s.bundled = runtime.bundled.kimiSearch;
    s.bundleMessage = runtime.bundleMessages.kimiSearch ?? "";
  }
  state.requestUpdate();
}

async function init(state: AppViewState) {
  if (s.initialized) return;
  s.initialized = true;
  try {
    await refreshSearchConfig(state);
  } catch {}
}

async function handleSave(state: AppViewState) {
  s.saving = true;
  s.error = null;
  s.successMsg = null;
  s.hint = null;
  state.requestUpdate();
  try {
    if (s.enabled && !s.bundled) {
      s.saving = false;
      s.error = s.bundleMessage || t("settings.search.notBundled");
      state.requestUpdate();
      return;
    }
    // 专属 key 写 sidecar（空字符串则清除），并注入 auth proxy；不写入 openclaw.json
    await ipc.settingsWriteKimiSearchKey({ apiKey: s.apiKey });
    const outcome = await runConfigPatch(state, draft => {
      applyKimiSearchSave(draft, { enabled: s.enabled, serviceBaseUrl: s.serviceBaseUrl });
    });
    if (!outcome.ok) {
      s.saving = false;
      s.error = tWithDetail("settings.error.saveFailed", outcome.error);
      state.requestUpdate();
      return;
    }
    await refreshSearchConfig(state);
    s.saving = false;
    s.successMsg = t("settings.saved");
    s.hint = outcome.hint ?? null;
    state.requestUpdate();
  } catch (e: any) {
    s.saving = false;
    s.error = tWithDetail("settings.error.saveFailed", e?.message);
    state.requestUpdate();
  }
}

export function resetSearchTab() { resetSearchState(); }

export function renderTabSearch(state: AppViewState) {
  if (!s.initialized) init(state);
  const autoReuseHint = !s.apiKey && s.isKimiCodeConfigured;

  return html`
    <div class="oc-settings__section">
      <h2 class="oc-settings__section-title">${t("settings.search.title")}</h2>
      <p class="oc-settings__hint">${t("settings.search.desc")}</p>

      <oc-toggle-switch .label=${t("settings.search.enable")} .checked=${s.enabled}
        @change=${(e: CustomEvent) => { s.enabled = e.detail.checked; state.requestUpdate(); }}
      ></oc-toggle-switch>

      <oc-provider-segment
        .providers=${["moonshot"]}
        .selected=${""}
        .labels=${{ moonshot: t("setup.provider.label.moonshot") }}
      ></oc-provider-segment>

      <div class="oc-settings__hint" style="margin-bottom:12px">${t("settings.search.guide")}
        <a class="oc-settings__link" href="#" @click=${(e: Event) => { e.preventDefault(); ipc.openExternal("https://www.kimi.com/code/console"); }}>${t("settings.search.getApiKey")}</a>
      </div>

      ${autoReuseHint ? html`
        <div class="oc-settings__hint" style="margin-bottom:12px;color:var(--accent)">${t("settings.search.autoReuse")}</div>
      ` : nothing}
      <div class="oc-settings__form-group">
        <label class="oc-settings__label">${t("setup.provider.apiKey")}</label>
        <oc-password-input .value=${s.apiKey} placeholder="sk-kimi-..."
          @input=${(e: CustomEvent) => { s.apiKey = e.detail.value; state.requestUpdate(); }}
        ></oc-password-input>
      </div>

      <details class="oc-settings__details-advanced">
        <summary>${t("setup.provider.oauth.advanced")}</summary>
        <div class="oc-settings__form-group" style="margin-top:12px">
          <label class="oc-settings__label">${t("settings.search.serviceBaseUrl")}</label>
          <input class="oc-settings__input" .value=${s.serviceBaseUrl}
            @input=${(e: Event) => { s.serviceBaseUrl = (e.target as HTMLInputElement).value; }} />
        </div>
      </details>

      <oc-message-box .message=${s.error ?? ""} .type=${"error"} .visible=${!!s.error}></oc-message-box>
      <oc-message-box .message=${s.successMsg ?? ""} .type=${"success"} .visible=${!!s.successMsg}></oc-message-box>
      ${s.hint ? html`<div class="oc-settings__field-hint">${s.hint}</div>` : nothing}

      <div class="oc-settings__btn-row">
        <button class="oc-settings__btn oc-settings__btn--primary" ?disabled=${s.saving} @click=${() => handleSave(state)}>${t("settings.save")}</button>
      </div>
    </div>
  `;
}
