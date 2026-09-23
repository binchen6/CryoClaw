/**
 * 扩展详情对话框（R91/R92）—— 插件详情（内核 `plugins inspect <id> --json`）、
 * 市场包详情（ClawHub `/api/v1/packages/<name>`）、技能详情（ClawHub
 * `/api/v1/skills/<slug>`，含 readme）的共用模态层。
 * 状态为模块级（对齐 confirm-dialog 的 pending 模式）；同一时刻仅一个详情。
 * readme 走与聊天/侧栏相同的净化 Markdown 链路（DOMPurify 白名单）。
 * R92：head 增加「用 Agent 翻译简介」——把简介/README 组装成翻译提示词预填
 * 聊天输入框并切换到对话视图（复用应用内已有的模型，零新增依赖）。
 */
import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { t } from "../i18n.ts";
import { toSanitizedMarkdownHtml } from "../markdown.ts";
import { formatRelativeTimestamp } from "../format.ts";
import { setCryoClawView } from "../app-view-switch.ts";
import type { AppViewState } from "../app-view-state.ts";

// ── 数据契约（防御性宽松类型：上游字段随版本演进，渲染前逐一收窄） ──

type InspectCapability = { kind?: unknown; ids?: unknown };
type InspectEntry = { name?: unknown; events?: unknown; names?: unknown; optional?: unknown };
type CompatibilityNotice = { code?: unknown; severity?: unknown; message?: unknown };

export type PluginInspectReport = {
  plugin?: {
    id?: unknown;
    name?: unknown;
    version?: unknown;
    description?: unknown;
    format?: unknown;
    origin?: unknown;
    source?: unknown;
    enabled?: unknown;
    status?: unknown;
    error?: unknown;
    channelIds?: unknown;
    providerIds?: unknown;
    toolNames?: unknown;
    hookNames?: unknown;
    commands?: unknown;
    services?: unknown;
  };
  shape?: unknown;
  capabilityMode?: unknown;
  bundleCapabilities?: unknown;
  capabilities?: unknown;
  typedHooks?: unknown;
  customHooks?: unknown;
  tools?: unknown;
  commands?: unknown;
  services?: unknown;
  compatibility?: unknown;
  diagnostics?: unknown;
  install?: {
    source?: unknown;
    spec?: unknown;
    version?: unknown;
    installPath?: unknown;
    clawhubPackage?: unknown;
  };
};

export type SkillDetailData = {
  slug?: unknown;
  name?: unknown;
  description?: unknown;
  version?: unknown;
  downloads?: unknown;
  updatedAt?: unknown;
  author?: unknown;
  readme?: unknown;
  tags?: unknown;
};

/** ClawHub /api/v1/packages/<name> 的信封 { package, owner }（宽松） */
export type MarketPackageDetail = {
  package?: {
    name?: unknown;
    displayName?: unknown;
    summary?: unknown;
    description?: unknown;
    latestVersion?: unknown;
    family?: unknown;
    channel?: unknown;
    isOfficial?: unknown;
    verificationTier?: unknown;
    readme?: unknown;
    stats?: { downloads?: unknown };
    updatedAt?: unknown;
  };
  owner?: { handle?: unknown; displayName?: unknown };
};

type ExtDetail =
  | { kind: "plugin"; key: string; title: string }
  | { kind: "market-package"; key: string; title: string }
  | { kind: "skill"; key: string; title: string; version?: string; downloads?: number; updatedAt?: string; author?: string };

let detail: ExtDetail | null = null;
let loading = false;
let error: string | null = null;
let pluginReport: PluginInspectReport | null = null;
let marketDetail: MarketPackageDetail | null = null;
let skillDetail: SkillDetailData | null = null;
// 请求代次守卫：详情切换/关闭后旧响应晚到不得覆写新内容
let detailToken = 0;

export function isExtDetailOpen(): boolean {
  return detail !== null;
}

export function closeExtDetail(state: AppViewState) {
  detailToken++;
  detail = null;
  loading = false;
  error = null;
  pluginReport = null;
  marketDetail = null;
  skillDetail = null;
  state.requestUpdate();
}

