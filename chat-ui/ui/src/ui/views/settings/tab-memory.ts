/**
 * Settings: Memory Tab — R87 四分页重构（参照 OpenClaw 官方记忆管理页设计）。
 *
 * 页首水平分页（概览 / 记忆 / 梦境 / 设置），数据面：
 * - 概览：功能状态卡（doctor.memory.status 深测 + 刷新 + 插件修复）、统计网格、
 *   召回测试（主进程 spawn 内核 CLI `memory search --json`，与真实对话同一管线）、
 *   危险区（doctor.memory.resetGroundedShortTerm / resetDreamDiary）
 * - 记忆：workspace markdown 列表（MEMORY.md 章节 + memory/*.md 日志），
 *   搜索 / 分页 / 展开 / 新建（追加到 MEMORY.md，主进程备份 .bak）
 * - 梦境：DREAMS.md 托管区条目（主进程统一解析，index 与删除接口一致），
 *   今夜梦境 + 历史梦境 + 查看 / 删除
 * - 设置：R85/R86 的设置表单原样保留（对话记忆 / 自动整理 / 引用标注 / 主动记忆）
 *
 * 配置读写仍走 config.get 快照 + 单次 config.patch（tab-memory.lib.ts）；
 * 运行状态走 gateway RPC；工作区数据走主进程 IPC（data/ipc-bridge.ts memory*）。
 */
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { loadMemoryStatus, resetGroundedShortTerm, resetDreamDiary, type MemoryStatus } from "../../controllers/memory.ts";
import { t, tWithDetail } from "../../i18n.ts";
import * as ipc from "../../data/ipc-bridge.ts";
import type { MemoryWorkspaceList, MemoryRecallData, MemoryReindexData, DreamListEntry } from "../../data/ipc-bridge.ts";
import { getConfigSnapshot, getCachedConfigSnapshot } from "../../controllers/config.ts";
import { formatRelativeTimestamp } from "../../format.ts";
import { renderModelOptionsGrouped } from "../../components/model-options.ts";
import { loadModelOrg } from "./model-org.lib.ts";
import { showConfirm } from "../confirm-dialog.ts";
import type { ConfiguredModel } from "../../ui-types.ts";
import "../../components/toggle-switch.ts";
import "../../components/message-box.ts";
import { runConfigPatch } from "./tab-patch.ts";
import {
  applyMemorySave, extractMemoryView, KIMI_EMBEDDING_MODEL, MEMORY_SEARCH_PROVIDERS,
  MEMORY_SEARCH_DEFAULTS, SESSION_MEMORY_DEFAULTS, DREAMING_DEFAULT_FREQUENCY,
  type ActiveMemoryMode, type MemoryCitationMode, type MemorySearchSource, type MemorySettingsView,
} from "./tab-memory.lib.ts";
import { initChannelTabOnce } from "./tab-channels-shared.ts";

/* ── 状态 ── */

type MemorySubTab = "overview" | "memories" | "dreams" | "settings";
const WS_PAGE_SIZE = 10;
const DREAM_PAGE_SIZE = 6;

// Memory 页状态必须可重建，避免用户丢弃的开关草稿污染下次打开。
function createMemoryState() {
  return {
    subtab: "overview" as MemorySubTab,
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
    // apiKey：msApiKey 只存用户输入（未触碰为空串）；msApiKeyHas = 配置里已有密钥
    // （脱敏快照回传哨兵/占位）；msApiKeyClear = 用户显式要求清除已保存密钥
    msApiKey: "",
    msApiKeyHas: false,
    msApiKeyClear: false,
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
    statusProbing: false,
    wasConnected: false,
    // memory-core 插件启用态（config 快照派生；enabled=false 时概览给一键修复）
    pluginDisabled: false,
    // 工作区记忆列表（记忆分页）
    wsList: null as MemoryWorkspaceList | null,
    wsLoading: false,
    wsFailed: false,
    wsLoaded: false,
    wsSearch: "",
    wsPage: 1,
    wsExpandedId: null as string | null,
    wsExpandedLoading: false,
    wsExpandedContent: null as { title: string; content: string } | null,
    wsCreateOpen: false,
    wsCreateTitle: "",
    wsCreateContent: "",
    wsCreating: false,
    // 梦境（梦境分页）
    dreamList: null as { found: boolean; entries: DreamListEntry[] } | null,
    dreamLoading: false,
    dreamFailed: false,
    dreamPage: 1,
    dreamExpandedIndex: null as number | null,
    dreamExpandedLoading: false,
    dreamExpandedBody: null as { dateText: string; body: string } | null,
    // 召回测试（概览分页）
    recallQuery: "",
    recallRunning: false,
    recallResult: null as MemoryRecallData | null,
    recallError: null as string | null,
    recallExpandedId: null as string | null,
    reindexRunning: false,
    reindexResult: null as MemoryReindexData | null,
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
  s.msApiKey = "";
  s.msApiKeyHas = view.search.apiKey.length > 0;
  s.msApiKeyClear = false;
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
    applyConfig: (config) => {
      applyViewToState(extractMemoryView(config));
      const entry = (config as any)?.plugins?.entries?.["memory-core"];
      s.pluginDisabled = entry?.enabled === false;
    },
  });
}

/* ── 数据加载 ── */

async function refreshStatus(state: AppViewState, probe: boolean) {
  s.statusProbing = probe;
  state.requestUpdate();
  await loadMemoryStatus(s, state, () => state.requestUpdate(), { force: true, probe });
  s.statusProbing = false;
  state.requestUpdate();
}

async function loadWorkspaceList(state: AppViewState, force = false) {
  if (s.wsLoading || (s.wsLoaded && !force)) return;
  s.wsLoading = true; s.wsFailed = false;
  state.requestUpdate();
  try {
    s.wsList = await ipc.memoryListWorkspace();
    s.wsLoaded = true;
  } catch {
    s.wsFailed = true;
  } finally {
    s.wsLoading = false;
    state.requestUpdate();
  }
}

