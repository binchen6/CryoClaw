/**
 * Settings: Plugins Tab（R8 立项，R91 扩展页重构）。
 *
 * 双视图：
 *   - 已安装：内核 `openclaw plugins list --json` 库存（主进程 IPC），
 *     启用开关走 config.patch `plugins.entries.<id>.enabled`（与渠道 tab 同机制），
 *     支持卸载（IPC → 内核 CLI）、检查更新 + 单项/全部更新（plugins update），
 *     插件名可点开详情对话框（plugins inspect）。
 *   - ClawHub 市场：浏览模式（分类关键词聚合 + 推荐算法排序，R91）与
 *     搜索模式（`plugins search`）双形态，一键安装（`plugins install clawhub:<name>`）。
 */
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { t, tWithDetail } from "../../i18n.ts";
import "../../components/toggle-switch.ts";
import "../../components/message-box.ts";
import { runConfigPatch } from "./tab-patch.ts";
import {
  isValidPluginName,
  mapInstalledPlugin,
  mapMarketPlugin,
  sortInstalledPlugins,
  sortMarketPlugins,
  type InstalledPluginView,
  type MarketPluginView,
} from "./tab-plugins.lib.ts";
import { showConfirm } from "../confirm-dialog.ts";
import { showToast } from "../../app-toast.ts";
import { openPluginDetail, openMarketPackageDetail } from "../ext-detail.ts";
import {
  buildRecommendations,
  inferCategory,
  rankMarket,
  diversifyByCategory,
  type MarketCategory,
  type MarketItemCore,
} from "../../market/market-recommend.ts";

type PluginsSubTab = "installed" | "market";

// 市场浏览条目（主进程 plugin-store:market-browse 契约，防御性映射到视图类型）
export type MarketBrowseItemView = MarketPluginView & {
  categories: string[];
  updatedAt?: string;
};

// 可更新条目（plugin-store:check-updates 契约）
type PluginUpdateView = {
  id: string;
  currentVersion: string;
  nextVersion: string;
};

const s = {
  initialized: false,
  loading: false,
  error: null as string | null,
  successMsg: null as string | null,
  installed: [] as InstalledPluginView[],
  // 市场
  subtab: "installed" as PluginsSubTab,
  query: "",
  searching: false,
  marketResults: [] as MarketPluginView[],
  marketLoaded: false,
  // 市场浏览（R91）
  browseMode: true,
  browseLoading: false,
  browseError: null as string | null,
  browseItems: [] as MarketBrowseItemView[],
  browseLoaded: false,
  browseCategory: "all",
  // 发现区渐进展示条数（R92 排版修复）：默认 24，显示更多步进 +24
  discoverCount: 24,
  // 正在安装/卸载的插件名（同一时刻只允许一个操作）
  busyName: null as string | null,
  // 正在切换启用的插件 id
  togglingId: null as string | null,
  // 插件更新（R91）
  checkingUpdates: false,
  updatable: [] as PluginUpdateView[],
  // R93：check-updates 部分失败（HTTP 回退后仍查不到的插件）非阻塞提示
  checkNotice: null as string | null,
  updatingId: null as string | null,
  updatingAll: false,
  needsRestart: false,
};

export function resetPluginsView() {
  // P3-8：离开视图时使在途市场搜索/浏览请求失效——否则迟到响应落地后会把
  // 已清空的 marketResults/browseItems 重新填回并重渲染（对照 tab-backup 的
  // initGeneration 模式；token 判定见 searchMarket/loadMarketBrowse）
  marketSearchToken += 1;
  marketBrowseToken += 1;
  s.initialized = false;
  s.loading = false;
  s.error = null;
  s.successMsg = null;
  s.installed = [];
  s.subtab = "installed";
  s.query = "";
  s.searching = false;
  s.marketResults = [];
  s.marketLoaded = false;
  s.browseMode = true;
  s.browseLoading = false;
  s.browseError = null;
  s.browseItems = [];
  s.browseLoaded = false;
  s.browseCategory = "all";
  s.discoverCount = 24;
  s.busyName = null;
  s.togglingId = null;
  s.checkingUpdates = false;
  s.updatable = [];
  s.checkNotice = null;
  s.updatingId = null;
  s.updatingAll = false;
  s.needsRestart = false;
}

