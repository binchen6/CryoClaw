/**
 * Settings: Plugins Tab（R8 重启立项）。
 *
 * 双视图：
 *   - 已安装：内核 `openclaw plugins list --json` 库存（主进程 IPC），
 *     启用开关走 config.patch `plugins.entries.<id>.enabled`（与渠道 tab 同机制），
 *     支持卸载（IPC → 内核 CLI）。
 *   - ClawHub 市场：内核 `openclaw plugins search --json`（ClawHub 包搜索），
 *     支持一键安装（IPC → 内核 CLI `plugins install clawhub:<name>`）。
 */
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { t, tWithDetail } from "../../i18n.ts";
import "../../components/toggle-switch.ts";
import "../../components/message-box.ts";
import { runConfigPatch } from "./tab-patch.ts";
import {
  isValidPluginName,
  mapInstalledPlugin,
  mapMarketPlugin,
  sortInstalledPlugins,
  sortMarketPlugins,
  type InstalledPluginView,
  type MarketPluginView,
} from "./tab-plugins.lib.ts";
import { showConfirm } from "../confirm-dialog.ts";
import { showToast } from "../../app-toast.ts";

type PluginsSubTab = "installed" | "market";

const s = {
  initialized: false,
  loading: false,
  error: null as string | null,
  successMsg: null as string | null,
  installed: [] as InstalledPluginView[],
  // 市场
  subtab: "installed" as PluginsSubTab,
  query: "",
  searching: false,
  marketResults: [] as MarketPluginView[],
  marketLoaded: false,
  // 正在安装/卸载的插件名（同一时刻只允许一个操作）
  busyName: null as string | null,
  // 正在切换启用的插件 id
  togglingId: null as string | null,
};

export function resetPluginsTab() {
  s.initialized = false;
  s.loading = false;
  s.error = null;
  s.successMsg = null;
  s.installed = [];
  s.subtab = "installed";
  s.query = "";
  s.searching = false;
  s.marketResults = [];
  s.marketLoaded = false;
  s.busyName = null;
  s.togglingId = null;
}

async function loadInstalled(state: AppViewState) {
  if (!window.cryoclaw?.pluginStoreList) return;
  s.loading = true;
  s.error = null;
  state.requestUpdate();
  try {
    const result = await window.cryoclaw.pluginStoreList();
    if (result?.success && Array.isArray(result.data)) {
      s.installed = sortInstalledPlugins(
        result.data.map(mapInstalledPlugin).filter((p: InstalledPluginView | null): p is InstalledPluginView => p !== null),
      );
    } else {
      s.error = result?.message ?? t("settings.plugins.loadFailed");
    }
  } catch {
    s.error = t("settings.plugins.loadFailed");
  } finally {
    s.loading = false;
    state.requestUpdate();
  }
}

function init(state: AppViewState) {
  if (s.initialized) return;
  s.initialized = true;
  void loadInstalled(state);
}

// 启用/禁用：config.patch plugins.entries.<id>.enabled（与渠道 tab 同一写入路径）
async function togglePluginEnabled(state: AppViewState, plugin: InstalledPluginView, next: boolean) {
  if (s.togglingId) return;
  s.togglingId = plugin.id;
  s.error = null;
  s.successMsg = null;
  state.requestUpdate();
  const outcome = await runConfigPatch(state, (draft) => {
    const plugins = (draft.plugins ??= {}) as Record<string, any>;
    const entries = (plugins.entries ??= {}) as Record<string, any>;
    const entry = (entries[plugin.id] ??= {}) as Record<string, any>;
    entry.enabled = next;
  });
  if (outcome.ok) {
    s.installed = s.installed.map((p) => (p.id === plugin.id ? { ...p, enabled: next } : p));
    s.successMsg = outcome.hint ?? t("settings.plugins.enableHint");
  } else {
    s.error = outcome.error ?? t("settings.error.saveFailed");
  }
  s.togglingId = null;
  state.requestUpdate();
}

async function uninstallPlugin(state: AppViewState, plugin: InstalledPluginView) {
  if (!window.cryoclaw?.pluginStoreUninstall || s.busyName) return;
  const confirmed = await showConfirm(
    state,
    t("settings.plugins.uninstallConfirm").replace("{name}", plugin.name),
    { danger: true },
  );
  if (!confirmed) return;
  s.busyName = plugin.id;
  s.error = null;
  state.requestUpdate();
  try {
    const result = await window.cryoclaw.pluginStoreUninstall({ id: plugin.id });
    if (result?.success) {
      showToast(state, t("settings.plugins.uninstallSuccess"));
      await loadInstalled(state);
    } else {
      s.error = result?.message ?? t("settings.plugins.uninstallFailed");
    }
  } catch (err: any) {
    s.error = tWithDetail("settings.plugins.uninstallFailed", err?.message);
  } finally {
    s.busyName = null;
    state.requestUpdate();
  }
}