async function loadDreams(state: AppViewState, force = false) {
  if (s.dreamLoading || (s.dreamList && !force)) return;
  s.dreamLoading = true; s.dreamFailed = false;
  state.requestUpdate();
  try {
    s.dreamList = await ipc.memoryListDreams();
  } catch {
    s.dreamFailed = true;
  } finally {
    s.dreamLoading = false;
    state.requestUpdate();
  }
}

async function toggleMemoryExpand(state: AppViewState, id: string) {
  if (s.wsExpandedId === id) {
    s.wsExpandedId = null; s.wsExpandedContent = null;
    state.requestUpdate();
    return;
  }
  s.wsExpandedId = id; s.wsExpandedContent = null; s.wsExpandedLoading = true;
  state.requestUpdate();
  try {
    s.wsExpandedContent = await ipc.memoryReadEntry(id);
  } catch {
    s.wsExpandedContent = null;
  } finally {
    s.wsExpandedLoading = false;
    state.requestUpdate();
  }
}

async function toggleDreamExpand(state: AppViewState, index: number) {
  if (s.dreamExpandedIndex === index) {
    s.dreamExpandedIndex = null; s.dreamExpandedBody = null;
    state.requestUpdate();
    return;
  }
  s.dreamExpandedIndex = index; s.dreamExpandedBody = null; s.dreamExpandedLoading = true;
  state.requestUpdate();
  try {
    s.dreamExpandedBody = await ipc.memoryReadDream(index);
  } catch {
    s.dreamExpandedBody = null;
  } finally {
    s.dreamExpandedLoading = false;
    state.requestUpdate();
  }
}

async function handleCreateMemory(state: AppViewState) {
  if (s.wsCreating) return;
  if (!s.wsCreateTitle.trim() && !s.wsCreateContent.trim()) return;
  s.wsCreating = true; s.error = null; s.successMsg = null;
  state.requestUpdate();
  try {
    await ipc.memoryAppendEntry(s.wsCreateTitle, s.wsCreateContent);
    s.wsCreateOpen = false; s.wsCreateTitle = ""; s.wsCreateContent = "";
    s.successMsg = t("settings.memory.memories.created");
    await loadWorkspaceList(state, true);
  } catch (e: any) {
    s.error = tWithDetail("settings.memory.memories.createFailed", e?.message);
  } finally {
    s.wsCreating = false;
    state.requestUpdate();
  }
}

async function handleDeleteDream(state: AppViewState, entry: DreamListEntry) {
  if (!(await showConfirm(state, t("settings.memory.dreams.deleteConfirm"), { danger: true }))) return;
  s.error = null; s.successMsg = null;
  state.requestUpdate();
  try {
    await ipc.memoryDeleteDream(entry.index);
    s.dreamExpandedIndex = null; s.dreamExpandedBody = null;
    s.successMsg = t("settings.memory.dreams.deleted");
    await loadDreams(state, true);
  } catch (e: any) {
    s.error = tWithDetail("settings.memory.dreams.deleteFailed", e?.message);
  }
  state.requestUpdate();
}

async function handleRecallTest(state: AppViewState) {
  if (s.recallRunning) return;
  const query = s.recallQuery.trim();
  if (!query) return;
  s.recallRunning = true; s.recallError = null; s.recallResult = null; s.recallExpandedId = null;
  state.requestUpdate();
  try {
    s.recallResult = await ipc.memoryRecallTest(query);
  } catch (e: any) {
    s.recallError = e?.message || String(e);
  } finally {
    s.recallRunning = false;
    state.requestUpdate();
  }
}

async function handleReindex(state: AppViewState) {
  if (s.reindexRunning) return;
  if (!(await showConfirm(state, t("settings.memory.overview.reindexConfirm"), { danger: false }))) return;
  s.reindexRunning = true; s.error = null; s.successMsg = null; s.reindexResult = null;
  state.requestUpdate();
  try {
    s.reindexResult = await ipc.memoryReindex();
    s.successMsg = t("settings.memory.overview.reindexDone");
  } catch (e: any) {
    s.error = tWithDetail("settings.memory.overview.reindexFailed", e?.message);
  } finally {
    s.reindexRunning = false;
    state.requestUpdate();
  }
}

async function handleRepairPlugin(state: AppViewState) {
  s.error = null; s.successMsg = null;
  state.requestUpdate();
  try {
    await ipc.memoryRepairPlugin();
    s.pluginDisabled = false;
    s.successMsg = t("settings.memory.overview.repairDone");
    // 刷新配置快照，让设置分页同步插件启用态
    if (state.client && state.connected) {
      try { await getConfigSnapshot(state.client, { force: true }); } catch {}
    }
  } catch (e: any) {
    s.error = tWithDetail("settings.memory.overview.repairFailed", e?.message);
  }
  state.requestUpdate();
}

async function handleResetShortTerm(state: AppViewState) {
  if (!(await showConfirm(state, t("settings.memory.danger.resetShortTermConfirm"), { danger: true }))) return;
  s.error = null; s.successMsg = null;
  state.requestUpdate();
  const ok = await resetGroundedShortTerm(state.client ?? null);
  if (ok) s.successMsg = t("settings.memory.danger.resetShortTermDone");
  else s.error = t("settings.memory.danger.resetShortTermFailed");
  state.requestUpdate();
}

async function handleResetDreams(state: AppViewState) {
  if (!(await showConfirm(state, t("settings.memory.danger.resetDreamsConfirm"), { danger: true }))) return;
  s.error = null; s.successMsg = null;
  state.requestUpdate();
  const ok = await resetDreamDiary(state.client ?? null);
  if (ok) {
    s.successMsg = t("settings.memory.danger.resetDreamsDone");
    await loadDreams(state, true);
  } else {
    s.error = t("settings.memory.danger.resetDreamsFailed");
  }
  state.requestUpdate();
}