async function loadInstalled(state: AppViewState) {
  if (!window.cryoclaw?.pluginStoreList) return;
  s.loading = true;
  s.error = null;
  state.requestUpdate();
  try {
    const result = await window.cryoclaw.pluginStoreList();
    if (result?.success && Array.isArray(result.data)) {
      s.installed = sortInstalledPlugins(
        result.data.map(mapInstalledPlugin).filter((p: InstalledPluginView | null): p is InstalledPluginView => p !== null),
      );
    } else {
      s.error = result?.message ?? t("settings.plugins.loadFailed");
    }
  } catch {
    s.error = t("settings.plugins.loadFailed");
  } finally {
    s.loading = false;
    state.requestUpdate();
  }
}

function init(state: AppViewState) {
  if (s.initialized) return;
  s.initialized = true;
  void loadInstalled(state);
}

// 启用/禁用：config.patch plugins.entries.<id>.enabled（与渠道 tab 同一写入路径）
async function togglePluginEnabled(state: AppViewState, plugin: InstalledPluginView, next: boolean) {
  if (s.togglingId) return;
  s.togglingId = plugin.id;
  s.error = null;
  s.successMsg = null;
  state.requestUpdate();
  const outcome = await runConfigPatch(state, (draft) => {
    const plugins = (draft.plugins ??= {}) as Record<string, any>;
    const entries = (plugins.entries ??= {}) as Record<string, any>;
    const entry = (entries[plugin.id] ??= {}) as Record<string, any>;
    entry.enabled = next;
  });
  if (outcome.ok) {
    s.installed = s.installed.map((p) => (p.id === plugin.id ? { ...p, enabled: next } : p));
    s.successMsg = outcome.hint ?? t("settings.plugins.enableHint");
  } else {
    s.error = outcome.error ?? t("settings.error.saveFailed");
  }
  s.togglingId = null;
  state.requestUpdate();
}

async function uninstallPlugin(state: AppViewState, plugin: InstalledPluginView) {
  if (!window.cryoclaw?.pluginStoreUninstall || s.busyName || s.updatingId || s.updatingAll) return;
  const confirmed = await showConfirm(
    state,
    t("settings.plugins.uninstallConfirm").replace("{name}", plugin.name),
    { danger: true },
  );
  if (!confirmed) return;
  s.busyName = plugin.id;
  s.error = null;
  state.requestUpdate();
  try {
    const result = await window.cryoclaw.pluginStoreUninstall({ id: plugin.id });
    if (result?.success) {
      showToast(state, t("settings.plugins.uninstallSuccess"));
      await loadInstalled(state);
    } else {
      s.error = result?.message ?? t("settings.plugins.uninstallFailed");
    }
  } catch (err: any) {
    s.error = tWithDetail("settings.plugins.uninstallFailed", err?.message);
  } finally {
    s.busyName = null;
    state.requestUpdate();
  }
}

// 市场搜索请求令牌：连续搜索时丢弃迟到响应（与 app-skills 的 storeRequestToken 同模式）
let marketSearchToken = 0;

async function searchMarket(state: AppViewState) {
  if (!window.cryoclaw?.pluginStoreSearch) return;
  const q = s.query.trim();
  if (!q) return;
  s.browseMode = false;
  const token = ++marketSearchToken;
  s.searching = true;
  s.error = null;
  state.requestUpdate();
  try {
    const result = await window.cryoclaw.pluginStoreSearch({ q, limit: 20 });
    if (token !== marketSearchToken) return;
    if (result?.success && Array.isArray(result.data)) {
      s.marketResults = sortMarketPlugins(
        result.data.map(mapMarketPlugin).filter((p: MarketPluginView | null): p is MarketPluginView => p !== null),
      );
      s.marketLoaded = true;
    } else {
      s.error = result?.message ?? t("settings.plugins.searchFailed");
    }
  } catch {
    if (token !== marketSearchToken) return;
    s.error = t("settings.plugins.searchFailed");
  } finally {
    if (token === marketSearchToken) {
      s.searching = false;
      state.requestUpdate();
    }
  }
}

