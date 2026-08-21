/**
 * Settings: Provider Tab — 分组模型管理。
 *
 * 数据链路全面切换到内核原生配置 RPC：
 * - 读：config.get 脱敏快照（controllers/config.ts 缓存 + baseHash 乐观锁）
 * - 写：config.patch 合并补丁（数组删条目/重排自动 replacePaths 整体替换）
 * - 模型目录：models.list 动态目录（controllers/models.ts），不再硬编码清单
 * - API key 验证保留主进程 IPC settings:verify-key（真实 HTTP 探测）
 * - kimi-code 真实 key 走 sidecar IPC settings:write-kimi-api-key，
 *   config 中只写 proxy-managed 占位符；同时联动启用 kimi-search + memory embedding
 */
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { t, getLocale } from "../../i18n.ts";
import * as ipc from "../../data/ipc-bridge.ts";
import "../../components/toggle-switch.ts";
import "../../components/password-input.ts";
import "../../components/message-box.ts";
import "../../components/provider-segment.ts";
import {
  PROVIDERS, CUSTOM_PRESETS, KIMI_CODE_FIXED_MODEL,
  CUSTOM_MODEL_SENTINEL, PROVIDER_DISPLAY_ORDER, getProviderLabels,
  isValidHttpBaseUrl,
} from "../setup/setup-constants.ts";
import {
  getCachedGatewayModels, getCachedGatewayModelEntries, loadGatewayModels, catalogModelSupportsImage,
} from "../../controllers/models.ts";
import {
  getConfigSnapshot, getCachedConfigSnapshot, patchConfig,
  type ConfigPatchResult,
} from "../../controllers/config.ts";
import { showConfirm } from "../confirm-dialog.ts";
import {
  groupProvidersFromConfig, readFallbacks, reorderIds, applyIdOrder,
  resolveAddTarget as resolveAddTargetFor, buildModelEntry, applyKimiCodeLinkage,
  formatContextWindow, applyCapabilityOverrides, deriveOverridesFromEntry,
  type AddSelection,
  type ProviderGroup, type GroupedProvider, type ProviderModelEntry, type ProviderGroupId,
} from "./tab-provider.lib.ts";
import {
  emptyModelOrg, loadModelOrg, saveModelOrg, addOrgGroup, renameOrgGroup, removeOrgGroup,
  reorderOrgGroups, assignModelToGroup, pruneModelOrgAssignments, generateOrgGroupId,
  type ModelOrgState,
} from "./model-org.lib.ts";
import { renderModelOptionsGrouped } from "../../components/model-options.ts";
import { deriveUsageView, type UsageLabels } from "./tab-provider-usage.lib.ts";

/** 编辑器可选思考档位（off/on 为基础开关、adaptive 为 provider 专有，不暴露） */
const EDITABLE_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/* ── types ── */

interface AgentRow {
  id: string;
  label: string;
  modelPrimary: string;
}

type DragRef =
  | { kind: "model"; providerKey: string; id: string }
  | { kind: "fallback"; id: string }
  | { kind: "org-group"; id: string };

interface DropTarget {
  kind: "model" | "fallback" | "org-group";
  id: string;
  position: "before" | "after";
}

/** 能力编辑草稿（编辑既有模型与分组追加共用） */
interface CapsDraft {
  contextWindow: string;
  contextTokens: string;
  maxTokens: string;
  image: boolean;
  video: boolean;
  audio: boolean;
  reasoning: boolean;
  thinkingLevels: string[];
}

/* ── module-level state ── */

function createProviderState() {
  return {
    initialized: false,
    loading: false,
    busy: false,
    error: null as string | null,
    successMsg: null as string | null,
    /** 内核 restart 要求提示（热应用 / 平滑重启 / 需重启） */
    restartHint: null as string | null,
    collapsedGroups: new Set<string>(),
    // 拖拽
    drag: null as DragRef | null,
    dropTarget: null as DropTarget | null,
    // 别名行内编辑
    aliasEditing: null as string | null,
    aliasDraft: "",
    // provider 密钥行内编辑
    keyEditing: null as string | null,
    keyDraft: "",
    // 添加面板
    addOpen: false,
    addProvider: "moonshot" as string,
    addSubPlatform: "kimi-code" as string,
    addCustomPreset: "" as string,
    addApiKey: "",
    addModelId: "",
    addCustomModelId: "",
    addAlias: "",
    addBaseUrl: "",
    addApiType: "openai-completions",
    addShowCustomModelInput: false,
    saving: false,
    /** 分组追加模式：目标 providerKey（复用其端点与密钥）；null = 完整添加流程 */
    addToProviderKey: null as string | null,
    /** 追加模式的能力覆盖草稿（选型时从目录初始化） */
    addCaps: null as CapsDraft | null,
    // 模型能力编辑
    editingModelKey: null as string | null,
    editingProviderKey: "" as string,
    editDraft: null as CapsDraft | null,
    editSaving: false,
    // Kimi OAuth / 用量
    oauthLoggedIn: false,
    oauthLoading: false,
    oauthSuccess: false,
    oauthNoMembership: false,
    pendingOAuthToken: null as string | null,
    usageData: null as any,
    usageLoading: false,
    // fallback 添加
    fallbackAddKey: "",
    // per-agent 映射
    agents: [] as AgentRow[],
    agentsLoaded: false,
    // R9 自定义分组（localStorage 持久化，纯展示层）
    org: emptyModelOrg() as ModelOrgState,
    orgLoaded: false,
    orgGroupDraft: "",
    orgRenaming: null as string | null,
    orgRenameDraft: "",
    assignMenuFor: null as string | null,
    // 模型过滤
    filterQuery: "",
  };
}

const s = createProviderState();

function resetProviderState() {
  Object.assign(s, createProviderState());
}

/* ── helpers ── */

function isKimiCodeAdd(): boolean {
  return s.addProvider === "moonshot" && s.addSubPlatform === "kimi-code";
}

/** 添加流程当前选择对应的 config provider key 与端点（纯函数在 tab-provider.lib.ts） */
function currentAddSelection(): AddSelection {
  return {
    provider: s.addProvider,
    subPlatform: s.addSubPlatform,
    customPreset: s.addCustomPreset,
    baseUrl: s.addBaseUrl,
    apiType: s.addApiType,
  };
}

function resolveAddTarget() {
  return resolveAddTargetFor(currentAddSelection());
}

/** 添加流程的模型下拉选项（动态目录；kimi-code 兜底固定模型；手动 custom 无目录） */
function getAddModelOptions(): string[] {
  const target = resolveAddTarget();
  if (!target?.catalogProvider) return [];
  const catalog = getCachedGatewayModels()?.[target.catalogProvider];
  if (catalog?.length) return catalog;
  if (target.catalogProvider === "kimi-coding") return [KIMI_CODE_FIXED_MODEL];
  return [];
}

function getAddModelId(): string {
  if (s.addShowCustomModelInput) return s.addCustomModelId.trim();
  return s.addModelId || s.addCustomModelId.trim();
}

function allConfiguredKeys(): string[] {
  const snap = getCachedConfigSnapshot();
  if (!snap) return [];
  const keys: string[] = [];
  for (const group of groupProvidersFromConfig(snap.config)) {
    for (const prov of group.providers) {
      for (const m of prov.models) keys.push(m.key);
    }
  }
  return keys;
}

function groupLabel(groupId: ProviderGroupId): string {
  return t(`settings.provider.group.${groupId}`);
}

/* ── 数据加载 ── */

async function refreshSnapshot(state: AppViewState) {
  if (!state.client) return;
  await getConfigSnapshot(state.client, { force: true });
  pruneOrgAgainstConfig();
  // 主应用模型选择器（compose/cron）同步刷新
  try {
    await state.loadConfiguredModels?.();
  } catch {}
}

/** 清理指向已删模型的分组指派（config 为准，org 只是展示层） */
function pruneOrgAgainstConfig() {
  const keys = allConfiguredKeys();
  const pruned = pruneModelOrgAssignments(s.org, keys);
  if (pruned !== s.org) {
    s.org = pruned;
    saveModelOrg(pruned);
  }
}

async function init(state: AppViewState) {
  if (s.initialized) return;
  s.initialized = true;
  s.loading = true;
  if (!s.orgLoaded) {
    s.org = loadModelOrg();
    s.orgLoaded = true;
  }
  state.requestUpdate();
  try {
    if (state.client && state.connected) {
      await getConfigSnapshot(state.client);
      pruneOrgAgainstConfig();
      void loadGatewayModels(state.client).then(catalog => {
        if (catalog) state.requestUpdate();
      });
    }
    await checkOAuthStatus(state);
  } finally {
    s.loading = false;
    state.requestUpdate();
  }
}

async function loadAgents(state: AppViewState) {
  if (s.agentsLoaded || !state.client || !state.connected) return;
  try {
    const res = await state.client.request<any>("agents.list", {});
    const rows: AgentRow[] = [];
    for (const entry of res?.agents ?? []) {
      const id = typeof entry?.id === "string" ? entry.id : "";
      if (!id) continue;
      const label =
        (typeof entry?.identity?.name === "string" && entry.identity.name) ||
        (typeof entry?.name === "string" && entry.name) ||
        id;
      rows.push({
        id,
        label,
        modelPrimary: typeof entry?.model?.primary === "string" ? entry.model.primary : "",
      });
    }
    s.agents = rows;
    s.agentsLoaded = true;
    state.requestUpdate();
  } catch {
    /* agents.list 失败时隐藏映射表 */
  }
}

/* ── patch 执行封装 ── */

async function runPatch(
  state: AppViewState,
  mutator: (draft: Record<string, unknown>) => void,
  opts?: { replacePaths?: string[] },
): Promise<boolean> {
  if (!state.client || s.busy) return false;
  s.busy = true;
  s.error = null;
  s.successMsg = null;
  s.restartHint = null;
  state.requestUpdate();
  try {
    const result: ConfigPatchResult = await patchConfig(state.client, mutator, opts);
    if (!result.ok) {
      s.error = result.error ?? t("setup.error.connection");
      return false;
    }
    await refreshSnapshot(state);
    s.successMsg = t("settings.saved");
    if (result.restartScheduled) {
      s.restartHint = t("settings.patch.restartScheduled");
    } else if (result.requiresRestart) {
      s.restartHint = t("settings.patch.restartRequired");
    } else if (!result.noop) {
      s.restartHint = t("settings.patch.appliedHot");
    }
    return true;
  } finally {
    s.busy = false;
    state.requestUpdate();
  }
}