/* ── 保存（设置分页；逻辑与 R85/R86 一致） ── */

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
    provider: s.msProvider,
    model: s.msModel,
    baseUrl: s.msBaseUrl,
    // 三态：显式清除 > 新输入 > 不改动（null，draft 现值透传）
    apiKeyInput: s.msApiKeyClear ? "" : (s.msApiKey.trim() || null),
    apiKey: "",
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

/**
 * 已配置的服务商（models.providers）里可作联想服务的 key：
 * 内核 isOpenAICompatibleMemoryProvider 只接受 api=openai-completions/openai-responses
 * 或带 baseUrl 的 provider key，其余（如 anthropic）选了也无法工作——过滤掉。
 * 与内置白名单重名的也排除（避免下拉重复项）。
 */
function customEmbeddingProviderKeys(): string[] {
  const snap = getCachedConfigSnapshot();
  const raw = snap?.config as Record<string, unknown> | null | undefined;
  const providers = raw?.models && typeof raw.models === "object"
    ? (raw.models as Record<string, unknown>).providers : undefined;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return [];
  const builtin = new Set<string>(MEMORY_SEARCH_PROVIDERS);
  return Object.entries(providers as Record<string, unknown>)
    .filter(([, v]) => {
      if (!v || typeof v !== "object" || Array.isArray(v)) return false;
      const p = v as { api?: unknown; baseUrl?: unknown };
      const api = typeof p.api === "string" ? p.api : "";
      const hasBaseUrl = typeof p.baseUrl === "string" && p.baseUrl.trim() !== "";
      return api === "openai-completions" || api === "openai-responses" || hasBaseUrl;
    })
    .map(([k]) => k)
    .filter((k) => !builtin.has(k));
}

/** 模型下拉：选项为已配置模型（provider/model 组合键），空值 = 跟随默认模型 */
function modelSelectField(label: string, value: string, models: ConfiguredModel[], onChange: (v: string) => void, opts?: { hint?: string }) {
  // 当前值不在已配置模型中：先按裸 id / 组合键后缀匹配（R82 及更早保存的是裸 id），
  // 仍匹配不到则追加为额外选项——避免打开页面即静默改写/丢失存量值
  const known = models.some(m => m.key === value);
  const bareMatch = !known && value ? models.find(m => m.key.endsWith(`/${value}`)) : undefined;
  const selectedKey = known ? value : bareMatch?.key ?? value;
  const extraOption = !known && !bareMatch && value
    ? html`<option value=${value} selected>${value}</option>`
    : nothing;
  return html`
    <div class="oc-settings__form-group">
      <label class="oc-settings__label">${label}</label>
      <select class="oc-settings__select" .value=${selectedKey}
        @change=${(e: Event) => { onChange((e.target as HTMLSelectElement).value); }}>
        <option value="" ?selected=${!selectedKey}>${t("settings.memory.followDefaultModel")}</option>
        ${renderModelOptionsGrouped(models, loadModelOrg(), selectedKey || undefined)}
        ${extraOption}
      </select>
      ${opts?.hint ? html`<div class="oc-settings__field-hint">${opts.hint}</div>` : nothing}
    </div>
  `;
}

/** 联想服务提供商下拉：内置白名单 + 已配置的服务商（openai-compatible）分组 */
function customEmbeddingProviders(state: AppViewState, manualEdit: () => void) {
  const customKeys = customEmbeddingProviderKeys();
  // 当前值是 provider key 但不在快照里（provider 已被删除等）→ 追加额外选项防丢失
  const orphan = s.msProvider && !MEMORY_SEARCH_PROVIDERS.includes(s.msProvider as never)
    && !customKeys.includes(s.msProvider)
    ? html`<option value=${s.msProvider} selected>${s.msProvider}</option>`
    : nothing;
  return html`
    <div class="oc-settings__form-group">
      <label class="oc-settings__label">${t("settings.memory.search.provider")}</label>
      <select class="oc-settings__select" .value=${s.msProvider}
        @change=${(e: Event) => { s.msProvider = (e.target as HTMLSelectElement).value; manualEdit(); state.requestUpdate(); }}>
        ${MEMORY_SEARCH_PROVIDERS.map(p => html`<option value=${p} ?selected=${p === s.msProvider}>${p}</option>`)}
        ${customKeys.length > 0 ? html`
          <optgroup label=${t("settings.memory.search.customProvidersGroup")}>
            ${customKeys.map(k => html`<option value=${k} ?selected=${k === s.msProvider}>${k}</option>`)}
          </optgroup>`
          : nothing}
        ${orphan}
      </select>
      <div class="oc-settings__field-hint">${t("settings.memory.search.providerHint")}</div>
    </div>
  `;
}