// 市场浏览请求令牌（与 searchMarket 同理：重试/切页丢弃迟到响应）
let marketBrowseToken = 0;

function mapBrowseItem(raw: unknown): MarketBrowseItemView | null {
  const base = mapMarketPlugin(raw);
  if (!base) return null;
  const p = raw as Record<string, unknown>;
  const categories = Array.isArray(p.categories)
    ? p.categories.filter((c): c is string => typeof c === "string" && Boolean(c.trim()))
    : [];
  return {
    ...base,
    categories,
    ...(typeof p.updatedAt === "string" && p.updatedAt.trim() ? { updatedAt: p.updatedAt } : {}),
  };
}

async function loadMarketBrowse(state: AppViewState) {
  if (!window.cryoclaw?.pluginStoreMarketBrowse) return;
  const token = ++marketBrowseToken;
  s.browseLoading = true;
  s.browseError = null;
  state.requestUpdate();
  try {
    const result = await window.cryoclaw.pluginStoreMarketBrowse({ limit: 20 });
    if (token !== marketBrowseToken) return;
    if (result?.success && result.data && Array.isArray(result.data.items)) {
      s.browseItems = result.data.items
        .map(mapBrowseItem)
        .filter((p: MarketBrowseItemView | null): p is MarketBrowseItemView => p !== null);
      s.browseLoaded = true;
    } else {
      s.browseError = result?.message ?? t("ext.market.loadFailed");
    }
  } catch {
    if (token !== marketBrowseToken) return;
    s.browseError = t("ext.market.loadFailed");
  } finally {
    if (token === marketBrowseToken) {
      s.browseLoading = false;
      state.requestUpdate();
    }
  }
}

// ── 插件更新（R91） ──

async function checkUpdates(state: AppViewState) {
  if (!window.cryoclaw?.pluginStoreCheckUpdates || s.checkingUpdates) return;
  s.checkingUpdates = true;
  s.error = null;
  s.checkNotice = null;
  state.requestUpdate();
  try {
    const result = await window.cryoclaw.pluginStoreCheckUpdates();
    if (result?.success && result.data && Array.isArray(result.data.updatable)) {
      s.updatable = result.data.updatable.filter(
        (u: unknown): u is PluginUpdateView => {
          const e = u as Record<string, unknown>;
          return typeof e.id === "string" && typeof e.currentVersion === "string" && typeof e.nextVersion === "string";
        },
      );
      // R93：部分插件在内核 + HTTP 回退后仍查不到（多为网络不可达）——非阻塞提示
      const failed = result.data.failed;
      if (Array.isArray(failed) && failed.length > 0) {
        s.checkNotice = t("ext.plugins.checkPartialFailed").replace("{ids}", failed.filter((f: unknown): f is string => typeof f === "string").join(", "));
      }
    } else {
      s.error = result?.message ?? t("ext.plugins.checkFailed");
    }
  } catch {
    s.error = t("ext.plugins.checkFailed");
  } finally {
    s.checkingUpdates = false;
    state.requestUpdate();
  }
}

