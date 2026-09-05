/**
 * 技能管理视图：搜索栏 + 排序栏 + 技能卡片列表 + 加载更多。
 * 已安装技能排在前面，未安装技能排在后面。
 */
import { html, nothing } from "lit";
import { t } from "./i18n.ts";

export type SkillItem = {
  slug: string;
  name: string;
  description: string;
  version: string;
  downloads: number;
  highlighted: boolean;
  updatedAt: string;
  author: string;
};

export type SkillStoreState = {
  skills: SkillItem[];
  installedSlugs: Set<string>;
  loading: boolean;
  error: string | null;
  searchQuery: string;
  sort: "updated" | "trending" | "downloads";
  nextCursor: string | null;
  installingSlugs: Set<string>;
  toastMessage: string | null;
};

export type SkillStoreCallbacks = {
  onInstall: (slug: string) => void;
  onUninstall: (slug: string) => void;
};

// 字母头像颜色表（根据 slug 哈希取色）。
// 单一来源：app-skills.ts（已安装视图）与本模块共用此色板与哈希函数，
// 数组顺序沿用已安装视图（更高频），商店视图个别 slug 颜色因此有变化，纯外观。
// 2026.9 R3：收敛为 CryoBlue 同族色板 —— 蓝青两系深浅交错，白字对比度均 ≥3:1，
// 整体低饱和同温区，与应用品牌一致、相互易区分。
export const SKILL_AVATAR_COLORS = [
  "#1a6fd0", "#155e75", "#2a89dd", "#164e63",
  "#1659b1", "#0e7490", "#164a90", "#0891b2",
  "#163e75", "#0f2a4e",
];

// 根据 key（slug 或名称）生成确定性颜色
export function skillAvatarColor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return SKILL_AVATAR_COLORS[Math.abs(hash) % SKILL_AVATAR_COLORS.length];
}

// 格式化下载数：>1000 显示 1.2k
function formatDownloads(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// 渲染单个技能卡片
function renderSkillCard(
  skill: SkillItem,
  installed: boolean,
  installing: boolean,
  onInstall: () => void,
  onUninstall: () => void,
) {
  const letter = (skill.name || skill.slug || "?").charAt(0).toUpperCase();
  const bgColor = skillAvatarColor(skill.slug);
  return html`
    <div class="skill-store__card">
      <div class="skill-store__card-header">
        <!-- 字母头像底色为固定品牌色板（不随主题变化），字色恒用白色保底对比度 -->
        <div class="skill-store__card-icon" style="background: ${bgColor}; color: #fff;">
          <span class="skill-store__card-letter">${letter}</span>
        </div>
        <div class="skill-store__card-info">
          <div class="skill-store__card-name">${skill.name}</div>
          <div class="skill-store__card-meta">
            ${skill.version ? html`v${skill.version}` : nothing}
            ${skill.downloads > 0 ? html`<span class="skill-store__card-downloads">${formatDownloads(skill.downloads)} ${t("skillStore.downloads")}</span>` : nothing}
          </div>
        </div>
        <div class="skill-store__card-action">
          ${installed
            ? html`
                <button
                  class="skill-store__btn skill-store__btn--installed"
                  type="button"
                  @click=${onUninstall}
                  ?disabled=${installing}
                >${t("skillStore.uninstall")}</button>
              `
            : html`
                <button
                  class="skill-store__btn skill-store__btn--install"
                  type="button"
                  @click=${onInstall}
                  ?disabled=${installing}
                >${installing ? t("skillStore.installing") : t("skillStore.install")}</button>
              `}
        </div>
      </div>
      <div class="skill-store__card-desc">${skill.description}</div>
    </div>
  `;
}

// 已安装技能排在前面
function sortSkills(skills: SkillItem[], installedSlugs: Set<string>): SkillItem[] {
  return [...skills].sort((a, b) => {
    const ai = installedSlugs.has(a.slug) ? 0 : 1;
    const bi = installedSlugs.has(b.slug) ? 0 : 1;
    return ai - bi;
  });
}

// 技能管理主视图
export function renderSkillStoreView(
  state: SkillStoreState,
  callbacks: SkillStoreCallbacks,
) {
  const sorted = sortSkills(state.skills, state.installedSlugs);
  return html`
    ${state.error
      ? html`<div class="skill-store__error">${state.error}</div>`
      : nothing}

    ${sorted.length === 0 && !state.loading && !state.error
      ? html`<div class="skill-store__empty">${t("skillStore.empty")}</div>`
      : nothing}

    <div class="skill-store__list">
      ${sorted.map((skill) =>
        renderSkillCard(
          skill,
          state.installedSlugs.has(skill.slug),
          state.installingSlugs.has(skill.slug),
          () => callbacks.onInstall(skill.slug),
          () => callbacks.onUninstall(skill.slug),
        ),
      )}
    </div>

    ${state.loading
      ? html`<div class="skill-store__loading">${t("chat.loading")}</div>`
      : nothing}

    ${state.toastMessage
      ? html`<div class="skill-store__toast">${state.toastMessage}</div>`
      : nothing}
  `;
}