/** 打开插件详情（inspect 数据经 IPC 拉取） */
export function openPluginDetail(state: AppViewState, plugin: { id: string; name: string }) {
  if (!window.cryoclaw?.pluginStoreDetail) return;
  const token = ++detailToken;
  detail = { kind: "plugin", key: plugin.id, title: plugin.name };
  loading = true;
  error = null;
  pluginReport = null;
  marketDetail = null;
  skillDetail = null;
  state.requestUpdate();
  void (async () => {
    try {
      const result = await window.cryoclaw!.pluginStoreDetail!({ id: plugin.id });
      if (token !== detailToken) return;
      if (result?.success && result.data && typeof result.data === "object") {
        pluginReport = result.data as PluginInspectReport;
      } else {
        error = result?.message ?? t("ext.detail.loadFailed");
      }
    } catch {
      if (token !== detailToken) return;
      error = t("ext.detail.loadFailed");
    } finally {
      if (token === detailToken) {
        loading = false;
        state.requestUpdate();
      }
    }
  })();
}

/** 打开市场包详情（ClawHub package API，R92） */
export function openMarketPackageDetail(state: AppViewState, pkg: { name: string; displayName?: string }) {
  if (!window.cryoclaw?.pluginStoreMarketDetail) return;
  const token = ++detailToken;
  detail = { kind: "market-package", key: pkg.name, title: pkg.displayName ?? pkg.name };
  loading = true;
  error = null;
  pluginReport = null;
  marketDetail = null;
  skillDetail = null;
  state.requestUpdate();
  void (async () => {
    try {
      const result = await window.cryoclaw!.pluginStoreMarketDetail!({ name: pkg.name });
      if (token !== detailToken) return;
      if (result?.success && result.data && typeof result.data === "object") {
        marketDetail = result.data as MarketPackageDetail;
      } else {
        error = result?.message ?? t("ext.detail.loadFailed");
      }
    } catch {
      if (token !== detailToken) return;
      error = t("ext.detail.loadFailed");
    } finally {
      if (token === detailToken) {
        loading = false;
        state.requestUpdate();
      }
    }
  })();
}

/** 打开技能详情（ClawHub detail，含 readme；owner 用于多作者 slug 消歧） */
export function openSkillDetail(state: AppViewState, skill: {
  slug: string;
  name: string;
  version?: string;
  downloads?: number;
  updatedAt?: string;
  author?: string;
}) {
  if (!window.cryoclaw?.skillStoreDetail) return;
  const token = ++detailToken;
  detail = {
    kind: "skill",
    key: skill.slug,
    title: skill.name,
    version: skill.version,
    downloads: skill.downloads,
    updatedAt: skill.updatedAt,
    author: skill.author,
  };
  loading = true;
  error = null;
  pluginReport = null;
  marketDetail = null;
  skillDetail = null;
  state.requestUpdate();
  void (async () => {
    try {
      const result = await window.cryoclaw!.skillStoreDetail!({ slug: skill.slug, owner: skill.author });
      if (token !== detailToken) return;
      if (result?.success && result.data && typeof result.data === "object") {
        skillDetail = result.data as SkillDetailData;
      } else {
        error = result?.message ?? t("skillStore.loadDetailFailed");
      }
    } catch {
      if (token !== detailToken) return;
      error = t("skillStore.loadDetailFailed");
    } finally {
      if (token === detailToken) {
        loading = false;
        state.requestUpdate();
      }
    }
  })();
}

// ── 翻译（R92）：把简介组装成提示词预填聊天输入框 ──

// 提示词里塞的简介长度上限：readme 可达数十 KB，塞满输入框没法编辑
const TRANSLATE_TEXT_LIMIT = 4000;

