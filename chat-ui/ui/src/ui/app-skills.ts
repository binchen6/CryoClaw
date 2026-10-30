/**
 * 技能管理视图 —— 已安装技能（gateway RPC）+ 技能商店（clawhub API）的
 * 全部状态与渲染。从 app-render.ts 抽出（阶段 16 架构重构），逻辑未变。
 */

import { html, nothing } from "lit";
import { t, getLocale } from "./i18n.ts";
const tr=(zh:string,en:string)=>getLocale().startsWith("zh")?zh:en;
import { activateOnKeydown } from "./a11y.ts";
import { icons } from "./icons.ts";
import { renderSkillStoreView, skillAvatarColor, type SkillStoreState, type SkillItem } from "./skill-store-view.ts";
import { selectVisibleInstalledSkills } from "./skill-visibility.ts";
import { showToast } from "./app-toast.ts";
import { openSkillDetail } from "./views/ext-detail.ts";
import {
  buildRecommendations,
  skillToMarketItem,
  type SkillStoreItem,
} from "./market/market-recommend.ts";
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
};

let skillStoreDataLoaded = false;
let localSkillSlugs = new Set<string>();
let localInventoryStarted = false;
let localInventoryPending = 0;
let localInventoryFailed = false;
let localImportBusy = false;

// 商店请求代次守卫：排序/搜索快速切换时旧响应晚到会整体覆写当前列表与
// nextCursor（展示错误排序/旧结果，分页游标错配）。发起前自增，写回前比对。
let storeRequestToken = 0;

// ── 技能更新：仅由用户显式检查，不在进入页面或更新完成后自动重查 ──
let skillUpdates: Array<{ slug: string; current: string | null; latest: string }> | null = null;
let skillUpdatesChecking = false;
let skillUpdatesApplying = false;

async function checkSkillStoreUpdates(state: AppViewState, opts: { force?: boolean; slug?: string } = {}) {
  if (!window.cryoclaw?.skillStoreCheckUpdates) return;
  if (skillUpdatesChecking) return;
  if (skillUpdates !== null && !opts.force && !opts.slug) return;
  skillUpdatesChecking = true;
  state.requestUpdate();
  try {
    const result = await window.cryoclaw.skillStoreCheckUpdates(opts.slug ? {slug:opts.slug} : undefined);
    if (result?.success && Array.isArray(result.data?.updates)) {
      skillUpdates = [...(opts.slug ? (skillUpdates ?? []).filter(u => u.slug !== opts.slug) : []), ...result.data.updates];
      if (opts.force || opts.slug) showToast(state, result.data.updates.length ? tr("发现可用更新，点击详情查看。", "Updates available. Open details to review.") : tr("未发现更新；无版本信息的本地技能无法比较。", "No updates found; unversioned local skills cannot be compared."));
    } else {
      showToast(state, result?.message || t("ext.plugins.checkFailed"), undefined, "error");
      skillUpdates ??= [];
    }
  } catch {
    skillUpdates ??= [];
    if (opts.force || opts.slug) showToast(state,t("ext.plugins.checkFailed"),undefined,"error");
  } finally {
    skillUpdatesChecking = false;
    state.requestUpdate();
  }
}

async function updateAllSkills(state: AppViewState, slug?: string) {
  if (!window.cryoclaw?.skillStoreUpdate || skillUpdatesApplying) return;
  const slugs = slug ? [slug] : (skillUpdates ?? []).map((u) => u.slug);
  if (slugs.length === 0) return;
  skillUpdatesApplying = true;
  state.requestUpdate();
  try {
    const result = await window.cryoclaw.skillStoreUpdate({ slugs });
    const failed = result?.data?.failed?.length ?? 0;
    const updated = result?.data?.updated?.length ?? 0;
    if (result?.success || updated > 0) {
      showToast(
        state,
        failed > 0
          ? t("skillStore.updatePartial").replace("{ok}", String(updated)).replace("{fail}", String(failed))
          : t("skillStore.updateDone").replace("{n}", String(updated)),
        undefined,failed>0?"warning":"success",
      );
    } else {
      showToast(state, t("skillStore.updateFailed"),undefined,"error");
    }
    skillUpdates = null; // 版本表已变；下次由用户手动重查。
    void loadSkills(state);
    await refreshInstalledSlugs();
  } catch {
      showToast(state, t("skillStore.updateFailed"),undefined,"error");
  } finally {
    skillUpdatesApplying = false;
    state.requestUpdate();
  }
}