async function runUpdate(state: AppViewState, id?: string) {
  if (!window.cryoclaw?.pluginStoreUpdate) return;
  // 互斥守卫（R91 三审 P1）：更新与安装/卸载都会让内核 CLI 改写同一插件
  // 状态目录，必须全量互斥——三处流的 busy 标记彼此可见
  if (s.busyName || s.updatingId || s.updatingAll) return;
  if (id) {
    s.updatingId = id;
  } else {
    s.updatingAll = true;
  }
  s.error = null;
  state.requestUpdate();
  try {
    const result = await window.cryoclaw.pluginStoreUpdate(id ? { id } : {});
    if (result?.success) {
      if (result.data?.needsRestart) s.needsRestart = true;
      showToast(state, t("ext.plugins.updateDone"));
      // 更新结果行含 each id 的 cur→next，提示行直接展示
      if (result.data?.message) s.successMsg = result.data.message;
      s.updatable = s.updatable.filter((u) => (id ? u.id !== id : false));
      await loadInstalled(state);
    } else {
      s.error = result?.message ?? t("ext.plugins.updateFailed");
    }
  } catch (err: any) {
    s.error = tWithDetail("ext.plugins.updateFailed", err?.message);
  } finally {
    s.updatingId = null;
    s.updatingAll = false;
    state.requestUpdate();
  }
}

function restartGateway(state: AppViewState) {
  window.cryoclaw?.restartGateway?.();
  s.needsRestart = false;
  state.requestUpdate();
}

// ── 个性化 hints：从已安装插件推导（渠道/供应商 id + 名称 token） ──

// 停用词：出现在几乎所有插件名里、无个性化价值的通用 token
const HINT_STOPWORDS = new Set([
  "plugin", "plugins", "openclaw", "channel", "connector", "provider", "extension",
  "official", "tool", "model", "llm", "ai", "bot", "agent", "wrapper", "sdk", "api",
  "integration", "for", "clawhub", "core", "client", "server", "open", "claw",
]);

function deriveHints(installed: InstalledPluginView[]): string[] {
  const tokens = new Set<string>();
  for (const p of installed) {
    for (const id of [p.id, p.name]) {
      for (const token of id.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)) {
        if (token.length >= 3 && !HINT_STOPWORDS.has(token)) tokens.add(token);
      }
    }
  }
  return [...tokens];
}

function installedNameSet(installed: InstalledPluginView[]): Set<string> {
  const names = new Set<string>();
  for (const p of installed) {
    names.add(p.id);
    names.add(p.id.toLowerCase());
    names.add(p.name.toLowerCase());
    // 规范化形态（R92 排版审查修复）：官方包名（@openclaw/deepseek-plugin）与
    // 运行时 id（deepseek）不同名，直接比对会让已装插件仍出现在推荐位——
    // 去掉 @scope/ 与常见 -plugin/-openclaw-plugin 尾巴后再入集合
    names.add(normalizeMarketName(p.id));
    names.add(normalizeMarketName(p.name));
  }
  return names;
}

/** 包名 → 规范化 id：去 @scope/、去 -plugin 类后缀、小写（匹配已装运行时 id） */
function normalizeMarketName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/[-_]?openclaw[-_]?plugin$/, "")
    .replace(/[-_]?plugin$/, "");
}

// ── 渲染 ──

function kindLabel(kind?: string): string {
  if (!kind) return "";
  const key = `settings.plugins.kind.${kind}`;
  const label = t(key);
  return label === key ? kind : label;
}

