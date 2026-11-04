/** Tencent QQ Bot: account-scoped settings and an explicitly started QR flow. */
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { t, tWithDetail } from "../../i18n.ts";
import * as ipc from "../../data/ipc-bridge.ts";
import { getConfigSnapshot, getCachedConfigSnapshot, invalidateConfigSnapshotCache } from "../../controllers/config.ts";
import "../../components/toggle-switch.ts";
import "../../components/password-input.ts";
import "../../components/message-box.ts";
import { runConfigPatch } from "./tab-patch.ts";
import { extractQqbotView, applyQqbotSave, type QqbotView } from "./tab-channels.lib.ts";
import { QqbotLoginController } from "./qqbot-login.ts";
import { markChannelSaved, renderChannelSaveFooter, runChannelToggle, runChannelSave, loadBundledRuntimeState, verifyChannelCredentials, renderChannelEnableCard } from "./tab-channels-shared.ts";

function createQqbotState() {
  return {
    ...extractQqbotView(null), originalAppId: "", mode: "qr" as "qr" | "manual",
    allowFromText: "", groupAllowFromText: "",
    bundled: true, bundleMessage: "", saving: false,
    error: null as string | null, successMsg: null as string | null, hint: null as string | null,
    initialized: false, loadState: "loading", reloading: false,
    boundAccounts: [] as Array<{ accountId: string; appId: string }>,
  };
}
const s = createQqbotState();
let epoch = 0;
let qr: QqbotLoginController | null = null;
let lastLoadedConfig: Record<string, unknown> | null = null;

export function resetQqbotTab() {
  ++epoch;
  qr?.cancel(); qr = null;
  lastLoadedConfig = null;
  Object.assign(s, createQqbotState());
}

function applyView(view: QqbotView) {
  // Never put the redacted sentinel in the editable password control.
  Object.assign(s, view, { originalAppId: view.appId, clientSecret: "", allowFromText: view.allowFrom.join("\n"), groupAllowFromText: view.groupAllowFrom.join("\n") });
}

async function init(state: AppViewState) {
  if (s.initialized) return;
  s.initialized = true;
  const generation = epoch;
  try {
    if (state.client && state.connected) {
      const snapshot = await getConfigSnapshot(state.client);
      if (generation !== epoch) return;
      if (snapshot) {
        lastLoadedConfig = snapshot.config;
        const view = extractQqbotView(snapshot.config);
        applyView(view.accounts.some(a => a.accountId === "default") ? view : extractQqbotView(snapshot.config, view.accounts[0]?.accountId));
      }
    }
    const runtime = { bundled: true, bundleMessage: "", loadState: "loading" };
    await loadBundledRuntimeState("qqbot", runtime);
    if (generation !== epoch) return;
    Object.assign(s, runtime, { loadState: runtime.loadState === "error" ? "error" : "ready" });
  } catch { if (generation === epoch) s.loadState = "error"; }
  if (generation === epoch) state.requestUpdate();
}

function login(state: AppViewState) {
  if (!qr) qr = new QqbotLoginController({
    start: ipc.settingsQqbotLoginStart,
    wait: ipc.settingsQqbotLoginWait,
    cancel: ipc.settingsQqbotLoginCancel,
    onChange: () => state.requestUpdate(),
    onConnected: async (result, isCurrent) => {
      s.boundAccounts = result.accounts ?? [];
      await reloadBoundAccounts(state, isCurrent);
    },
  });
  return qr;
}

async function reloadBoundAccounts(state: AppViewState, isCurrent: () => boolean = () => true) {
  const generation = epoch;
  s.reloading = true; s.error = null; state.requestUpdate();
  try {
    if (!state.client || !state.connected) throw new Error("Gateway restarting");
    // config.get otherwise returns cached data after a restart disconnect.
    invalidateConfigSnapshotCache();
    const snapshot = await getConfigSnapshot(state.client, { force: true });
    if (generation !== epoch || !isCurrent()) return;
    if (!snapshot || !s.boundAccounts.length || !s.boundAccounts.every(a => extractQqbotView(snapshot.config, a.accountId).appId === a.appId)) throw new Error("Waiting for persisted accounts");
    lastLoadedConfig = snapshot.config;
    applyView(extractQqbotView(snapshot.config, s.boundAccounts[0].accountId));
    s.boundAccounts = [];
    markChannelSaved("qqbot", s.enabled, s, null);
  } catch {
    if (generation === epoch && isCurrent()) s.error = t("settings.channels.qqbot.reloadRequired");
  } finally {
    if (generation === epoch && isCurrent()) { s.reloading = false; state.requestUpdate(); }
  }
}

