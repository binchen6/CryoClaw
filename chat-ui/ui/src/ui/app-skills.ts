/**
 * 技能管理视图 —— 已安装技能（gateway RPC）+ 技能商店（clawhub API）的
 * 全部状态与渲染。从 app-render.ts 抽出（阶段 16 架构重构），逻辑未变。
 */

import { html, nothing } from "lit";
import { t } from "./i18n.ts";
import { renderSkillStoreView, type SkillStoreState } from "./skill-store-view.ts";
import { setCryoClawView } from "./app-view-switch.ts";
import { showToast } from "./app-toast.ts";
import "./components/toggle-switch.ts";
import type { SkillStatusEntry } from "./types.ts";
import {
  loadSkills,
  updateSkillEnabled,
  updateSkillEdit,
  saveSkillApiKey,
} from "./controllers/skills.ts";
import type { AppViewState } from "./app-view-state.ts";

// "installed" = 已安装/内置技能（gateway RPC），"store" = 技能商店（clawhub API）
let skillsSubTab: "installed" | "store" = "installed";

// 商店模式：浏览（按排序）或搜索
type StoreMode = "trending" | "downloads" | "updated" | "search";
let storeMode: StoreMode = "trending";

const skillStoreState: SkillStoreState = {
  skills: [],
  installedSlugs: new Set(),
  loading: false,
  error: null,
  searchQuery: "",
  sort: "trending",
  nextCursor: null,
  installingSlugs: new Set(),
  toastMessage: null,
};

let skillStoreDataLoaded = false;

// 商店请求代次守卫：排序/搜索快速切换时旧响应晚到会整体覆写当前列表与
// nextCursor（展示错误排序/旧结果，分页游标错配）。发起前自增，写回前比对。
let storeRequestToken = 0;

// 加载技能列表（初次或切换排序时调用）
async function loadSkillStoreData(state: AppViewState, append = false) {
  if (!window.cryoclaw?.skillStoreList) return;
  const token = ++storeRequestToken;
  skillStoreState.loading = true;
  skillStoreState.error = null;
  state.requestUpdate();
  try {
    const result = await window.cryoclaw.skillStoreList({
      sort: skillStoreState.sort,
      limit: 20,
      cursor: append ? skillStoreState.nextCursor : undefined,
    });
    if (token !== storeRequestToken) return;
    if (result?.success && result.data) {
      const skills = Array.isArray(result.data.skills) ? result.data.skills : [];
      skillStoreState.skills = append
        ? [...skillStoreState.skills, ...skills]
        : skills;
      skillStoreState.nextCursor = result.data.nextCursor ?? null;
    } else {
      skillStoreState.error = result?.message ?? t("skillStore.error");
    }
    // 同步已安装列表
    await refreshInstalledSlugs();
  } catch {
    if (token !== storeRequestToken) return;
    skillStoreState.error = t("skillStore.error");
  } finally {
    if (token === storeRequestToken) {
      skillStoreState.loading = false;
      skillStoreDataLoaded = true;
      state.requestUpdate();
    }
  }
}

// 搜索技能
async function searchSkillStore(state: AppViewState) {
  if (!window.cryoclaw?.skillStoreSearch) return;
  const q = skillStoreState.searchQuery.trim();
  if (!q) {
    skillStoreDataLoaded = false;
    await loadSkillStoreData(state);
    return;
  }
  const token = ++storeRequestToken;
  skillStoreState.loading = true;
  skillStoreState.error = null;
  state.requestUpdate();
  try {
    const result = await window.cryoclaw.skillStoreSearch({ q, limit: 20 });
    if (token !== storeRequestToken) return;
    if (result?.success && result.data) {
      skillStoreState.skills = Array.isArray(result.data.skills) ? result.data.skills : [];
      skillStoreState.nextCursor = null;
    } else {
      skillStoreState.error = result?.message ?? t("skillStore.error");
    }
  } catch {
    if (token !== storeRequestToken) return;
    skillStoreState.error = t("skillStore.error");
  } finally {
    if (token === storeRequestToken) {
      skillStoreState.loading = false;
      state.requestUpdate();
    }
  }
}

// 刷新已安装列表
async function refreshInstalledSlugs() {
  if (!window.cryoclaw?.skillStoreListInstalled) return;
  try {
    const result = await window.cryoclaw.skillStoreListInstalled();
    if (result?.success && Array.isArray(result.data)) {
      skillStoreState.installedSlugs = new Set(result.data);
    }
  } catch { /* ignore */ }
}