function renderInstalledRow(state: AppViewState, plugin: InstalledPluginView) {
  const busy = s.busyName === plugin.id;
  const toggling = s.togglingId === plugin.id;
  const update = s.updatable.find((u) => u.id === plugin.id || u.id === plugin.name);
  const updating = s.updatingId === (update?.id ?? null);
  return html`
    <div class="oc-plugins__row">
      <div class="oc-plugins__row-main">
        <div class="oc-plugins__row-head">
          <button
            class="oc-plugins__name-btn"
            type="button"
            title=${t("skillStore.detail")}
            @click=${() => openPluginDetail(state, { id: plugin.id, name: plugin.name })}
          >${plugin.name}</button>
          <span class="oc-plugins__id">${plugin.id}</span>
          ${plugin.kind ? html`<span class="oc-tag oc-tag--muted">${kindLabel(plugin.kind)}</span>` : nothing}
          ${plugin.version ? html`<span class="oc-plugins__version">v${plugin.version}</span>` : nothing}
          ${update
            ? html`<button
                class="oc-tag oc-tag--accent oc-plugins__update-tag"
                type="button"
                ?disabled=${updating || Boolean(s.updatingAll)}
                title="v${update.currentVersion} → v${update.nextVersion}"
                @click=${() => void runUpdate(state, update.id)}
              >${t("ext.plugins.update")} v${update.currentVersion} → v${update.nextVersion}${updating ? "…" : ""}</button>`
            : nothing}
          ${plugin.status === "error" ? html`<span class="oc-tag oc-tag--danger">${t("settings.plugins.statusError")}</span>` : nothing}
        </div>
        ${plugin.description ? html`<div class="oc-plugins__desc" title=${plugin.description}>${plugin.description}</div>` : nothing}
      </div>
      <div class="oc-plugins__row-side">
        <oc-toggle-switch
          .checked=${plugin.enabled}
          .disabled=${toggling}
          .label=${t("settings.plugins.enable")}
          @change=${(e: CustomEvent) => void togglePluginEnabled(state, plugin, e.detail.checked)}
        ></oc-toggle-switch>
        <button
          class="btn btn--sm"
          type="button"
          ?disabled=${busy}
          @click=${() => void uninstallPlugin(state, plugin)}
        >${busy ? t("settings.plugins.uninstalling") : t("settings.plugins.uninstall")}</button>
      </div>
    </div>
  `;
}

function isMarketItemInstalled(item: MarketPluginView): boolean {
  // R92：加规范化形态比对——官方包名（@openclaw/deepseek-plugin）与运行时 id
  // （deepseek）不同名，裸比对会让已装插件在市场仍显示可安装
  const normalized = normalizeMarketName(item.name);
  return s.installed.some((p) =>
    p.id === item.name
    || p.id === item.runtimeId
    || p.name.toLowerCase() === item.name.toLowerCase()
    || normalizeMarketName(p.id) === normalized
    || normalizeMarketName(p.name) === normalized);
}

function renderMarketCard(state: AppViewState, item: MarketPluginView) {
  const installed = isMarketItemInstalled(item);
  const busy = s.busyName === item.name;
  // R92：整卡可点开详情（ClawHub package API）；安装按钮 stopPropagation 不冒泡
  const openDetail = () => openMarketPackageDetail(state, { name: item.name, displayName: item.displayName });
  return html`
    <div class="ext-market__card ext-market__card--clickable" role="button" tabindex="0" @click=${openDetail} @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(); } }}>
      <div class="ext-market__card-head">
        <span class="ext-market__name">${item.displayName ?? item.name}</span>
        ${item.isOfficial ? html`<span class="oc-tag oc-tag--accent">${t("settings.plugins.official")}</span>` : nothing}
        ${item.verificationTier && item.verificationTier.toLowerCase().includes("verified")
          ? html`<span class="oc-tag oc-tag--muted">${t("ext.market.verified")}</span>` : nothing}
      </div>
      ${item.latestVersion ? html`<span class="ext-market__version">v${item.latestVersion}</span>` : nothing}
      ${item.summary ? html`<div class="ext-market__summary">${item.summary}</div>` : nothing}
      <div class="ext-market__meta">
        ${typeof item.downloads === "number" && item.downloads > 0
          ? html`<span>${t("settings.plugins.downloads").replace("{n}", String(item.downloads))}</span>` : nothing}
        ${item.ownerHandle ? html`<span>@${item.ownerHandle}</span>` : nothing}
      </div>
      <div class="ext-market__card-actions" @click=${(e: Event) => e.stopPropagation()}>
        ${installed
          ? html`<span class="oc-plugins__installed-badge">${t("settings.plugins.installedBadge")}</span>`
          : html`<button
              class="btn primary btn--sm"
              type="button"
              ?disabled=${busy}
              @click=${() => void installFromMarket(state, item)}
            >${busy ? t("settings.plugins.installing") : t("settings.plugins.install")}</button>`}
      </div>
    </div>
  `;
}

