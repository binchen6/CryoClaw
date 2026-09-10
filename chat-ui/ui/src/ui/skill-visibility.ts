/**
 * skill-visibility.ts — 已安装技能列表的可见集合（纯逻辑）。
 *
 * 计数徽章与列表共用此函数，避免出现"58 项"却只渲染 2 行的偏差（R66 修复）。
 * 独立成模块是为了可被 node:test 直接测试：app-skills.ts 的事件链会 import
 * toggle-switch（构造期使用 CSSStyleSheet 等浏览器 API），测试导入该模块会崩。
 */
import type { SkillStatusEntry } from "./types.ts";

export function selectVisibleInstalledSkills(state: {
  skillsReport?: { skills?: SkillStatusEntry[] } | null;
  skillsFilter?: string | null;
}): SkillStatusEntry[] {
  const allSkills = state.skillsReport?.skills ?? [];
  // 过滤被阻止项（blockedByAllowlist / eligible === false）
  const visibleSkills = allSkills.filter((s: SkillStatusEntry) => s.eligible !== false);
  const filter = (state.skillsFilter ?? "").trim().toLowerCase();
  if (!filter) return visibleSkills;
  return visibleSkills.filter((s: SkillStatusEntry) =>
    [s.name, s.description, s.source].join(" ").toLowerCase().includes(filter),
  );
}