// ── 技能推荐（R91）：已装技能名 token 作为个性化 hints ──
// 停用词：技能名/渠道名里高频出现、无个性化区分度的通用词
const SKILL_HINT_STOPWORDS = new Set([
  "skill", "skills", "tool", "tools", "agent", "assistant", "helper", "utils",
  "for", "with", "cli", "api", "docs", "doc", "guide", "openclaw", "clawhub",
]);

function deriveSkillHints(installed: string[]): string[] {
  const tokens = new Set<string>();
  for (const name of installed) {
    for (const token of name.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)) {
      if (token.length >= 3 && !SKILL_HINT_STOPWORDS.has(token)) tokens.add(token);
    }
  }
  return [...tokens];
}

/** 商店"为你推荐"栏：排除已安装，个性化加权 + 排序 + 类目多样化，取前 4 */
function renderSkillRecommendations(state: AppViewState): typeof nothing | ReturnType<typeof html> {
  const pool = skillStoreState.skills.filter((s) => s.slug && !skillStoreState.installedSlugs.has(s.slug));
  if (pool.length < 3) return nothing;
  const recs = buildRecommendations(
    pool.map((s) => skillToMarketItem(s as SkillStoreItem)),
    { hints: deriveSkillHints([...skillStoreState.installedSlugs]), limit: 4 },
  );
  if (recs.length < 3) return nothing;
  // slug → 原始条目回查（点击打开详情需要完整 SkillItem）
  const bySlug = new Map(pool.map((s) => [s.slug, s]));
  return html`
    <section class="skill-store__recommend">
      <div class="skill-store__recommend-title">
        ${t("skillStore.recommended")}
        <span class="skill-store__recommend-hint">${t("skillStore.recommendedHint")}</span>
      </div>
      <div class="skill-store__recommend-row">
        ${recs.map((item) => {
          const skill = bySlug.get(item.name);
          if (!skill) return nothing;
          const installing = skillStoreState.installingSlugs.has(skill.slug);
          const letter = (skill.name || skill.slug || "?").charAt(0).toUpperCase();
          return html`
            <div class="skill-store__recommend-card" role="button" tabindex="0"
              @keydown=${activateOnKeydown(() => openSkillDetail(state, skill))}
              @click=${() => openSkillDetail(state, skill)}>
              <span class="skill-store__card-icon" style="background: ${skillAvatarColor(skill.slug)}; color: var(--text-on-accent);">
                <span class="skill-store__card-letter">${letter}</span>
              </span>
              <span class="skill-store__recommend-info">
                <span class="skill-store__recommend-name">${skill.name}</span>
                <span class="skill-store__recommend-desc">${clamp(skill.description, 80)}</span>
              </span>
              <button
                class="skill-store__btn skill-store__btn--install"
                type="button"
                ?disabled=${installing}
                @click=${(e: Event) => {
                  e.stopPropagation();
                  void installSkillFromStore(state, skill.slug);
                }}
              >${installing ? t("skillStore.installing") : t("skillStore.install")}</button>
            </div>
          `;
        })}
      </div>
    </section>
  `;
}

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
      // 裸 message（主进程英文错误）只进 console，UI 统一友好文案（D5）
      console.warn("[skillStore] list failed:", result?.message);
      skillStoreState.error = t("skillStore.error");
    }
    // 同步已安装列表
    await refreshInstalledSlugs();
  } catch (err) {
    if (token !== storeRequestToken) return;
    console.warn("[skillStore] list error:", err);
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
      console.warn("[skillStore] search failed:", result?.message);
      skillStoreState.error = t("skillStore.error");
    }
  } catch (err) {
    if (token !== storeRequestToken) return;
    console.warn("[skillStore] search error:", err);
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
  if (!window.cryoclaw?.skillStoreListInstalled) { localInventoryFailed=true; return; }
  localInventoryPending++;localInventoryFailed=false;
  try {
    const result = await window.cryoclaw.skillStoreListInstalled();
    if (result?.success && Array.isArray(result.data)) {
      skillStoreState.installedSlugs = new Set(result.data);
      localSkillSlugs = new Set(Array.isArray(result.local)?result.local:[]);
    } else localInventoryFailed=true;
  } catch { localInventoryFailed=true; }
  finally { localInventoryPending--; }
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
      showToast(state, t("skillStore.installSuccess"),undefined,"success");
    } else {
      showToast(state, t("skillStore.installFailed"),undefined,"error");
    }
  } catch {
      showToast(state, t("skillStore.installFailed"),undefined,"error");
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
      showToast(state, t("skillStore.uninstallSuccess"),undefined,"success");
    } else {
      showToast(state, t("skillStore.uninstallFailed"),undefined,"error");
    }
  } catch {
      showToast(state, t("skillStore.uninstallFailed"),undefined,"error");
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
      showToast(state, t("skillStore.uninstallSuccess"),undefined,"success");
    } else {
      showToast(state, t("skillStore.uninstallFailed"),undefined,"error");
    }
  } catch {
      showToast(state, t("skillStore.uninstallFailed"),undefined,"error");
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

// 字母头像颜色：色板与哈希函数统一在 skill-store-view.ts（单一来源）

// 截断描述
function clamp(text: string | undefined, max: number): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}