async function installFromMarket(state: AppViewState, plugin: MarketPluginView) {
  if (!window.cryoclaw?.pluginStoreInstall || s.busyName || s.updatingId || s.updatingAll) return;
  // 冲突检测（R17）：市场包的运行时 id 可能与已安装插件相同，安装会覆盖既有插件
  const collision = plugin.runtimeId
    ? s.installed.find((p) => p.id === plugin.runtimeId)
    : undefined;
  // 安装风险确认：非官方插件明确告知来源与验证级别；冲突时红色强提醒
  const confirmed = await showConfirm(
    state,
    collision
      ? t("settings.plugins.installCollisionConfirm")
          .replace("{name}", plugin.displayName ?? plugin.name)
          .replace("{collision}", collision.name)
      : t("settings.plugins.installConfirm")
          .replace("{name}", plugin.displayName ?? plugin.name)
          .replace("{channel}", plugin.channel ?? "community")
          .replace("{tier}", plugin.verificationTier ?? "unknown"),
    collision ? { danger: true } : undefined,
  );
  if (!confirmed) return;
  s.busyName = plugin.name;
  s.error = null;
  s.successMsg = null;
  state.requestUpdate();
  try {
    const result = await window.cryoclaw.pluginStoreInstall({ name: plugin.name });
    if (result?.success) {
      showToast(state, t("settings.plugins.installSuccess"));
      s.successMsg = result.warning ?? t("settings.plugins.installEnableHint");
      await loadInstalled(state);
    } else {
      s.error = result?.message ?? t("settings.plugins.installFailed");
    }
  } catch (err: any) {
    s.error = tWithDetail("settings.plugins.installFailed", err?.message);
  } finally {
    s.busyName = null;
    state.requestUpdate();
  }
}

// ── 市场浏览（R91：分类聚合 + 推荐算法） ──

const CATEGORY_ORDER: MarketCategory[] = ["channel", "provider", "tool", "memory", "search", "voice", "security", "other"];

function categoryLabel(cat: string): string {
  const key = `ext.market.category.${cat}`;
  const label = t(key);
  return label === key ? cat : label;
}

