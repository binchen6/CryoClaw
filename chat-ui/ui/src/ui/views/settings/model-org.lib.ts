/**
 * 模型自定义分组（R9）纯函数库 — localStorage 持久化 + 选择器分桶。
 *
 * 设计边界：
 * - 模型的定义与组内顺序仍以内核 config 为唯一事实来源（tab-provider 拖拽写 config.patch）；
 * - 本模块只管「UI 组织层」：自定义分组的增删改排序 + 模型→分组指派，存 localStorage
 *   （cryoclaw.model-org.v1），不进内核 config，避免污染内核 schema。
 * - 纯函数不依赖 lit / i18n / IPC，可独立单测；localStorage 读写封装在 load/save 两个入口。
 */
import { reorderIds } from "./tab-provider.lib.ts";

export interface ModelOrgGroup {
  id: string;
  name: string;
}

export interface ModelOrgState {
  version: 1;
  /** 分组显示顺序 = 数组顺序（拖拽排序的事实来源） */
  groups: ModelOrgGroup[];
  /** modelKey(`provider/id`) → groupId；未收录 = 未分组 */
  assignments: Record<string, string>;
}

export const MODEL_ORG_STORAGE_KEY = "cryoclaw.model-org.v1";

export function emptyModelOrg(): ModelOrgState {
  return { version: 1, groups: [], assignments: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 解析 localStorage 原始字符串；任何畸形输入一律回退空状态（不抛错） */
export function parseModelOrg(raw: string | null | undefined): ModelOrgState {
  if (!raw) return emptyModelOrg();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return emptyModelOrg();
    const groupsRaw = Array.isArray(parsed.groups) ? parsed.groups : [];
    const seen = new Set<string>();
    const groups: ModelOrgGroup[] = [];
    for (const g of groupsRaw) {
      if (!isRecord(g)) continue;
      const id = typeof g.id === "string" ? g.id : "";
      const name = typeof g.name === "string" ? g.name.trim() : "";
      if (!id || !name || seen.has(id)) continue;
      seen.add(id);
      groups.push({ id, name });
    }
    const assignmentsRaw = isRecord(parsed.assignments) ? parsed.assignments : {};
    const assignments: Record<string, string> = {};
    for (const [modelKey, groupId] of Object.entries(assignmentsRaw)) {
      if (typeof groupId === "string" && groupId && seen.has(groupId)) {
        assignments[modelKey] = groupId;
      }
    }
    return { version: 1, groups, assignments };
  } catch {
    return emptyModelOrg();
  }
}

export function serializeModelOrg(org: ModelOrgState): string {
  return JSON.stringify(org);
}

/* ── localStorage 读写（带脏检查缓存：raw 未变不重复 parse） ── */

let cachedRaw: string | null = null;
let cachedOrg: ModelOrgState | null = null;

export function loadModelOrg(): ModelOrgState {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(MODEL_ORG_STORAGE_KEY);
  } catch {
    return cachedOrg ?? emptyModelOrg();
  }
  if (cachedOrg && raw === cachedRaw) return cachedOrg;
  cachedRaw = raw;
  cachedOrg = parseModelOrg(raw);
  return cachedOrg;
}

export function saveModelOrg(org: ModelOrgState): void {
  try {
    const raw = serializeModelOrg(org);
    localStorage.setItem(MODEL_ORG_STORAGE_KEY, raw);
    cachedRaw = raw;
    cachedOrg = org;
  } catch {
    /* 存储不可用时仅内存态生效，不阻断 UI */
  }
}

/* ── 分组 CRUD / 排序 ── */

