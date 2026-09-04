/**
 * Settings: Channels Tab — platform sub-navigation container.
 *
 * 启用状态点已切到内核 config.get 快照读取（R4 config.patch 化），
 * 不再走主进程 IPC 逐渠道拉取。
 */
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { t } from "../../i18n.ts";
import { getConfigSnapshot, getCachedConfigSnapshot } from "../../controllers/config.ts";
import {
  extractFeishuView, extractQqbotView, extractWecomView, extractDingtalkView, extractWeixinEnabled,
} from "./tab-channels.lib.ts";
import { CHANNEL_PLATFORMS } from "./settings-constants.ts";
import { renderChannelWeixin, cleanupWeixinTab } from "./tab-channels-weixin.ts";
import { renderChannelFeishu, resetFeishuTab } from "./tab-channels-feishu.ts";
import { renderChannelWecom, resetWecomTab } from "./tab-channels-wecom.ts";
import { renderChannelDingtalk, resetDingtalkTab } from "./tab-channels-dingtalk.ts";
import { renderChannelQqbot, resetQqbotTab } from "./tab-channels-qqbot.ts";

// Channels 容器状态也必须可重建，避免子面板脏状态和导航状态互相打架。
function createChannelsState() {
  return {
    activePlatform: "weixin",
    enabledMap: {} as Record<string, boolean>,
    initialized: false,
  };
}

const s = createChannelsState();

/** 从 config 快照同步全渠道启用状态点 */
export function syncChannelEnabledFromSnapshot() {
  const config = getCachedConfigSnapshot()?.config;
  if (!config) return;
  s.enabledMap = {
    weixin: extractWeixinEnabled(config),
    feishu: extractFeishuView(config).enabled,
    wecom: extractWecomView(config).enabled,
    dingtalk: extractDingtalkView(config).enabled,
    qqbot: extractQqbotView(config).enabled,
  };
}

async function init(state: AppViewState) {
  if (s.initialized) return;
  s.initialized = true;
  try {
    if (state.client && state.connected) {
      await getConfigSnapshot(state.client);
      syncChannelEnabledFromSnapshot();
      state.requestUpdate();
    }
  } catch {}
}

/** Called by sub-panels after a successful enable/disable save to sync the nav status dot. */
export function updateChannelEnabled(platform: string, enabled: boolean) {
  s.enabledMap[platform] = enabled;
}

function switchPlatform(newPlatform: string) {
  const prev = s.activePlatform;
  if (prev === newPlatform) return;
  if (prev === "weixin") cleanupWeixinTab();
  s.activePlatform = newPlatform;
}

export function cleanupChannelsTab() {
  cleanupWeixinTab();
  resetFeishuTab();
  resetWecomTab();
  resetDingtalkTab();
  resetQqbotTab();
  Object.assign(s, createChannelsState());
}

export function renderTabChannels(state: AppViewState) {
  init(state);
  const active = s.activePlatform;

  return html`
    <div class="oc-settings__section">
      <h2 class="oc-settings__section-title">${t("settings.nav.channels")}</h2>
      <p class="oc-settings__hint">${t("settings.channels.desc")}</p>
      <div class="oc-settings-channels">
        <nav class="oc-settings-channels__nav">
          ${CHANNEL_PLATFORMS.map(p => html`
            <button class="oc-settings-channels__nav-item ${p.id === active ? "oc-settings-channels__nav-item--active" : ""}"
              @click=${() => { switchPlatform(p.id); state.requestUpdate(); }}>
              ${t(p.labelKey)}
              ${s.enabledMap[p.id] ? html`<span class="oc-settings-channels__status-dot"></span>` : nothing}
            </button>
          `)}
        </nav>
        <div class="oc-settings-channels__panel">
          ${renderChannelPanel(state, active)}
        </div>
      </div>
    </div>
  `;
}

function renderChannelPanel(state: AppViewState, platform: string) {
  switch (platform) {
    case "weixin": return renderChannelWeixin(state);
    case "feishu": return renderChannelFeishu(state);
    case "wecom": return renderChannelWecom(state);
    case "dingtalk": return renderChannelDingtalk(state);
    case "qqbot": return renderChannelQqbot(state);
    default: return renderChannelWeixin(state);
  }
}