function renderMarketBrowse(state: AppViewState) {
  if (s.browseLoading && !s.browseLoaded) {
    return html`<div class="oc-settings__hint">${t("chat.loading")}</div>`;
  }
  if (s.browseError) {
    return html`
      <div class="oc-settings__hint">${s.browseError}</div>
      <button class="btn btn--sm" type="button" @click=${() => void loadMarketBrowse(state)}>${t("ext.market.retry")}</button>
    `;
  }
  if (!s.browseItems.length) {
    return html`<div class="oc-settings__hint">${t("ext.market.empty")}</div>`;
  }

  const exclude = installedNameSet(s.installed);
  const hints = deriveHints(s.installed);
  const pool: Array<MarketBrowseItemView & { score?: { total: number } }> = s.browseItems;
  const recommendations = buildRecommendations(pool, { excludeNames: exclude, hints, limit: 6 });
  // R92 排版修复：热门 rail 排除推荐已展示的包（否则同一张卡在两行里连刷两遍）
  const recNames = new Set(recommendations.map((r) => r.name));
  const trending = diversifyByCategory(rankMarket(pool.filter((p) => !recNames.has(p.name)))).slice(0, 8);

  const filtered = s.browseCategory === "all"
    ? pool
    : pool.filter((item) => {
        const cats = item.categories.length > 0 ? item.categories : [inferCategory(item)];
        return cats.includes(s.browseCategory);
      });

  const rail = (items: Array<MarketPluginView>, key: string, hintKey?: string) => html`
    <section class="ext-market__section">
      <h3 class="ext-market__section-title">${t(key)}${hintKey ? html`<span class="ext-market__section-hint">${t(hintKey)}</span>` : nothing}</h3>
      <div class="ext-market__grid">
        ${items.map((item) => renderMarketCard(state, item))}
      </div>
    </section>
  `;

  // 发现区渐进展示（R92 排版修复）：聚合池可达数百条，一次全渲染既是卡片墙
  // 也是 DOM 负担；默认 24 张 +「显示更多」步进，分类切换时复位
  const DISCOVER_PAGE = 24;
  const discoverAll = diversifyByCategory(rankMarket(filtered));
  const discoverVisible = discoverAll.slice(0, s.discoverCount);

  return html`
    ${recommendations.length >= 3 ? rail(recommendations, "ext.market.recommended", "ext.market.recommendedHint") : nothing}
    ${trending.length > 0 ? rail(trending, "ext.market.trending") : nothing}
    <div class="ext-market__chips" role="tablist">
      <button
        class="ext-market__chip ${s.browseCategory === "all" ? "active" : ""}"
        type="button"
        @click=${() => { s.browseCategory = "all"; s.discoverCount = 24; state.requestUpdate(); }}
      >${t("ext.market.category.all")}</button>
      ${CATEGORY_ORDER.map((cat) => {
        const count = pool.filter((item) => {
          const cats = item.categories.length > 0 ? item.categories : [inferCategory(item)];
          return cats.includes(cat);
        }).length;
        if (count === 0) return nothing;
        return html`
          <button
            class="ext-market__chip ${s.browseCategory === cat ? "active" : ""}"
            type="button"
            @click=${() => { s.browseCategory = cat; s.discoverCount = DISCOVER_PAGE; state.requestUpdate(); }}
          >${categoryLabel(cat)} <span class="ext-market__chip-count">${count}</span></button>
        `;
      })}
    </div>
    ${discoverAll.length > 0
      ? html`
        <section class="ext-market__section">
          <h3 class="ext-market__section-title">${s.browseCategory === "all" ? t("ext.market.discover") : categoryLabel(s.browseCategory)}</h3>
          <div class="ext-market__grid">
            ${discoverVisible.map((item) => renderMarketCard(state, item))}
          </div>
          ${discoverAll.length > discoverVisible.length
            ? html`<div class="ext-market__more">
                <button
                  class="btn btn--sm"
                  type="button"
                  @click=${() => { s.discoverCount += DISCOVER_PAGE; state.requestUpdate(); }}
                >${t("ext.market.showMore")}（${discoverAll.length - discoverVisible.length}）</button>
              </div>`
            : nothing}
        </section>
      `
      : html`<div class="oc-settings__hint">${t("ext.market.empty")}</div>`}
  `;
}

function renderMarketBody(state: AppViewState) {
  if (!s.browseMode) {
    // 搜索模式
    if (s.searching && !s.marketLoaded) {
      return html`<div class="oc-settings__hint">${t("chat.loading")}</div>`;
    }
    if (!s.marketResults.length) {
      return html`<div class="oc-settings__hint">${t("ext.market.empty")}</div>`;
    }
    return html`
      <div class="ext-market__grid ext-market__grid--list">
        ${s.marketResults.map((p) => renderMarketCard(state, p))}
      </div>
    `;
  }
  return renderMarketBrowse(state);
}

function renderInstalledBody(state: AppViewState) {
  if (s.loading && s.installed.length === 0) {
    return html`<div class="oc-settings__hint">${t("chat.loading")}</div>`;
  }
  if (!s.installed.length) {
    return html`<div class="oc-settings__hint">${t("settings.plugins.empty")}</div>`;
  }
  return html`<div class="oc-plugins__list">${s.installed.map((p) => renderInstalledRow(state, p))}</div>`;
}

function renderBody(state: AppViewState) {
  if (s.subtab === "installed") {
    return renderInstalledBody(state);
  }
  return renderMarketBody(state);
}