async function saveQqbot(state: AppViewState): Promise<boolean> {
  if (s.enabled) {
    if (s.allowFromText.split(/[,\n]/).map(id => id.trim()).some(id => id !== "openclaw:approval-disabled" && /[a-z]/.test(id))) {
      s.error = t("settings.channels.qqbot.openidFormat"); return false;
    }
    if (!s.bundled) { s.error = s.bundleMessage || t("settings.channels.qqbot.notBundled"); return false; }
    if (s.accountId === "default" || s.accountEnabled) {
      if (!s.appId.trim()) { s.error = t("settings.channels.qqbot.appIdRequired"); return false; }
      if (!s.clientSecret.trim() && (!s.hasCredentials || s.appId !== s.originalAppId)) { s.error = t("settings.channels.qqbot.clientSecretRequired"); return false; }
      if (s.clientSecret.trim() && !(await verifyChannelCredentials(s, { provider: "qqbot", appId: s.appId.trim(), clientSecret: s.clientSecret.trim() }))) return false;
    }
    if (s.transport === "webhook" && (!s.webhookPath.startsWith("/") || s.webhookPath.includes("?") || s.webhookPath.includes("#"))) {
      s.error = t("settings.channels.qqbot.webhookPathRequired"); return false;
    }
  }
  const outcome = await runConfigPatch(state, draft => applyQqbotSave(draft, { ...s, clientSecret: s.clientSecret || undefined,
    allowFrom: s.allowFromText.split(/[,\n]/), groupAllowFrom: s.groupAllowFromText.split(/[,\n]/),
  }));
  if (!outcome.ok) { s.error = tWithDetail("settings.error.saveFailed", outcome.error); return false; }
  const config = getCachedConfigSnapshot()?.config;
  if (config) { lastLoadedConfig = config; applyView(extractQqbotView(config, s.accountId)); }
  markChannelSaved("qqbot", s.enabled, s, outcome.hint);
  return true;
}

function setAccount(state: AppViewState, accountId: string) {
  ++epoch;
  qr?.cancel();
  s.reloading = false;
  applyView(extractQqbotView(getCachedConfigSnapshot()?.config ?? lastLoadedConfig, accountId));
  s.error = s.successMsg = s.hint = null;
  state.requestUpdate();
}

function booleanField(state: AppViewState, key: "accountEnabled" | "markdownSupport" | "streaming" | "defaultRequireMention" | "urlDirectUpload") {
  return html`<div class="oc-settings__form-group"><oc-toggle-switch .label=${t(`settings.channels.qqbot.${key}`)} .checked=${s[key]}
    @change=${(e: CustomEvent) => { s[key] = Boolean(e.detail.checked); state.requestUpdate(); }}></oc-toggle-switch></div>`;
}

function allowlistField(state: AppViewState, key: "allowFrom" | "groupAllowFrom") {
  const textKey = key === "allowFrom" ? "allowFromText" : "groupAllowFromText";
  return html`<div class="oc-settings__form-group"><label class="oc-settings__label" for=${`qqbot-${key}`}>${t(`settings.channels.qqbot.${key}`)}</label>
    <textarea id=${`qqbot-${key}`} class="oc-settings__input" rows="3" .value=${s[textKey]}
      @input=${(e: Event) => { s[textKey] = (e.target as HTMLTextAreaElement).value; state.requestUpdate(); }}></textarea>
    <p class="oc-settings__hint">${t("settings.channels.qqbot.allowlistHint")}</p></div>`;
}

