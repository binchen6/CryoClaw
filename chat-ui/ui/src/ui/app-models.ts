import type { GatewayBrowserClient } from "./gateway.ts";
import type { SessionsListResult } from "./types.ts";
import type { ConfiguredModel } from "./ui-types.ts";
import { getConfigSnapshot, deriveConfiguredModels } from "./controllers/config.ts";
import { mergeAccountModels } from "./controllers/models.ts";
import { markSessionMeterDirty } from "./context-meter.ts";
import type { ThinkingCapabilities } from "./chat/thinking-levels.ts";

export type ModelSelectionHost = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
  currentModel: string | null;
  configuredModels: ConfiguredModel[];
  dirtyMeterSessions: Set<string>;
  meterTotalsBaseline: Map<string, number>;
  lastError: string | null;
  updateThinkingCapabilities(): void;
  requestUpdate(): void;
};

export function applyModelThinkingCapabilities(
  state: Pick<ModelSelectionHost, "client" | "sessionKey"> & {
    thinkingLevel: string; thinkingLevels: string[]; isBinaryThinking: boolean;
  },
  caps: ThinkingCapabilities,
  persistLevel: (level: string) => void,
) {
  state.thinkingLevels = caps.levels;
  state.isBinaryThinking = caps.isBinary;
  // The visible model is optimistic until its patch is acknowledged. Preserve
  // the existing preference so a refused choice cannot disable the old model.
  if (!hasPendingSessionModelChange(state, state.sessionKey)
    && state.thinkingLevel !== "off" && !caps.levels.includes(state.thinkingLevel)) {
    state.thinkingLevel = "off";
    persistLevel("off");
  }
}


type ModelFields = Pick<import("./types.ts").GatewaySessionRow, "model" | "modelProvider"> & {
  thinkingLevels?: unknown; thinkingDefault?: unknown;
};
type Selection = {
  revision: number; sequence: number; pending: boolean; promise: Promise<boolean> | null;
  fields: ModelFields; confirmed: ModelFields; fallback: string | null;
  hadSuccess: boolean; wasDirty: boolean; baseline: number | undefined;
};
type SelectionMeta = { client: GatewayBrowserClient; revision: number; sessions: Map<string, Selection> };
const selections = new WeakMap<object, SelectionMeta>();
const modelLoads = new WeakMap<object, { client: GatewayBrowserClient; generation: number }>();
function selectionMeta(state: { client: GatewayBrowserClient | null }): SelectionMeta | undefined {
  const meta = selections.get(state);
  return meta?.client === state.client ? meta : undefined;
}
function modelFields(row: import("./types.ts").GatewaySessionRow | undefined): ModelFields {
  return { model: row?.model, modelProvider: row?.modelProvider,
    thinkingLevels: row?.thinkingLevels, thinkingDefault: row?.thinkingDefault };
}
function selectedFields(model: string): ModelFields {
  return { model, modelProvider: model.slice(0, model.indexOf("/")) || undefined,
    thinkingLevels: undefined, thinkingDefault: undefined };
}
function projectSelection(state: Pick<ModelSelectionHost, "sessionsResult">, key: string, fields: ModelFields) {
  const result = state.sessionsResult;
  const rows = result?.sessions ?? [];
  const found = rows.some(row => row.key === key);
  state.sessionsResult = { ...result, sessions: found
    ? rows.map(row => row.key === key ? { ...row, ...fields } : row)
    : [...rows, { key, ...fields }] };
}

/** Tag the read when it starts so an older snapshot cannot undo a newer choice. */
export function captureSessionModelRead(state: { client: GatewayBrowserClient | null }) {
  return { client: state.client, revision: selectionMeta(state)?.revision ?? 0 };
}
export function reconcileSessionModelRead(
  state: { client: GatewayBrowserClient | null }, result: SessionsListResult,
  read: ReturnType<typeof captureSessionModelRead>,
): SessionsListResult {
  const meta = selectionMeta(state);
  if (!meta || read.client !== state.client) return result;
  let sessions = result.sessions;
  for (const [key, selection] of meta.sessions) {
    if (selection.pending || selection.revision > read.revision) {
      sessions = sessions.map(row => row.key === key ? { ...row, ...selection.fields } : row);
      // A newly created session can be absent from the snapshot taken before its patch.
      if (!sessions.some(row => row.key === key)) sessions = [...sessions, { key, ...selection.fields }];
    } else {
      // A read started after confirmation is authoritative, including changes from other clients.
      meta.sessions.delete(key);
    }
  }
  return sessions === result.sessions ? result : { ...result, sessions };
}

/** Wait only for changes that are in flight when this send starts (and any newer choice). */
export function hasPendingSessionModelChange(state: { client: GatewayBrowserClient | null }, sessionKey: string): boolean {
  return selectionMeta(state)?.sessions.get(sessionKey)?.pending === true;
}

export async function waitForSessionModelChange(
  state: { client: GatewayBrowserClient | null; connected: boolean }, sessionKey: string,
): Promise<boolean> {
  const client = state.client;
  let selection = selectionMeta(state)?.sessions.get(sessionKey);
  if (!selection?.pending) return true;
  let operation: Promise<boolean> | null = selection.promise;
  while (operation) {
    const ok = await operation;
    if (state.client !== client || !state.connected) return false;
    selection = selectionMeta(state)?.sessions.get(sessionKey);
    if (!selection?.promise || selection.promise === operation) return ok;
    operation = selection.promise;
  }
  return true;
}