/** 联想服务 API Key：password 输入 + 已保存密钥的清除/撤销（manualEdit 见调用方注入） */
function apiKeyField(state: AppViewState, manualEdit: () => void) {
  const disabled = s.msProvider === "none" || s.msProvider === "local";
  if (disabled) return nothing;
  const input = html`
    <input class="oc-settings__input" type="password" autocomplete="off" .value=${s.msApiKey}
      placeholder=${s.msApiKeyHas && !s.msApiKeyClear
        ? t("settings.memory.search.apiKeySavedPlaceholder")
        : t("settings.memory.search.apiKeyPlaceholder")}
      @input=${(e: Event) => {
        s.msApiKey = (e.target as HTMLInputElement).value;
        // 清除挂起时输入新 key = 用户改主意：撤销清除，以新值为准
        if (s.msApiKeyClear && s.msApiKey.trim()) s.msApiKeyClear = false;
        manualEdit();
        state.requestUpdate();
      }} />
  `;
  return html`
    <div class="oc-settings__form-group">
      <label class="oc-settings__label">${t("settings.memory.search.apiKey")}</label>
      ${input}
      ${s.msApiKeyClear
        ? html`
          <div class="oc-settings__field-hint">${t("settings.memory.search.apiKeyClearPending")}
            <button type="button" class="btn btn--sm" @click=${() => { s.msApiKeyClear = false; state.requestUpdate(); }}>${t("settings.memory.search.apiKeyUndoClear")}</button>
          </div>`
        : s.msApiKeyHas
          ? html`<div class="oc-settings__field-hint">
              <button type="button" class="btn btn--sm" @click=${() => { s.msApiKeyClear = true; s.msApiKey = ""; manualEdit(); state.requestUpdate(); }}>${t("settings.memory.search.apiKeyClear")}</button>
            </div>`
          : nothing}
      <div class="oc-settings__field-hint">${t("settings.memory.search.apiKeyHint")}</div>
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

/* ── 概览分页 ── */

function statCell(labelKey: string, value: unknown) {
  const v = value == null ? "—" : String(value);
  return html`
    <div class="oc-memory-stat">
      <div class="oc-memory-stat__value">${v}</div>
      <div class="oc-memory-stat__label">${t(labelKey)}</div>
    </div>
  `;
}

function renderOverviewTab(state: AppViewState) {
  const ms = s.memoryStatus;
  const dreaming = ms?.dreaming;

  // 功能状态：插件启用 + embedding 连通 +（可深测）
  const statusLine = s.statusFailed || !ms
    ? html`<span class="oc-memory-badge oc-memory-badge--warn">${t("settings.memory.statusUnavailable")}</span>`
    : s.pluginDisabled
      ? html`<span class="oc-memory-badge oc-memory-badge--warn">${t("settings.memory.overview.pluginDisabled")}</span>`
      : ms.embedding?.ok
        ? html`<span class="oc-memory-badge oc-memory-badge--ok">${t("settings.memory.overview.running")}</span>`
        : html`<span class="oc-memory-badge oc-memory-badge--warn">${t("settings.memory.statusEmbeddingUnavailable")}</span>`;

  const statusRows = ms && !s.statusFailed ? html`
    ${ms.provider ? html`<div class="oc-memory-status-row">
      <span class="oc-memory-status-row__label">${t("settings.memory.statusBackend")}</span>
      <span class="oc-memory-status-row__value">${ms.provider}</span>
    </div>` : nothing}
    <div class="oc-memory-status-row">
      <span class="oc-memory-status-row__label">${t("settings.memory.statusEmbedding")}</span>
      <span class="oc-memory-status-row__value">${ms.embedding?.ok
        ? t("settings.memory.embeddingEnabled")
        : `${t("settings.memory.statusEmbeddingUnavailable")}${ms.embedding?.error ? ` (${ms.embedding.error})` : ""}`}
      </span>
    </div>
  ` : nothing;

  const recallExamples = [1, 2, 3, 4].map(i => t(`settings.memory.overview.recallExample${i}`));
  const recallResults = s.recallResult;
  const recallBody = s.recallRunning
    ? html`<div class="oc-settings__field-hint">${t("settings.memory.overview.recallRunning")}</div>`
    : s.recallError
      ? html`<div class="oc-settings__field-hint">${tWithDetail("settings.memory.overview.recallFailed", s.recallError)}</div>`
      : recallResults
        ? html`
            ${recallResults.stale ? html`
              <div class="oc-memory-stale">
                ${t("settings.memory.overview.indexStale")}
                <button type="button" class="btn btn--sm" ?disabled=${s.reindexRunning}
                  @click=${() => handleReindex(state)}>${t("settings.memory.overview.reindex")}</button>
              </div>` : nothing}
            ${recallResults.results.length === 0
              ? html`<div class="oc-settings__field-hint">${t("settings.memory.overview.recallEmpty")}</div>`
              : html`<div class="oc-memory-recall-list">
                  ${recallResults.results.map((r, i) => {
                    const id = r.id ?? r.path ?? String(i);
                    const score = typeof r.score === "number" ? Math.round(r.score * 100) : null;
                    const snippet = (r.content ?? r.path ?? "").toString();
                    const expanded = s.recallExpandedId === id;
                    return html`
                      <div class="oc-memory-recall-item">
                        <button type="button" class="oc-memory-recall-item__head" @click=${() => {
                          s.recallExpandedId = expanded ? null : id;
                          state.requestUpdate();
                        }}>
                          ${score != null ? html`<span class="oc-memory-recall-item__score">${score}%</span>` : nothing}
                          <span class="oc-memory-recall-item__snippet">${snippet.slice(0, 200)}</span>
                        </button>
                        ${expanded ? html`<pre class="oc-memory-recall-item__body">${snippet}</pre>` : nothing}
                      </div>
                    `;
                  })}
                </div>`}
          `
        : nothing;

  return html`
    <div class="oc-settings__card">
      <div class="oc-settings__card-title">${t("settings.memory.overview.statusTitle")}</div>
      <div class="oc-settings__field-hint">${t("settings.memory.overview.statusDesc")}</div>
      <div class="oc-memory-status-row">
        <span class="oc-memory-status-row__label">${t("settings.memory.overview.state")}</span>
        <span class="oc-memory-status-row__value">${statusLine}</span>
      </div>
      ${statusRows}
      <div class="btn-row">
        <button type="button" class="btn btn--sm" ?disabled=${s.statusProbing}
          @click=${() => refreshStatus(state, true)}>${t("settings.memory.overview.refresh")}</button>
        ${s.pluginDisabled ? html`
          <button type="button" class="btn btn--sm" @click=${() => handleRepairPlugin(state)}>
            ${t("settings.memory.overview.repairPlugin")}
          </button>` : nothing}
        <button type="button" class="btn btn--sm" ?disabled=${s.reindexRunning}
          @click=${() => handleReindex(state)}>${t("settings.memory.overview.reindex")}</button>
      </div>
      ${s.reindexRunning ? html`<div class="oc-settings__field-hint">${t("settings.memory.overview.reindexRunning")}</div>` : nothing}
      ${s.reindexResult?.ok ? html`<div class="oc-settings__field-hint">${t("settings.memory.overview.reindexSummary")
        .replace("{files}", String(s.reindexResult.files ?? "—"))
        .replace("{chunks}", String(s.reindexResult.chunks ?? "—"))}</div>` : nothing}
    </div>

    <div class="oc-settings__card">
      <div class="oc-settings__card-title">${t("settings.memory.overview.statsTitle")}</div>
      <div class="oc-memory-stats-grid">
        ${statCell("settings.memory.statusShortTerm", dreaming?.shortTermCount)}
        ${statCell("settings.memory.overview.statRecallSignals", dreaming?.recallSignalCount ?? dreaming?.totalSignalCount)}
        ${statCell("settings.memory.statusPromoted", dreaming?.promotedTotal)}
        ${statCell("settings.memory.overview.statPromotedToday", dreaming?.promotedToday)}
        ${statCell("settings.memory.overview.statMemoryFiles", s.wsList ? s.wsList.longTermCount + s.wsList.dailyCount : null)}
        ${statCell("settings.memory.overview.statDreams", s.dreamList?.entries.length)}
        ${statCell("settings.memory.overview.statLightHits", dreaming?.lightPhaseHitCount)}
        ${statCell("settings.memory.overview.statRemHits", dreaming?.remPhaseHitCount)}
      </div>
    </div>

    <div class="oc-settings__card">
      <div class="oc-settings__card-title">${t("settings.memory.overview.recallTitle")}</div>
      <div class="oc-settings__field-hint">${t("settings.memory.overview.recallDesc")}</div>
      <div class="oc-settings__form-group oc-memory-recall-controls">
        <input class="oc-settings__input" .value=${s.recallQuery}
          placeholder=${t("settings.memory.overview.recallPlaceholder")}
          @input=${(e: Event) => { s.recallQuery = (e.target as HTMLInputElement).value; state.requestUpdate(); }}
          @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") handleRecallTest(state); }} />
        <button type="button" class="btn primary btn--sm" ?disabled=${s.recallRunning || !s.recallQuery.trim()}
          @click=${() => handleRecallTest(state)}>${t("settings.memory.overview.recallRun")}</button>
      </div>
      <div class="oc-memory-chips">
        ${recallExamples.map(q => html`
          <button type="button" class="oc-memory-chip" @click=${() => { s.recallQuery = q; handleRecallTest(state); }}>${q}</button>
        `)}
      </div>
      ${recallBody}
      <div class="oc-settings__field-hint">${t("settings.memory.overview.recallTip")}</div>
    </div>

    <div class="oc-settings__card oc-memory-danger">
      <div class="oc-settings__card-title">${t("settings.memory.danger.title")}</div>
      <div class="oc-settings__field-hint">${t("settings.memory.danger.desc")}</div>
      <div class="oc-memory-danger__item">
        <div>
          <div>${t("settings.memory.danger.resetShortTerm")}</div>
          <div class="oc-settings__field-hint">${t("settings.memory.danger.resetShortTermHint")}</div>
        </div>
        <button type="button" class="btn danger btn--sm" @click=${() => handleResetShortTerm(state)}>
          ${t("settings.memory.danger.resetShortTermButton")}
        </button>
      </div>
      <div class="oc-memory-danger__item">
        <div>
          <div>${t("settings.memory.danger.resetDreams")}</div>
          <div class="oc-settings__field-hint">${t("settings.memory.danger.resetDreamsHint")}</div>
        </div>
        <button type="button" class="btn danger btn--sm" @click=${() => handleResetDreams(state)}>
          ${t("settings.memory.danger.resetDreamsButton")}
        </button>
      </div>
    </div>
  `;
}

/* ── 记忆分页 ── */

function filteredWorkspaceEntries() {
  const list = s.wsList?.entries ?? [];
  const q = s.wsSearch.trim().toLowerCase();
  if (!q) return list;
  return list.filter(e =>
    e.title.toLowerCase().includes(q) || e.snippet.toLowerCase().includes(q));
}

function renderMemoriesTab(state: AppViewState) {
  const all = filteredWorkspaceEntries();
  const totalPages = Math.max(1, Math.ceil(all.length / WS_PAGE_SIZE));
  const page = Math.min(s.wsPage, totalPages);
  const pageEntries = all.slice((page - 1) * WS_PAGE_SIZE, page * WS_PAGE_SIZE);

  const createForm = s.wsCreateOpen ? html`
    <div class="oc-memory-create">
      <input class="oc-settings__input" .value=${s.wsCreateTitle}
        placeholder=${t("settings.memory.memories.createTitlePlaceholder")}
        @input=${(e: Event) => { s.wsCreateTitle = (e.target as HTMLInputElement).value; state.requestUpdate(); }} />
      <textarea class="oc-settings__input oc-memory-create__body" rows="4" .value=${s.wsCreateContent}
        placeholder=${t("settings.memory.memories.createBodyPlaceholder")}
        @input=${(e: Event) => { s.wsCreateContent = (e.target as HTMLTextAreaElement).value; state.requestUpdate(); }}></textarea>
      <div class="btn-row">
        <button type="button" class="btn primary btn--sm" ?disabled=${s.wsCreating || (!s.wsCreateTitle.trim() && !s.wsCreateContent.trim())}
          @click=${() => handleCreateMemory(state)}>${t("settings.memory.memories.createSave")}</button>
        <button type="button" class="btn btn--sm" ?disabled=${s.wsCreating}
          @click=${() => { s.wsCreateOpen = false; state.requestUpdate(); }}>${t("settings.cancel")}</button>
      </div>
    </div>
  ` : nothing;

  const listBody = s.wsLoading && !s.wsList
    ? html`<div class="oc-settings__field-hint">${t("settings.memory.statusLoading")}</div>`
    : s.wsFailed
      ? html`
          <div class="oc-settings__field-hint">${t("settings.memory.memories.listFailed")}</div>
          <div class="btn-row">
            <button type="button" class="btn btn--sm" ?disabled=${s.wsLoading}
              @click=${() => loadWorkspaceList(state, true)}>${t("settings.memory.overview.refresh")}</button>
          </div>`
      : all.length === 0
        ? html`<div class="oc-settings__field-hint">${t("settings.memory.memories.empty")}</div>`
        : html`
            ${pageEntries.map(e => {
              const expanded = s.wsExpandedId === e.id;
              return html`
                <div class="oc-memory-item ${e.kind === "long-term" ? "oc-memory-item--lt" : ""}">
                  <button type="button" class="oc-memory-item__head" @click=${() => toggleMemoryExpand(state, e.id)}>
                    <span class="oc-memory-item__kind">${e.kind === "long-term"
                      ? t("settings.memory.memories.kindLongTerm")
                      : t("settings.memory.memories.kindDaily")}</span>
                    <span class="oc-memory-item__title">${e.title}</span>
                    <span class="oc-memory-item__meta">${e.mtimeMs != null
                      ? formatRelativeTimestamp(e.mtimeMs, { dateFallback: true })
                      : ""}</span>
                  </button>
                  ${expanded ? html`
                    <div class="oc-memory-item__snippet">${e.snippet}</div>
                    ${s.wsExpandedLoading
                      ? html`<div class="oc-settings__field-hint">${t("settings.memory.statusLoading")}</div>`
                      : s.wsExpandedContent
                        ? html`<pre class="oc-memory-item__body">${s.wsExpandedContent.content}</pre>`
                        : html`<div class="oc-settings__field-hint">${t("settings.memory.memories.readFailed")}</div>`}
                  ` : nothing}
                </div>
              `;
            })}
            ${all.length > WS_PAGE_SIZE ? html`
              <div class="oc-memory-pager">
                <button type="button" class="btn btn--sm" ?disabled=${page <= 1}
                  @click=${() => { s.wsPage = page - 1; state.requestUpdate(); }}>${t("settings.memory.pagerPrev")}</button>
                <span class="oc-memory-pager__info">${t("settings.memory.pagerInfo")
                  .replace("{page}", String(page)).replace("{total}", String(totalPages))}</span>
                <button type="button" class="btn btn--sm" ?disabled=${page >= totalPages}
                  @click=${() => { s.wsPage = page + 1; state.requestUpdate(); }}>${t("settings.memory.pagerNext")}</button>
              </div>` : nothing}
          `;

  return html`
    <div class="oc-settings__card">
      <div class="oc-memory-toolbar">
        <input class="oc-settings__input oc-memory-toolbar__search" .value=${s.wsSearch}
          placeholder=${t("settings.memory.memories.searchPlaceholder")}
          @input=${(e: Event) => {
            s.wsSearch = (e.target as HTMLInputElement).value;
            s.wsPage = 1;
            state.requestUpdate();
          }} />
        <span class="oc-memory-toolbar__count">${t("settings.memory.memories.count")
          .replace("{n}", String(all.length))}</span>
        <button type="button" class="btn primary btn--sm" @click=${() => { s.wsCreateOpen = !s.wsCreateOpen; state.requestUpdate(); }}>
          ${t("settings.memory.memories.create")}
        </button>
      </div>
      ${createForm}
      ${listBody}
    </div>
  `;
}

/* ── 梦境分页 ── */

function renderDreamsTab(state: AppViewState) {
  if (s.dreamLoading && !s.dreamList) {
    return html`<div class="oc-settings__card">
      <div class="oc-settings__field-hint">${t("settings.memory.statusLoading")}</div>
    </div>`;
  }
  if (s.dreamFailed || !s.dreamList) {
    return html`<div class="oc-settings__card">
      <div class="oc-settings__field-hint">${t("settings.memory.dreams.listFailed")}</div>
      <div class="btn-row">
        <button type="button" class="btn btn--sm" @click=${() => loadDreams(state, true)}>${t("settings.memory.overview.refresh")}</button>
      </div>
    </div>`;
  }
  const entries = s.dreamList.entries;
  if (!s.dreamList.found || entries.length === 0) {
    return html`<div class="oc-settings__card">
      <div class="oc-settings__card-title">${t("settings.memory.dreams.empty")}</div>
      <div class="oc-settings__field-hint">${t("settings.memory.dreams.emptyHint")}</div>
      <div class="btn-row">
        <button type="button" class="btn btn--sm" @click=${() => loadDreams(state, true)}>${t("settings.memory.overview.refresh")}</button>
      </div>
    </div>`;
  }

  const tonight = entries[0];
  const history = entries.slice(1);
  const totalPages = Math.max(1, Math.ceil(history.length / DREAM_PAGE_SIZE));
  const page = Math.min(s.dreamPage, totalPages);
  const pageEntries = history.slice((page - 1) * DREAM_PAGE_SIZE, page * DREAM_PAGE_SIZE);

  const dreamEntry = (e: DreamListEntry, tonightStyle: boolean) => {
    const expanded = s.dreamExpandedIndex === e.index;
    return html`
      <div class="oc-memory-dream ${tonightStyle ? "oc-memory-dream--tonight" : ""}">
        <div class="oc-memory-dream__head">
          <span class="oc-memory-dream__date">${e.dateMs != null
            ? formatRelativeTimestamp(e.dateMs, { dateFallback: true })
            : e.dateText}</span>
          <span class="oc-memory-dream__chars">${t("settings.memory.dreams.chars").replace("{n}", String(e.chars))}</span>
          <span class="oc-memory-dream__actions">
            <button type="button" class="btn btn--sm" @click=${() => toggleDreamExpand(state, e.index)}>
              ${t("settings.memory.dreams.view")}
            </button>
            <button type="button" class="btn danger btn--sm" @click=${() => handleDeleteDream(state, e)}>
              ${t("settings.memory.dreams.delete")}
            </button>
          </span>
        </div>
        <div class="oc-memory-dream__snippet">${e.snippet}</div>
        ${expanded ? html`
          ${s.dreamExpandedLoading
            ? html`<div class="oc-settings__field-hint">${t("settings.memory.statusLoading")}</div>`
            : s.dreamExpandedBody
              ? html`<pre class="oc-memory-dream__body">${s.dreamExpandedBody.body}</pre>`
              : html`<div class="oc-settings__field-hint">${t("settings.memory.dreams.readFailed")}</div>`}
        ` : nothing}
      </div>
    `;
  };

  return html`
    <div class="oc-settings__card">
      <div class="oc-settings__card-title">${t("settings.memory.dreams.tonightTitle")}</div>
      <div class="oc-settings__field-hint">${t("settings.memory.dreams.tonightDesc")}</div>
      ${dreamEntry(tonight, true)}
    </div>
    <div class="oc-settings__card">
      <div class="oc-settings__card-title">${t("settings.memory.dreams.historyTitle")}</div>
      ${history.length === 0
        ? html`<div class="oc-settings__field-hint">${t("settings.memory.dreams.historyEmpty")}</div>`
        : html`
            ${pageEntries.map(e => dreamEntry(e, false))}
            ${history.length > DREAM_PAGE_SIZE ? html`
              <div class="oc-memory-pager">
                <button type="button" class="btn btn--sm" ?disabled=${page <= 1}
                  @click=${() => { s.dreamPage = page - 1; state.requestUpdate(); }}>${t("settings.memory.pagerPrev")}</button>
                <span class="oc-memory-pager__info">${t("settings.memory.pagerInfo")
                  .replace("{page}", String(page)).replace("{total}", String(totalPages))}</span>
                <button type="button" class="btn btn--sm" ?disabled=${page >= totalPages}
                  @click=${() => { s.dreamPage = page + 1; state.requestUpdate(); }}>${t("settings.memory.pagerNext")}</button>
              </div>` : nothing}
          `}
      <div class="btn-row">
        <button type="button" class="btn btn--sm" ?disabled=${s.dreamLoading}
          @click=${() => loadDreams(state, true)}>${t("settings.memory.overview.refresh")}</button>
      </div>
    </div>
  `;
}

/* ── 设置分页（R85/R86 卡片原样保留） ── */

// 主卡：会话记忆 + 智能联想合并。两个大白话开关置顶；
// Kimi 一键紧随其后；全部技术参数（provider/model/阈值/来源/归档）收进「高级设置」。
function renderMainMemoryCard(state: AppViewState) {
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

  return card("settings.memory.main.title", "settings.memory.main.desc",
    toggle(t("settings.memory.autoSave"), s.smEnabled,
      (v) => { s.smEnabled = v; state.requestUpdate(); },
      t("settings.memory.autoSaveHint")),
    toggle(t("settings.memory.smartRecall"), s.msEnabled,
      (v) => { s.msEnabled = v; if (!v) s.kimiApply = false; state.requestUpdate(); },
      t("settings.memory.smartRecallHint")),
    kimiArea,
    html`
      <details class="oc-settings__details-advanced">
        <summary>${t("settings.memory.advanced")}</summary>
        ${toggle(t("settings.memory.search.remember"), s.msRemember,
          (v) => { s.msRemember = v; state.requestUpdate(); },
          t("settings.memory.search.rememberHint"))}
        <div class="oc-settings__form-group">
          <label class="oc-settings__label">${t("settings.memory.search.sources")}</label>
          ${toggle(t("settings.memory.search.sourceMemory"), s.msSources.includes("memory"),
            (v) => toggleSource("memory", v))}
          ${toggle(t("settings.memory.search.sourceSessions"), s.msSources.includes("sessions"),
            (v) => toggleSource("sessions", v))}
          <div class="oc-settings__field-hint">${t("settings.memory.search.sourcesHint")}</div>
        </div>
        ${customEmbeddingProviders(state, manualEdit)}
        ${textField(t("settings.memory.search.model"), s.msModel,
          (v) => { s.msModel = v; manualEdit(); state.requestUpdate(); },
          { hint: t("settings.memory.search.modelHint"), placeholder: KIMI_EMBEDDING_MODEL })}
        ${textField(t("settings.memory.search.baseUrl"), s.msBaseUrl,
          (v) => { s.msBaseUrl = v; manualEdit(); state.requestUpdate(); },
          { hint: t("settings.memory.search.baseUrlHint"), placeholder: "https://api.example.com/v1" })}
        ${apiKeyField(state, manualEdit)}
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
          <label class="oc-settings__label">${t("settings.memory.session.messages")}</label>
          <input class="oc-settings__input" type="number" min="1" .value=${s.smMessages}
            @input=${(e: Event) => { s.smMessages = (e.target as HTMLInputElement).value; state.requestUpdate(); }} />
          <div class="oc-settings__field-hint">${t("settings.memory.session.messagesHint")}</div>
        </div>
        ${toggle(t("settings.memory.session.llmSlug"), s.smLlmSlug,
          (v) => { s.smLlmSlug = v; state.requestUpdate(); },
          t("settings.memory.session.llmSlugHint"))}
        ${modelSelectField(t("settings.memory.session.model"), s.smModel, state.configuredModels,
          (v) => { s.smModel = v; state.requestUpdate(); },
          { hint: t("settings.memory.session.modelHint") })}
      </details>
    `,
  );
}

/* ── 自动整理：常用时间下拉 + 自定义 cron 兜底 ── */

const FREQ_PRESETS: ReadonlyArray<{ value: string; key: string }> = [
  { value: DREAMING_DEFAULT_FREQUENCY, key: "settings.memory.dreaming.freqDaily3" },
  { value: "0 4 * * *", key: "settings.memory.dreaming.freqDaily4" },
  { value: "0 */12 * * *", key: "settings.memory.dreaming.freq12h" },
  { value: "0 */6 * * *", key: "settings.memory.dreaming.freq6h" },
];
const FREQ_CUSTOM = "__custom__";

function renderDreamingCard(state: AppViewState) {
  const isPreset = FREQ_PRESETS.some(p => p.value === s.dmFrequency.trim());
  return card("settings.memory.dreaming.title", "settings.memory.dreaming.desc",
    toggle(t("settings.memory.dreaming.enable"), s.dmEnabled,
      (v) => { s.dmEnabled = v; state.requestUpdate(); }),
    html`
      <div class="oc-settings__form-group">
        <label class="oc-settings__label">${t("settings.memory.dreaming.frequency")}</label>
        <select class="oc-settings__select" .value=${isPreset ? s.dmFrequency.trim() : FREQ_CUSTOM}
          @change=${(e: Event) => {
            const v = (e.target as HTMLSelectElement).value;
            if (v !== FREQ_CUSTOM) {
              s.dmFrequency = v;
            } else if (isPreset || !s.dmFrequency.trim()) {
              s.dmFrequency = ""; // 首次切自定义留空，露出 placeholder 提示
            }
            state.requestUpdate();
          }}>
          ${FREQ_PRESETS.map(p => html`<option value=${p.value}>${t(p.key)}</option>`)}
          <option value=${FREQ_CUSTOM}>${t("settings.memory.dreaming.freqCustom")}</option>
        </select>
        ${!isPreset ? html`
          <input class="oc-settings__input" style="margin-top: var(--spacer-8)" .value=${s.dmFrequency}
            placeholder=${DREAMING_DEFAULT_FREQUENCY}
            @input=${(e: Event) => { s.dmFrequency = (e.target as HTMLInputElement).value; state.requestUpdate(); }} />
          <div class="oc-settings__field-hint">${t("settings.memory.dreaming.freqCustomHint")}</div>
        ` : nothing}
      </div>
    `,
    html`
      <details class="oc-settings__details-advanced">
        <summary>${t("settings.memory.dreaming.advanced")}</summary>
        ${toggle(t("settings.memory.dreaming.light"), s.dmLight,
          (v) => { s.dmLight = v; state.requestUpdate(); }, t("settings.memory.dreaming.lightHint"))}
        ${toggle(t("settings.memory.dreaming.deep"), s.dmDeep,
          (v) => { s.dmDeep = v; state.requestUpdate(); }, t("settings.memory.dreaming.deepHint"))}
        ${toggle(t("settings.memory.dreaming.rem"), s.dmRem,
          (v) => { s.dmRem = v; state.requestUpdate(); }, t("settings.memory.dreaming.remHint"))}
        ${modelSelectField(t("settings.memory.dreaming.model"), s.dmModel, state.configuredModels,
          (v) => { s.dmModel = v; state.requestUpdate(); },
          { hint: t("settings.memory.dreaming.modelHint") })}
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
    modelSelectField(t("settings.memory.active.model"), s.amModel, state.configuredModels,
      (v) => { s.amModel = v; state.requestUpdate(); },
      { hint: t("settings.memory.active.modelHint") }),
  );
}