/** 生成短 id（渲染层无 crypto 依赖需求，时间戳+随机足够） */
export function generateOrgGroupId(): string {
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 添加分组；空名返回原状态。返回新状态与新组 id */
export function addOrgGroup(org: ModelOrgState, name: string, id = generateOrgGroupId()): { org: ModelOrgState; id: string } {
  const trimmed = name.trim();
  if (!trimmed) return { org, id: "" };
  return { org: { ...org, groups: [...org.groups, { id, name: trimmed }] }, id };
}

/** 重命名分组；空名/不存在返回原状态 */
export function renameOrgGroup(org: ModelOrgState, id: string, name: string): ModelOrgState {
  const trimmed = name.trim();
  if (!trimmed || !org.groups.some((g) => g.id === id)) return org;
  return { ...org, groups: org.groups.map((g) => (g.id === id ? { ...g, name: trimmed } : g)) };
}

/** 删除分组并清掉指向它的指派 */
export function removeOrgGroup(org: ModelOrgState, id: string): ModelOrgState {
  if (!org.groups.some((g) => g.id === id)) return org;
  const assignments: Record<string, string> = {};
  for (const [modelKey, groupId] of Object.entries(org.assignments)) {
    if (groupId !== id) assignments[modelKey] = groupId;
  }
  return { ...org, groups: org.groups.filter((g) => g.id !== id), assignments };
}

/** 拖拽排序分组（复用模型排序同一套 before/after 语义） */
export function reorderOrgGroups(
  org: ModelOrgState,
  draggedId: string,
  targetId: string,
  position: "before" | "after",
): ModelOrgState {
  const ids = org.groups.map((g) => g.id);
  const nextIds = reorderIds(ids, draggedId, targetId, position);
  if (nextIds === ids) return org;
  const byId = new Map(org.groups.map((g) => [g.id, g]));
  return { ...org, groups: nextIds.map((id) => byId.get(id)!).filter(Boolean) };
}

/** 指派模型到分组；groupId 为 null/空串 = 取消指派 */
export function assignModelToGroup(org: ModelOrgState, modelKey: string, groupId: string | null): ModelOrgState {
  const assignments = { ...org.assignments };
  if (!groupId || !org.groups.some((g) => g.id === groupId)) {
    delete assignments[modelKey];
  } else {
    assignments[modelKey] = groupId;
  }
  return { ...org, assignments };
}

/** 清理失效指派（模型已被删除时调用，保持存储干净） */
export function pruneModelOrgAssignments(org: ModelOrgState, validKeys: ReadonlySet<string> | string[]): ModelOrgState {
  const valid = validKeys instanceof Set ? validKeys : new Set(validKeys);
  let changed = false;
  const assignments: Record<string, string> = {};
  for (const [modelKey, groupId] of Object.entries(org.assignments)) {
    if (valid.has(modelKey)) {
      assignments[modelKey] = groupId;
    } else {
      changed = true;
    }
  }
  return changed ? { ...org, assignments } : org;
}

/* ── 选择器分桶 ── */

export interface ModelOrgBucket<T> {
  /** null = 未分组桶 */
  group: ModelOrgGroup | null;
  models: T[];
}

/**
 * 把模型列表按分组切桶：分组按 org.groups 顺序（空桶跳过），
 * 未分组模型收尾（为空则不出桶）。桶内保持入参顺序。
 */
export function bucketModelsByOrg<T extends { key: string }>(
  models: T[],
  org: ModelOrgState,
): Array<ModelOrgBucket<T>> {
  const buckets = new Map<string, T[]>();
  const ungrouped: T[] = [];
  for (const m of models) {
    const groupId = org.assignments[m.key];
    if (groupId && org.groups.some((g) => g.id === groupId)) {
      const list = buckets.get(groupId) ?? [];
      list.push(m);
      buckets.set(groupId, list);
    } else {
      ungrouped.push(m);
    }
  }
  const result: Array<ModelOrgBucket<T>> = [];
  for (const group of org.groups) {
    const list = buckets.get(group.id);
    if (list?.length) result.push({ group, models: list });
  }
  if (ungrouped.length) result.push({ group: null, models: ungrouped });
  return result;
}
