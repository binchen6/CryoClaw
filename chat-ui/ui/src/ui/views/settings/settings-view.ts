/**
 * Settings View — top-level container with tab navigation.
 * Replaces the old iframe-based settings page.
 */
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { t } from "../../i18n.ts";
import * as ipc from "../../data/ipc-bridge.ts";
import { SETTINGS_TABS, getTabIcon } from "./settings-constants.ts";
import { renderTabChannels, cleanupChannelsTab } from "./tab-channels.ts";
import { renderTabSearch, resetSearchTab } from "./tab-search.ts";
import { renderTabMemory, resetMemoryTab } from "./tab-memory.ts";
import { renderTabVoice, resetVoiceTab } from "./tab-voice.ts";
import { renderTabAppearance, resetAppearanceTab } from "./tab-appearance.ts";
import { renderTabAdvanced, resetAdvancedTab } from "./tab-advanced.ts";
import { renderTabBackup, cleanupBackupTab } from "./tab-backup.ts";
import { renderTabAbout, cleanupAboutTab } from "./tab-about.ts";
import { renderTabEnvInfo, resetEnvInfoTab } from "./tab-info.ts";
import { renderTabProvider, resetProviderTab } from "./tab-provider.ts";
import { renderTabSessionUsage, resetSessionUsageTab } from "./tab-session-usage.ts";
import { renderTabApprovals, resetApprovalsTab } from "./tab-approvals.ts";

/* ── module-level state ── */

const s = {
  activeTab: "channels",
  notice: null as string | null,
  navigateUnlisten: null as (() => void) | null,
  initialized: false,
};

/* ── init ── */

function isKnownTab(tabId: string): boolean {
  return SETTINGS_TABS.some(tab => tab.id === tabId);
}

function consumeNavigationHints(state: AppViewState) {
  if (state.settingsTabHint) {
    if (isKnownTab(state.settingsTabHint) && state.settingsTabHint !== s.activeTab) {
      cleanupTab(s.activeTab);
      s.activeTab = state.settingsTabHint;
    }
    s.notice = state.settingsNotice ?? null;
    state.settingsTabHint = null;
    state.settingsNotice = null;
    return;
  }
  if (state.settingsNotice) {
    s.notice = state.settingsNotice;
    state.settingsNotice = null;
  }
}

function init(state: AppViewState) {
  if (s.initialized) return;
  s.initialized = true;

  // Listen for main-process tab navigation
  s.navigateUnlisten = ipc.onSettingsNavigate((payload: any) => {
    if (payload?.tab && payload.tab !== s.activeTab) {
      cleanupTab(s.activeTab);
      s.activeTab = payload.tab;
    }
    if (payload?.notice) {
      s.notice = payload.notice;
    }
    state.requestUpdate();
  });
}

/* ── tab cleanup on switch ── */

function cleanupTab(tabId: string) {
  switch (tabId) {
    case "channels": cleanupChannelsTab(); break;
    case "backup": cleanupBackupTab(); break;
    case "about": cleanupAboutTab(); break;
    case "env-info": resetEnvInfoTab(); break;
    case "session-usage": resetSessionUsageTab(); break;
    case "approvals": resetApprovalsTab(); break;
  }
}

/* ── tab rendering ── */

function renderActiveTab(state: AppViewState) {
  switch (s.activeTab) {
    case "channels": return renderTabChannels(state);
    case "provider": return renderTabProvider(state);
    case "search": return renderTabSearch(state);

    case "memory": return renderTabMemory(state);
    case "voice": return renderTabVoice(state);
    case "appearance": return renderTabAppearance(state);
    case "advanced": return renderTabAdvanced(state);
    case "session-usage": return renderTabSessionUsage(state);
    case "approvals": return renderTabApprovals(state);
    case "backup": return renderTabBackup(state, s.notice);
    case "about": return renderTabAbout(state);
    case "env-info": return renderTabEnvInfo(state);
    default: return renderTabChannels(state);
  }
}

/* ── invalidate all tabs (called after backup restore to force re-fetch) ── */

export function invalidateAllSettings() {
  resetProviderTab();
  resetSearchTab();
  resetMemoryTab();
  resetVoiceTab();
  resetAppearanceTab();
  resetAdvancedTab();
  resetSessionUsageTab();
  resetApprovalsTab();
  cleanupChannelsTab();
  cleanupBackupTab();
  cleanupAboutTab();
}

/* ── cleanup (called when leaving settings view) ── */

export function cleanupSettingsView() {
  if (s.navigateUnlisten) {
    s.navigateUnlisten();
    s.navigateUnlisten = null;
  }
  resetProviderTab();
  resetSearchTab();
  resetMemoryTab();
  resetVoiceTab();
  resetAppearanceTab();
  resetAdvancedTab();
  resetSessionUsageTab();
  resetApprovalsTab();
  cleanupChannelsTab();
  cleanupBackupTab();
  cleanupAboutTab();
  s.initialized = false;
  // Reset to defaults so next open starts at Channels (Plan: "Channels - default")
  s.activeTab = "channels";
  s.notice = null;
}

/* ── render entry point ── */

export function renderSettingsView(state: AppViewState) {
  init(state);
  consumeNavigationHints(state);

  return html`
    <div class="oc-settings-container">
      <nav class="oc-settings-nav">
        <div class="oc-settings-nav__title">${t("settings.title")}</div>
        ${SETTINGS_TABS.map((tab, idx) => {
          const prev = SETTINGS_TABS[idx - 1];
          const groupLabel = tab.group && tab.group !== prev?.group
            ? html`<div class="oc-settings-nav__group">${t(`settings.group.${tab.group}`)}</div>`
            : nothing;
          return html`${groupLabel}
            <button
              class="oc-settings-nav-item ${s.activeTab === tab.id ? 'oc-settings-nav-item--active' : ''}"
              @click=${() => { if (s.activeTab !== tab.id) { cleanupTab(s.activeTab); s.activeTab = tab.id; s.notice = null; state.requestUpdate(); } }}
            >${getTabIcon(tab.id)}${t(tab.labelKey)}</button>
          `;
        })}
      </nav>
      <div class="oc-settings-content">
        ${renderActiveTab(state)}
      </div>
    </div>
  `;
}