function renderSettingsTab(state: AppViewState) {
  return html`
    ${renderMainMemoryCard(state)}
    ${renderDreamingCard(state)}
    ${renderCitationsCard(state)}
    ${renderActiveMemoryCard(state)}
    <div class="btn-row">
      <button class="btn primary" ?disabled=${s.saving} @click=${() => handleSave(state)}>${t("settings.save")}</button>
    </div>
  `;
}

/* ── 页面入口 ── */

export function resetMemoryTab() { resetMemoryState(); }

export function renderTabMemory(state: AppViewState) {
  if (!s.initialized) init(state);

  // 网关断线后标记状态过期，重连回来时重新拉取（对齐 tab-usage 的做法）。
  if (s.wasConnected && !state.connected) s.statusLoaded = false;
  s.wasConnected = state.connected;
  if (!s.statusLoaded && !s.statusLoading && state.connected && state.client) {
    loadMemoryStatus(s, state, () => state.requestUpdate());
  }

  // 概览统计要 workspace/梦境计数；记忆/梦境分页各自懒加载。
  // 失败后（wsFailed/dreamFailed）不再由渲染路径自动重试，避免无限 IPC 循环，
  // 交给失败卡片上的刷新按钮手动重试。
  if (s.subtab === "overview" || s.subtab === "memories") {
    if (!s.wsLoaded && !s.wsLoading && !s.wsFailed) loadWorkspaceList(state);
  }
  if (s.subtab === "overview" || s.subtab === "dreams") {
    if (!s.dreamList && !s.dreamLoading && !s.dreamFailed) loadDreams(state);
  }

  const subtabs: Array<{ id: MemorySubTab; key: string }> = [
    { id: "overview", key: "settings.memory.subtabOverview" },
    { id: "memories", key: "settings.memory.subtabMemories" },
    { id: "dreams", key: "settings.memory.subtabDreams" },
    { id: "settings", key: "settings.memory.subtabSettings" },
  ];

  return html`
    <div class="oc-settings__section">
      <h2 class="oc-settings__section-title">${t("settings.memory.title")}</h2>
      <p class="oc-settings__page-desc">${t("settings.memory.desc")}</p>

      <div class="oc-memory-subtabs" role="tablist">
        ${subtabs.map(tb => html`
          <button type="button" role="tab" class="oc-memory-subtabs__btn"
            aria-selected=${s.subtab === tb.id ? "true" : "false"}
            @click=${() => { s.subtab = tb.id; state.requestUpdate(); }}>${t(tb.key)}</button>
        `)}
      </div>

      ${s.subtab === "overview" ? renderOverviewTab(state) : nothing}
      ${s.subtab === "memories" ? renderMemoriesTab(state) : nothing}
      ${s.subtab === "dreams" ? renderDreamsTab(state) : nothing}
      ${s.subtab === "settings" ? renderSettingsTab(state) : nothing}

      <oc-message-box .message=${s.error ?? ""} .type=${"error"} .visible=${!!s.error}></oc-message-box>
      <oc-message-box .message=${s.successMsg ?? ""} .type=${"success"} .visible=${!!s.successMsg}></oc-message-box>
      ${s.hint ? html`<div class="oc-settings__field-hint">${s.hint}</div>` : nothing}
    </div>
  `;
}