async function searchMarket(state: AppViewState) {
  if (!window.cryoclaw?.pluginStoreSearch) return;
  const q = s.query.trim();
  if (!q) return;
  s.searching = true;
  s.error = null;
  state.requestUpdate();
  try {
    const result = await window.cryoclaw.pluginStoreSearch({ q, limit: 20 });
    if (result?.success && Array.isArray(result.data)) {
      s.marketResults = sortMarketPlugins(
        result.data.map(mapMarketPlugin).filter((p: MarketPluginView | null): p is MarketPluginView => p !== null),
      );
      s.marketLoaded = true;
    } else {
      s.error = result?.message ?? t("settings.plugins.searchFailed");
    }
  } catch {
    s.error = t("settings.plugins.searchFailed");
  } finally {
    s.searching = false;
    state.requestUpdate();
  }
}

async function installFromMarket(state: AppViewState, plugin: MarketPluginView) {
  if (!window.cryoclaw?.pluginStoreInstall || s.busyName) return;
  // 冲突检测（R17）：市场包的运行时 id 可能与已安装插件相同，安装会覆盖既有插件
  const collision = plugin.runtimeId
    ? s.installed.find((p) => p.id === plugin.runtimeId)
    : undefined;
  // 安装风险确认：非官方插件明确告知来源与验证级别；冲突时红色强提醒
  const confirmed = await showConfirm(
    state,
    collision
      ? t("settings.plugins.installCollisionConfirm")
          .replace("{name}", plugin.displayName ?? plugin.name)
          .replace("{collision}", collision.name)
      : t("settings.plugins.installConfirm")
          .replace("{name}", plugin.displayName ?? plugin.name)
          .replace("{channel}", plugin.channel ?? "community")
          .replace("{tier}", plugin.verificationTier ?? "unknown"),
    collision ? { danger: true } : undefined,
  );
  if (!confirmed) return;
  s.busyName = plugin.name;
  s.error = null;
  s.successMsg = null;
  state.requestUpdate();
  try {
    const result = await window.cryoclaw.pluginStoreInstall({ name: plugin.name });
    if (result?.success) {
      showToast(state, t("settings.plugins.installSuccess"));
      s.successMsg = result.warning ?? t("settings.plugins.installEnableHint");
      await loadInstalled(state);
    } else {
      s.error = result?.message ?? t("settings.plugins.installFailed");
    }
  } catch (err: any) {
    s.error = tWithDetail("settings.plugins.installFailed", err?.message);
  } finally {
    s.busyName = null;
    state.requestUpdate();
  }
}

function kindLabel(kind?: string): string {
  if (!kind) return "";
  const key = `settings.plugins.kind.${kind}`;
  const label = t(key);
  return label === key ? kind : label;
}

function renderInstalledRow(state: AppViewState, plugin: InstalledPluginView) {
  const busy = s.busyName === plugin.id;
  const toggling = s.togglingId === plugin.id;
  return html`
    <div class="oc-plugins__row">
      <div class="oc-plugins__row-main">
        <div class="oc-plugins__row-head">
          <span class="oc-plugins__name">${plugin.name}</span>
          <span class="oc-plugins__id">${plugin.id}</span>
          ${plugin.kind ? html`<span class="oc-tag oc-tag--muted">${kindLabel(plugin.kind)}</span>` : nothing}
          ${plugin.version ? html`<span class="oc-plugins__version">v${plugin.version}</span>` : nothing}
          ${plugin.status === "error" ? html`<span class="oc-tag oc-tag--danger">${t("settings.plugins.statusError")}</span>` : nothing}
        </div>
        ${plugin.description ? html`<div class="oc-plugins__desc" title=${plugin.description}>${plugin.description}</div>` : nothing}
      </div>
      <div class="oc-plugins__row-side">
        <oc-toggle-switch
          .checked=${plugin.enabled}
          .disabled=${toggling}
          .label=${t("settings.plugins.enable")}
          @change=${(e: CustomEvent) => void togglePluginEnabled(state, plugin, e.detail.checked)}
        ></oc-toggle-switch>
        <button
          class="oc-settings__btn oc-settings__btn--secondary oc-settings__btn--compact"
          type="button"
          ?disabled=${busy}
          @click=${() => void uninstallPlugin(state, plugin)}
        >${busy ? t("settings.plugins.uninstalling") : t("settings.plugins.uninstall")}</button>
      </div>
    </div>
  `;
}