/** Publish config-backed models immediately; slower account readiness supplements them later. */
export async function loadConfiguredModels(state: ModelSelectionHost) {
  if (!state.client || !state.connected) return;
  const client = state.client, previousLoad = modelLoads.get(state);
  const generation = (previousLoad?.generation ?? 0) + 1;
  modelLoads.set(state, { client, generation });
  const current = () => state.client === client && state.connected && modelLoads.get(state)?.generation === generation;
  const catalogPromise = client.request("models.list", { view: "configured" }).catch(() => null);
  try {
    const snapshot = await getConfigSnapshot(client);
    if (!current()) return;
    const configModels = snapshot ? deriveConfiguredModels(snapshot.config) : null;
    const defaults = snapshot?.config.agents as { defaults?: { model?: { primary?: string }; models?: Record<string, { alias?: string }> } } | undefined;
    const publish = (models: ConfiguredModel[]) => {
      state.configuredModels = models;
      if (!state.sessionsResult?.sessions.find(row => row.key === state.sessionKey)?.model) {
        state.currentModel = models.find(model => model.isDefault)?.key ?? models[0]?.key ?? null;
      }
      state.updateThinkingCapabilities();
      state.requestUpdate();
    };
    if (configModels) {
      const knownAccounts = previousLoad && previousLoad.client !== client ? [] : state.configuredModels.map(model => {
        const slash = model.key.indexOf("/");
        return { provider: model.key.slice(0, slash), id: model.key.slice(slash + 1), name: model.name, available: true };
      });
      publish(mergeAccountModels(configModels, { models: knownAccounts },
        defaults?.defaults?.model?.primary, defaults?.defaults?.models));
    }
    const catalog = await catalogPromise;
    if (!current()) return;
    if (catalog) publish(mergeAccountModels(configModels ?? state.configuredModels, catalog,
      defaults?.defaults?.model?.primary, defaults?.defaults?.models));
  } catch {
    // Preserve usable models during a transient disconnect.
  }
}

export async function handleModelChange(state: ModelSelectionHost, modelKey: string) {
  if (!state.client || !state.connected || !modelKey.trim()) return;
  const client = state.client, key = state.sessionKey;
  let meta = selectionMeta(state);
  if (!meta) {
    meta = { client, revision: 0, sessions: new Map() };
    selections.set(state, meta);
  }
  let selection = meta.sessions.get(key);
  if (!selection) {
    const fields = modelFields(state.sessionsResult?.sessions.find(row => row.key === key));
    selection = { revision: 0, sequence: 0, pending: false, promise: null,
      fields, confirmed: fields, fallback: state.currentModel, hadSuccess: false,
      wasDirty: state.dirtyMeterSessions.has(key), baseline: state.meterTotalsBaseline.get(key) };
    meta.sessions.set(key, selection);
  }
  const previous = selection.pending ? selection.promise : null;
  const sequence = ++selection.sequence;
  selection.revision = ++meta.revision;
  selection.pending = true;
  const fields = selectedFields(modelKey);
  selection.fields = fields;
  state.currentModel = modelKey;
  projectSelection(state, key, fields);
  const nextDirty = new Set(state.dirtyMeterSessions);
  markSessionMeterDirty(nextDirty, key);
  state.dirtyMeterSessions = nextDirty;
  state.meterTotalsBaseline.set(key, state.sessionsResult?.sessions.find(row => row.key === key)?.totalTokens ?? 0);
  state.requestUpdate();
  const owner = meta, entry = selection;
  const ownsConnection = () => {
    if (state.client === client && state.connected) return true;
    if (entry.sequence === sequence) owner.sessions.delete(key);
    return false;
  };
  const operation = (async () => {
    if (previous) await previous;
    if (!ownsConnection()) return false;
    try {
      await client.request("sessions.patch", { key, model: modelKey });
      if (!ownsConnection()) return false;
      entry.confirmed = fields;
      entry.hadSuccess = true;
      if (entry.sequence === sequence) {
        entry.pending = false;
        entry.revision = ++owner.revision;
        projectSelection(state, key, fields);
        if (state.sessionKey === key) state.updateThinkingCapabilities();
        state.requestUpdate();
      }
      return true;
    } catch (error) {
      if (!ownsConnection()) return false;
      if (entry.sequence === sequence) {
        entry.pending = false;
        entry.revision = ++owner.revision;
        entry.fields = entry.confirmed;
        projectSelection(state, key, entry.confirmed);
        if (!entry.hadSuccess) {
          if (!entry.wasDirty) state.dirtyMeterSessions = new Set([...state.dirtyMeterSessions].filter(session => session !== key));
          if (entry.baseline === undefined) state.meterTotalsBaseline.delete(key);
          else state.meterTotalsBaseline.set(key, entry.baseline);
        }
        if (state.sessionKey === key) {
          state.lastError = String(error);
          state.currentModel = entry.confirmed.model ?? entry.fallback;
          state.updateThinkingCapabilities();
        }
        state.requestUpdate();
      }
      return false;
    }
  })();
  entry.promise = operation;
  await operation;
}