/* ── 模型操作 ── */

async function handleSetDefault(modelKey: string, state: AppViewState) {
  await runPatch(state, draft => {
    const agents = (draft.agents ??= {}) as Record<string, any>;
    const defaults = (agents.defaults ??= {}) as Record<string, any>;
    const model = (defaults.model ??= {}) as Record<string, any>;
    model.primary = modelKey;
  });
}

async function handleDeleteModel(prov: GroupedProvider, entry: ProviderModelEntry, state: AppViewState) {
  if (entry.isDefault) {
    s.error = t("settings.provider.cannotDeleteDefault");
    state.requestUpdate();
    return;
  }
  if (!(await showConfirm(state, t("settings.provider.deleteConfirm"), { danger: true }))) return;
  await runPatch(state, draft => {
    const providers = (draft.models as any)?.providers ?? {};
    const target = providers[prov.providerKey];
    if (!target || !Array.isArray(target.models)) return;
    target.models = target.models.filter((m: any) => (typeof m === "string" ? m : m?.id) !== entry.id);
    if (target.models.length === 0) {
      delete providers[prov.providerKey];
    }
    // 同步从 fallbacks 移除
    const fallbacks = (draft.agents as any)?.defaults?.model?.fallbacks;
    if (Array.isArray(fallbacks)) {
      const next = fallbacks.filter((k: unknown) => k !== entry.key);
      (draft.agents as any).defaults.model.fallbacks = next;
    }
  });
}

async function handleDeleteProvider(prov: GroupedProvider, state: AppViewState) {
  const hasDefault = prov.models.some(m => m.isDefault);
  if (hasDefault) {
    s.error = t("settings.provider.cannotDeleteDefault");
    state.requestUpdate();
    return;
  }
  if (!(await showConfirm(state, t("settings.provider.deleteProviderConfirm"), { danger: true }))) return;
  const removedKeys = new Set(prov.models.map(m => m.key));
  await runPatch(state, draft => {
    const providers = (draft.models as any)?.providers ?? {};
    delete providers[prov.providerKey];
    const model = (draft.agents as any)?.defaults?.model;
    if (Array.isArray(model?.fallbacks)) {
      model.fallbacks = model.fallbacks.filter((k: unknown) => typeof k !== "string" || !removedKeys.has(k));
    }
  });
}

function startAliasEdit(entry: ProviderModelEntry, state: AppViewState) {
  s.aliasEditing = entry.key;
  s.aliasDraft = entry.name !== entry.id ? entry.name : "";
  state.requestUpdate();
}

async function handleAliasSave(prov: GroupedProvider, entry: ProviderModelEntry, state: AppViewState) {
  const alias = s.aliasDraft.trim();
  s.aliasEditing = null;
  await runPatch(state, draft => {
    const models = (draft.models as any)?.providers?.[prov.providerKey]?.models;
    if (!Array.isArray(models)) return;
    const idx = models.findIndex((m: any) => (typeof m === "string" ? m : m?.id) === entry.id);
    if (idx < 0) return;
    let target = models[idx];
    if (typeof target === "string") {
      target = { id: target, name: target, input: ["text"] };
      models[idx] = target;
    }
    // name 是内核 schema 必填字段，空别名回退到 id
    target.name = alias || target.id;
  });
}

/* ── provider 密钥编辑 ── */

function startKeyEdit(prov: GroupedProvider, state: AppViewState) {
  s.keyEditing = prov.providerKey;
  s.keyDraft = "";
  state.requestUpdate();
}

async function handleKeySave(prov: GroupedProvider, state: AppViewState) {
  const apiKey = s.keyDraft.trim();
  if (!apiKey) {
    s.keyEditing = null;
    state.requestUpdate();
    return;
  }
  const isKimiCoding = prov.providerKey === "kimi-coding";
  // verify 参数映射回 UI provider/preset（verifyProvider 只识别五大 UI provider）
  const presetKey = Object.keys(CUSTOM_PRESETS).find(k => CUSTOM_PRESETS[k].providerKey === prov.providerKey);
  const verifyParams: Record<string, unknown> = { apiKey, modelID: prov.models[0]?.id ?? "" };
  if (isKimiCoding) {
    verifyParams.provider = "moonshot";
    verifyParams.subPlatform = "kimi-code";
  } else if (prov.providerKey === "moonshot") {
    verifyParams.provider = "moonshot";
    verifyParams.subPlatform = "moonshot-cn";
  } else if (PROVIDERS[prov.providerKey]) {
    verifyParams.provider = prov.providerKey;
  } else if (presetKey) {
    verifyParams.provider = "custom";
    verifyParams.customPreset = presetKey;
  } else {
    verifyParams.provider = "custom";
    verifyParams.baseURL = prov.baseUrl;
    verifyParams.apiType = prov.api;
  }
  // 先真实 HTTP 验证（保留主进程 IPC）
  const verifyResult = await ipc.settingsVerifyKey(verifyParams);
  if (!verifyResult.success) {
    s.error = verifyResult.message ?? (verifyResult as any).error ?? t("setup.error.verifyFailed");
    state.requestUpdate();
    return;
  }
  if (isKimiCoding) {
    // 真实 key 写 sidecar + 注入代理；config 只写占位符
    const sidecar = await ipc.settingsWriteKimiApiKey({ apiKey });
    const proxyPort = sidecar?.proxyPort ?? 0;
    if (proxyPort <= 0) {
      s.error = t("setup.error.connection");
      state.requestUpdate();
      return;
    }
    const ok = await runPatch(state, draft => {
      const providers = (draft.models as any)?.providers ?? {};
      const target = providers["kimi-coding"];
      if (!target) return;
      target.apiKey = "proxy-managed";
      target.baseUrl = `http://127.0.0.1:${proxyPort}/coding`;
      applyKimiCodeLinkage(draft, proxyPort);
    });
    if (ok) s.keyEditing = null;
    return;
  }
  const ok = await runPatch(state, draft => {
    const providers = (draft.models as any)?.providers ?? {};
    const target = providers[prov.providerKey];
    if (!target) return;
    target.apiKey = apiKey;
  });
  if (ok) s.keyEditing = null;
}

/* ── 拖拽排序 ── */