function translateWithAgent(state: AppViewState) {
  if (!detail) return;
  const lines: string[] = [];
  if (detail.kind === "skill") {
    const d = skillDetail ?? {};
    lines.push(`技能：${detail.title}（${detail.key}）`);
    const desc = str(d.description) ?? "";
    if (desc) lines.push(`简介：${desc.slice(0, TRANSLATE_TEXT_LIMIT)}`);
    const readme = str(d.readme);
    if (readme) lines.push(`说明文档（节选）：\n${readme.slice(0, TRANSLATE_TEXT_LIMIT)}`);
  } else if (detail.kind === "market-package") {
    const p = marketDetail?.package ?? {};
    lines.push(`插件：${detail.title}（${detail.key}）`);
    const desc = str(p.summary) ?? str(p.description) ?? "";
    if (desc) lines.push(`简介：${desc.slice(0, TRANSLATE_TEXT_LIMIT)}`);
    const readme = str(p.readme);
    if (readme) lines.push(`说明文档（节选）：\n${readme.slice(0, TRANSLATE_TEXT_LIMIT)}`);
  } else {
    const p = pluginReport?.plugin ?? {};
    lines.push(`插件：${detail.title}（${detail.key}）`);
    const desc = str(p.description);
    if (desc) lines.push(`简介：${desc.slice(0, TRANSLATE_TEXT_LIMIT)}`);
  }
  const prompt = `请把下面的${detail.kind === "skill" ? "技能" : "插件"}介绍翻译成简体中文：先给出一句话总结（它是什么、解决什么问题），再列出主要能力（要点），最后说明适合什么场景使用。保留专有名词与命令原名。\n\n${lines.join("\n\n")}`;
  closeExtDetail(state);
  state.chatMessage = prompt;
  setCryoClawView(state, "chat");
  state.requestUpdate();
}

// ── 渲染辅助 ──

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && Boolean(x.trim())) : [];
}

function kvRow(labelKey: string, value: TemplateResult | string | null) {
  if (value == null || value === "") return nothing;
  return html`
    <div class="ext-detail__row">
      <span class="ext-detail__label">${t(labelKey)}</span>
      <span class="ext-detail__value">${value}</span>
    </div>
  `;
}

function chipList(items: string[], emptyKey = "ext.detail.none"): TemplateResult {
  if (items.length === 0) return html`<span class="ext-detail__muted">${t(emptyKey)}</span>`;
  return html`<span class="ext-detail__chips">${items.map((item) => html`<span class="oc-tag oc-tag--muted">${item}</span>`)}</span>`;
}

function originLabel(origin: unknown): string | null {
  const raw = str(origin);
  if (!raw) return null;
  const known = ["bundled", "npm", "clawhub", "config"] as const;
  const hit = known.find((k) => raw.toLowerCase().includes(k));
  return hit ? t(`ext.detail.origin.${hit}`) : raw;
}

