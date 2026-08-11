/**
 * 会话列表分组（Codex threads 风）：置顶优先，其余按更新时间分时间组。
 * 纯函数模块，独立可测（sidebar.ts 渲染层只负责消费分组结果）。
 */
import type { SidebarSessionOption } from "./sidebar.ts";

export type SidebarSessionGroup = {
  /** i18n key（sidebar.groupPinned / groupToday / groupYesterday / groupLast7Days / groupOlder） */
  labelKey: string;
  items: SidebarSessionOption[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** 本地零点时间戳 */
function localDayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 把会话列表分成「置顶 + 今天 / 昨天 / 最近 7 天 / 更早」。
 * 输入顺序在组内原样保留（上游已按 updatedAt 倒序）。
 * 缺 updatedAt 的会话归入「更早」。归档视图与搜索态不分组（调用方判断）。
 */
export function groupSidebarSessions(
  options: readonly SidebarSessionOption[],
  now: number = Date.now(),
): SidebarSessionGroup[] {
  const pinned = options.filter((s) => s.pinned);
  const rest = options.filter((s) => !s.pinned);
  const todayStart = localDayStart(now);
  const yesterdayStart = todayStart - DAY_MS;
  const last7Start = todayStart - 6 * DAY_MS;

  const today: SidebarSessionOption[] = [];
  const yesterday: SidebarSessionOption[] = [];
  const last7: SidebarSessionOption[] = [];
  const older: SidebarSessionOption[] = [];
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
  if (pinned.length > 0) groups.push({ labelKey: "sidebar.groupPinned", items: pinned });
  if (today.length > 0) groups.push({ labelKey: "sidebar.groupToday", items: today });
  if (yesterday.length > 0) groups.push({ labelKey: "sidebar.groupYesterday", items: yesterday });
  if (last7.length > 0) groups.push({ labelKey: "sidebar.groupLast7Days", items: last7 });
  if (older.length > 0) groups.push({ labelKey: "sidebar.groupOlder", items: older });
  return groups;
}
