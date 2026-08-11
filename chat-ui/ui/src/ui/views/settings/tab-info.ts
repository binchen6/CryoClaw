/**
 * Settings: 环境信息 tab — 一页看懂运行环境。
 * 数据：settings:get-env-info（主进程）+ 现有 gateway 状态（会话/任务/渠道）。
 */
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { t } from "../../i18n.ts";
import * as ipc from "../../data/ipc-bridge.ts";

type EnvState = {
  initialized: boolean;
  loading: boolean;
  error: string | null;
  info: ipc.EnvInfo | null;
};

const s: EnvState = { initialized: false, loading: false, error: null, info: null };

async function init(state: AppViewState) {
  if (s.initialized) return;
  s.initialized = true;
  s.loading = true;
  s.error = null;
  state.requestUpdate();
  try {
    s.info = await ipc.settingsGetEnvInfo();
  } catch (e) {
    s.error = String(e);
  } finally {
    s.loading = false;
    state.requestUpdate();
  }
}

export function resetEnvInfoTab() {
  s.initialized = false;
  s.loading = false;
  s.error = null;
  s.info = null;
}

function renderRow(label: string, value: string, mono = false) {
  return html`
    <div class="env-row">
      <span class="env-row__label">${label}</span>
      <span class="env-row__value ${mono ? "mono" : ""}">${value}</span>
    </div>
  `;
}

export function renderTabEnvInfo(state: AppViewState) {
  if (!s.initialized) init(state);
  const sessionsCount = state.sessionsResult?.sessions?.length ?? null;
  const tasksCount = state.tasks?.length ?? null;

  return html`
    <div class="oc-settings__section">
      <h2 class="oc-settings__section-title">${t("settings.env.title")}</h2>
      <p class="oc-settings__hint">${t("settings.env.desc")}</p>

      ${s.error ? html`<div class="callout danger">${s.error}</div>` : nothing}
      ${s.loading && !s.info ? html`<p class="muted">${t("settings.env.loading")}</p>` : nothing}

      ${s.info ? html`
        <div class="oc-settings__card">
          <div class="oc-settings__card-title">${t("settings.env.runtime")}</div>
          ${renderRow(t("settings.env.kernel"), s.info.kernelVersion)}
          ${renderRow(t("settings.env.configPath"), s.info.configPath, true)}
        </div>

        <div class="oc-settings__card">
          <div class="oc-settings__card-title">${t("settings.env.gateway")}</div>
          ${renderRow(t("settings.env.port"), String(s.info.gatewayPort), true)}
          ${renderRow(t("settings.env.bind"), s.info.gatewayBind, true)}
          ${renderRow(t("settings.env.reloadMode"), s.info.gatewayReloadMode, true)}
        </div>

        <div class="oc-settings__card">
          <div class="oc-settings__card-title">${t("settings.env.status")}</div>
          ${renderRow(t("settings.env.sessions"), sessionsCount === null ? "—" : String(sessionsCount))}
          ${renderRow(t("settings.env.tasks"), tasksCount === null ? "—" : String(tasksCount))}
          ${renderRow(t("settings.env.providers"), String(s.info.providerKeys.length))}
          ${renderRow(t("settings.env.channels"), String(s.info.enabledChannels.length))}
        </div>

        ${s.info.providerKeys.length > 0 ? html`
          <div class="oc-settings__card">
            <div class="oc-settings__card-title">${t("settings.env.providerList")}</div>
            <div class="env-chips">
              ${s.info.providerKeys.map((k) => html`<span class="env-chip">${k}</span>`)}
            </div>
          </div>
        ` : nothing}

        ${s.info.enabledChannels.length > 0 ? html`
          <div class="oc-settings__card">
            <div class="oc-settings__card-title">${t("settings.env.channelList")}</div>
            <div class="env-chips">
              ${s.info.enabledChannels.map((k) => html`<span class="env-chip env-chip--active">${k}</span>`)}
            </div>
          </div>
        ` : nothing}
      ` : nothing}
    </div>
  `;
}
