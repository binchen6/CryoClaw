/**
 * Settings: Voice Tab.
 * 语音只读状态 + 基础开关（TTS 开关 / Provider / Persona 走 gateway RPC，不写配置文件）。
 * 完整实时语音会话 UI 不在此实现，talk 配置节只读展示。
 */
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import {
  applyTtsAction,
  loadVoiceStatus,
  type TalkSection,
  type TtsStatus,
} from "../../controllers/voice.ts";
import { t } from "../../i18n.ts";
import "../../components/toggle-switch.ts";
import "../../components/message-box.ts";

// Voice 页状态必须可重建，避免缓存污染下次打开（对齐 tab-memory）。
function createVoiceState() {
  return {
    error: null as string | null,
    successMsg: null as string | null,
    actionPending: false,
    // TTS 状态/开关（走 gateway RPC）
    ttsStatus: null as TtsStatus | null,
    ttsLoading: false,
    ttsLoaded: false,
    ttsFailed: false,
    // Talk 配置（只读展示）
    talkConfig: null as TalkSection | null,
    talkLoaded: false,
    // 语音唤醒词（只读展示）
    wakeTriggers: null as string[] | null,
    wakeLoaded: false,
    wasConnected: false,
  };
}

const s = createVoiceState();

function resetVoiceState() {
  Object.assign(s, createVoiceState());
}

function renderStatusRow(label: string, value: unknown) {
  return html`
    <div class="oc-settings__form-group">
      <span class="oc-settings__field-hint">${label}: ${value == null || value === "" ? "—" : String(value)}</span>
    </div>
  `;
}

function renderTtsStatus() {
  if (s.ttsLoading && !s.ttsLoaded) {
    return html`<div class="oc-settings__field-hint">${t("settings.voice.statusLoading")}</div>`;
  }
  // 未连接 / RPC 失败 / 内核无 TTS 后端，统一降级为一行提示。
  if (s.ttsFailed || !s.ttsStatus) {
    return html`<div class="oc-settings__field-hint">${t("settings.voice.statusUnavailable")}</div>`;
  }
  const ts = s.ttsStatus;
  const providerStates = Array.isArray(ts.providerStates) ? ts.providerStates : [];
  return html`
    ${renderStatusRow(t("settings.voice.statusEnabled"), ts.enabled ? t("settings.voice.enabled") : t("settings.voice.disabled"))}
    ${ts.auto ? renderStatusRow(t("settings.voice.statusAuto"), ts.auto) : nothing}
    ${renderStatusRow(t("settings.voice.statusProvider"), ts.provider)}
    ${renderStatusRow(t("settings.voice.statusPersona"), ts.persona)}
    ${ts.fallbackProvider ? renderStatusRow(t("settings.voice.statusFallback"), ts.fallbackProvider) : nothing}
    ${providerStates.map(p => renderStatusRow(
      p.label ?? p.id ?? "",
      p.configured ? t("settings.voice.providerConfigured") : t("settings.voice.providerNotConfigured"),
    ))}
  `;
}

function renderTalkSection() {
  if (!s.talkLoaded) return nothing;
  return html`
    <div class="oc-settings__card">
      <div class="oc-settings__card-title">${t("settings.voice.talkTitle")}</div>
      ${!s.talkConfig
        ? html`<div class="oc-settings__field-hint">${t("settings.voice.talkUnavailable")}</div>`
        : html`
          ${renderStatusRow(t("settings.voice.talkProvider"), s.talkConfig.provider)}
          ${renderStatusRow(t("settings.voice.talkMode"), s.talkConfig.realtime?.mode)}
          ${renderStatusRow(t("settings.voice.talkTransport"), s.talkConfig.realtime?.transport)}
          ${renderStatusRow(t("settings.voice.talkLocale"), s.talkConfig.speechLocale)}
          ${typeof s.talkConfig.interruptOnSpeech === "boolean"
            ? renderStatusRow(t("settings.voice.talkInterrupt"),
                s.talkConfig.interruptOnSpeech ? t("settings.voice.enabled") : t("settings.voice.disabled"))
            : nothing}
        `}
      <div class="oc-settings__field-hint">${t("settings.voice.talkReadonlyHint")}</div>
    </div>
  `;
}