export function renderPluginsView(state: AppViewState) {
  init(state);
  const hasUpdates = s.updatable.length > 0;
  return html`
    <div class="oc-settings__section">
      <h2 class="oc-settings__section-title">${t("settings.plugins.title")}</h2>
      <p class="oc-settings__hint">${t("settings.plugins.desc")}</p>

      <div class="oc-plugins__tabs">
        <button
          class="oc-plugins__tab ${s.subtab ==="installed" ? "oc-plugins__tab--active" : ""}"
          type="button"
          @click=${() => { s.subtab = "installed"; state.requestUpdate(); }}
        >${t("settings.plugins.installed")} (${s.installed.length})</button>
        <button
          class="oc-plugins__tab ${s.subtab ==="market" ? "oc-plugins__tab--active" : ""}"
          type="button"
          @click=${() => {
            s.subtab = "market";
            if (s.browseMode && !s.browseLoaded && !s.browseLoading) void loadMarketBrowse(state);
            state.requestUpdate();
          }}
        >${t("settings.plugins.market")}</button>
      </div>

      ${s.subtab === "installed"
        ? html`<div class="oc-plugins__toolbar">
            <button
              class="btn btn--sm"
              type="button"
              ?disabled=${s.loading || !state.connected}
              @click=${() => void loadInstalled(state)}
            >${t("settings.plugins.refresh")}</button>
            ${window.cryoclaw?.pluginStoreCheckUpdates
              ? html`<button
                  class="btn btn--sm ${hasUpdates ? "primary" : ""}"
                  type="button"
                  ?disabled=${s.checkingUpdates}
                  @click=${() => void checkUpdates(state)}
                >${s.checkingUpdates ? t("ext.plugins.checking") : t("ext.plugins.checkUpdates")}</button>`
              : nothing}
            ${hasUpdates
              ? html`<span class="oc-plugins__updates-badge">${t("ext.plugins.updatesAvailable").replace("{n}", String(s.updatable.length))}</span>
                  <button
                    class="btn primary btn--sm"
                    type="button"
                    ?disabled=${s.updatingAll || Boolean(s.updatingId)}
                    @click=${() => void runUpdate(state)}
                  >${s.updatingAll ? t("ext.plugins.updating") : t("ext.plugins.updateAll")}</button>`
              : nothing}
            ${s.needsRestart
              ? html`<button class="btn danger btn--sm" type="button" @click=${() => restartGateway(state)}>
                  ${t("ext.plugins.restartGateway")}
                </button>`
              : nothing}
          </div>`
        : html`<div class="oc-plugins__toolbar">
            <input
              class="oc-settings__input oc-plugins__search"
              .value=${s.query}
              placeholder=${t("ext.market.searchPlaceholder")}
              @input=${(e: Event) => { s.query = (e.target as HTMLInputElement).value; state.requestUpdate(); }}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter" && !e.isComposing) {
                  e.preventDefault();
                  void searchMarket(state);
                }
              }}
            />
            <button
              class="btn primary btn--sm"
              type="button"
              ?disabled=${s.searching || !s.query.trim()}
              @click=${() => void searchMarket(state)}
            >${t("settings.plugins.search")}</button>
            ${!s.browseMode
              ? html`<button
                  class="btn btn--sm"
                  type="button"
                  @click=${() => {
                    s.browseMode = true;
                    s.marketResults = [];
                    s.marketLoaded = false;
                    if (!s.browseLoaded && !s.browseLoading) void loadMarketBrowse(state);
                    state.requestUpdate();
                  }}
                >${t("ext.market.discover")}</button>`
              : nothing}
          </div>
          ${s.browseMode && s.browseLoaded && s.browseItems.length === 0 && !s.browseLoading
            ? html`<p class="oc-settings__hint">${t("ext.market.browseHint")}</p>`
            : nothing}`}

      <div class="oc-settings__card oc-plugins__card">
        ${renderBody(state)}
      </div>

      <oc-message-box .message=${s.error ?? ""} .type=${"error"} .visible=${!!s.error}></oc-message-box>
      ${s.checkNotice ? html`<p class="oc-settings__hint">${s.checkNotice}</p>` : nothing}
      <oc-message-box .message=${s.successMsg ?? ""} .type=${"success"} .visible=${!!s.successMsg}></oc-message-box>
    </div>
  `;
}
