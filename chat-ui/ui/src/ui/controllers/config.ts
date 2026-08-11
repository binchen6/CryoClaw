/**
 * 内核原生配置 RPC 封装 — `config.get` / `config.patch`。
 *
 * 契约（openclaw 2026.7.1-2 取证）：
 * - `config.get` 返回脱敏快照：{ config, raw, hash, ... }，敏感值替换为
 *   `__OPENCLAW_REDACTED__` 哨兵；hash 是磁盘原始文件文本的 sha256。
 * - `config.patch` 参数 { raw(JSON5 字符串), baseHash, replacePaths?, note?, sessionKey? }，
 *   内核按 RFC7396 合并（id-keyed 数组按 id 就地合并、保留 base 顺序）；
 *   baseHash 不匹配时报 "config changed since last load; re-run config.get and retry"。
 * - 数组删条目/重排必须把该数组路径放进 replacePaths（内核有防丢条目护栏），
 *   命中 replacePaths 的数组被 patch 值整体替换，顺序由 patch 决定。
 * - 写侧自动还原 REDACTED 哨兵为磁盘原值，因此脱敏快照可安全参与 patch。
 *
 * 缓存 + 并发去重仿 controllers/models.ts 模式。
 */
import type { GatewayBrowserClient } from "../gateway.ts";
import type { ConfiguredModel } from "../ui-types.ts";

export interface ConfigSnapshot {
  hash: string;
  /** 脱敏后的配置树（REDACTED 哨兵原样保留） */
  config: Record<string, unknown>;
  raw: string | null;
}

export interface ConfigPatchResult {
  ok: boolean;
  /** 无实际变更（内核 noop 或本地 diff 为空） */
  noop: boolean;
  /** 内核判定该变更需要重启才生效（hybrid/restart/off 模式下的 restart 级路径） */
  requiresRestart: boolean;
  /** 内核已调度 SIGUSR1 进程内平滑重启 */
  restartScheduled: boolean;
  /** 失败时的中文化错误消息 */
  error?: string;
}

/** 内核脱敏哨兵值；出现在 patch 中时内核自动还原为磁盘原值 */
export const REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";

export function isRedactedValue(value: unknown): value is string {
  return value === REDACTED_SENTINEL;
}

/* ── 缓存 ── */

// 失败后 10 秒内不重试，避免 gateway 不可达时反复打 RPC
const RETRY_AFTER_FAILURE_MS = 10_000;

let cache: ConfigSnapshot | null = null;
let lastFailureAt = 0;
let inflight: Promise<ConfigSnapshot | null> | null = null;

/** 同步读缓存（无 TTL，配置一致性由 baseHash 乐观锁保证） */
export function getCachedConfigSnapshot(): ConfigSnapshot | null {
  return cache;
}

/** 使缓存失效（patch 成功后调用，下次读取重新拉取最新 hash）；同时重置失败节流 */
export function invalidateConfigSnapshotCache(): void {
  cache = null;
  lastFailureAt = 0;
}

function parseSnapshot(payload: unknown): ConfigSnapshot | null {
  const snap = payload as { hash?: unknown; config?: unknown; raw?: unknown } | undefined;
  if (!snap || typeof snap.hash !== "string") return null;
  const config =
    snap.config && typeof snap.config === "object" && !Array.isArray(snap.config)
      ? (snap.config as Record<string, unknown>)
      : null;
  if (!config) return null;
  return {
    hash: snap.hash,
    config,
    raw: typeof snap.raw === "string" ? snap.raw : null,
  };
}

/** 拉取并缓存配置快照；失败时回退到已有缓存或 null */
export async function getConfigSnapshot(
  client: GatewayBrowserClient,
  opts?: { force?: boolean },
): Promise<ConfigSnapshot | null> {
  if (!opts?.force) {
    if (cache) return cache;
    if (Date.now() - lastFailureAt < RETRY_AFTER_FAILURE_MS) return null;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const payload = await client.request("config.get", {});
      const snapshot = parseSnapshot(payload);
      if (snapshot) {
        cache = snapshot;
      } else {
        lastFailureAt = Date.now();
      }
      return snapshot;
    } catch {
      lastFailureAt = Date.now();
      return cache;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/* ── path 工具（不可变更新） ── */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 不可变地设置点分路径：`setPath(obj, "agents.defaults.model.primary", v)`。
 * 沿途缺失的对象层级自动创建；返回新对象，入参不被修改。
 */
export function setPath<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split(".").filter(Boolean);
  if (keys.length === 0) return value as T;
  const root: unknown = isPlainObject(obj) ? { ...(obj as Record<string, unknown>) } : {};
  let cursor = root as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    const child = cursor[key];
    cursor[key] = isPlainObject(child) ? { ...child } : {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1]] = value;
  return root as T;
}