// 安装技能
async function installSkillFromStore(state: AppViewState, slug: string) {
  if (!window.cryoclaw?.skillStoreInstall) return;
  skillStoreState.installingSlugs.add(slug);
  state.requestUpdate();
  try {
    const result = await window.cryoclaw.skillStoreInstall({ slug });
    if (result?.success) {
      skillStoreState.installedSlugs.add(slug);
    } else {
      showToast(state, t("skillStore.installFailed"));
    }
  } catch {
    showToast(state, t("skillStore.installFailed"));
  }
  skillStoreState.installingSlugs.delete(slug);
  state.requestUpdate();
}

// 卸载技能
async function uninstallSkillFromStore(state: AppViewState, slug: string) {
  if (!window.cryoclaw?.skillStoreUninstall) return;
  skillStoreState.installingSlugs.add(slug);
  state.requestUpdate();
  try {
    const result = await window.cryoclaw.skillStoreUninstall({ slug });
    if (result?.success) {
      skillStoreState.installedSlugs.delete(slug);
    } else {
      showToast(state, t("skillStore.uninstallFailed"));
    }
  } catch {
    showToast(state, t("skillStore.uninstallFailed"));
  }
  skillStoreState.installingSlugs.delete(slug);
  state.requestUpdate();
}

// 从已安装页面卸载技能（调用 clawhub uninstall 后刷新技能列表）
async function uninstallLocalSkill(state: AppViewState, slug: string) {
  if (!window.cryoclaw?.skillStoreUninstall) return;
  state.skillsBusyKey = slug;
  state.requestUpdate();
  try {
    const result = await window.cryoclaw.skillStoreUninstall({ slug });
    if (result?.success) {
      // 刷新已安装列表和商店已安装标记
      void loadSkills(state);
      await refreshInstalledSlugs();
    } else {
      showToast(state, t("skillStore.uninstallFailed"));
    }
  } catch {
    showToast(state, t("skillStore.uninstallFailed"));
  }
  state.skillsBusyKey = "";
  state.requestUpdate();
}

// ── 已安装技能视图（本地化重写） ──

// 分组定义：id → i18n key
const SKILL_GROUPS = [
  { id: "workspace", i18nKey: "skills.groupWorkspace", sources: ["openclaw-workspace"] },
  { id: "built-in", i18nKey: "skills.groupBuiltIn", sources: ["openclaw-bundled"] },
  { id: "installed", i18nKey: "skills.groupInstalled", sources: ["openclaw-managed"] },
  { id: "extra", i18nKey: "skills.groupExtra", sources: ["openclaw-extra"] },
];

// 按来源分组
function groupLocalSkills(skills: SkillStatusEntry[]) {
  const groups = new Map<string, { id: string; label: string; skills: SkillStatusEntry[] }>();
  for (const def of SKILL_GROUPS) {
    groups.set(def.id, { id: def.id, label: t(def.i18nKey), skills: [] });
  }
  const builtInDef = SKILL_GROUPS.find((g) => g.id === "built-in");
  const other = { id: "other", label: t("skills.groupOther"), skills: [] as SkillStatusEntry[] };
  for (const skill of skills) {
    const match = skill.bundled
      ? builtInDef
      : SKILL_GROUPS.find((g) => g.sources.includes(skill.source));
    if (match) {
      groups.get(match.id)?.skills.push(skill);
    } else {
      other.skills.push(skill);
    }
  }
  const ordered = SKILL_GROUPS
    .map((g) => groups.get(g.id))
    .filter((g): g is NonNullable<typeof g> => Boolean(g && g.skills.length > 0));
  if (other.skills.length > 0) ordered.push(other);
  return ordered;
}

// 字母头像颜色
const SKILL_COLORS = [
  "#c0392b", "#d35400", "#e67e22", "#f39c12",
  "#27ae60", "#1abc9c", "#2980b9", "#8e44ad",
  "#3498db", "#16a085", "#9b59b6", "#34495e",
];
function skillColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  return SKILL_COLORS[Math.abs(h) % SKILL_COLORS.length];
}

// 截断描述
function clamp(text: string | undefined, max: number): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}

