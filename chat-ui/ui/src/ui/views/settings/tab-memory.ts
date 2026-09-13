/**
 * Settings: Memory Tab — 内核 2026.9.3 记忆配置全景。
 *
 * 卡片信息架构：
 * 1. 会话记忆（hooks.internal.entries["session-memory"]）
 * 2. 语义记忆检索（根级 memory.search；Kimi 一键 = provider=openai + bge_m3_embed + 本地代理）
 * 3. 记忆引用（memory.citations：auto/on/off）
 * 4. 记忆固化 Dreaming（plugins.entries["memory-core"].config.dreaming）
 * 5. 主动记忆（plugins.entries["active-memory"]，entry 存在才显示）
 * 6. 运行状态（gateway RPC doctor.memory.status）
 *
 * 配置读写走 config.get 快照 + 单次 config.patch（memory + hooks + plugins 三域
 * 合并在同一 patch，见 tab-memory.lib.ts / tab-patch.ts）；运行状态走 gateway RPC，
 * 与配置读写互不阻塞。
 */
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { loadMemoryStatus, type MemoryStatus } from "../../controllers/memory.ts";
import { t, tWithDetail } from "../../i18n.ts";
import * as ipc from "../../data/ipc-bridge.ts";
import { getConfigSnapshot, getCachedConfigSnapshot } from "../../controllers/config.ts";
import "../../components/toggle-switch.ts";
import "../../components/message-box.ts";
import { runConfigPatch } from "./tab-patch.ts";
import {
  applyMemorySave, extractMemoryView, KIMI_EMBEDDING_MODEL, MEMORY_SEARCH_PROVIDERS,
  MEMORY_SEARCH_DEFAULTS, SESSION_MEMORY_DEFAULTS,
  type ActiveMemoryMode, type MemoryCitationMode, type MemorySearchSource, type MemorySettingsView,
} from "./tab-memory.lib.ts";
import { initChannelTabOnce } from "./tab-channels-shared.ts";

/* ── 状态 ── */

