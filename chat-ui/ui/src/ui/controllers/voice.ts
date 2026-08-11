import type { GatewayBrowserClient } from "../gateway.ts";
import { t, tWithDetail } from "../i18n.ts";

// tts.status 返回结构（内核 2026.7.1-2，字段防御性取值）：
// { enabled, auto, provider, persona, personas: [{id,label,description,provider}], fallbackProvider, fallbackProviders, prefsPath, providerStates: [{id,label,configured}] }
export type TtsProviderState = { id?: string; label?: string; configured?: boolean };
export type TtsPersona = { id?: string; label?: string; description?: string; provider?: string };
export type TtsStatus = {
  enabled?: boolean;
  auto?: string;
  provider?: string;
  persona?: string | null;
  personas?: TtsPersona[];
  fallbackProvider?: string | null;
  providerStates?: TtsProviderState[];
};

// talk.config 返回 { config: { talk?: {...} } }，talk 配置节见内核 src/config/talk.ts。
export type TalkSection = {
  provider?: string;
  speechLocale?: string;
  interruptOnSpeech?: boolean;
  realtime?: { mode?: string; transport?: string; provider?: string };
};
type TalkConfigResult = { config?: { talk?: TalkSection } };

// voicewake.get 返回 { triggers: string[] }。

export type VoiceGatewayState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
};

export type VoiceStatusState = {
  error: string | null;
  successMsg: string | null;
  actionPending: boolean;
  // TTS 状态/开关（走 gateway RPC）
  ttsStatus: TtsStatus | null;
  ttsLoading: boolean;
  ttsLoaded: boolean;
  ttsFailed: boolean;
  // Talk 配置（只读展示）
  talkConfig: TalkSection | null;
  talkLoaded: boolean;
  // 语音唤醒词（只读展示）
  wakeTriggers: string[] | null;
  wakeLoaded: boolean;
};

// 拉取语音相关状态；单个 RPC 失败只降级对应区块，互不阻塞。
export async function loadVoiceStatus(
  state: VoiceStatusState,
  gateway: VoiceGatewayState,
  requestUpdate: () => void,
) {
  const client = gateway.client;
  if (state.ttsLoading || state.ttsLoaded || !client || !gateway.connected) {
    return;
  }
  state.ttsLoading = true;
  requestUpdate();
  try {
    const [ttsRes, talkRes, wakeRes] = await Promise.allSettled([
      client.request("tts.status", {}),
      client.request("talk.config", {}),
      client.request("voicewake.get", {}),
    ]);
    if (ttsRes.status === "fulfilled") {
      state.ttsStatus = ttsRes.value as TtsStatus;
      state.ttsFailed = false;
    } else {
      state.ttsStatus = null;
      state.ttsFailed = true;
    }
    state.ttsLoaded = true;
    state.talkConfig =
      talkRes.status === "fulfilled" ? (talkRes.value as TalkConfigResult)?.config?.talk ?? null : null;
    state.talkLoaded = true;
    const wake = wakeRes.status === "fulfilled" ? (wakeRes.value as { triggers?: string[] })?.triggers : null;
    state.wakeTriggers = Array.isArray(wake) ? wake : null;
    state.wakeLoaded = true;
  } finally {
    state.ttsLoading = false;
    requestUpdate();
  }
}

// TTS 开关 / Provider / Persona 变更走内核 RPC（写入 TTS prefs，不改 openclaw.json，不重启 gateway）。
export async function applyTtsAction(
  state: VoiceStatusState,
  gateway: VoiceGatewayState,
  method: string,
  params: Record<string, unknown>,
  requestUpdate: () => void,
) {
  if (state.actionPending) {
    return;
  }
  state.actionPending = true;
  state.error = null;
  state.successMsg = null;
  requestUpdate();
  try {
    await gateway.client?.request(method, params);
    state.successMsg = t("settings.saved");
    // 重新拉取状态，展示最新生效值。
    state.ttsLoaded = false;
    void loadVoiceStatus(state, gateway, requestUpdate);
  } catch (e: any) {
    state.error = tWithDetail("settings.error.saveFailed", e?.message);
  } finally {
    state.actionPending = false;
    requestUpdate();
  }
}