// 渲染已安装技能视图
function renderInstalledSkillsView(state: AppViewState) {
  const report = state.skillsReport;
  const allSkills = report?.skills ?? [];
  // 1. 过滤被阻止的 skill（blockedByAllowlist 或 eligible === false）
  const visibleSkills = allSkills.filter((s: SkillStatusEntry) => s.eligible !== false);
  const filter = (state.skillsFilter ?? "").trim().toLowerCase();
  const filtered = filter
    ? visibleSkills.filter((s: SkillStatusEntry) =>
        [s.name, s.description, s.source].join(" ").toLowerCase().includes(filter),
      )
    : visibleSkills;
  const groups = groupLocalSkills(filtered);
  const busy = state.skillsBusyKey;
  const messages = state.skillMessages;

  return html`
    ${state.skillsError
      ? html`<div class="skill-store__error">${state.skillsError}</div>`
      : nothing}

    ${filtered.length === 0 && !state.skillsLoading
      ? html`<div class="skill-store__empty panel__empty">${t("skills.empty")}</div>`
      : nothing}

    ${groups.map((group) => html`
      <details class="skills-group" open>
        <summary class="skills-group__header">
          <span>${group.label}</span>
          <span class="skills-group__count">${group.skills.length}</span>
          <span class="skills-group__chevron"></span>
        </summary>
        <div class="skill-store__list">
          ${group.skills.map((skill: SkillStatusEntry) => {
            const key = skill.skillKey ?? "";
            const isBusy = busy === key;
            const msg = messages[key] ?? null;
            const letter = (skill.emoji || (skill.name ?? "?").charAt(0)).toUpperCase();
            const missing = [
              ...(skill.missing?.bins ?? []).map((b: string) => `bin:${b}`),
              ...(skill.missing?.env ?? []).map((e: string) => `env:${e}`),
              ...(skill.missing?.config ?? []).map((c: string) => `config:${c}`),
              ...(skill.missing?.os ?? []).map((o: string) => `os:${o}`),
            ];
            return html`
              <div class="skill-store__card">
                <div class="skill-store__card-header">
                  <!-- 字母头像底色为固定品牌色板（不随主题变化），字色恒用白色保底对比度 -->
                  <div class="skill-store__card-icon" style="background: ${skillColor(key)}; color: #fff;">
                    <span class="skill-store__card-letter">${letter}</span>
                  </div>
                  <div class="skill-store__card-info">
                    <div class="skill-store__card-name">${skill.name ?? key}</div>
                    <div class="skill-store__card-meta">
                      <span class="skills-badge">${skill.source}</span>
                    </div>
                  </div>
                  <div class="skill-store__card-action">
                    ${skill.source !== "openclaw-bundled"
                      ? html`
                        <button
                          class="skill-card__uninstall"
                          type="button"
                          title="${t("skillStore.uninstall")}"
                          ?disabled=${isBusy}
                          @click=${() => void uninstallLocalSkill(state, key)}
                        ><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>`
                      : nothing}
                    <oc-toggle-switch
                      .checked=${!skill.disabled}
                      ?disabled=${isBusy}
                      aria-label=${t("skills.enable")}
                      @change=${() => void updateSkillEnabled(state, key, !!skill.disabled)}
                    ></oc-toggle-switch>
                  </div>
                </div>
                <div class="skill-store__card-desc">${clamp(skill.description as string, 160)}</div>
                ${missing.length > 0
                  ? html`<div class="skills-missing">${t("skills.missing")}: ${missing.join(", ")}</div>`
                  : nothing}
                ${msg
                  ? html`<div class="skills-msg ${msg.kind === "error" ? "skills-msg--error" : "skills-msg--ok"}">${msg.message}</div>`
                  : nothing}
                ${skill.primaryEnv
                  ? html`
                    <div class="skills-apikey-row">
                      <input
                        class="skill-store__search-input"
                        type="password"
                        placeholder="API key (${skill.primaryEnv})"
                        .value=${state.skillEdits[key] ?? ""}
                        @input=${(e: Event) => updateSkillEdit(state, key, (e.target as HTMLInputElement).value)}
                      />
                      <button
                        class="skill-store__btn skill-store__btn--install"
                        type="button"
                        ?disabled=${isBusy}
                        @click=${() => void saveSkillApiKey(state, key)}
                      >${t("skills.saveKey")}</button>
                    </div>
                  `
                  : nothing}
              </div>
            `;
          })}
        </div>
      </details>
    `)}
  `;
}

// 打开技能管理视图（默认显示已安装技能）
export function openSkillsView(state: AppViewState, subTab: "installed" | "store" = "installed") {
  skillsSubTab = subTab;
  setCryoClawView(state, "skills");
  if (subTab === "installed") {
    void loadSkills(state);
  } else if (!skillStoreDataLoaded) {
    void loadSkillStoreData(state);
  }
}