function renderWakeSection() {
  if (!s.wakeLoaded) return nothing;
  const triggers = s.wakeTriggers ?? [];
  return html`
    <div class="oc-settings__card">
      <div class="oc-settings__card-title">${t("settings.voice.wakewordTitle")}</div>
      ${triggers.length === 0
        ? html`<div class="oc-settings__field-hint">${t("settings.voice.wakewordNone")}</div>`
        : html`<div class="oc-settings__field-hint">${triggers.join(", ")}</div>`}
    </div>
  `;
}

function renderTtsControls(state: AppViewState) {
  const ts = s.ttsStatus;
  if (s.ttsFailed || !ts) return nothing;
  const providerStates = Array.isArray(ts.providerStates) ? ts.providerStates : [];
  const personas = Array.isArray(ts.personas) ? ts.personas : [];
  const update = () => state.requestUpdate();
  return html`
    <div class="oc-settings__form-group">
      <oc-toggle-switch .label=${t("settings.voice.ttsEnable")} .checked=${ts.enabled ?? false}
        .disabled=${s.actionPending}
        @change=${(e: CustomEvent) => applyTtsAction(s, state, e.detail.checked ? "tts.enable" : "tts.disable", {}, update)}
      ></oc-toggle-switch>
    </div>

    ${providerStates.length > 0 ? html`
      <div class="oc-settings__form-group">
        <label class="oc-settings__label">${t("settings.voice.ttsProvider")}</label>
        <select class="oc-settings__select" ?disabled=${s.actionPending}
          @change=${(e: Event) => applyTtsAction(s, state, "tts.setProvider", { provider: (e.target as HTMLSelectElement).value }, update)}>
          ${providerStates.map(p => html`
            <option value=${p.id ?? ""} ?selected=${p.id === ts.provider}>${p.label ?? p.id}</option>
          `)}
        </select>
      </div>
    ` : nothing}

    ${personas.length > 0 ? html`
      <div class="oc-settings__form-group">
        <label class="oc-settings__label">${t("settings.voice.ttsPersona")}</label>
        <select class="oc-settings__select" ?disabled=${s.actionPending}
          @change=${(e: Event) => applyTtsAction(s, state, "tts.setPersona", { persona: (e.target as HTMLSelectElement).value }, update)}>
          <option value="default" ?selected=${!ts.persona}>${t("settings.voice.personaDefault")}</option>
          ${personas.map(p => html`
            <option value=${p.id ?? ""} ?selected=${p.id === ts.persona}>${p.label ?? p.id}</option>
          `)}
        </select>
      </div>
    ` : nothing}
  `;
}

export function resetVoiceTab() { resetVoiceState(); }

export function renderTabVoice(state: AppViewState) {
  // 网关断线后标记状态过期，重连回来时重新拉取（对齐 tab-memory/tab-session-usage）。
  if (s.wasConnected && !state.connected) {
    s.ttsLoaded = false;
    s.talkLoaded = false;
    s.wakeLoaded = false;
  }
  s.wasConnected = state.connected;
  if (!s.ttsLoaded && !s.ttsLoading && state.connected && state.client) {
    loadVoiceStatus(s, state, () => state.requestUpdate());
  }

  return html`
    <div class="oc-settings__section">
      <h2 class="oc-settings__section-title">${t("settings.voice.title")}</h2>
      <p class="oc-settings__hint">${t("settings.voice.desc")}</p>

      ${renderTtsControls(state)}

      <oc-message-box .message=${s.error ?? ""} .type=${"error"} .visible=${!!s.error}></oc-message-box>
      <oc-message-box .message=${s.successMsg ?? ""} .type=${"success"} .visible=${!!s.successMsg}></oc-message-box>

      <div class="oc-settings__card">
        <div class="oc-settings__card-title">${t("settings.voice.statusTitle")}</div>
        ${renderTtsStatus()}
      </div>

      ${renderTalkSection()}
      ${renderWakeSection()}
    </div>
  `;
}