function onDragStart(drag: DragRef, e: DragEvent, state: AppViewState) {
  s.drag = drag;
  e.dataTransfer?.setData("text/plain", drag.id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  state.requestUpdate();
}

function onCardDragOver(kind: "model" | "fallback" | "org-group", id: string, e: DragEvent, state: AppViewState) {
  if (!s.drag || s.drag.kind !== kind || s.drag.id === id) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const position = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
  const next: DropTarget = { kind, id, position };
  if (s.dropTarget?.id !== next.id || s.dropTarget?.position !== next.position || s.dropTarget?.kind !== kind) {
    s.dropTarget = next;
    state.requestUpdate();
  }
}

function onDragEnd(state: AppViewState) {
  s.drag = null;
  s.dropTarget = null;
  state.requestUpdate();
}

async function handleModelDrop(prov: GroupedProvider, state: AppViewState) {
  const drag = s.drag;
  const target = s.dropTarget;
  onDragEnd(state);
  if (!drag || drag.kind !== "model" || !target || target.kind !== "model") return;
  if (drag.providerKey !== prov.providerKey) return; // 仅组内排序
  const ids = prov.models.map(m => m.id);
  const nextIds = reorderIds(ids, drag.id, target.id, target.position);
  if (nextIds === ids) return;
  await runPatch(state, draft => {
    const models = (draft.models as any)?.providers?.[prov.providerKey]?.models;
    if (!Array.isArray(models)) return;
    const idOf = (m: any) => (typeof m === "string" ? m : m?.id ?? "");
    const reordered = applyIdOrder(models, nextIds, idOf);
    models.length = 0;
    models.push(...reordered);
  }, { replacePaths: [`models.providers.${prov.providerKey}.models`] });
}

async function handleFallbackDrop(state: AppViewState) {
  const drag = s.drag;
  const target = s.dropTarget;
  onDragEnd(state);
  if (!drag || drag.kind !== "fallback" || !target || target.kind !== "fallback") return;
  const snap = getCachedConfigSnapshot();
  const ids = readFallbacks(snap?.config);
  const nextIds = reorderIds(ids, drag.id, target.id, target.position);
  if (nextIds === ids) return;
  await runPatch(state, draft => {
    const model = ((draft.agents as any).defaults ??= {}).model ??= {};
    model.fallbacks = nextIds;
  }, { replacePaths: ["agents.defaults.model.fallbacks"] });
}

/* ── 自定义分组（R9，localStorage 展示层） ── */

/** org 变更统一入口：更新内存态 + 落盘 + 触发重渲染（含 compose/cron 选择器） */
function commitOrg(next: ModelOrgState, state: AppViewState) {
  s.org = next;
  saveModelOrg(next);
  state.requestUpdate();
}

function handleOrgAdd(state: AppViewState) {
  const name = s.orgGroupDraft.trim();
  if (!name) return;
  const { org } = addOrgGroup(s.org, name, generateOrgGroupId());
  s.orgGroupDraft = "";
  commitOrg(org, state);
}

function startOrgRename(groupId: string, state: AppViewState) {
  const group = s.org.groups.find(g => g.id === groupId);
  s.orgRenaming = groupId;
  s.orgRenameDraft = group?.name ?? "";
  s.assignMenuFor = null;
  state.requestUpdate();
}

function handleOrgRenameSave(state: AppViewState) {
  const id = s.orgRenaming;
  const name = s.orgRenameDraft;
  s.orgRenaming = null;
  if (!id) { state.requestUpdate(); return; }
  commitOrg(renameOrgGroup(s.org, id, name), state);
}

function handleOrgRemove(groupId: string, state: AppViewState) {
  commitOrg(removeOrgGroup(s.org, groupId), state);
}

function handleOrgGroupDrop(state: AppViewState) {
  const drag = s.drag;
  const target = s.dropTarget;
  onDragEnd(state);
  if (!drag || drag.kind !== "org-group" || !target || target.kind !== "org-group") return;
  commitOrg(reorderOrgGroups(s.org, drag.id, target.id, target.position), state);
}

function toggleAssignMenu(modelKey: string, state: AppViewState) {
  s.assignMenuFor = s.assignMenuFor === modelKey ? null : modelKey;
  state.requestUpdate();
}

function handleAssign(modelKey: string, groupId: string | null, state: AppViewState) {
  s.assignMenuFor = null;
  commitOrg(assignModelToGroup(s.org, modelKey, groupId), state);
}

/** 模型是否命中过滤词（名称 / id / key，忽略大小写） */
function modelMatchesFilter(entry: ProviderModelEntry, prov: GroupedProvider): boolean {
  const q = s.filterQuery.trim().toLowerCase();
  if (!q) return true;
  return (
    entry.name.toLowerCase().includes(q) ||
    entry.id.toLowerCase().includes(q) ||
    entry.key.toLowerCase().includes(q) ||
    prov.displayName.toLowerCase().includes(q)
  );
}

/* ── fallback 模型 ── */

async function handleFallbackAdd(state: AppViewState) {
  const key = s.fallbackAddKey;
  if (!key) return;
  s.fallbackAddKey = "";
  await runPatch(state, draft => {
    const model = ((draft.agents as any).defaults ??= {}).model ??= {};
    const list = Array.isArray(model.fallbacks) ? model.fallbacks : [];
    if (list.includes(key)) return;
    model.fallbacks = [...list, key];
  });
}

async function handleFallbackRemove(key: string, state: AppViewState) {
  await runPatch(state, draft => {
    const model = (draft.agents as any)?.defaults?.model;
    if (!Array.isArray(model?.fallbacks)) return;
    model.fallbacks = model.fallbacks.filter((k: unknown) => k !== key);
  });
}

/* ── per-agent 模型 ── */

async function handleAgentModelChange(agentId: string, modelKey: string, state: AppViewState) {
  if (!state.client || !modelKey) return;
  s.error = null;
  try {
    await state.client.request("agents.update", { agentId, model: modelKey });
    const row = s.agents.find(a => a.id === agentId);
    if (row) row.modelPrimary = modelKey;
    s.successMsg = t("settings.saved");
  } catch (err: any) {
    s.error = err?.message ?? String(err);
  }
  state.requestUpdate();
}

/* ── 添加流程 ── */

function toggleAddPanel(state: AppViewState) {
  s.addOpen = !s.addOpen;
  s.error = null;
  s.successMsg = null;
  if (!s.addOpen) {
    s.addToProviderKey = null;
    s.addCaps = null;
  }
  if (s.addOpen) {
    const options = getAddModelOptions();
    if (!s.addModelId && options.length) s.addModelId = options[0];
  }
  state.requestUpdate();
}

/* ── 分组追加模式（复用 provider 端点与密钥） ── */

/** provider key → 动态目录 key（目录里存在才用；kimi-coding 有固定兜底模型） */
function catalogProviderForKey(providerKey: string): string | null {
  const catalog = getCachedGatewayModels();
  if (catalog?.[providerKey]?.length) return providerKey;
  if (providerKey === "kimi-coding") return "kimi-coding";
  return null;
}

function getGroupAddModelOptions(providerKey: string): string[] {
  const cp = catalogProviderForKey(providerKey);
  if (!cp) return [];
  const catalog = getCachedGatewayModels()?.[cp];
  if (catalog?.length) return catalog;
  if (cp === "kimi-coding") return [KIMI_CODE_FIXED_MODEL];
  return [];
}

function emptyCapsDraft(): CapsDraft {
  return { contextWindow: "", contextTokens: "", maxTokens: "", image: false, video: false, audio: false, reasoning: false, thinkingLevels: [] };
}

/** 追加模式下选中模型后，从目录初始化能力草稿（用户未改动则与目录一致） */
function initAddCapsFromCatalog(providerKey: string, modelId: string) {
  const cp = catalogProviderForKey(providerKey);
  const cat = cp ? getCachedGatewayModelEntries()?.[cp]?.find((m) => m.id === modelId) : undefined;
  const draft = emptyCapsDraft();
  if (cat) {
    draft.image = Array.isArray(cat.input) ? cat.input.includes("image") : false;
    draft.video = Array.isArray(cat.input) ? cat.input.includes("video") : false;
    draft.audio = Array.isArray(cat.input) ? cat.input.includes("audio") : false;
    draft.reasoning = cat.reasoning === true;
    draft.contextWindow = typeof cat.contextWindow === "number" ? String(cat.contextWindow) : "";
    const efforts = (cat as any)?.compat?.supportedReasoningEfforts;
    if (Array.isArray(efforts)) {
      draft.thinkingLevels = efforts.filter((e: unknown): e is string => typeof e === "string" && e !== "off");
    }
  }
  s.addCaps = draft;
}

function startAddToGroup(prov: GroupedProvider, state: AppViewState) {
  s.addToProviderKey = prov.providerKey;
  s.addOpen = true;
  s.error = null;
  s.successMsg = null;
  s.addModelId = "";
  s.addCustomModelId = "";
  s.addShowCustomModelInput = false;
  s.addAlias = "";
  const options = getGroupAddModelOptions(prov.providerKey);
  if (options.length) {
    s.addModelId = options[0];
    initAddCapsFromCatalog(prov.providerKey, options[0]);
  } else {
    s.addShowCustomModelInput = true;
    s.addCaps = emptyCapsDraft();
  }
  state.requestUpdate();
}

/** 由能力草稿构造 overrides；forAdd=true 时空白字段=不触碰（跟随目录），否则=删除（继承/回默认） */
function buildOverridesFromCaps(caps: CapsDraft, forAdd: boolean) {
  const num = (raw: string) => {
    const v = raw.trim();
    if (!v) return forAdd ? undefined : null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : forAdd ? undefined : null;
  };
  return {
    contextWindow: num(caps.contextWindow),
    contextTokens: num(caps.contextTokens),
    maxTokens: num(caps.maxTokens),
    modalities: { image: caps.image, video: caps.video, audio: caps.audio },
    reasoning: caps.reasoning,
    thinkingLevels: caps.reasoning ? caps.thinkingLevels : [],
  };
}

async function handleAddToGroupSave(state: AppViewState) {
  if (s.saving || s.busy) return;
  const providerKey = s.addToProviderKey;
  if (!providerKey) return;
  const modelId = getAddModelId();
  if (!modelId) {
    s.error = t("setup.error.noModelId");
    state.requestUpdate();
    return;
  }
  const snap = getCachedConfigSnapshot();
  const existingProv = (snap?.config?.models as any)?.providers?.[providerKey];
  const hasModel = Array.isArray(existingProv?.models) && existingProv.models.some((m: any) => (typeof m === "string" ? m : m?.id) === modelId);
  if (hasModel) {
    s.error = t("settings.provider.modelExists");
    state.requestUpdate();
    return;
  }

  s.saving = true;
  s.error = null;
  state.requestUpdate();
  try {
    const catalogProvider = catalogProviderForKey(providerKey);
    const supportsImage = catalogModelSupportsImage(catalogProvider ?? providerKey, modelId) ?? s.addCaps?.image ?? false;
    const entry = buildModelEntry(
      catalogProvider, modelId, s.addAlias.trim(), supportsImage,
      s.addCaps ? buildOverridesFromCaps(s.addCaps, true) : undefined,
    );
    const hasPrimary = !!(snap?.config?.agents as any)?.defaults?.model?.primary;
    const ok = await runPatch(state, draft => {
      const providers = ((draft.models ??= {}) as any).providers ??= {};
      const prov = (providers[providerKey] ??= { models: [] });
      if (!Array.isArray(prov.models)) prov.models = [];
      prov.models.push(entry);
      if (!hasPrimary) {
        (((draft.agents ??= {}) as any).defaults ??= {}).model ??= {};
        (draft.agents as any).defaults.model.primary = `${providerKey}/${modelId}`;
      }
    });
    if (ok) {
      s.addToProviderKey = null;
      s.addCaps = null;
      closeAddPanelAfterSave(state);
    }
  } finally {
    s.saving = false;
    state.requestUpdate();
  }
}

/* ── 模型能力编辑 ── */

function startModelEdit(prov: GroupedProvider, entry: ProviderModelEntry, state: AppViewState) {
  const snap = getCachedConfigSnapshot();
  const rawModels = (snap?.config?.models as any)?.providers?.[prov.providerKey]?.models;
  const raw = Array.isArray(rawModels)
    ? rawModels.find((m: any) => (typeof m === "string" ? m : m?.id) === entry.id)
    : undefined;
  s.editingModelKey = entry.key;
  s.editingProviderKey = prov.providerKey;
  s.editDraft = deriveOverridesFromEntry(raw);
  s.error = null;
  state.requestUpdate();
}

function cancelModelEdit(state: AppViewState) {
  s.editingModelKey = null;
  s.editDraft = null;
  state.requestUpdate();
}

async function handleModelEditSave(entry: ProviderModelEntry, state: AppViewState) {
  if (s.editSaving || s.busy || !s.editDraft) return;
  const providerKey = s.editingProviderKey;
  const overrides = buildOverridesFromCaps(s.editDraft, false);
  s.editSaving = true;
  s.error = null;
  state.requestUpdate();
  try {
    const ok = await runPatch(state, draft => {
      const models = (draft.models as any)?.providers?.[providerKey]?.models;
      if (!Array.isArray(models)) return;
      const idx = models.findIndex((m: any) => (typeof m === "string" ? m : m?.id) === entry.id);
      if (idx < 0) return;
      const raw = models[idx];
      // 裸字符串 entry 升格为对象（内核 schema 要求 {id,name}，顺带修复）
      const base = typeof raw === "string" ? { id: raw, name: entry.name || raw } : { ...raw };
      if (!base.name) base.name = entry.name || entry.id;
      models[idx] = applyCapabilityOverrides(base, overrides);
    });
    if (ok) {
      s.editingModelKey = null;
      s.editDraft = null;
    }
  } finally {
    s.editSaving = false;
    state.requestUpdate();
  }
}

function onAddProviderChange(provider: string, state: AppViewState) {
  s.addProvider = provider;
  s.addCustomPreset = "";
  s.addApiKey = "";
  s.addModelId = "";
  s.addCustomModelId = "";
  s.addShowCustomModelInput = false;
  s.addBaseUrl = "";
  s.error = null;
  if (provider === "moonshot") s.addSubPlatform = "kimi-code";
  const options = getAddModelOptions();
  if (options.length) s.addModelId = options[0];
  state.requestUpdate();
}

async function handleAddSave(state: AppViewState) {
  if (s.saving || s.busy) return;
  const target = resolveAddTarget();
  if (!target) return;
  const modelId = getAddModelId();
  if (!modelId) {
    s.error = t("setup.error.noModelId");
    state.requestUpdate();
    return;
  }
  if (s.addProvider === "custom" && !s.addCustomPreset) {
    if (!target.baseUrl) {
      s.error = t("setup.error.noBaseUrl");
      state.requestUpdate();
      return;
    }
    if (!isValidHttpBaseUrl(target.baseUrl)) {
      s.error = t("settings.provider.invalidBaseUrl");
      state.requestUpdate();
      return;
    }
  }

  const isKimiCode = isKimiCodeAdd();
  const snap = getCachedConfigSnapshot();
  const existingProv = (snap?.config?.models as any)?.providers?.[target.providerKey];
  const hasModel = Array.isArray(existingProv?.models) && existingProv.models.some((m: any) => (typeof m === "string" ? m : m?.id) === modelId);
  if (hasModel) {
    s.error = t("settings.provider.modelExists");
    state.requestUpdate();
    return;
  }

  let apiKey = s.addApiKey.trim();
  if (isKimiCode && s.pendingOAuthToken) apiKey = s.pendingOAuthToken;
  // kimi-code 已登录且未提供新 key：沿用代理现有 token，跳过 verify 与 sidecar 写入
  const keepProxyAuth = isKimiCode && !apiKey && s.oauthLoggedIn;
  const reuseExistingKey = !apiKey && !!existingProv?.apiKey;
  if (!apiKey && !keepProxyAuth && !reuseExistingKey) {
    s.error = t("setup.error.noKey");
    state.requestUpdate();
    return;
  }

  s.saving = true;
  s.error = null;
  state.requestUpdate();

  try {
    let supportsImage: boolean | undefined;
    if (apiKey) {
      const verifyParams: Record<string, unknown> = {
        provider: s.addProvider,
        apiKey,
        modelID: modelId,
        subPlatform: s.addProvider === "moonshot" ? s.addSubPlatform : "",
        customPreset: s.addCustomPreset,
      };
      if (s.addProvider === "custom" && !s.addCustomPreset) {
        verifyParams.baseURL = target.baseUrl;
        verifyParams.apiType = s.addApiType;
      }
      if (isKimiCode) verifyParams.verifyViaProxy = true;
      const verifyResult = await ipc.settingsVerifyKey(verifyParams);
      if (!verifyResult.success) {
        const errMsg = verifyResult.message ?? (verifyResult as any).error ?? "";
        if (isKimiCode && s.pendingOAuthToken && errMsg.includes("401")) {
          s.pendingOAuthToken = null;
          try { await ipc.kimiOAuthLogout(); } catch {}
          s.oauthNoMembership = true;
          return;
        }
        s.error = errMsg || t("setup.error.verifyFailed");
        return;
      }
      supportsImage = verifyResult.supportsImage;
    }
    // 探测不确定时回退到 models.list 目录的 input 能力
    if (supportsImage === undefined) {
      supportsImage = catalogModelSupportsImage(target.catalogProvider ?? target.providerKey, modelId) ?? false;
    }

    const alias = s.addAlias.trim();
    const entry = buildModelEntry(target.catalogProvider, modelId, alias, supportsImage);
    const hasPrimary = !!(snap?.config?.agents as any)?.defaults?.model?.primary;

    if (isKimiCode && apiKey) {
      // 真实 key 写 sidecar + 注入代理；config 只写占位符
      const sidecar = await ipc.settingsWriteKimiApiKey({ apiKey });
      const proxyPort = sidecar?.proxyPort ?? 0;
      if (proxyPort <= 0) {
        s.error = t("setup.error.connection");
        return;
      }
      const ok = await runPatch(state, draft => {
        const providers = ((draft.models ??= {}) as any).providers ??= {};
        const prov = (providers["kimi-coding"] ??= { models: [] });
        prov.apiKey = "proxy-managed";
        prov.baseUrl = `http://127.0.0.1:${proxyPort}/coding`;
        prov.api = "anthropic-messages";
        if (!Array.isArray(prov.models)) prov.models = [];
        prov.models.push(entry);
        if (!hasPrimary) {
          (((draft.agents ??= {}) as any).defaults ??= {}).model ??= {};
          (draft.agents as any).defaults.model.primary = `kimi-coding/${modelId}`;
        }
        applyKimiCodeLinkage(draft, proxyPort);
      });
      if (ok) {
        s.pendingOAuthToken = null;
        closeAddPanelAfterSave(state);
      }
      return;
    }

    const ok = await runPatch(state, draft => {
      const providers = ((draft.models ??= {}) as any).providers ??= {};
      if (!providers[target.providerKey]) {
        providers[target.providerKey] = {
          apiKey: apiKey || "",
          baseUrl: target.baseUrl,
          api: target.api,
          models: [],
        };
      }
      const prov = providers[target.providerKey];
      // 提供了新 key 才覆写；否则保留原 key
      if (apiKey) prov.apiKey = apiKey;
      if (!prov.baseUrl && target.baseUrl) prov.baseUrl = target.baseUrl;
      if (!prov.api && target.api) prov.api = target.api;
      if (!Array.isArray(prov.models)) prov.models = [];
      prov.models.push(entry);
      if (!hasPrimary) {
        (((draft.agents ??= {}) as any).defaults ??= {}).model ??= {};
        (draft.agents as any).defaults.model.primary = `${target.providerKey}/${modelId}`;
      }
    });
    if (ok) closeAddPanelAfterSave(state);
  } finally {
    s.saving = false;
    state.requestUpdate();
  }
}

function closeAddPanelAfterSave(state: AppViewState) {
  s.addOpen = false;
  s.addApiKey = "";
  s.addAlias = "";
  s.addCustomModelId = "";
  s.addShowCustomModelInput = false;
  state.requestUpdate();
}

/* ── Kimi OAuth ── */

async function handleOAuthLogin(state: AppViewState) {
  if (s.oauthLoading) return;
  s.oauthLoading = true;
  s.oauthSuccess = false;
  s.oauthNoMembership = false;
  s.error = null;
  state.requestUpdate();
  try {
    const result = await ipc.kimiOAuthLogin();
    if (!result.success) {
      s.error = result.message ?? t("setup.error.verifyFailed");
      s.oauthLoading = false;
      state.requestUpdate();
      return;
    }
    s.pendingOAuthToken = result.accessToken ?? null;
    s.oauthLoading = false;
    s.oauthSuccess = true;
    s.oauthLoggedIn = true;
    state.requestUpdate();
  } catch (e: any) {
    s.error = t("setup.error.connection") + (e?.message ?? "");
    s.oauthLoading = false;
    state.requestUpdate();
  }
}

async function handleOAuthLogout(state: AppViewState) {
  try { await ipc.kimiOAuthLogout(); } catch {}
  s.pendingOAuthToken = null;
  s.oauthLoggedIn = false;
  s.oauthSuccess = false;
  s.usageData = null;
  state.requestUpdate();
}

async function handleOAuthCancel(state: AppViewState) {
  try { await ipc.kimiOAuthCancel(); } catch {}
  s.oauthLoading = false;
  state.requestUpdate();
}

async function checkOAuthStatus(state: AppViewState) {
  try {
    const result = await ipc.kimiOAuthStatus();
    s.oauthLoggedIn = result.loggedIn ?? false;
    if (s.oauthLoggedIn) await loadUsage(state);
    state.requestUpdate();
  } catch {}
}

async function loadUsage(state: AppViewState) {
  if (s.usageLoading) return;
  s.usageLoading = true;
  state.requestUpdate();
  try {
    const result = await ipc.kimiGetUsage();
    if (result?.data) s.usageData = result.data;
  } catch {
    // 刷新失败保留既有数据
  } finally {
    s.usageLoading = false;
    state.requestUpdate();
  }
}

/* ── render ── */

export function resetProviderTab() { resetProviderState(); }

export function renderTabProvider(state: AppViewState) {
  if (!s.initialized) init(state);
  const snap = getCachedConfigSnapshot();
  const groups = snap ? groupProvidersFromConfig(snap.config) : [];
  const fallbacks = snap ? readFallbacks(snap.config) : [];
  const fallbackRank = new Map(fallbacks.map((key, index) => [key, index + 1]));
  const defaultEntry = groups.flatMap(g => g.providers).flatMap(p => p.models).find(m => m.isDefault);
  const totalModels = groups.reduce((sum, g) => sum + g.providers.reduce((n, p) => n + p.models.length, 0), 0);

  return html`
    <div class="oc-settings__section">
      <div class="oc-provider-header">
        <div>
          <h2 class="oc-settings__section-title">${t("settings.provider.title")}</h2>
          <p class="oc-settings__hint">${t("settings.provider.desc")}</p>
        </div>
        <button class="oc-settings__btn oc-settings__btn--primary" @click=${() => toggleAddPanel(state)}>
          ${s.addOpen ? t("settings.provider.cancelAdd") : `+ ${t("settings.provider.addModel")}`}
        </button>
      </div>

      ${defaultEntry ? html`
        <div class="oc-provider-status">${t("settings.provider.currentUsing")}${defaultEntry.name} <span class="oc-provider-status__key">${defaultEntry.key}</span></div>
      ` : nothing}

      ${s.loading && !snap ? html`<div class="oc-provider-loading">${t("settings.loading")}</div>` : nothing}

      ${s.addOpen ? renderAddPanel(state) : nothing}

      ${!snap && !s.loading ? html`
        <div class="cc-alert cc-alert--warn">${t("settings.provider.configUnavailable")}</div>
      ` : nothing}

      ${snap ? renderOrgManager(state) : nothing}

      ${totalModels > 0 ? html`
        <div class="oc-provider-filter">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input class="oc-provider-filter__input" .value=${s.filterQuery} placeholder=${t("settings.provider.filterPlaceholder")}
            @input=${(e: Event) => { s.filterQuery = (e.target as HTMLInputElement).value; state.requestUpdate(); }} />
        </div>
      ` : nothing}

      ${groups.map(group => renderGroup(group, state, fallbackRank))}

      ${snap ? renderFallbacks(state, fallbacks) : nothing}
      ${snap ? renderAgentMapping(state) : nothing}

      <oc-message-box .message=${s.error ?? ""} .type=${"error"} .visible=${!!s.error}></oc-message-box>
      <oc-message-box .message=${s.successMsg ?? ""} .type=${"success"} .visible=${!!s.successMsg}></oc-message-box>
      ${s.restartHint ? html`<div class="oc-provider-restart-hint">${s.restartHint}</div>` : nothing}
    </div>
  `;
}

/* ── 自定义分组管理区 ── */

function renderOrgManager(state: AppViewState) {
  const modelCountOf = (groupId: string) =>
    Object.values(s.org.assignments).filter(g => g === groupId).length;
  return html`
    <div class="oc-provider-org">
      <div class="oc-provider-org__header">
        <h3 class="oc-settings__section-subtitle">${t("settings.provider.customGroups.title")}</h3>
        <p class="oc-settings__hint">${t("settings.provider.customGroups.desc")}</p>
      </div>
      <div class="oc-provider-org__add">
        <input class="oc-settings__input" .value=${s.orgGroupDraft} placeholder=${t("settings.provider.customGroups.placeholder")}
          @input=${(e: Event) => { s.orgGroupDraft = (e.target as HTMLInputElement).value; state.requestUpdate(); }}
          @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") handleOrgAdd(state); }} />
        <button class="oc-settings__btn oc-settings__btn--secondary" ?disabled=${!s.orgGroupDraft.trim()}
          @click=${() => handleOrgAdd(state)}>${t("settings.provider.customGroups.add")}</button>
      </div>
      ${s.org.groups.length === 0 ? html`
        <div class="oc-provider-fallbacks__empty">${t("settings.provider.customGroups.empty")}</div>
      ` : html`
        <div class="oc-provider-org__list">
          ${s.org.groups.map(group => {
            const isDropBefore = s.dropTarget?.kind === "org-group" && s.dropTarget.id === group.id && s.dropTarget.position === "before";
            const isDropAfter = s.dropTarget?.kind === "org-group" && s.dropTarget.id === group.id && s.dropTarget.position === "after";
            const isDragging = s.drag?.kind === "org-group" && s.drag.id === group.id;
            const renaming = s.orgRenaming === group.id;
            return html`
              <div class="oc-provider-org__row ${isDropBefore ? "drop-before" : ""} ${isDropAfter ? "drop-after" : ""} ${isDragging ? "is-dragging" : ""}"
                draggable=${!renaming}
                @dragstart=${(e: DragEvent) => onDragStart({ kind: "org-group", id: group.id }, e, state)}
                @dragover=${(e: DragEvent) => onCardDragOver("org-group", group.id, e, state)}
                @drop=${(e: DragEvent) => { e.preventDefault(); handleOrgGroupDrop(state); }}
                @dragend=${() => onDragEnd(state)}>
                <svg class="oc-provider-card__grip" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>
                ${renaming ? html`
                  <input class="oc-settings__input oc-provider-org__rename" .value=${s.orgRenameDraft}
                    @input=${(e: Event) => { s.orgRenameDraft = (e.target as HTMLInputElement).value; state.requestUpdate(); }}
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.key === "Enter") handleOrgRenameSave(state);
                      if (e.key === "Escape") { s.orgRenaming = null; state.requestUpdate(); }
                    }} />
                  <button class="oc-settings__btn oc-settings__btn--primary" @click=${() => handleOrgRenameSave(state)}>${t("settings.save")}</button>
                ` : html`
                  <span class="oc-provider-org__name">${group.name}</span>
                  <span class="cc-tag">${modelCountOf(group.id)}</span>
                  <span class="oc-provider-block__actions">
                    <button class="oc-provider-list-item__action-btn" data-tooltip=${t("settings.provider.customGroups.rename")}
                      @click=${() => startOrgRename(group.id, state)}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                    </button>
                    <button class="oc-provider-list-item__action-btn oc-provider-list-item__delete-btn" data-tooltip=${t("settings.provider.customGroups.remove")}
                      @click=${() => handleOrgRemove(group.id, state)}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                  </span>
                `}
              </div>
            `;
          })}
        </div>
      `}
    </div>
  `;
}