/** 读取点分路径；不存在时返回 undefined */
export function getPath(obj: unknown, path: string): unknown {
  let cursor = obj;
  for (const key of path.split(".").filter(Boolean)) {
    if (!isPlainObject(cursor) && !Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/* ── merge patch 构造 ── */

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return (
      keysA.length === keysB.length && keysA.every((key) => deepEqual(a[key], b[key]))
    );
  }
  return false;
}

function hasStringId(value: unknown): value is { id: string } {
  return isPlainObject(value) && typeof value.id === "string" && value.id.length > 0;
}

/**
 * 判断数组变更是否需要 replacePaths 整体替换：
 * - 条目数量减少（删条目）
 * - id-keyed 数组中共同 id 的相对顺序变化（重排）
 * 内核 mergeObjectArraysById 保留 base 顺序，以上两类变更只有整体替换才能生效；
 * 且内核护栏要求删条目必须显式 replacePaths。
 */
function arrayNeedsReplace(base: unknown[], next: unknown[]): boolean {
  if (next.length < base.length) return true;
  if (base.length > 0 && base.every(hasStringId) && next.every(hasStringId)) {
    const nextIds = new Set(next.map((entry) => entry.id));
    const baseIds = new Set(base.map((entry) => entry.id));
    const baseCommon = base.filter((entry) => nextIds.has(entry.id)).map((entry) => entry.id);
    const nextCommon = next.filter((entry) => baseIds.has(entry.id)).map((entry) => entry.id);
    // 共同 id 的相对顺序变化 → 需要整体替换
    if (baseCommon.length !== nextCommon.length) return true;
    for (let i = 0; i < baseCommon.length; i++) {
      if (baseCommon[i] !== nextCommon[i]) return true;
    }
  }
  return false;
}

export interface MergePatch {
  /** RFC7396 合并补丁对象（空对象表示无变更） */
  patch: Record<string, unknown>;
  /** 需要整体替换的数组路径（自动探测 + 调用方显式声明的并集） */
  replacePaths: string[];
  /** 发生变更的顶层以下路径（供 UI 展示/调试） */
  changedPaths: string[];
}

function diffValue(
  base: unknown,
  next: unknown,
  path: string,
  autoReplacePaths: Set<string>,
  changedPaths: string[],
): { changed: boolean; value?: unknown } {
  if (deepEqual(base, next)) return { changed: false };
  if (isPlainObject(base) && isPlainObject(next)) {
    const patch: Record<string, unknown> = {};
    let changed = false;
    for (const key of Object.keys(next)) {
      const childPath = path ? `${path}.${key}` : key;
      const child = diffValue(base[key], next[key], childPath, autoReplacePaths, changedPaths);
      if (child.changed) {
        patch[key] = child.value;
        changed = true;
      }
    }
    for (const key of Object.keys(base)) {
      if (!(key in next)) {
        patch[key] = null;
        changed = true;
        changedPaths.push(path ? `${path}.${key}` : key);
      }
    }
    return changed ? { changed: true, value: patch } : { changed: false };
  }
  if (Array.isArray(base) && Array.isArray(next) && arrayNeedsReplace(base, next)) {
    autoReplacePaths.add(path);
  }
  changedPaths.push(path);
  return { changed: true, value: next };
}

/** 由 base → next 构造 RFC7396 merge patch；数组删条目/重排自动标记 replacePaths */
export function buildMergePatch(
  base: Record<string, unknown>,
  next: Record<string, unknown>,
  options?: { replacePaths?: string[] },
): MergePatch {
  const autoReplacePaths = new Set<string>();
  const changedPaths: string[] = [];
  const result = diffValue(base, next, "", autoReplacePaths, changedPaths);
  const replacePaths = new Set<string>([...autoReplacePaths, ...(options?.replacePaths ?? [])]);
  return {
    patch: result.changed && isPlainObject(result.value) ? result.value : {},
    replacePaths: [...replacePaths],
    changedPaths,
  };
}

/* ── config.patch ── */

export interface PatchConfigOptions {
  /** 显式声明整体替换的数组路径（与自动探测结果取并集） */
  replacePaths?: string[];
  note?: string;
  sessionKey?: string;
}

/** 内核 baseHash 冲突错误文案（2026.7.1-2 取证） */
const BASE_HASH_CONFLICT_HINT = "config changed since last load";
const ARRAY_REMOVE_GUARD_HINT = "would remove entries from array path";

/** 内核错误 → 中文提示 */
export function mapConfigPatchError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (message.includes(BASE_HASH_CONFLICT_HINT)) {
    return "配置已被其他进程修改，请重试";
  }
  if (message.includes(ARRAY_REMOVE_GUARD_HINT)) {
    return "内核拒绝了数组删减操作（缺少 replacePaths 声明）";
  }
  if (message.includes("base hash required") || message.includes("base hash unavailable")) {
    return "配置快照失效，请刷新后重试";
  }
  if (message.includes("JSON5") || message.includes("parse")) {
    return "配置内容解析失败";
  }
  if (message.includes("not connected") || message.includes("handshake")) {
    return "gateway 连接已断开，请稍后重试";
  }
  return message || "配置写入失败";
}