// Memory 页状态必须可重建，避免用户丢弃的开关草稿污染下次打开。
function createMemoryState() {
  return {
    // 会话记忆（session-memory hook）
    smEnabled: true,
    smMessages: String(SESSION_MEMORY_DEFAULTS.messages),
    smLlmSlug: false,
    smModel: "",
    // 语义记忆检索（memory.search）
    msEnabled: true,
    msProvider: "openai" as string,
    msModel: "",
    msBaseUrl: "",
    msRemember: false,
    msSources: ["memory"] as MemorySearchSource[],
    msMaxResults: String(MEMORY_SEARCH_DEFAULTS.maxResults),
    msMinScore: String(MEMORY_SEARCH_DEFAULTS.minScore),
    // Kimi 一键语义记忆：true = 保存时走本地代理预置（覆盖 provider/model/remote）
    kimiApply: false,
    kimiEmbeddingActive: false,
    isKimiCodeConfigured: false,
    // 记忆引用（memory.citations）
    citations: "auto" as MemoryCitationMode,
    // 记忆固化（memory-core dreaming）
    dmEnabled: true,
    dmFrequency: "",
    dmModel: "",
    dmLight: true,
    dmDeep: true,
    dmRem: true,
    // 主动记忆（active-memory 插件；amPresent=false 整卡隐藏）
    amPresent: false,
    amEnabled: false,
    amMode: "escalate" as ActiveMemoryMode,
    amModel: "",
    // 保存反馈
    saving: false,
    error: null as string | null,
    successMsg: null as string | null,
    hint: null as string | null,
    initialized: false,
    // 记忆状态区块（走 gateway RPC，与配置读写互不阻塞）
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

function applyViewToState(view: MemorySettingsView) {
  s.smEnabled = view.sessionMemory.enabled;
  s.smMessages = String(view.sessionMemory.messages);
  s.smLlmSlug = view.sessionMemory.llmSlug;
  s.smModel = view.sessionMemory.model;
  s.msEnabled = view.search.enabled;
  s.msProvider = view.search.provider;
  s.msModel = view.search.model;
  s.msBaseUrl = view.search.baseUrl;
  s.msRemember = view.search.rememberAcrossConversations;
  s.msSources = [...view.search.sources];
  s.msMaxResults = String(view.search.maxResults);
  s.msMinScore = String(view.search.minScore);
  s.kimiApply = false;
  s.kimiEmbeddingActive = view.kimiProxy.embeddingActive;
  s.isKimiCodeConfigured = view.kimiProxy.isKimiCodeConfigured;
  s.citations = view.citations;
  s.dmEnabled = view.dreaming.enabled;
  s.dmFrequency = view.dreaming.frequency;
  s.dmModel = view.dreaming.model;
  s.dmLight = view.dreaming.light.enabled;
  s.dmDeep = view.dreaming.deep.enabled;
  s.dmRem = view.dreaming.rem.enabled;
  s.amPresent = view.activeMemory !== null;
  if (view.activeMemory) {
    s.amEnabled = view.activeMemory.enabled;
    s.amMode = view.activeMemory.mode;
    s.amModel = view.activeMemory.model;
  }
}

async function init(state: AppViewState) {
  await initChannelTabOnce(state, s, {
    applyConfig: (config) => applyViewToState(extractMemoryView(config)),
  });
}

/* ── 保存 ── */

function parseNumberOr(raw: string, fallback: number): number {
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : fallback;
}

function buildSaveView(): MemorySettingsView {
  const view = extractMemoryView(null);
  view.sessionMemory = {
    enabled: s.smEnabled,
    messages: parseNumberOr(s.smMessages, SESSION_MEMORY_DEFAULTS.messages),
    llmSlug: s.smLlmSlug,
    model: s.smModel,
  };
  view.search = {
    enabled: s.msEnabled,
    provider: s.msProvider as MemorySettingsView["search"]["provider"],
    model: s.msModel,
    baseUrl: s.msBaseUrl,
    rememberAcrossConversations: s.msRemember,
    sources: s.msSources.length > 0 ? s.msSources : ["memory"],
    maxResults: parseNumberOr(s.msMaxResults, MEMORY_SEARCH_DEFAULTS.maxResults),
    minScore: parseNumberOr(s.msMinScore, MEMORY_SEARCH_DEFAULTS.minScore),
  };
  view.citations = s.citations;
  view.dreaming = {
    enabled: s.dmEnabled,
    frequency: s.dmFrequency,
    model: s.dmModel,
    storageMode: "",
    light: { enabled: s.dmLight },
    deep: { enabled: s.dmDeep },
    rem: { enabled: s.dmRem },
  };
  view.activeMemory = s.amPresent
    ? { enabled: s.amEnabled, mode: s.amMode, model: s.amModel }
    : null;
  return view;
}

async function handleSave(state: AppViewState) {
  s.saving = true; s.error = null; s.successMsg = null; s.hint = null; state.requestUpdate();
  try {
    // Kimi 一键：先确保本地 auth proxy 运行并拿到端口（主进程职责）
    let kimiProxyPort: number | null = null;
    if (s.kimiApply && s.isKimiCodeConfigured) {
      const proxy = await ipc.settingsEnsureKimiProxy();
      kimiProxyPort = proxy?.proxyPort ?? 0;
      if (!kimiProxyPort || kimiProxyPort <= 0) {
        s.saving = false;
        s.error = t("settings.error.saveFailed");
        state.requestUpdate();
        return;
      }
    }
    // memory + hooks.internal + plugins.entries 三域合并在同一次 config.patch
    const outcome = await runConfigPatch(state, draft => {
      applyMemorySave(draft, buildSaveView(), { kimiProxyPort });
    });
    if (!outcome.ok) {
      s.saving = false;
      s.error = tWithDetail("settings.error.saveFailed", outcome.error);
      state.requestUpdate();
      return;
    }
    // 保存后从最新快照回填（同步 Kimi 代理激活态等派生标志）
    if (state.client && state.connected) {
      try {
        await getConfigSnapshot(state.client, { force: true });
        const config = getCachedConfigSnapshot()?.config;
        if (config) applyViewToState(extractMemoryView(config));
      } catch {}
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

/* ── 渲染助手 ── */

function toggle(label: string, checked: boolean, onChange: (checked: boolean) => void, hint?: string) {
  return html`
    <div class="oc-settings__form-group">
      <oc-toggle-switch .label=${label} .checked=${checked}
        @change=${(e: CustomEvent) => { onChange(e.detail.checked); }}
      ></oc-toggle-switch>
      ${hint ? html`<div class="oc-settings__field-hint">${hint}</div>` : nothing}
    </div>
  `;
}

function textField(label: string, value: string, onInput: (v: string) => void, opts?: {
  hint?: string; placeholder?: string; type?: "text" | "number"; min?: number; max?: number; step?: number;
}) {
  return html`
    <div class="oc-settings__form-group">
      <label class="oc-settings__label">${label}</label>
      <input class="oc-settings__input" type=${opts?.type ?? "text"} .value=${value}
        placeholder=${opts?.placeholder ?? ""} min=${opts?.min ?? nothing} max=${opts?.max ?? nothing}
        step=${opts?.step ?? nothing}
        @input=${(e: Event) => { onInput((e.target as HTMLInputElement).value); }} />
      ${opts?.hint ? html`<div class="oc-settings__field-hint">${opts.hint}</div>` : nothing}
    </div>
  `;
}

function segmented<T extends string>(
  options: Array<{ value: T; label: string }>,
  selected: T,
  onSelect: (v: T) => void,
) {
  return html`
    <div class="oc-settings__segmented" role="group">
      ${options.map(o => html`
        <button type="button" class="oc-settings__segmented-btn"
          aria-pressed=${selected === o.value ? "true" : "false"}
          @click=${() => { onSelect(o.value); }}>${o.label}</button>
      `)}
    </div>
  `;
}

function card(titleKey: string, descKey: string, ...children: unknown[]) {
  return html`
    <div class="oc-settings__card">
      <div class="oc-settings__card-title">${t(titleKey)}</div>
      ${descKey ? html`<div class="oc-settings__field-hint">${t(descKey)}</div>` : nothing}
      ${children}
    </div>
  `;
}

/* ── 卡片 ── */

function renderSessionMemoryCard(state: AppViewState) {
  return card("settings.memory.session.title", "settings.memory.session.desc",
    toggle(t("settings.memory.autoSave"), s.smEnabled,
      (v) => { s.smEnabled = v; state.requestUpdate(); }),
    textField(t("settings.memory.session.messages"), s.smMessages,
      (v) => { s.smMessages = v; state.requestUpdate(); },
      { type: "number", min: 1, hint: t("settings.memory.session.messagesHint") }),
    toggle(t("settings.memory.session.llmSlug"), s.smLlmSlug,
      (v) => { s.smLlmSlug = v; state.requestUpdate(); },
      t("settings.memory.session.llmSlugHint")),
    textField(t("settings.memory.session.model"), s.smModel,
      (v) => { s.smModel = v; state.requestUpdate(); },
      { hint: t("settings.memory.session.modelHint") }),
  );
}

function renderSearchCard(state: AppViewState) {
  // 手动改 provider/model = 放弃一键预置，按用户值保存
  const manualEdit = () => { if (s.kimiApply) s.kimiApply = false; };
  const kimiArea = s.isKimiCodeConfigured
    ? html`
        ${!s.kimiEmbeddingActive && !s.kimiApply ? html`
          <div class="oc-settings__form-group">
            <button type="button" class="btn"
              @click=${() => {
                s.kimiApply = true; s.msEnabled = true;
                s.msProvider = "openai"; s.msModel = KIMI_EMBEDDING_MODEL;
                state.requestUpdate();
              }}>${t("settings.memory.kimiOneClick")}</button>
          </div>
        ` : nothing}
        ${s.kimiApply ? html`<div class="oc-settings__field-hint">${t("settings.memory.kimiPending")}</div>` : nothing}
        ${s.kimiEmbeddingActive ? html`<div class="oc-settings__field-hint">${t("settings.memory.kimiActive")}</div>` : nothing}
      `
    : html`<div class="oc-settings__field-hint">${t("settings.memory.embeddingRequiresKimi")}</div>`;

  const toggleSource = (src: MemorySearchSource, checked: boolean) => {
    if (!checked) {
      const next = s.msSources.filter(x => x !== src);
      if (next.length === 0) return; // 至少保留一个来源
      s.msSources = next;
    } else if (!s.msSources.includes(src)) {
      s.msSources = [...s.msSources, src];
    }
    state.requestUpdate();
  };

  return card("settings.memory.embedding", "settings.memory.search.desc",
    toggle(t("settings.memory.search.enable"), s.msEnabled,
      (v) => { s.msEnabled = v; if (!v) s.kimiApply = false; state.requestUpdate(); }),
    kimiArea,
    html`
      <div class="oc-settings__form-group">
        <label class="oc-settings__label">${t("settings.memory.search.provider")}</label>
        <select class="oc-settings__select" .value=${s.msProvider}
          @change=${(e: Event) => { s.msProvider = (e.target as HTMLSelectElement).value; manualEdit(); state.requestUpdate(); }}>
          ${MEMORY_SEARCH_PROVIDERS.map(p => html`<option value=${p}>${p}</option>`)}
        </select>
      </div>
    `,
    textField(t("settings.memory.search.model"), s.msModel,
      (v) => { s.msModel = v; manualEdit(); state.requestUpdate(); },
      { hint: t("settings.memory.search.modelHint"), placeholder: KIMI_EMBEDDING_MODEL }),
    toggle(t("settings.memory.search.remember"), s.msRemember,
      (v) => { s.msRemember = v; state.requestUpdate(); },
      t("settings.memory.search.rememberHint")),
    html`
      <div class="oc-settings__form-group">
        <label class="oc-settings__label">${t("settings.memory.search.sources")}</label>
        ${toggle(t("settings.memory.search.sourceMemory"), s.msSources.includes("memory"),
          (v) => toggleSource("memory", v))}
        ${toggle(t("settings.memory.search.sourceSessions"), s.msSources.includes("sessions"),
          (v) => toggleSource("sessions", v))}
        <div class="oc-settings__field-hint">${t("settings.memory.search.sourcesHint")}</div>
      </div>
    `,
    html`
      <details class="oc-settings__details-advanced">
        <summary>${t("settings.memory.search.advanced")}</summary>
        <div class="oc-settings__form-group">
          <label class="oc-settings__label">${t("settings.memory.search.maxResults")}</label>
          <input class="oc-settings__input" type="number" min="1" max="50" .value=${s.msMaxResults}
            @input=${(e: Event) => { s.msMaxResults = (e.target as HTMLInputElement).value; state.requestUpdate(); }} />
          <div class="oc-settings__field-hint">${t("settings.memory.search.maxResultsHint")}</div>
        </div>
        <div class="oc-settings__form-group">
          <label class="oc-settings__label">${t("settings.memory.search.minScore")}</label>
          <input class="oc-settings__input" type="number" min="0" max="0.9" step="0.05" .value=${s.msMinScore}
            @input=${(e: Event) => { s.msMinScore = (e.target as HTMLInputElement).value; state.requestUpdate(); }} />
          <div class="oc-settings__field-hint">${t("settings.memory.search.minScoreHint")}</div>
        </div>
        <div class="oc-settings__form-group">
          <label class="oc-settings__label">${t("settings.memory.search.baseUrl")}</label>
          <input class="oc-settings__input" .value=${s.msBaseUrl} placeholder="https://api.example.com/v1"
            @input=${(e: Event) => { s.msBaseUrl = (e.target as HTMLInputElement).value; manualEdit(); state.requestUpdate(); }} />
          <div class="oc-settings__field-hint">${t("settings.memory.search.baseUrlHint")}</div>
        </div>
      </details>
    `,
  );
}

function renderCitationsCard(state: AppViewState) {
  return card("settings.memory.citations.title", "settings.memory.citations.desc",
    html`<div class="oc-settings__form-group">
      ${segmented<MemoryCitationMode>(
        [
          { value: "auto", label: t("settings.memory.citations.auto") },
          { value: "on", label: t("settings.memory.citations.on") },
          { value: "off", label: t("settings.memory.citations.off") },
        ],
        s.citations,
        (v) => { s.citations = v; state.requestUpdate(); },
      )}
    </div>`,
  );
}

function renderDreamingCard(state: AppViewState) {
  return card("settings.memory.dreaming.title", "settings.memory.dreaming.desc",
    toggle(t("settings.memory.dreaming.enable"), s.dmEnabled,
      (v) => { s.dmEnabled = v; state.requestUpdate(); }),
    textField(t("settings.memory.dreaming.frequency"), s.dmFrequency,
      (v) => { s.dmFrequency = v; state.requestUpdate(); },
      { hint: t("settings.memory.dreaming.frequencyHint"), placeholder: "0 3 * * *" }),
    textField(t("settings.memory.dreaming.model"), s.dmModel,
      (v) => { s.dmModel = v; state.requestUpdate(); },
      { hint: t("settings.memory.dreaming.modelHint") }),
    html`
      <details class="oc-settings__details-advanced">
        <summary>${t("settings.memory.dreaming.advanced")}</summary>
        ${toggle(t("settings.memory.dreaming.light"), s.dmLight,
          (v) => { s.dmLight = v; state.requestUpdate(); }, t("settings.memory.dreaming.lightHint"))}
        ${toggle(t("settings.memory.dreaming.deep"), s.dmDeep,
          (v) => { s.dmDeep = v; state.requestUpdate(); }, t("settings.memory.dreaming.deepHint"))}
        ${toggle(t("settings.memory.dreaming.rem"), s.dmRem,
          (v) => { s.dmRem = v; state.requestUpdate(); }, t("settings.memory.dreaming.remHint"))}
      </details>
    `,
  );
}

function renderActiveMemoryCard(state: AppViewState) {
  if (!s.amPresent) return nothing;
  return card("settings.memory.active.title", "settings.memory.active.desc",
    toggle(t("settings.memory.active.enable"), s.amEnabled,
      (v) => { s.amEnabled = v; state.requestUpdate(); }),
    html`<div class="oc-settings__form-group">
      <label class="oc-settings__label">${t("settings.memory.active.mode")}</label>
      ${segmented<ActiveMemoryMode>(
        [
          { value: "escalate", label: t("settings.memory.active.modeEscalate") },
          { value: "always", label: t("settings.memory.active.modeAlways") },
          { value: "off", label: t("settings.memory.active.modeOff") },
        ],
        s.amMode,
        (v) => { s.amMode = v; state.requestUpdate(); },
      )}
    </div>`,
    textField(t("settings.memory.active.model"), s.amModel,
      (v) => { s.amModel = v; state.requestUpdate(); },
      { hint: t("settings.memory.active.modelHint") }),
  );
}

/* ── 运行状态卡 ── */

function renderStatusRow(label: string, value: unknown) {
  return html`
    <div class="oc-memory-status-row">
      <span class="oc-memory-status-row__label">${label}</span>
      <span class="oc-memory-status-row__value">${value == null || value === "" ? "—" : String(value)}</span>
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

  return html`
    <div class="oc-settings__section">
      <h2 class="oc-settings__section-title">${t("settings.memory.title")}</h2>
      <p class="oc-settings__page-desc">${t("settings.memory.desc")}</p>

      ${renderSessionMemoryCard(state)}
      ${renderSearchCard(state)}
      ${renderCitationsCard(state)}
      ${renderDreamingCard(state)}
      ${renderActiveMemoryCard(state)}

      <div class="oc-settings__card">
        <div class="oc-settings__card-title">${t("settings.memory.statusTitle")}</div>
        ${renderMemoryStatus()}
      </div>

      <oc-message-box .message=${s.error ?? ""} .type=${"error"} .visible=${!!s.error}></oc-message-box>
      <oc-message-box .message=${s.successMsg ?? ""} .type=${"success"} .visible=${!!s.successMsg}></oc-message-box>
      ${s.hint ? html`<div class="oc-settings__field-hint">${s.hint}</div>` : nothing}

      <div class="btn-row">
        <button class="btn primary" ?disabled=${s.saving} @click=${() => handleSave(state)}>${t("settings.save")}</button>
      </div>
    </div>
  `;
}