/* ── 能力编辑器（模型卡片编辑与分组追加共用） ── */

function renderCapsEditor(draft: CapsDraft, state: AppViewState) {
  const numInput = (
    label: string,
    field: "contextWindow" | "contextTokens" | "maxTokens",
    placeholder: string,
  ) => html`
    <div class="oc-settings__form-group">
      <label class="oc-settings__label">${label}</label>
      <input class="oc-settings__input" type="number" min="1" step="1" .value=${draft[field]}
        placeholder=${placeholder}
        @input=${(e: Event) => { draft[field] = (e.target as HTMLInputElement).value.replace(/[^\d]/g, ""); state.requestUpdate(); }} />
    </div>
  `;
  const CONTEXT_PRESETS: Array<[string, number]> = [["128K", 131072], ["256K", 262144], ["512K", 524288], ["1M", 1048576]];
  const capToggle = (label: string, field: "image" | "video" | "audio") => html`
    <oc-toggle-switch .label=${label} .checked=${draft[field]}
      @change=${(e: CustomEvent) => { draft[field] = e.detail.checked; state.requestUpdate(); }}
    ></oc-toggle-switch>
  `;
  return html`
    <div class="oc-caps-editor">
      ${numInput(t("settings.provider.caps.contextWindow"), "contextWindow", t("settings.provider.caps.inheritHint"))}
      <div class="oc-caps-editor__chips">
        ${CONTEXT_PRESETS.map(([label, v]) => html`
          <button class="oc-caps-chip ${draft.contextWindow === String(v) ? "is-active" : ""}"
            @click=${() => { draft.contextWindow = String(v); state.requestUpdate(); }}>${label}</button>
        `)}
      </div>
      ${numInput(t("settings.provider.caps.maxTokens"), "maxTokens", t("settings.provider.caps.inheritHint"))}
      <div class="oc-settings__form-group">
        <label class="oc-settings__label">${t("settings.provider.caps.modalities")}</label>
        <div class="oc-caps-editor__toggles">
          ${capToggle(t("settings.provider.caps.image"), "image")}
          ${capToggle(t("settings.provider.caps.video"), "video")}
          ${capToggle(t("settings.provider.caps.audio"), "audio")}
        </div>
      </div>
      <div class="oc-settings__form-group">
        <oc-toggle-switch .label=${t("settings.provider.caps.reasoning")} .checked=${draft.reasoning}
          @change=${(e: CustomEvent) => { draft.reasoning = e.detail.checked; state.requestUpdate(); }}
        ></oc-toggle-switch>
      </div>
      ${draft.reasoning ? html`
        <div class="oc-settings__form-group">
          <label class="oc-settings__label">${t("settings.provider.caps.thinkingLevels")}</label>
          <div class="oc-caps-editor__chips">
            ${EDITABLE_THINKING_LEVELS.map(lv => html`
              <button class="oc-caps-chip ${draft.thinkingLevels.includes(lv) ? "is-active" : ""}"
                @click=${() => {
                  const i = draft.thinkingLevels.indexOf(lv);
                  if (i >= 0) draft.thinkingLevels.splice(i, 1);
                  else draft.thinkingLevels.push(lv);
                  state.requestUpdate();
                }}>${t(`chat.thinkLevel.${lv}`)}</button>
            `)}
          </div>
          <span class="oc-provider-dynamic-hint">${t("settings.provider.caps.thinkingLevelsHint")}</span>
        </div>
      ` : nothing}
    </div>
  `;
}