// 技能视图根渲染（app-render 的视图分支调用）
export function renderSkillsView(state: AppViewState) {
  return html`
    <div class="skills-scroll panel" @scroll=${(e: Event) => {
      if (skillsSubTab !== "store") return;
      if (skillStoreState.loading || !skillStoreState.nextCursor) return;
      const el = e.target as HTMLElement;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) {
        void loadSkillStoreData(state, true);
      }
    }}>
      <section class="skill-store">
        <div class="skill-store__header panel__header">
          <h2 class="skill-store__title panel__title">${t("skillStore.title")}</h2>
        </div>

        <!-- 标签栏 + 右侧操作区 -->
        <div class="skills-tab-bar">
          <button
            class="skills-tab-btn ${skillsSubTab === "installed" ? "active" : ""}"
            type="button"
            @click=${() => {
              skillsSubTab = "installed";
              void loadSkills(state);
              state.requestUpdate();
            }}
          >${t("skills.tabInstalled")}</button>
          <button
            class="skills-tab-btn ${skillsSubTab === "store" ? "active" : ""}"
            type="button"
            @click=${() => {
              skillsSubTab = "store";
              if (!skillStoreDataLoaded) {
                void loadSkillStoreData(state);
              }
              state.requestUpdate();
            }}
          >${t("skills.tabStore")}</button>
          <div class="skills-tab-bar__actions panel__actions">
            ${skillsSubTab === "installed"
              ? html`
                  <span class="skills-count">${t("skills.shown").replace("{n}", String((state.skillsReport?.skills ?? []).length))}</span>
                  <button
                    class="skill-store__sort-btn"
                    type="button"
                    ?disabled=${state.skillsLoading}
                    @click=${() => void loadSkills(state)}
                  >${state.skillsLoading ? t("skills.refreshing") : t("skills.refresh")}</button>
                `
              : html`
                  ${(["trending", "downloads", "updated"] as const).map((key) => html`
                    <button
                      class="skill-store__sort-btn ${storeMode === key ? "active" : ""}"
                      type="button"
                      @click=${() => {
                        storeMode = key;
                        skillStoreState.sort = key;
                        skillStoreState.skills = [];
                        skillStoreState.nextCursor = null;
                        skillStoreState.searchQuery = "";
                        skillStoreState.error = null;
                        skillStoreDataLoaded = false;
                        state.requestUpdate();
                        void loadSkillStoreData(state);
                      }}
                    >${t(`skillStore.sort${key.charAt(0).toUpperCase() + key.slice(1)}`)}</button>
                  `)}
                  <button
                    class="skill-store__sort-btn ${storeMode === "search" ? "active" : ""}"
                    type="button"
                    @click=${() => {
                      storeMode = "search";
                      skillStoreState.skills = [];
                      skillStoreState.nextCursor = null;
                      skillStoreState.searchQuery = "";
                      skillStoreState.error = null;
                      state.requestUpdate();
                      requestAnimationFrame(() => {
                        (state.renderRoot?.querySelector(".skill-store__search-input") as HTMLInputElement)?.focus();
                      });
                    }}
                    data-tooltip="${t("skillStore.search")}"
                  ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button>
                `
            }
          </div>
        </div>

        <!-- 搜索框：已安装 tab 始终显示，商店 tab 仅搜索模式显示 -->
        ${skillsSubTab === "installed" || storeMode === "search"
          ? html`
            <div class="skill-store__toolbar panel__toolbar">
              <div class="skill-store__search">
                <input
                  class="skill-store__search-input"
                  type="text"
                  placeholder=${t(skillsSubTab === "installed" ? "skills.search" : "skillStore.search")}
                  .value=${skillsSubTab === "installed" ? (state.skillsFilter ?? "") : skillStoreState.searchQuery}
                  @input=${(e: Event) => {
                    const val = (e.target as HTMLInputElement).value;
                    if (skillsSubTab === "installed") {
                      state.skillsFilter = val;
                      state.requestUpdate();
                    } else {
                      skillStoreState.searchQuery = val;
                      state.requestUpdate();
                    }
                  }}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === "Enter" && skillsSubTab === "store") {
                      void searchSkillStore(state);
                    }
                  }}
                />
              </div>
            </div>
          `
          : nothing
        }

        <!-- 标签页内容 -->
        ${skillsSubTab === "installed"
          ? renderInstalledSkillsView(state)
          : renderSkillStoreView(skillStoreState, {
              onInstall: (slug) => void installSkillFromStore(state, slug),
              onUninstall: (slug) => void uninstallSkillFromStore(state, slug),
            })
        }
      </section>
    </div>
  `;
}