// 已安装技能列表的可见集合（纯逻辑见 skill-visibility.ts）：计数徽章与列表共用，
// 避免出现"58 项"却只渲染 2 行的偏差。
// 加载骨架：首刷无数据时的占位卡片（shimmer），替代空白区域——QA 曾捕获
// 「刷新中 + 0 项 + 大面积空白」。仅在「加载中且尚无数据」时渲染。
function renderSkillsSkeleton() {
  return html`
    <div class="skill-store__list" aria-hidden="true">
      ${[72, 58, 80].map(
        (w) => html`
          <div class="skill-store__card skill-store__card--skeleton">
            <div class="skill-store__card-header">
              <span class="skills-skeleton__avatar"></span>
              <span class="skills-skeleton__line" style="width: ${w}%"></span>
            </div>
            <span class="skills-skeleton__line skills-skeleton__line--desc" style="width: 88%"></span>
          </div>
        `,
      )}
    </div>
  `;
}

// 渲染已安装技能视图
function renderInstalledSkillsView(state: AppViewState) {
  const filtered = selectVisibleInstalledSkills(state);
  const groups = groupLocalSkills(filtered);
  const busy = state.skillsBusyKey;
  const messages = state.skillMessages;

  return html`
    ${state.skillsError
      ? html`<div class="skill-store__error">
          <span>${state.skillsError}</span>
          <button
            class="btn btn--sm"
            type="button"
            ?disabled=${state.skillsLoading}
            @click=${() => void loadSkills(state,{force:true})}
          >${t("ext.market.retry")}</button>
        </div>`
      : nothing}

    ${state.skillsLoading && filtered.length === 0
      ? renderSkillsSkeleton()
      : nothing}

    ${filtered.length === 0 && !state.skillsLoading && !state.skillsError
      ? html`<div class="empty-state">
          <span class="empty-state__icon">${icons.puzzle}</span>
          <div class="empty-state__title">${t("skills.empty")}</div>
        </div>`
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
            const slug = typeof skill.filePath === "string" ? skill.filePath.split(/[\\/]/).slice(-2,-1)[0] || String(skill.name || key) : String(skill.name || key);
            const local = localSkillSlugs.has(slug) || !skillStoreState.installedSlugs.has(slug);
            const update = !local && skillUpdates?.find(u => u.slug === slug || u.slug === key);
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
                  <div class="skill-store__card-icon" style="background: ${skillAvatarColor(key)}; color: var(--text-on-accent);">
                    <span class="skill-store__card-letter">${letter}</span>
                  </div>
                  <div class="skill-store__card-info">
                    <button class="oc-plugins__name-btn" type="button" @click=${() => openSkillDetail(state,{slug,name:skill.name ?? key,local:true})}>${skill.name ?? key}</button>
                    ${update ? html`<div class="skill-store__card-meta"><button class="btn btn--sm" type="button" @click=${() => openSkillDetail(state,{slug,name:skill.name ?? key})}>${update.current} → ${update.latest} · ${t("skillStore.detail")}</button><button class="btn btn--sm" type="button" ?disabled=${skillUpdatesApplying} @click=${() => void updateAllSkills(state,slug)}>${t("ext.plugins.update")}</button></div>` : nothing}
                    <div class="skill-store__card-meta">
                      <span class="skills-badge">${skill.source}</span>
                    </div>
                  </div>
                  <div class="skill-store__card-action">
                    ${!local ? html`<button class="btn btn--sm" type="button" ?disabled=${skillUpdatesChecking || skillUpdatesApplying} @click=${() => void checkSkillStoreUpdates(state,{slug,force:true})}>${t("ext.plugins.checkUpdates")}</button>` : nothing}
                    ${skill.source !== "openclaw-bundled"
                      ? html`
                        <button
                          class="icon-btn icon-btn--danger"
                          type="button"
                          title="${t("skillStore.uninstall")}"
                          aria-label="${t("skillStore.uninstall")}"
                          ?disabled=${isBusy}
                          @click=${() => void uninstallLocalSkill(state, key)}
                        >${icons.trash}</button>`
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
                        aria-label=${`${skill.name}: ${t("skills.saveKey")}`}
                        autocomplete="off"
                        @keydown=${(e: KeyboardEvent) => {
                          if (e.isComposing || e.keyCode === 229 || e.repeat || isBusy) return;
                          if (e.key === "Enter") { e.preventDefault(); void saveSkillApiKey(state, key); }
                        }}
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

// 技能视图根渲染（app-extensions 的扩展视图 skills tab 调用）
export function renderSkillsView(state: AppViewState) {
  if(!localInventoryStarted){localInventoryStarted=true;void refreshInstalledSlugs().then(()=>state.requestUpdate());}
  // 更新检查仅由用户显式触发，不在页面渲染或切换时自动联网。
  const loading=skillsSubTab === "installed"?state.skillsLoading || !state.skillsReport && !state.skillsError || localInventoryPending>0:skillStoreState.loading || localInventoryPending>0;
  const failed=localInventoryFailed || (skillsSubTab === "installed"?state.skillsError:skillStoreState.error);
  const empty=skillsSubTab === "installed"?!selectVisibleInstalledSkills(state).length:!skillStoreState.skills.length;
  return html`
    <div data-page-id=${`extensions:skills:${skillsSubTab}`} data-load-state=${loading?"loading":failed?"error":empty?"empty":"ready"} aria-busy=${loading} class="skills-scroll panel" @scroll=${(e: Event) => {
      if (skillsSubTab !== "store") return;
      if (skillStoreState.loading || !skillStoreState.nextCursor) return;
      const el = e.target as HTMLElement;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) {
        void loadSkillStoreData(state, true);
      }
    }}>
      <section class="skill-store">
        <!-- 标签栏 + 右侧操作区（R94 砍级：原「技能」H2 与 ext-tabs 重复，已移除） -->
        <div class="skills-tab-bar">
          <button
            class="skills-tab-btn ${skillsSubTab === "installed" ? "active" : ""}" data-page-nav="extensions:skills:installed"
            aria-pressed=${skillsSubTab === "installed"}
            type="button"
            @click=${() => {
              skillsSubTab = "installed";
              void loadSkills(state);
              state.requestUpdate();
            }}
          >${t("skills.tabInstalled")}</button>
          <button
            class="skills-tab-btn ${skillsSubTab === "store" ? "active" : ""}" data-page-nav="extensions:skills:store"
            aria-pressed=${skillsSubTab === "store"}
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
            <button class="btn btn--sm" type="button" ?disabled=${localImportBusy || skillUpdatesApplying} @click=${async()=>{
              if(!window.cryoclaw?.skillStoreImportLocal)return;
              localImportBusy=true;state.requestUpdate();
              try{const result=await window.cryoclaw.skillStoreImportLocal();if(!result?.success)showToast(state,result?.message??t("skillStore.error"),undefined,"error");else if(!result.canceled){await refreshInstalledSlugs();await loadSkills(state,{force:true});}}
              catch(error){showToast(state,String(error),undefined,"error");}finally{localImportBusy=false;state.requestUpdate();}
            }}>${t("ext.importLocal")}</button>
            ${skillsSubTab === "installed"
              ? html`
                  <span class="skills-count">${t("skills.shown").replace("{n}", String(selectVisibleInstalledSkills(state).length))}</span>
                  ${skillUpdatesChecking && skillUpdates === null
                    ? html`<span class="skills-count">${t("skillStore.checkingUpdates")}</span>`
                    : nothing}
                  ${skillUpdates && skillUpdates.length > 0
                    ? html`
                      <button
                        class="skill-store__sort-btn skill-store__update-btn"
                        type="button"
                        ?disabled=${skillUpdatesApplying}
                        data-tooltip=${skillUpdates.map((u) => `${u.slug} ${u.current ?? "?"} → ${u.latest}`).join("\n")}
                        @click=${() => void updateAllSkills(state)}
                      >${skillUpdatesApplying
                        ? t("skillStore.updating")
                        : t("skillStore.updateAll").replace("{n}", String(skillUpdates.length))}</button>
                    `
                    : nothing}
                  <button
                    class="skill-store__sort-btn"
                    type="button"
                    ?disabled=${skillUpdatesChecking || skillUpdatesApplying}
                    @click=${() => void checkSkillStoreUpdates(state, { force: true })}
                  >${skillUpdatesChecking ? t("ext.plugins.checking") : t("ext.plugins.checkUpdates")}</button>
                  <button
                    class="skill-store__sort-btn"
                    type="button"
                    ?disabled=${state.skillsLoading}
                    @click=${() => void loadSkills(state,{force:true})}
                  >${state.skillsLoading ? t("skills.refreshing") : t("skills.refresh")}</button>
                `
              : html`
                  ${(["trending", "downloads", "updated"] as const).map((key) => html`
                    <button
                      class="skill-store__sort-btn ${storeMode === key ? "active" : ""}"
                      aria-pressed=${storeMode === key}
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
                    aria-pressed=${storeMode === "search"}
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
                  ><svg class="cryo-icon" aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button>
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
                  aria-label=${t(skillsSubTab === "installed" ? "skills.search" : "skillStore.search")}
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
                    if (e.isComposing || e.keyCode === 229) return;
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
          : html`
              ${renderSkillRecommendations(state)}
              ${renderSkillStoreView(skillStoreState, {
                onInstall: (slug) => void installSkillFromStore(state, slug),
                onUninstall: (slug) => void uninstallSkillFromStore(state, slug),
                onOpenDetail: (skill: SkillItem) => openSkillDetail(state, skill),
              })}
            `
        }
      </section>
    </div>
  `;
}