function renderMarketRow(state: AppViewState, plugin: MarketPluginView) {
  const installed = s.installed.some((p) => p.id === plugin.name || p.id === plugin.runtimeId);
  const busy = s.busyName === plugin.name;
  return html`
    <div class="oc-plugins__row">
      <div class="oc-plugins__row-main">
        <div class="oc-plugins__row-head">
          <span class="oc-plugins__name">${plugin.displayName ?? plugin.name}</span>
          <span class="oc-plugins__id">${plugin.name}</span>
          ${plugin.isOfficial ? html`<span class="oc-tag oc-tag--accent">${t("settings.plugins.official")}</span>` : nothing}
          ${plugin.channel && plugin.channel !== "official" ? html`<span class="oc-tag oc-tag--muted">${plugin.channel}</span>` : nothing}
          ${plugin.latestVersion ? html`<span class="oc-plugins__version">v${plugin.latestVersion}</span>` : nothing}
        </div>
        ${plugin.summary ? html`<div class="oc-plugins__desc" title=${plugin.summary}>${plugin.summary}</div>` : nothing}
        <div class="oc-plugins__meta">
          ${typeof plugin.downloads === "number" ? html`<span class="oc-plugins__downloads">${t("settings.plugins.downloads").replace("{n}", String(plugin.downloads))}</span>` : nothing}
          ${plugin.ownerHandle ? html`<span class="oc-plugins__owner">@${plugin.ownerHandle}</span>` : nothing}
        </div>
      </div>
      <div class="oc-plugins__row-side">
        ${installed
          ? html`<span class="oc-plugins__installed-badge">${t("settings.plugins.installedBadge")}</span>`
          : html`<button
              class="oc-settings__btn oc-settings__btn--primary oc-settings__btn--compact"
              type="button"
              ?disabled=${busy}
              @click=${() => void installFromMarket(state, plugin)}
            >${busy ? t("settings.plugins.installing") : t("settings.plugins.install")}</button>`}
      </div>
    </div>
  `;
}

function renderBody(state: AppViewState) {
  if (s.subtab === "installed") {
    if (s.loading && s.installed.length === 0) {
      return html`<div class="oc-settings__hint">${t("chat.loading")}</div>`;
    }
    if (!s.installed.length) {
      return html`<div class="oc-settings__hint">${t("settings.plugins.empty")}</div>`;
    }
    return html`<div class="oc-plugins__list">${s.installed.map((p) => renderInstalledRow(state, p))}</div>`;
  }
  if (s.searching && !s.marketLoaded) {
    return html`<div class="oc-settings__hint">${t("chat.loading")}</div>`;
  }
  if (!s.marketResults.length) {
    return html`<div class="oc-settings__hint">${t("settings.plugins.marketEmpty")}</div>`;
  }
  return html`<div class="oc-plugins__list">${s.marketResults.map((p) => renderMarketRow(state, p))}</div>`;
}

export function renderTabPlugins(state: AppViewState) {
  init(state);
  return html`
    <div class="oc-settings__section">
      <h2 class="oc-settings__section-title">${t("settings.plugins.title")}</h2>
      <p class="oc-settings__hint">${t("settings.plugins.desc")}</p>

      <div class="oc-plugins__tabs">
        <button
          class="oc-plugins__tab ${s.subtab === "installed" ? "oc-plugins__tab--active" : ""}"
          type="button"
          @click=${() => { s.subtab = "installed"; state.requestUpdate(); }}
        >${t("settings.plugins.installed")} (${s.installed.length})</button>
        <button
          class="oc-plugins__tab ${s.subtab === "market" ? "oc-plugins__tab--active" : ""}"
          type="button"
          @click=${() => { s.subtab = "market"; state.requestUpdate(); }}
        >${t("settings.plugins.market")}</button>
      </div>

      ${s.subtab === "installed"
        ? html`<div class="oc-plugins__toolbar">
            <button
              class="oc-settings__btn oc-settings__btn--secondary oc-settings__btn--compact"
              type="button"
              ?disabled=${s.loading || !state.connected}
              @click=${() => void loadInstalled(state)}
            >${t("settings.plugins.refresh")}</button>
          </div>`
        : html`<div class="oc-plugins__toolbar">
            <input
              class="oc-settings__input oc-plugins__search"
              .value=${s.query}
              placeholder=${t("settings.plugins.searchPlaceholder")}
              @input=${(e: Event) => { s.query = (e.target as HTMLInputElement).value; state.requestUpdate(); }}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter" && !e.isComposing) {
                  e.preventDefault();
                  void searchMarket(state);
                }
              }}
            />
            <button
              class="oc-settings__btn oc-settings__btn--primary oc-settings__btn--compact"
              type="button"
              ?disabled=${s.searching || !s.query.trim()}
              @click=${() => void searchMarket(state)}
            >${t("settings.plugins.search")}</button>
          </div>`}

      <div class="oc-settings__card oc-plugins__card">
        ${renderBody(state)}
      </div>

      <oc-message-box .message=${s.error ?? ""} .type=${"error"} .visible=${!!s.error}></oc-message-box>
      <oc-message-box .message=${s.successMsg ?? ""} .type=${"success"} .visible=${!!s.successMsg}></oc-message-box>
    </div>
  `;
}