export function renderChannelQqbot(state: AppViewState) {
  if (!s.initialized) void init(state);
  const flow = login(state);
  const busy = flow.state.status === "starting" || flow.state.status === "waiting";
  const qrMessage = flow.state.status === "idle" ? "" : flow.state.status === "error"
    ? tWithDetail("settings.channels.qqbot.qrError", flow.state.message)
    : t(`settings.channels.qqbot.qrStatus.${flow.state.status}`);
  return html`
    <div class="oc-settings__section" data-page-id="settings:channels:qqbot" data-load-state=${s.loadState === "loading" ? "loading" : s.loadState === "error" || s.error ? "error" : "ready"} aria-busy=${s.loadState === "loading"}>
      <div class="oc-flex oc-items-start oc-justify-end oc-mb-8"><a class="oc-settings__link" href="#" @click=${(e: Event) => { e.preventDefault(); void ipc.openExternal("https://q.qq.com"); }}>${t("settings.channels.qqbot.openPlatform")} &rarr;</a></div>
      ${!s.bundled ? html`<oc-message-box .message=${s.bundleMessage || t("settings.channels.qqbot.notBundled")} .type=${"info"} .visible=${true}></oc-message-box>` : nothing}
      ${renderChannelEnableCard("qqbot", s.enabled, checked => {
        if (!checked) flow.cancel();
        void runChannelToggle(state, s, checked, { save: () => saveQqbot(state) });
      })}
      <div class="oc-settings__card">
        <div class="oc-settings__form-group"><label class="oc-settings__label" for="qqbot-setup-mode">${t("settings.channels.qqbot.setupMode")}</label>
          <select id="qqbot-setup-mode" class="oc-settings__select" .value=${s.mode} @change=${(e: Event) => {
            flow.cancel(); s.reloading = false; s.mode = (e.target as HTMLSelectElement).value as typeof s.mode; state.requestUpdate();
          }}><option value="qr">${t("settings.channels.qqbot.qrMode")}</option><option value="manual">${t("settings.channels.qqbot.manualMode")}</option></select>
        </div>
        ${s.mode === "qr" ? html`
          <p class="oc-settings__hint">${t("settings.channels.qqbot.qrHint")}</p>
          ${flow.state.qrDataUrl ? html`<div class="oc-weixin-qr-section"><div class="oc-weixin-qr-container"><img class="oc-weixin-qr-image" alt=${t("settings.channels.qqbot.qrAlt")} src=${flow.state.qrDataUrl} /></div></div>` : nothing}
          <p class="oc-settings__hint" role="status" aria-live="polite">${qrMessage}</p>
          <div class="btn-row">${busy ? html`<button class="btn" @click=${() => flow.cancel()}>${t("settings.channels.qqbot.qrCancel")}</button>` : nothing}
            <button class="btn primary" ?disabled=${!s.bundled || s.saving || flow.state.status === "starting"} @click=${() => { s.error = s.successMsg = null; void flow.start(); }}>${t(flow.state.status === "idle" ? "settings.channels.qqbot.qrStart" : "settings.channels.qqbot.qrRetry")}</button>
          </div>` : html`<p class="oc-settings__hint">${t("settings.channels.qqbot.manualHint")}</p>`}
      </div>
      <div class="oc-settings__form-group"><label class="oc-settings__label" for="qqbot-account">${t("settings.channels.qqbot.account")}</label>
        <select id="qqbot-account" class="oc-settings__select" ?disabled=${s.saving} @change=${(e: Event) => setAccount(state, (e.target as HTMLSelectElement).value)}>
          ${s.accounts.map(a => html`<option value=${a.accountId} .selected=${s.accountId === a.accountId}>${a.name || a.accountId}${a.appId ? ` · ${a.appId}` : ""}</option>`)}
        </select>
        <p class="oc-settings__hint">${t("settings.channels.qqbot.accountScope")}</p>
      </div>
      ${s.accounts.filter(a => a.appId).map(a => html`<p class="oc-settings__hint">${a.name || a.accountId} · App ID ${a.appId} · ${t(a.enabled ? "settings.channels.qqbot.accountOn" : "settings.channels.qqbot.accountOff")}</p>`)}
      ${s.boundAccounts.length ? html`<p class="oc-settings__hint" role="status">${t("settings.channels.qqbot.reloadRequired")}</p><div class="btn-row"><button class="btn" ?disabled=${s.reloading} @click=${() => void reloadBoundAccounts(state)}>${t("settings.channels.qqbot.reloadAccounts")}</button></div>` : nothing}
      ${s.enabled ? html`
        ${s.accountId !== "default" ? booleanField(state, "accountEnabled") : html`<p class="oc-settings__hint">${t("settings.channels.qqbot.defaultAccountEnable")}</p>`}
        ${s.mode === "manual" ? html`
          <div class="oc-settings__form-group"><label class="oc-settings__label" for="qqbot-app-id">${t("settings.channels.qqbot.appId")}</label><input id="qqbot-app-id" class="oc-settings__input" .value=${s.appId} @input=${(e: Event) => { s.appId = (e.target as HTMLInputElement).value; state.requestUpdate(); }} /></div>
          <div class="oc-settings__form-group"><label class="oc-settings__label">${t("settings.channels.qqbot.clientSecret")}</label><oc-password-input .value=${s.clientSecret} @input=${(e: CustomEvent) => { s.clientSecret = e.detail.value; state.requestUpdate(); }}></oc-password-input>
            ${s.hasCredentials ? html`<p class="oc-settings__hint">${t("settings.channels.qqbot.secretKept")}</p>` : nothing}
          </div>` : nothing}
        <div class="oc-settings__card"><div class="oc-settings__card-title">${t("settings.channels.qqbot.capabilities")}</div>
          ${booleanField(state, "markdownSupport")}${booleanField(state, "streaming")}${booleanField(state, "defaultRequireMention")}${booleanField(state, "urlDirectUpload")}
          <p class="oc-settings__hint">${t("settings.channels.qqbot.modelHint")}</p>
        </div>
        <div class="oc-settings__card"><div class="oc-settings__card-title">${t("settings.channels.qqbot.access")}</div>
          <div class="oc-settings__form-group"><label class="oc-settings__label" for="qqbot-dm-policy">${t("settings.channels.qqbot.dmPolicy")}</label><select id="qqbot-dm-policy" class="oc-settings__select" .value=${s.dmPolicy} @change=${(e: Event) => { s.dmPolicy = (e.target as HTMLSelectElement).value as typeof s.dmPolicy; state.requestUpdate(); }}>
            ${["open", "pairing", "allowlist", "disabled"].map(value => html`<option value=${value}>${t(`settings.channels.qqbot.policy.${value}`)}</option>`)}</select></div>
          ${s.dmPolicy === "allowlist" ? allowlistField(state, "allowFrom") : nothing}
          <div class="oc-settings__form-group"><label class="oc-settings__label" for="qqbot-group-policy">${t("settings.channels.qqbot.groupPolicy")}</label><select id="qqbot-group-policy" class="oc-settings__select" .value=${s.groupPolicy} @change=${(e: Event) => { s.groupPolicy = (e.target as HTMLSelectElement).value as typeof s.groupPolicy; state.requestUpdate(); }}>
            ${["open", "allowlist", "disabled"].map(value => html`<option value=${value}>${t(`settings.channels.qqbot.policy.${value}`)}</option>`)}</select></div>
          ${s.groupPolicy === "allowlist" ? allowlistField(state, "groupAllowFrom") : nothing}
        </div>
        <details class="oc-settings__card"><summary class="oc-settings__card-title">${t("settings.channels.qqbot.advanced")}</summary>
          <div class="oc-settings__form-group"><label class="oc-settings__label" for="qqbot-transport">${t("settings.channels.qqbot.transport")}</label><select id="qqbot-transport" class="oc-settings__select" .value=${s.transport} @change=${(e: Event) => { s.transport = (e.target as HTMLSelectElement).value as typeof s.transport; state.requestUpdate(); }}><option value="websocket">WebSocket</option><option value="webhook">Webhook</option></select></div>
          ${s.transport === "webhook" ? html`<div class="oc-settings__form-group"><label class="oc-settings__label" for="qqbot-webhook">${t("settings.channels.qqbot.webhookPath")}</label><input id="qqbot-webhook" class="oc-settings__input" placeholder="/qqbot/webhook" .value=${s.webhookPath} @input=${(e: Event) => { s.webhookPath = (e.target as HTMLInputElement).value; state.requestUpdate(); }} /><p class="oc-settings__hint">${t("settings.channels.qqbot.webhookHint")}</p></div>` : nothing}
          <p class="oc-settings__hint">${t("settings.channels.qqbot.managedUpgrade")}</p>
        </details>
      ` : nothing}
      ${renderChannelSaveFooter(s, () => { flow.cancel(); return runChannelSave(state, s, () => saveQqbot(state)); })}
    </div>`;
}