interface PatchResponse {
  ok?: boolean;
  noop?: boolean;
  restart?: unknown;
  sentinel?: { payload?: { stats?: { requiresRestart?: boolean } } };
}

function parsePatchResponse(payload: unknown): Omit<ConfigPatchResult, "ok"> {
  const res = (payload ?? {}) as PatchResponse;
  const requiresRestart = res.sentinel?.payload?.stats?.requiresRestart === true;
  const restartScheduled = res.restart != null;
  return {
    noop: res.noop === true,
    requiresRestart: requiresRestart || restartScheduled,
    restartScheduled,
  };
}

/**
 * 以「读快照 → 变更草稿 → diff → config.patch」的方式写入配置。
 * baseHash 冲突时自动重取快照并重放 mutator 一次；再冲突则报中文错误。
 * mutator 直接修改 draft（脱敏快照的深拷贝），REDACTED 哨兵由内核写侧自动还原。
 */
export async function patchConfig(
  client: GatewayBrowserClient,
  mutator: (draft: Record<string, unknown>) => void,
  options?: PatchConfigOptions,
): Promise<ConfigPatchResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const snapshot = await getConfigSnapshot(client, { force: attempt > 0 });
    if (!snapshot) {
      return { ok: false, noop: false, requiresRestart: false, restartScheduled: false, error: "无法读取配置快照（gateway 不可达）" };
    }
    const draft = structuredClone(snapshot.config);
    try {
      mutator(draft);
    } catch (err) {
      return { ok: false, noop: false, requiresRestart: false, restartScheduled: false, error: mapConfigPatchError(err) };
    }
    const { patch, replacePaths } = buildMergePatch(snapshot.config, draft, {
      replacePaths: options?.replacePaths,
    });
    if (Object.keys(patch).length === 0) {
      return { ok: true, noop: true, requiresRestart: false, restartScheduled: false };
    }
    try {
      const params: Record<string, unknown> = {
        raw: JSON.stringify(patch),
        baseHash: snapshot.hash,
      };
      if (replacePaths.length > 0) params.replacePaths = replacePaths;
      if (options?.note) params.note = options.note;
      if (options?.sessionKey) params.sessionKey = options.sessionKey;
      const payload = await client.request("config.patch", params);
      invalidateConfigSnapshotCache();
      return { ok: true, ...parsePatchResponse(payload) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? "");
      // baseHash 冲突：失效缓存后重取重放一次
      if (attempt === 0 && message.includes(BASE_HASH_CONFLICT_HINT)) {
        invalidateConfigSnapshotCache();
        continue;
      }
      return { ok: false, noop: false, requiresRestart: false, restartScheduled: false, error: mapConfigPatchError(err) };
    }
  }
  return { ok: false, noop: false, requiresRestart: false, restartScheduled: false, error: "配置已被其他进程修改，请重试" };
}

/* ── 从配置快照派生已配置模型列表（替代 settings:get-configured-models IPC） ── */

/** 由配置快照聚合所有 provider 的模型列表（语义同旧 settings:get-configured-models） */
export function deriveConfiguredModels(config: Record<string, unknown> | null | undefined): ConfiguredModel[] {
  const providers = getPath(config, "models.providers");
  const primary = getPath(config, "agents.defaults.model.primary");
  const result: ConfiguredModel[] = [];
  if (!isPlainObject(providers)) return result;
  for (const [providerKey, prov] of Object.entries(providers)) {
    if (!isPlainObject(prov) || !Array.isArray(prov.models)) continue;
    for (const entry of prov.models) {
      const id = typeof entry === "string" ? entry : (isPlainObject(entry) ? entry.id : undefined);
      if (typeof id !== "string" || !id) continue;
      const name =
        isPlainObject(entry) && typeof entry.name === "string" && entry.name ? entry.name : id;
      // custom-xxx key 用 baseUrl hostname 做显示名，更可读
      let displayProvider = providerKey;
      if (providerKey.startsWith("custom-") && typeof prov.baseUrl === "string") {
        try {
          displayProvider = new URL(prov.baseUrl).hostname;
        } catch {
          /* 保留 providerKey */
        }
      }
      const key = `${providerKey}/${id}`;
      result.push({ key, name, provider: displayProvider, isDefault: key === primary });
    }
  }
  return result;
}
