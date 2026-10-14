/**
 * 会话列表分组（Codex threads 风）：置顶优先，其余按更新时间分时间组。
 * 纯函数模块，独立可测（<oc-session-panel> 渲染层只负责消费分组结果）。
 */
import type { SessionPanelSessionOption } from "./components/oc-session-panel.ts";

export type SidebarSessionGroup = {
  /** i18n key（sidebar.groupPinned / groupToday / groupYesterday / groupLast7Days / groupOlder） */
  labelKey: string;
  items: SessionPanelSessionOption[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** 本地零点时间戳 */
function localDayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 组内父子嵌套（2026.10.3 子会话谱系）：spawnedBy 指向同组内父会话的子会话
 * 移到父会话之后并标 depth（渲染层缩进 + ↳ 标记），多级派生链（子再派生）
 * 按谱系顺序递归展开；父会话不在同组（跨时间组/置顶分离）或谱系成环时，
 * 子会话保持顶层位置，保证任何会话皆可达。
 */
function nestSubsessions(
  items: SessionPanelSessionOption[],
): SessionPanelSessionOption[] {
  const byKey = new Map(items.map((s) => [s.key, s]));
  const childrenOf = new Map<string, SessionPanelSessionOption[]>();
  const roots: SessionPanelSessionOption[] = [];
  for (const s of items) {
    const parentKey = s.spawnedBy;
    if (parentKey && parentKey !== s.key && byKey.has(parentKey)) {
      const arr = childrenOf.get(parentKey) ?? [];
      arr.push(s);
      childrenOf.set(parentKey, arr);
    } else {
      roots.push(s);
    }
  }
  if (childrenOf.size === 0) {
    return items;
  }
  const out: SessionPanelSessionOption[] = [];
  const visited = new Set<string>();
  const emit = (s: SessionPanelSessionOption, depth: number): void => {
    // visited 断链：谱系成环（脏数据）时终止递归，避免栈溢出
    if (visited.has(s.key)) return;
    visited.add(s.key);
    out.push(depth === 0 ? s : { ...s, depth });
    for (const child of childrenOf.get(s.key) ?? []) emit(child, depth + 1);
  };
  for (const root of roots) emit(root, 0);
  // 环上节点没有根，兜底按原顺序补回顶层，不丢会话
  for (const s of items) {
    if (!visited.has(s.key)) out.push(s);
  }
  return out;
}

/**
 * 把会话列表分成「置顶 + 今天 / 昨天 / 最近 7 天 / 更早」。
 * 输入顺序在组内原样保留（上游已按 updatedAt 倒序）。
 * 缺 updatedAt 的会话归入「更早」。归档视图与搜索态不分组（调用方判断）。
 */
export function groupSidebarSessions(
  options: readonly SessionPanelSessionOption[],
  now: number = Date.now(),
): SidebarSessionGroup[] {
  const pinned = options.filter((s) => s.pinned);
  const rest = options.filter((s) => !s.pinned);
  const todayStart = localDayStart(now);
  const yesterdayStart = todayStart - DAY_MS;
  const last7Start = todayStart - 6 * DAY_MS;

  const today: SessionPanelSessionOption[] = [];
  const yesterday: SessionPanelSessionOption[] = [];
  const last7: SessionPanelSessionOption[] = [];
  const older: SessionPanelSessionOption[] = [];
  for (const s of rest) {
    const ts = s.updatedAt;
    if (ts != null && ts >= todayStart) {
      today.push(s);
    } else if (ts != null && ts >= yesterdayStart) {
      yesterday.push(s);
    } else if (ts != null && ts >= last7Start) {
      last7.push(s);
    } else {
      older.push(s);
    }
  }

  const groups: SidebarSessionGroup[] = [];
  if (pinned.length > 0) groups.push({ labelKey: "sidebar.groupPinned", items: nestSubsessions(pinned) });
  if (today.length > 0) groups.push({ labelKey: "sidebar.groupToday", items: nestSubsessions(today) });
  if (yesterday.length > 0) groups.push({ labelKey: "sidebar.groupYesterday", items: nestSubsessions(yesterday) });
  if (last7.length > 0) groups.push({ labelKey: "sidebar.groupLast7Days", items: nestSubsessions(last7) });
  if (older.length > 0) groups.push({ labelKey: "sidebar.groupOlder", items: nestSubsessions(older) });
  return groups;
}