function renderModelEditPanel(prov: GroupedProvider, entry: ProviderModelEntry, state: AppViewState) {
  if (!s.editDraft) return nothing;
  return html`
    <div class="oc-provider-edit-panel">
      <div class="oc-provider-edit-panel__title">${t("settings.provider.editModel")} · ${entry.name}</div>
      ${renderCapsEditor(s.editDraft, state)}
      <div class="oc-settings__btn-row">
        <button class="oc-settings__btn oc-settings__btn--secondary" @click=${() => cancelModelEdit(state)}>${t("settings.cancel")}</button>
        <button class="oc-settings__btn oc-settings__btn--primary" ?disabled=${s.editSaving || s.busy}
          @click=${() => handleModelEditSave(entry, state)}>
          ${s.editSaving ? "..." : t("settings.save")}
        </button>
      </div>
    </div>
  `;
}

/* ── 分组渲染 ── */

function renderGroup(group: ProviderGroup, state: AppViewState, fallbackRank: Map<string, number>) {
  const filtering = s.filterQuery.trim() !== "";
  // 过滤时强制展开，确保命中结果可见
  const collapsed = !filtering && s.collapsedGroups.has(group.groupId);
  const count = group.providers.reduce((sum, p) => sum + p.models.length, 0);
  const visibleProviders = filtering
    ? group.providers.filter(prov => prov.models.some(m => modelMatchesFilter(m, prov)))
    : group.providers;
  if (filtering && visibleProviders.length === 0) return nothing;
  // 单 provider 组（无子头）：组头直接挂「新增模型」按钮
  const singleProv = group.providers.length === 1 && group.groupId !== "custom" && group.providers[0].providerKey !== "kimi-coding"
    ? group.providers[0]
    : null;
  return html`
    <div class="oc-provider-group">
      <div class="oc-provider-group__header"
        @click=${() => {
          if (collapsed) s.collapsedGroups.delete(group.groupId);
          else s.collapsedGroups.add(group.groupId);
          state.requestUpdate();
        }}>
        <svg class="oc-provider-group__chevron ${collapsed ? "" : "is-open"}" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        <span class="oc-provider-group__label">${groupLabel(group.groupId)}</span>
        <span class="cc-tag">${count}</span>
        ${singleProv ? html`
          <button class="oc-provider-group__add-btn" data-tooltip=${t("settings.provider.addModelToGroup")}
            @click=${(e: Event) => { e.stopPropagation(); startAddToGroup(singleProv, state); }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            ${t("settings.provider.addModel")}
          </button>
        ` : nothing}
      </div>
      ${collapsed ? nothing : visibleProviders.map(prov => renderProvider(prov, group, state, fallbackRank))}
    </div>
  `;
}

function renderProvider(prov: GroupedProvider, group: ProviderGroup, state: AppViewState, fallbackRank: Map<string, number>) {
  const isKimiCoding = prov.providerKey === "kimi-coding";
  const showSubHeader = group.providers.length > 1 || group.groupId === "custom" || isKimiCoding;
  const visibleModels = prov.models.filter(m => modelMatchesFilter(m, prov));
  if (visibleModels.length === 0) return nothing;
  return html`
    <div class="oc-provider-block">
      ${showSubHeader ? html`
        <div class="oc-provider-block__header">
          <span class="oc-provider-block__name">${isKimiCoding ? t("setup.provider.subPlatform.kimiCode") : prov.displayName}</span>
          <span class="oc-provider-block__key-state ${prov.hasApiKey ? "is-set" : ""}">
            ${prov.hasApiKey ? t("settings.provider.keySet") : t("settings.provider.keyMissing")}
          </span>
          <span class="oc-provider-block__actions">
            <button class="oc-provider-list-item__action-btn" data-tooltip=${t("settings.provider.addModelToGroup")}
              @click=${() => startAddToGroup(prov, state)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            ${!isKimiCoding ? html`
              <button class="oc-provider-list-item__action-btn" data-tooltip=${t("settings.provider.editKey")}
                @click=${() => startKeyEdit(prov, state)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
              </button>
            ` : nothing}
            <button class="oc-provider-list-item__action-btn oc-provider-list-item__delete-btn" data-tooltip=${t("settings.provider.deleteProvider")}
              @click=${() => handleDeleteProvider(prov, state)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </span>
        </div>
      ` : nothing}

      ${isKimiCoding ? renderKimiCodingExtras(prov, state) : nothing}

      ${s.keyEditing === prov.providerKey ? html`
        <div class="oc-provider-key-editor">
          <oc-password-input .value=${s.keyDraft} .placeholder=${t("settings.provider.newKeyPlaceholder")}
            @input=${(e: CustomEvent) => { s.keyDraft = e.detail.value; state.requestUpdate(); }}
          ></oc-password-input>
          <div class="oc-settings__btn-row">
            <button class="oc-settings__btn oc-settings__btn--secondary" @click=${() => { s.keyEditing = null; state.requestUpdate(); }}>${t("settings.cancel")}</button>
            <button class="oc-settings__btn oc-settings__btn--primary" ?disabled=${s.busy} @click=${() => handleKeySave(prov, state)}>${t("settings.save")}</button>
          </div>
        </div>
      ` : nothing}

      <div class="oc-provider-cards">
        ${visibleModels.map(entry => renderModelCard(prov, entry, state, fallbackRank))}
      </div>
    </div>
  `;
}

function renderModelCard(prov: GroupedProvider, entry: ProviderModelEntry, state: AppViewState, fallbackRank: Map<string, number>) {
  const isDropBefore = s.dropTarget?.kind === "model" && s.dropTarget.id === entry.id && s.dropTarget.position === "before";
  const isDropAfter = s.dropTarget?.kind === "model" && s.dropTarget.id === entry.id && s.dropTarget.position === "after";
  const isDragging = s.drag?.kind === "model" && s.drag.id === entry.id && s.drag.providerKey === prov.providerKey;
  const rank = fallbackRank.get(entry.key);
  const assignedGroup = s.org.groups.find(g => g.id === s.org.assignments[entry.key]);
  const menuOpen = s.assignMenuFor === entry.key;
  return html`
    <div class="oc-provider-card ${isDropBefore ? "drop-before" : ""} ${isDropAfter ? "drop-after" : ""} ${isDragging ? "is-dragging" : ""} ${menuOpen ? "has-menu" : ""}"
      draggable="true"
      @dragstart=${(e: DragEvent) => onDragStart({ kind: "model", providerKey: prov.providerKey, id: entry.id }, e, state)}
      @dragover=${(e: DragEvent) => onCardDragOver("model", entry.id, e, state)}
      @drop=${(e: DragEvent) => { e.preventDefault(); handleModelDrop(prov, state); }}
      @dragend=${() => onDragEnd(state)}>
      <svg class="oc-provider-card__grip" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>
      <div class="oc-provider-card__info">
        ${s.aliasEditing === entry.key ? html`
          <div class="oc-provider-card__alias-edit">
            <input class="oc-settings__input" .value=${s.aliasDraft} placeholder=${t("settings.provider.modelAliasPlaceholder")}
              @input=${(e: Event) => { s.aliasDraft = (e.target as HTMLInputElement).value; state.requestUpdate(); }}
              @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") handleAliasSave(prov, entry, state); if (e.key === "Escape") { s.aliasEditing = null; state.requestUpdate(); } }} />
            <button class="oc-settings__btn oc-settings__btn--primary" @click=${() => handleAliasSave(prov, entry, state)}>${t("settings.save")}</button>
          </div>
        ` : html`
          <div class="oc-provider-card__name">${entry.name}</div>
        `}
        <div class="oc-provider-card__meta">
          <span>${entry.id}</span>
          ${entry.isDefault ? html`<span class="cc-tag cc-tag--brand">${t("settings.provider.badge.default")}</span>` : nothing}
          ${rank ? html`<span class="cc-tag">${t("settings.provider.badge.fallback")} ${rank}</span>` : nothing}
          ${entry.supportsImage ? html`<span class="cc-tag">${t("settings.provider.imageTag")}</span>` : nothing}
          ${entry.supportsVideo ? html`<span class="cc-tag">${t("settings.provider.videoTag")}</span>` : nothing}
          ${entry.supportsAudio ? html`<span class="cc-tag">${t("settings.provider.audioTag")}</span>` : nothing}
          ${entry.reasoning ? html`<span class="cc-tag" data-tooltip=${entry.thinkingLevels.length > 0 ? entry.thinkingLevels.join(" / ") : nothing}>${t("settings.provider.reasoningTag")}</span>` : nothing}
          ${entry.contextWindow ? html`<span class="cc-tag">${formatContextWindow(entry.contextWindow)}</span>` : nothing}
        </div>
      </div>
      <div class="oc-provider-card__actions">
        <button class="oc-provider-list-item__action-btn" data-tooltip=${t("settings.provider.editModel")}
          @click=${() => s.editingModelKey === entry.key ? cancelModelEdit(state) : startModelEdit(prov, entry, state)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
        </button>
        <button class="oc-provider-list-item__action-btn ${assignedGroup ? "is-assigned" : ""}"
          data-tooltip=${t("settings.provider.customGroups.assign")}
          @click=${() => toggleAssignMenu(entry.key, state)}>
          ${assignedGroup
            ? html`<span class="oc-provider-card__group-chip">${assignedGroup.name}</span>`
            : html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`}
        </button>
        <button class="oc-provider-list-item__action-btn" data-tooltip=${t("settings.provider.modelAlias")}
          @click=${() => startAliasEdit(entry, state)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </button>
        ${!entry.isDefault ? html`
          <button class="oc-provider-list-item__action-btn oc-provider-list-item__delete-btn" data-tooltip=${t("settings.provider.deleteModel")}
            @click=${() => handleDeleteModel(prov, entry, state)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        ` : nothing}
        <button class="oc-provider-list-item__action-btn ${entry.isDefault ? "is-default" : ""}" ?disabled=${entry.isDefault || s.busy}
          data-tooltip=${t("settings.provider.setDefault")}
          @click=${() => handleSetDefault(entry.key, state)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="${entry.isDefault ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        </button>
      </div>
      ${menuOpen ? html`
        <div class="oc-provider-assign-menu" @click=${(e: Event) => e.stopPropagation()}>
          <div class="oc-provider-assign-menu__title">${t("settings.provider.customGroups.assign")}</div>
          <button class="oc-provider-assign-menu__item ${!assignedGroup ? "is-active" : ""}"
            @click=${() => handleAssign(entry.key, null, state)}>${t("settings.provider.customGroups.none")}</button>
          ${s.org.groups.map(g => html`
            <button class="oc-provider-assign-menu__item ${assignedGroup?.id === g.id ? "is-active" : ""}"
              @click=${() => handleAssign(entry.key, g.id, state)}>${g.name}</button>
          `)}
          ${s.org.groups.length === 0 ? html`
            <div class="oc-provider-assign-menu__empty">${t("settings.provider.customGroups.empty")}</div>
          ` : nothing}
        </div>
      ` : nothing}
      ${s.editingModelKey === entry.key ? renderModelEditPanel(prov, entry, state) : nothing}
    </div>
  `;
}

/* ── kimi-coding 附加区（OAuth + 用量） ── */

function renderKimiCodingExtras(prov: GroupedProvider, state: AppViewState) {
  return html`
    <div class="oc-provider-kimi-extras">
      ${s.oauthLoading ? html`
        <div class="oc-provider-kimi-oauth-row">
          <span class="oc-provider-spinner"></span>
          <span>${t("setup.provider.oauth.waiting")}</span>
          <button class="oc-settings__btn oc-settings__btn--secondary" @click=${() => handleOAuthCancel(state)}>${t("setup.provider.oauth.cancel")}</button>
        </div>
      ` : s.oauthLoggedIn ? html`
        <div class="oc-provider-kimi-oauth-row">
          <span class="oc-provider-kimi-oauth-ok">${t("setup.provider.oauth.success")}</span>
          <button class="oc-settings__btn oc-settings__btn--secondary" @click=${() => handleOAuthLogout(state)}>${t("setup.provider.oauth.logout")}</button>
          <button class="oc-settings__btn oc-settings__btn--secondary" @click=${() => startKeyEdit(prov, state)}>${t("settings.provider.editKey")}</button>
        </div>
      ` : html`
        <div class="oc-provider-kimi-oauth-row">
          <button class="oc-settings__btn oc-settings__btn--primary" @click=${() => handleOAuthLogin(state)}>${t("setup.provider.oauth.login")}</button>
          <button class="oc-settings__btn oc-settings__btn--secondary" @click=${() => startKeyEdit(prov, state)}>${t("settings.provider.editKey")}</button>
        </div>
      `}
      ${s.oauthLoggedIn ? renderUsagePanel(state) : nothing}
    </div>
  `;
}

function renderUsagePanel(state: AppViewState) {
  if (!s.usageData) return nothing;
  const locale = getLocale() === "zh" ? "zh" : "en";
  const labels: UsageLabels = {
    rateFallback: t("settings.provider.usage.rateLimit"),
    hourUsage: t("settings.provider.usage.hourUsage"),
    minuteUsage: t("settings.provider.usage.minuteUsage"),
  };
  const view = deriveUsageView(s.usageData, locale, labels);
  if (!view.week && !view.rate) return nothing;

  const refreshTitle = t("settings.provider.usage.refresh");
  const renderCard = (card: NonNullable<typeof view.week>) => html`
    <div class="oc-provider-usage-card" title=${card.rawText}>
      <div class="oc-provider-usage-title">${card.title || t("settings.provider.usage.weekUsage")}</div>
      <div class="oc-provider-usage-value">${card.pctText}</div>
      <div class="oc-provider-usage-bar"><div class="oc-provider-usage-bar-fill" style="width:${card.pct}%"></div></div>
      ${card.resetText ? html`<div class="oc-provider-usage-reset">${card.resetText}</div>` : nothing}
    </div>
  `;
  const weekCard = view.week
    ? renderCard({ ...view.week, title: t("settings.provider.usage.weekUsage") })
    : nothing;
  const rateCard = view.rate ? renderCard(view.rate) : nothing;

  return html`
    <div class="oc-provider-usage-wrap">
      <div class="oc-provider-usage-toolbar">
        <button
          class="oc-provider-usage-refresh ${s.usageLoading ? "is-loading" : ""}"
          title=${refreshTitle}
          aria-label=${refreshTitle}
          ?disabled=${s.usageLoading}
          @click=${() => loadUsage(state)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
            <path d="M21 3v5h-5"/>
            <path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
            <path d="M3 21v-5h5"/>
          </svg>
        </button>
      </div>
      <div class="oc-provider-usage">
        ${weekCard}
        ${rateCard}
      </div>
    </div>
  `;
}

/* ── 添加面板 ── */

/** 分组追加面板：复用目标 provider 的 baseUrl/api/apiKey，仅选模型 + 别名 + 能力覆盖 */
function renderGroupAddPanel(state: AppViewState) {
  const providerKey = s.addToProviderKey!;
  const options = getGroupAddModelOptions(providerKey);
  if (!s.addCaps) s.addCaps = emptyCapsDraft();

  return html`
    <div class="oc-provider-add-panel">
      <div class="oc-provider-add-panel__title">${t("settings.provider.addModelToGroup")}</div>
      <div class="oc-provider-reuse-notice">
        ${t("settings.provider.reuseGroupConfig")}<span class="oc-provider-reuse-notice__key">${providerKey}</span>
      </div>

      ${options.length > 0 ? html`
        <div class="oc-settings__form-group">
          <label class="oc-settings__label">${t("setup.provider.model")}</label>
          <select class="oc-settings__select" .value=${s.addModelId}
            @change=${(e: Event) => {
              const v = (e.target as HTMLSelectElement).value;
              if (v === CUSTOM_MODEL_SENTINEL) {
                s.addShowCustomModelInput = true;
                s.addModelId = v;
                s.addCaps = emptyCapsDraft();
              } else {
                s.addShowCustomModelInput = false;
                s.addModelId = v;
                s.addCustomModelId = "";
                initAddCapsFromCatalog(providerKey, v);
              }
              state.requestUpdate();
            }}>
            ${options.map(m => html`<option value=${m} ?selected=${s.addModelId === m}>${m}</option>`)}
            <option value=${CUSTOM_MODEL_SENTINEL}>${t("setup.provider.customModelOption")}</option>
          </select>
          <span class="oc-provider-dynamic-hint">${t("settings.provider.modelsDynamicHint")}</span>
        </div>
      ` : nothing}

      ${s.addShowCustomModelInput || options.length === 0 ? html`
        <div class="oc-settings__form-group">
          <label class="oc-settings__label">${t("setup.provider.customModelId")}</label>
          <input class="oc-settings__input" .value=${s.addCustomModelId}
            @input=${(e: Event) => { s.addCustomModelId = (e.target as HTMLInputElement).value; state.requestUpdate(); }} />
        </div>
      ` : nothing}

      <div class="oc-settings__form-group">
        <label class="oc-settings__label">${t("settings.provider.modelAlias")}</label>
        <input class="oc-settings__input" .value=${s.addAlias} placeholder=${t("settings.provider.modelAliasPlaceholder")}
          @input=${(e: Event) => { s.addAlias = (e.target as HTMLInputElement).value; state.requestUpdate(); }} />
      </div>

      <details class="oc-settings__details-advanced">
        <summary>${t("settings.provider.caps.title")}</summary>
        ${renderCapsEditor(s.addCaps, state)}
      </details>

      <div class="oc-settings__btn-row">
        <button class="oc-settings__btn oc-settings__btn--secondary" @click=${() => toggleAddPanel(state)}>${t("settings.cancel")}</button>
        <button class="oc-settings__btn oc-settings__btn--primary" ?disabled=${s.saving || s.busy}
          @click=${() => handleAddToGroupSave(state)}>
          ${s.saving ? "..." : t("settings.provider.addModelSave")}
        </button>
      </div>
    </div>
  `;
}

function renderAddPanel(state: AppViewState) {
  // 分组追加模式：复用 provider 端点与密钥，只选模型 + 别名 + 能力
  if (s.addToProviderKey) return renderGroupAddPanel(state);
  const target = resolveAddTarget();
  const options = getAddModelOptions();
  const isOAuth = isKimiCodeAdd();
  const isCustom = s.addProvider === "custom";
  const isManualCustom = isCustom && !s.addCustomPreset;

  return html`
    <div class="oc-provider-add-panel">
      <div class="oc-provider-add-panel__title">${t("settings.provider.addModelTitle")}</div>

      <!-- 1. 选择 provider -->
      <oc-provider-segment
        .providers=${PROVIDER_DISPLAY_ORDER.map(p => p)}
        .selected=${s.addProvider}
        .labels=${getProviderLabels()}
        @select=${(e: CustomEvent) => onAddProviderChange(e.detail.provider, state)}
      ></oc-provider-segment>

      ${s.addProvider === "moonshot" ? html`
        <div class="oc-settings__form-group" style="margin-top:12px">
          <label class="oc-settings__label">${t("setup.provider.platform")}</label>
          <div class="oc-settings__radio-group">
            <label class="oc-settings__radio">
              <input type="radio" name="addSubPlatform" value="kimi-code" .checked=${s.addSubPlatform === "kimi-code"}
                @change=${() => { s.addSubPlatform = "kimi-code"; s.addApiKey = ""; const o = getAddModelOptions(); s.addModelId = o[0] ?? ""; state.requestUpdate(); }} />
              ${t("setup.provider.subPlatform.kimiCode")}<span class="oc-settings__badge">${t("setup.provider.subPlatform.searchBadge")}</span>
            </label>
            <label class="oc-settings__radio">
              <input type="radio" name="addSubPlatform" value="moonshot-cn" .checked=${s.addSubPlatform === "moonshot-cn"}
                @change=${() => { s.addSubPlatform = "moonshot-cn"; s.addApiKey = ""; const o = getAddModelOptions(); s.addModelId = o[0] ?? ""; state.requestUpdate(); }} />
              ${t("setup.provider.subPlatform.moonshotCn")}
            </label>
          </div>
        </div>
      ` : nothing}

      ${isCustom ? html`
        <div class="oc-settings__form-group" style="margin-top:12px">
          <label class="oc-settings__label">${t("setup.provider.preset")}</label>
          <select class="oc-settings__select" .value=${s.addCustomPreset}
            @change=${(e: Event) => {
              s.addCustomPreset = (e.target as HTMLSelectElement).value;
              s.addModelId = "";
              s.addShowCustomModelInput = false;
              const o = getAddModelOptions();
              if (o.length) s.addModelId = o[0];
              state.requestUpdate();
            }}>
            <option value="__placeholder__" disabled ?selected=${!s.addCustomPreset}>${t("setup.provider.presetPlaceholder")}</option>
            ${Object.entries(CUSTOM_PRESETS).map(([k, v]) => html`
              <option value=${k} ?selected=${s.addCustomPreset === k}>${v.providerKey}</option>
            `)}
            <option value="">${t("setup.provider.presetManual")}</option>
          </select>
        </div>
      ` : nothing}

      ${isManualCustom ? html`
        <details class="oc-settings__details-advanced" open>
          <summary>${t("settings.provider.customAdvanced")}</summary>
          <div class="oc-settings__form-group">
            <label class="oc-settings__label">${t("setup.provider.baseUrl")}</label>
            <input class="oc-settings__input" .value=${s.addBaseUrl}
              @input=${(e: Event) => { s.addBaseUrl = (e.target as HTMLInputElement).value; state.requestUpdate(); }} />
          </div>
          <div class="oc-settings__form-group">
            <label class="oc-settings__label">${t("setup.provider.apiType")}</label>
            <div class="oc-settings__radio-group">
              ${["openai-completions", "anthropic-messages", "openai-responses"].map(v => html`
                <label class="oc-settings__radio">
                  <input type="radio" name="addApiType" value=${v} .checked=${s.addApiType === v}
                    @change=${() => { s.addApiType = v; state.requestUpdate(); }} /> ${v}
                </label>
              `)}
            </div>
          </div>
        </details>
      ` : nothing}

      <!-- 2. API key / OAuth -->
      ${isOAuth ? html`
        <div style="margin-top:12px">
          ${s.oauthSuccess || s.pendingOAuthToken ? html`
            <div class="oc-provider-kimi-oauth-ok">${t("setup.provider.oauth.success")}</div>
          ` : s.oauthLoggedIn ? html`
            <div class="oc-provider-kimi-oauth-ok">${t("settings.provider.oauthReusing")}</div>
          ` : html`
            <button class="oc-settings__btn oc-settings__btn--primary" ?disabled=${s.oauthLoading}
              @click=${() => handleOAuthLogin(state)}>
              ${s.oauthLoading ? t("setup.provider.oauth.waiting") : t("setup.provider.oauth.login")}
            </button>
          `}
          <details class="oc-settings__details-advanced" style="margin-top:8px">
            <summary>${t("setup.provider.oauth.advanced")}</summary>
            <div class="oc-settings__form-group">
              <label class="oc-settings__label">${t("setup.provider.apiKey")}</label>
              <oc-password-input .value=${s.addApiKey} .placeholder=${target?.placeholder ?? ""}
                @input=${(e: CustomEvent) => { s.addApiKey = e.detail.value; state.requestUpdate(); }}
              ></oc-password-input>
            </div>
          </details>
        </div>
      ` : html`
        <div class="oc-settings__form-group" style="margin-top:12px">
          <label class="oc-settings__label">${t("setup.provider.apiKey")}</label>
          <oc-password-input .value=${s.addApiKey} .placeholder=${target?.placeholder ?? ""}
            @input=${(e: CustomEvent) => { s.addApiKey = e.detail.value; state.requestUpdate(); }}
          ></oc-password-input>
          ${target?.platformUrl ? html`
            <a class="oc-provider-link" @click=${(e: Event) => { e.preventDefault(); ipc.openExternal(target.platformUrl); }}>
              ${t("setup.provider.getKey")}
            </a>
          ` : nothing}
        </div>
      `}

      <!-- 3. 选择模型（动态目录） -->
      ${options.length > 0 ? html`
        <div class="oc-settings__form-group">
          <label class="oc-settings__label">${t("setup.provider.model")}</label>
          <select class="oc-settings__select" .value=${s.addModelId}
            @change=${(e: Event) => {
              const v = (e.target as HTMLSelectElement).value;
              if (v === CUSTOM_MODEL_SENTINEL) {
                s.addShowCustomModelInput = true;
                s.addModelId = v;
              } else {
                s.addShowCustomModelInput = false;
                s.addModelId = v;
                s.addCustomModelId = "";
              }
              state.requestUpdate();
            }}>
            ${options.map(m => html`<option value=${m} ?selected=${s.addModelId === m}>${m}</option>`)}
            <option value=${CUSTOM_MODEL_SENTINEL}>${t("setup.provider.customModelOption")}</option>
          </select>
          <span class="oc-provider-dynamic-hint">${t("settings.provider.modelsDynamicHint")}</span>
        </div>
      ` : nothing}

      ${s.addShowCustomModelInput || options.length === 0 ? html`
        <div class="oc-settings__form-group">
          <label class="oc-settings__label">${t("setup.provider.customModelId")}</label>
          <input class="oc-settings__input" .value=${s.addCustomModelId}
            @input=${(e: Event) => { s.addCustomModelId = (e.target as HTMLInputElement).value; state.requestUpdate(); }} />
        </div>
      ` : nothing}

      <div class="oc-settings__form-group">
        <label class="oc-settings__label">${t("settings.provider.modelAlias")}</label>
        <input class="oc-settings__input" .value=${s.addAlias} placeholder=${t("settings.provider.modelAliasPlaceholder")}
          @input=${(e: Event) => { s.addAlias = (e.target as HTMLInputElement).value; state.requestUpdate(); }} />
      </div>

      ${s.oauthNoMembership ? html`
        <div class="cc-alert cc-alert--error">
          <span>${t("setup.provider.oauth.noMembership")}</span>
          <a class="oc-provider-link" @click=${(e: Event) => { e.preventDefault(); ipc.openExternal("https://kimi.com/pricing?utm_source=oneclaw"); }}>
            ${t("setup.provider.oauth.subscribeLink")}
          </a>
        </div>
      ` : nothing}

      <!-- 4. 保存 -->
      <div class="oc-settings__btn-row">
        <button class="oc-settings__btn oc-settings__btn--secondary" @click=${() => toggleAddPanel(state)}>${t("settings.cancel")}</button>
        <button class="oc-settings__btn oc-settings__btn--primary" ?disabled=${s.saving || s.busy}
          @click=${() => handleAddSave(state)}>
          ${s.saving ? "..." : t("settings.provider.addModelSave")}
        </button>
      </div>
    </div>
  `;
}

/* ── fallback 模型 ── */

function renderFallbacks(state: AppViewState, fallbacks: string[]) {
  const configuredKeys = allConfiguredKeys();
  const nameOf = new Map<string, string>();
  const snap = getCachedConfigSnapshot();
  if (snap) {
    for (const group of groupProvidersFromConfig(snap.config)) {
      for (const prov of group.providers) {
        for (const m of prov.models) nameOf.set(m.key, m.name);
      }
    }
  }
  const addable = configuredKeys.filter(k => !fallbacks.includes(k));
  return html`
    <div class="oc-provider-fallbacks">
      <h3 class="oc-settings__section-subtitle">${t("settings.provider.fallbacks.title")}</h3>
      <p class="oc-settings__hint">${t("settings.provider.fallbacks.desc")}</p>
      ${fallbacks.length === 0 ? html`
        <div class="oc-provider-fallbacks__empty">${t("settings.provider.fallbacks.empty")}</div>
      ` : html`
        <div class="oc-provider-fallbacks__list">
          ${fallbacks.map(key => {
            const isDropBefore = s.dropTarget?.kind === "fallback" && s.dropTarget.id === key && s.dropTarget.position === "before";
            const isDropAfter = s.dropTarget?.kind === "fallback" && s.dropTarget.id === key && s.dropTarget.position === "after";
            return html`
              <div class="oc-provider-card oc-provider-card--fallback ${isDropBefore ? "drop-before" : ""} ${isDropAfter ? "drop-after" : ""}"
                draggable="true"
                @dragstart=${(e: DragEvent) => onDragStart({ kind: "fallback", id: key }, e, state)}
                @dragover=${(e: DragEvent) => onCardDragOver("fallback", key, e, state)}
                @drop=${(e: DragEvent) => { e.preventDefault(); handleFallbackDrop(state); }}
                @dragend=${() => onDragEnd(state)}>
                <svg class="oc-provider-card__grip" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>
                <div class="oc-provider-card__info">
                  <div class="oc-provider-card__name">${nameOf.get(key) ?? key}</div>
                  <div class="oc-provider-card__meta"><span>${key}</span></div>
                </div>
                <div class="oc-provider-card__actions">
                  <button class="oc-provider-list-item__action-btn oc-provider-list-item__delete-btn" data-tooltip=${t("settings.provider.fallbacks.remove")}
                    @click=${() => handleFallbackRemove(key, state)}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>
              </div>
            `;
          })}
        </div>
      `}
      ${addable.length > 0 ? html`
        <div class="oc-provider-fallbacks__add">
          <select class="oc-settings__select" .value=${s.fallbackAddKey}
            @change=${(e: Event) => { s.fallbackAddKey = (e.target as HTMLSelectElement).value; state.requestUpdate(); }}>
            <option value="" ?selected=${!s.fallbackAddKey}>${t("settings.provider.fallbacks.addPlaceholder")}</option>
            ${renderModelOptionsGrouped(addable.map(k => ({ key: k, name: nameOf.get(k) ?? k })), s.org, s.fallbackAddKey || undefined)}
          </select>
          <button class="oc-settings__btn oc-settings__btn--secondary" ?disabled=${!s.fallbackAddKey || s.busy}
            @click=${() => handleFallbackAdd(state)}>${t("settings.provider.fallbacks.add")}</button>
        </div>
      ` : nothing}
    </div>
  `;
}

/* ── per-agent 模型映射 ── */

function renderAgentMapping(state: AppViewState) {
  if (!s.agentsLoaded) loadAgents(state);
  const configuredKeys = allConfiguredKeys();
  if (configuredKeys.length === 0) return nothing;
  // key → 显示名（与 fallback 区同源），选择器按自定义分组渲染
  const nameOf = new Map<string, string>();
  const snap = getCachedConfigSnapshot();
  if (snap) {
    for (const group of groupProvidersFromConfig(snap.config)) {
      for (const prov of group.providers) {
        for (const m of prov.models) nameOf.set(m.key, m.name);
      }
    }
  }
  const optionModels = configuredKeys.map(k => ({ key: k, name: nameOf.get(k) ?? k }));
  return html`
    <details class="oc-settings__details-advanced oc-provider-agents">
      <summary>${t("settings.provider.agents.title")}</summary>
      <p class="oc-settings__hint">${t("settings.provider.agents.desc")}</p>
      ${s.agents.length === 0 ? html`
        <div class="oc-provider-fallbacks__empty">${t("settings.provider.agents.empty")}</div>
      ` : html`
        <div class="oc-provider-agents__rows">
          ${s.agents.map(agent => html`
            <div class="oc-provider-agents__row">
              <span class="oc-provider-agents__label">${agent.label}</span>
              <select class="oc-settings__select" .value=${agent.modelPrimary}
                @change=${(e: Event) => handleAgentModelChange(agent.id, (e.target as HTMLSelectElement).value, state)}>
                ${!agent.modelPrimary ? html`<option value="" selected disabled>${t("settings.provider.agents.followDefault")}</option>` : nothing}
                ${renderModelOptionsGrouped(optionModels, s.org, agent.modelPrimary || undefined)}
              </select>
            </div>
          `)}
        </div>
      `}
    </details>
  `;
}