function formatDownloads(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ── 插件详情内容 ──

function renderPluginDetail(report: PluginInspectReport): TemplateResult {
  const p = report.plugin ?? {};
  const capabilities = Array.isArray(report.capabilities)
    ? (report.capabilities as InspectCapability[])
        .map((cap) => ({
          kind: str(cap.kind) ?? "?",
          ids: strArray(cap.ids),
        }))
        // 只展示有具体 id 的能力行：空 id 的“注册型”能力对用户无信息量
        .filter((cap) => cap.ids.length > 0)
    : [];
  const customHooks = Array.isArray(report.customHooks)
    ? (report.customHooks as InspectEntry[]).map((h) => str(h.name) ?? "?")
    : [];
  const tools = Array.isArray(report.tools)
    ? (report.tools as InspectEntry[]).flatMap((entry) => strArray(entry.names))
    : [];
  const compat = Array.isArray(report.compatibility) ? (report.compatibility as CompatibilityNotice[]) : [];
  const install = report.install;
  const installBits = [
    str(install?.source),
    str(install?.spec),
    str(install?.version),
    str(install?.clawhubPackage),
  ].filter((x): x is string => x !== null);

  return html`
    <div class="ext-detail__grid">
      ${kvRow("ext.detail.version", str(p.version))}
      ${kvRow("ext.detail.origin", originLabel(p.origin))}
      ${kvRow("ext.detail.status", str(p.status) ? html`<span class="oc-tag ${p.status === "error" ? "oc-tag--danger" : "oc-tag--muted"}">${str(p.status)}</span>` : null)}
      ${kvRow("ext.detail.description", str(p.description))}
      ${capabilities.length > 0
        ? html`<div class="ext-detail__row">
            <span class="ext-detail__label">${t("ext.detail.capabilities")}</span>
            <span class="ext-detail__value">
              ${capabilities.map((cap) => html`
                <span class="ext-detail__cap">
                  <span class="ext-detail__cap-kind">${cap.kind}</span>
                  ${cap.ids.length > 0 ? chipList(cap.ids) : html`<span class="ext-detail__muted">(${t("ext.detail.none")})</span>`}
                </span>
              `)}
            </span>
          </div>`
        : nothing}
      ${kvRow("ext.detail.channels", strArray(p.channelIds).length ? chipList(strArray(p.channelIds)) : null)}
      ${kvRow("ext.detail.providers", strArray(p.providerIds).length ? chipList(strArray(p.providerIds)) : null)}
      ${kvRow("ext.detail.tools", tools.length ? chipList(tools) : strArray(p.toolNames).length ? chipList(strArray(p.toolNames)) : null)}
      ${kvRow("ext.detail.hooks", customHooks.length ? chipList(customHooks) : strArray(p.hookNames).length ? chipList(strArray(p.hookNames)) : null)}
      ${kvRow("ext.detail.commands", strArray(report.commands).length ? chipList(strArray(report.commands)) : strArray(p.commands).length ? chipList(strArray(p.commands)) : null)}
      ${kvRow("ext.detail.services", strArray(report.services).length ? chipList(strArray(report.services)) : strArray(p.services).length ? chipList(strArray(p.services)) : null)}
      ${kvRow("ext.detail.installRecord", installBits.length ? html`<code class="ext-detail__code">${installBits.join(" · ")}</code>` : null)}
      ${compat.length > 0
        ? html`<div class="ext-detail__row">
            <span class="ext-detail__label">${t("ext.detail.compatibility")}</span>
            <span class="ext-detail__value ext-detail__compat">
              ${compat.map((notice) => html`<div class="ext-detail__compat-item ${str(notice.severity) === "warn" ? "ext-detail__compat-item--warn" : ""}">${str(notice.message) ?? str(notice.code) ?? ""}</div>`)}
            </span>
          </div>`
        : nothing}
      ${str(p.error)
        ? html`<div class="callout danger ext-detail__error">${str(p.error)}</div>`
        : nothing}
    </div>
  `;
}

// ── 市场包详情内容（R92） ──

function renderMarketPackageDetail(meta: { kind: "market-package"; key: string; title: string }, data: MarketPackageDetail | null): TemplateResult {
  const p = data?.package ?? {};
  const owner = data?.owner;
  const ownerHandle = str(owner?.handle) ?? str(owner?.displayName);
  const downloadsRaw = p.stats?.downloads;
  const downloads = typeof downloadsRaw === "number" && downloadsRaw > 0 ? downloadsRaw : null;
  const updatedAt = str(p.updatedAt);
  const updatedMs = updatedAt ? Date.parse(updatedAt) : NaN;
  const readme = str(p.readme);
  const tags: string[] = [];
  if (str(p.family)) tags.push(str(p.family)!);
  if (str(p.channel) && str(p.channel) !== "official") tags.push(str(p.channel)!);
  return html`
    <div class="ext-detail__grid">
      ${kvRow("ext.detail.package", html`<code class="ext-detail__code">${meta.key}</code>`)}
      ${kvRow("ext.detail.version", str(p.latestVersion))}
      ${kvRow("skillStore.author", ownerHandle)}
      ${downloads != null ? kvRow("ext.detail.downloads", formatDownloads(downloads)) : nothing}
      ${!isNaN(updatedMs)
        ? kvRow("skillStore.updated", html`<span title=${updatedAt!}>${formatRelativeTimestamp(updatedMs)}</span>`)
        : nothing}
      ${str(p.summary) ? kvRow("ext.detail.description", str(p.summary)) : nothing}
      ${tags.length > 0 ? kvRow("skillStore.tags", chipList(tags)) : nothing}
      ${readme
        ? html`<div class="ext-detail__readme-block">
            <div class="ext-detail__readme-title">${t("skillStore.readme")}</div>
            <div class="ext-detail__readme markdown-body">${unsafeHTML(toSanitizedMarkdownHtml(readme))}</div>
          </div>`
        : nothing}
    </div>
  `;
}

// ── 技能详情内容 ──

function renderSkillDetail(meta: ExtDetail & { kind: "skill" }, data: SkillDetailData | null): TemplateResult {
  const readme = str(data?.readme);
  const tags = strArray(data?.tags);
  const updatedAt = str(data?.updatedAt) ?? meta.updatedAt ?? null;
  const updatedMs = updatedAt ? Date.parse(updatedAt) : NaN;
  return html`
    <div class="ext-detail__grid">
      ${kvRow("skillStore.version", str(data?.version) ?? meta.version ?? null)}
      ${kvRow("skillStore.author", str(data?.author) ?? meta.author ?? null)}
      ${(typeof data?.downloads === "number" && data.downloads > 0) || (meta.downloads ?? 0) > 0
        ? kvRow("skillStore.downloads", formatDownloads(typeof data?.downloads === "number" ? data.downloads : (meta.downloads ?? 0)))
        : nothing}
      ${!isNaN(updatedMs)
        ? kvRow("skillStore.updated", html`<span title=${updatedAt ?? ""}>${formatRelativeTimestamp(updatedMs)}</span>`)
        : nothing}
      ${tags.length > 0 ? kvRow("skillStore.tags", chipList(tags)) : nothing}
      ${str(data?.description) ? kvRow("ext.detail.description", str(data?.description)) : nothing}
      ${readme
        ? html`<div class="ext-detail__readme-block">
            <div class="ext-detail__readme-title">${t("skillStore.readme")}</div>
            <div class="ext-detail__readme markdown-body">${unsafeHTML(toSanitizedMarkdownHtml(readme))}</div>
          </div>`
        : nothing}
    </div>
  `;
}

// ── 对话框骨架 ──

export function renderExtDetailDialog(state: AppViewState) {
  if (!detail) return nothing;
  const title = detail.title;
  // market-package 与 ext 两种 kind 目前共用 key 作副标题，不做分支
  const sub = detail.key;
  // 翻译入口只在拿到数据后出现（loading/错误态没有可翻内容）
  const canTranslate = !loading && !error;
  return html`
    <div
      class="cc-dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-label=${title}
      tabindex="-1"
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Escape") closeExtDetail(state);
      }}
    >
      <div class="cc-dialog ext-detail__dialog">
        <div class="cc-dialog__head">
          <div class="cc-dialog__title">
            ${title}
            <span class="ext-detail__subtitle">${sub}</span>
          </div>
          <div class="ext-detail__head-actions">
            ${canTranslate
              ? html`<button class="btn btn--sm ext-detail__translate-btn" type="button" @click=${() => translateWithAgent(state)}>
                  ${t("ext.detail.translate")}
                </button>`
              : nothing}
            <button class="cc-dialog__close" type="button" aria-label=${t("ext.detail.close")} @click=${() => closeExtDetail(state)}>×</button>
          </div>
        </div>
        <div class="cc-dialog__body ext-detail__body">
          ${loading
            ? html`<div class="ext-detail__muted">${t("chat.loading")}</div>`
            : error
              ? html`<div class="callout danger">${error}</div>`
              : detail.kind === "plugin"
                ? (pluginReport ? renderPluginDetail(pluginReport) : nothing)
                : detail.kind === "market-package"
                  ? renderMarketPackageDetail(detail, marketDetail)
                  : renderSkillDetail(detail, skillDetail)}
        </div>
      </div>
    </div>
  `;
}
