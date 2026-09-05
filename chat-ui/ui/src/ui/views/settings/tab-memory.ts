/**
 * Settings: Memory Tab.
 *
 * R4：配置读写改走 config.get 快照 + config.patch；记忆状态区块仍走
 * gateway RPC（doctor.memory.*），两者互不阻塞。
 */
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { loadMemoryStatus, type MemoryStatus } from "../../controllers/memory.ts";
import { t, tWithDetail } from "../../i18n.ts";
import * as ipc from "../../data/ipc-bridge.ts";
import "../../components/toggle-switch.ts";
import "../../components/message-box.ts";
import { runConfigPatch } from "./tab-patch.ts";
import { extractMemoryView, applyMemorySave } from "./tab-channels.lib.ts";
import { initChannelTabOnce } from "./tab-channels-shared.ts";

// Memory 页状态必须可重建，避免用户丢弃的开关草稿污染下次打开。
function createMemoryState() {
  return {
    sessionMemoryEnabled: false,
    embeddingEnabled: false,
    isKimiCodeConfigured: false,
    saving: false,
    error: null as string | null,
    successMsg: null as string | null,
    hint: null as string | null,
    initialized: false,
    // 记忆状态区块（走 gateway RPC，与上面的配置读写互不阻塞）
    memoryStatus: null as MemoryStatus | null,
    statusLoading: false,
    statusLoaded: false,
    statusFailed: false,
    wasConnected: false,
  };
}

const s = createMemoryState();

// 退出 Settings 时直接丢掉 Memory 页缓存，下次重新从 config 快照拉真配置。
function resetMemoryState() {
  Object.assign(s, createMemoryState());
}

async function init(state: AppViewState) {
  await initChannelTabOnce(state, s, {
    applyConfig: (config) => {
      const view = extractMemoryView(config);
      s.sessionMemoryEnabled = view.sessionMemoryEnabled;
      s.embeddingEnabled = view.embeddingEnabled;
      s.isKimiCodeConfigured = view.isKimiCodeConfigured;
    },
  });
}

async function handleSave(state: AppViewState) {
  s.saving = true; s.error = null; s.successMsg = null; s.hint = null; state.requestUpdate();
  try {
    // embedding 走本地 auth proxy：先确保 proxy 运行并拿到端口（主进程职责）
    let proxyPort = 0;
    if (s.embeddingEnabled) {
      const proxy = await ipc.settingsEnsureKimiProxy();
      proxyPort = proxy?.proxyPort ?? 0;
      if (proxyPort <= 0) {
        s.saving = false;
        s.error = t("settings.error.saveFailed");
        state.requestUpdate();
        return;
      }
    }
    const outcome = await runConfigPatch(state, draft => {
      applyMemorySave(draft, {
        sessionMemoryEnabled: s.sessionMemoryEnabled,
        embeddingEnabled: s.embeddingEnabled,
        proxyPort,
      });
    });
    if (!outcome.ok) {
      s.saving = false;
      s.error = tWithDetail("settings.error.saveFailed", outcome.error);
      state.requestUpdate();
      return;
    }
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

function renderStatusRow(label: string, value: unknown) {
  return html`
    <div class="oc-settings__form-group">
      <span class="oc-settings__field-hint">${label}: ${value == null || value === "" ? "—" : String(value)}</span>
    </div>
  `;
}

function renderMemoryStatus() {
  if (s.statusLoading && !s.statusLoaded) {
    return html`<div class="oc-settings__field-hint">${t("settings.memory.statusLoading")}</div>`;
  }
  // 未连接 / RPC 失败 / 内核无记忆后端，统一降级为一行提示。
  if (s.statusFailed || !s.memoryStatus) {
    return html`<div class="oc-settings__field-hint">${t("settings.memory.statusUnavailable")}</div>`;
  }
  const ms = s.memoryStatus;
  const embedding = ms.embedding;
  const embeddingText = embedding?.ok
    ? t("settings.memory.embeddingEnabled")
    : `${t("settings.memory.statusEmbeddingUnavailable")}${embedding?.error ? ` (${embedding.error})` : ""}`;
  const dreaming = ms.dreaming;
  return html`
    ${ms.provider ? renderStatusRow(t("settings.memory.statusBackend"), ms.provider) : nothing}
    ${renderStatusRow(t("settings.memory.statusEmbedding"), embeddingText)}
    ${dreaming ? html`
      ${renderStatusRow(t("settings.memory.statusShortTerm"), dreaming.shortTermCount)}
      ${renderStatusRow(t("settings.memory.statusSignals"), dreaming.totalSignalCount)}
      ${renderStatusRow(t("settings.memory.statusPromoted"),
        dreaming.promotedToday ? `${dreaming.promotedTotal ?? 0} (+${dreaming.promotedToday})` : dreaming.promotedTotal)}
    ` : nothing}
  `;
}

export function resetMemoryTab() { resetMemoryState(); }

export function renderTabMemory(state: AppViewState) {
  if (!s.initialized) init(state);

  // 网关断线后标记状态过期，重连回来时重新拉取（对齐 tab-session-usage 的做法）。
  if (s.wasConnected && !state.connected) s.statusLoaded = false;
  s.wasConnected = state.connected;
  if (!s.statusLoaded && !s.statusLoading && state.connected && state.client) {
    loadMemoryStatus(s, state, () => state.requestUpdate());
  }

  const embeddingStatus = s.isKimiCodeConfigured && s.embeddingEnabled
    ? t("settings.memory.embeddingEnabled")
    : !s.isKimiCodeConfigured
      ? t("settings.memory.embeddingRequiresKimi")
      : "";

  return html`
    <div class="oc-settings__section">
      <h2 class="oc-settings__section-title">${t("settings.memory.title")}</h2>
      <p class="oc-settings__hint">${t("settings.memory.desc")}</p>

      <div class="oc-settings__form-group">
        <oc-toggle-switch .label=${t("settings.memory.autoSave")} .checked=${s.sessionMemoryEnabled}
          @change=${(e: CustomEvent) => { s.sessionMemoryEnabled = e.detail.checked; state.requestUpdate(); }}
        ></oc-toggle-switch>
      </div>

      <div class="oc-settings__form-group">
        <oc-toggle-switch .label=${t("settings.memory.embedding")} .checked=${s.embeddingEnabled}
          .disabled=${!s.isKimiCodeConfigured}
          @change=${(e: CustomEvent) => { s.embeddingEnabled = e.detail.checked; state.requestUpdate(); }}
        ></oc-toggle-switch>
        ${embeddingStatus ? html`<div class="oc-settings__field-hint">${embeddingStatus}</div>` : ""}
      </div>

      <oc-message-box .message=${s.error ?? ""} .type=${"error"} .visible=${!!s.error}></oc-message-box>
      <oc-message-box .message=${s.successMsg ?? ""} .type=${"success"} .visible=${!!s.successMsg}></oc-message-box>
      ${s.hint ? html`<div class="oc-settings__field-hint">${s.hint}</div>` : nothing}

      <div class="oc-settings__btn-row">
        <button class="oc-settings__btn oc-settings__btn--primary" ?disabled=${s.saving} @click=${() => handleSave(state)}>${t("settings.save")}</button>
      </div>

      <div class="oc-settings__card">
        <div class="oc-settings__card-title">${t("settings.memory.statusTitle")}</div>
        ${renderMemoryStatus()}
      </div>
    </div>
  `;
}
