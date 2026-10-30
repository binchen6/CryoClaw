/**
 * Settings: 概览 tab（原「环境信息」重构版，2026.10）。
 * 一页看懂：身份与版本 → 关键计数 → 资源占用 → 运行时 → 网关 → 路径。
 * 数据：settings:get-env-info（主进程汇总 os/process/gateway 运行态）+ 渲染端会话/任务状态。
 * 布局语言：仪表盘——hero 版本 + 状态灯，mono 数字读数，双段内存条为签名元素。
 */
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { t } from "../../i18n.ts";
import { showToast } from "../../app-toast.ts";
import * as ipc from "../../data/ipc-bridge.ts";
import "../../components/message-box.ts";

type OverviewState = {
  initialized: boolean;
  loading: boolean;
  error: string | null;
  info: ipc.EnvInfo | null;
  /** 已复制成功的路径 key（短暂打勾反馈） */
  copiedKey: string | null;
};

const s: OverviewState = { initialized: false, loading: false, error: null, info: null, copiedKey: null };

async function load(state: AppViewState) {
  s.loading = true;
  s.error = null;
  state.requestUpdate();
  try {
    s.info = await ipc.settingsGetEnvInfo();
  } catch (e) {
    s.error = String(e);
  } finally {
    s.loading = false;
    state.requestUpdate();
  }
}

async function init(state: AppViewState) {
  if (s.initialized) return;
  s.initialized = true;
  await load(state);
}

export function resetOverviewTab() {
  s.initialized = false;
  s.loading = false;
  s.error = null;
  s.info = null;
  s.copiedKey = null;
}

/* ── 读数格式化（本页私有约定：内存 GB/MB 一位小数，时长按天/时/分缩写） ── */

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function formatUptime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return t("settings.overview.uptime.dh").replace("{d}", String(d)).replace("{h}", String(h));
  if (h > 0) return t("settings.overview.uptime.hm").replace("{h}", String(h)).replace("{m}", String(m));
  return t("settings.overview.uptime.m").replace("{m}", String(Math.max(1, m)));
}

/** 内核风格的平台行：Windows 11 x64 / macOS 15.2 arm64 */
function formatOsLine(v: NonNullable<ipc.EnvInfo["versions"]>): string {
  const typeMap: Record<string, string> = { Windows_NT: "Windows", Darwin: "macOS", Linux: "Linux" };
  const osName = typeMap[v.osType ?? ""] ?? v.osType ?? "";
  return [osName, v.osRelease, v.arch].filter(Boolean).join(" · ") || "—";
}

/* ── 复制路径 ── */

let copyTimer: ReturnType<typeof setTimeout> | null = null;

async function copyPath(key: string, value: string, state: AppViewState) {
  try {
    await navigator.clipboard.writeText(value);
    s.copiedKey = key;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copyTimer = null;
      s.copiedKey = null;
      state.requestUpdate();
    }, 1500);
    state.requestUpdate();
  } catch {
    showToast(state, t("settings.overview.copyFailed"), undefined, "error");
  }
}

/* ── 小组件 ── */

function renderStat(value: string, label: string) {
  return html`
    <div class="ov-stat">
      <span class="ov-stat__value">${value}</span>
      <span class="ov-stat__label">${label}</span>
    </div>
  `;
}

function renderRow(label: string, value: string) {
  return html`
    <div class="ov-row">
      <span class="ov-row__label">${label}</span>
      <span class="ov-row__value">${value}</span>
    </div>
  `;
}

function renderPathRow(key: string, label: string, value: string, state: AppViewState) {
  const copied = s.copiedKey === key;
  return html`
    <div class="ov-path">
      <span class="ov-row__label">${label}</span>
      <div class="ov-path__right">
        <span class="ov-path__value" title=${value}>${value}</span>
        <button
          class="ov-copy-btn ${copied ? "ov-copy-btn--ok" : ""}"
          type="button"
          title=${t("settings.overview.copy")}
          aria-label=${copied ? t("settings.overview.copied") : t("settings.overview.copy")}
          @click=${() => void copyPath(key, value, state)}
        >
          ${copied
            ? html`<svg class="cryo-icon" aria-hidden="true" focusable="false" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`
            : html`<svg class="cryo-icon" aria-hidden="true" focusable="false" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`}
        </button>
      </div>
    </div>
  `;
}

/** 网关状态灯：running=绿（呼吸）、starting=蓝、其余=灰 */
function renderGatewayPill(info: ipc.EnvInfo) {
  const state = info.gatewayRuntime?.state ?? "unknown";
  const cls = state === "running" ? "ov-pill--ok" : state === "starting" ? "ov-pill--busy" : "ov-pill--idle";
  const label = state === "running"
    ? t("settings.overview.gateway.running")
    : state === "starting"
      ? t("settings.overview.gateway.starting")
      : t("settings.overview.gateway.stopped");
  return html`
    <span class="ov-pill ${cls}">
      <span class="ov-pill__dot"></span>${label}
    </span>
  `;
}

export function renderTabOverview(state: AppViewState) {
  if (!s.initialized) void init(state);
  const info = s.info;
  const sessionsCount = state.sessionsResult?.sessions?.length ?? null;
  const tasksCount = state.runHistory.length > 0 ? state.runHistory.length : null;

  return html`
    <div class="oc-settings__section" data-page-id="settings:overview" data-load-state=${s.loading?"loading":s.error?"error":!s.info?"loading":"ready"} aria-busy=${s.loading || !s.info && !s.error}>
      <div class="ov-head">
        <div>
          <h2 class="oc-settings__section-title">${t("settings.overview.title")}</h2>
          <p class="oc-settings__page-desc">${t("settings.overview.desc")}</p>
        </div>
        <button
          class="ov-refresh-btn"
          type="button"
          ?disabled=${s.loading}
          title=${t("settings.overview.refresh")}
          @click=${() => void load(state)}
        >
          <svg class=${s.loading ? "ov-spin" : ""} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg>
          ${t("settings.overview.refresh")}
        </button>
      </div>

      <oc-message-box .message=${s.error ?? ""} .type=${"error"} .visible=${!!s.error}></oc-message-box>
      ${s.loading && !info ? html`<p class="muted">${t("settings.overview.loading")}</p>` : nothing}

      ${info ? html`
        <!-- hero：身份 + 版本 + 网关状态 -->
        <div class="ov-hero">
          <div class="ov-hero__identity">
            <div class="ov-hero__name-row">
              <span class="ov-hero__name">CryoClaw</span>
              <span class="ov-hero__version">${info.appVersion ?? "—"}</span>
            </div>
            <div class="ov-hero__meta">
              ${t("settings.overview.hero.meta")
                .replace("{kernel}", info.kernelVersion)
                .replace("{electron}", info.versions?.electron ?? "—")}
              ${info.kernelUpdate?.updateAvailable && info.kernelUpdate.latest
                ? html`<span class="ov-kernel-update">${t("settings.overview.kernel.updateAvailable").replace("{v}", info.kernelUpdate.latest)}</span>`
                : nothing}
            </div>
            <div class="ov-hero__meta ov-hero__meta--dim">${formatOsLine(info.versions ?? {})}</div>
          </div>
          <div class="ov-hero__side">
            ${renderGatewayPill(info)}
            <span class="ov-hero__uptime">${t("settings.overview.uptime.label")} ${formatUptime(info.uptimeSec)}</span>
          </div>
        </div>

        <!-- 计数条 -->
        <div class="ov-stats">
          ${renderStat(sessionsCount === null ? "—" : String(sessionsCount), t("settings.overview.stat.sessions"))}
          ${renderStat(String(info.providerKeys.length), t("settings.overview.stat.providers"))}
          ${renderStat(String(info.enabledChannels.length), t("settings.overview.stat.channels"))}
          ${renderStat(String(info.skillsInstalled ?? 0), t("settings.overview.stat.skills"))}
          ${renderStat(
            info.pluginsTotal != null ? `${info.pluginsEnabled ?? 0}/${info.pluginsTotal}` : "—",
            t("settings.overview.stat.plugins"),
          )}
          ${renderStat(tasksCount === null ? "—" : String(tasksCount), t("settings.overview.stat.tasks"))}
        </div>

        <!-- 资源 + 运行时 -->
        <div class="ov-grid">
          <div class="oc-settings__card">
            <div class="oc-settings__card-title">${t("settings.overview.resources")}</div>
            ${info.memory ? html`
              <div class="ov-mem">
                <div class="ov-mem__head">
                  <span class="ov-row__label">${t("settings.overview.mem.system")}</span>
                  <span class="ov-mem__nums">
                    ${formatBytes(info.memory.systemUsed)} / ${formatBytes(info.memory.systemTotal)}
                    <span class="ov-mem__pct">${Math.min(100, Math.round((info.memory.systemUsed / Math.max(1, info.memory.systemTotal)) * 100))}%</span>
                  </span>
                </div>
                <div class="ov-mem__bar" role="img" aria-label=${t("settings.overview.mem.system")}>
                  <div class="ov-mem__fill" style="width:${Math.min(100, (info.memory.systemUsed / Math.max(1, info.memory.systemTotal)) * 100)}%"></div>
                  <div class="ov-mem__app" style="width:${Math.min(100, (info.memory.appBytes / Math.max(1, info.memory.systemTotal)) * 100)}%"></div>
                </div>
                <div class="ov-mem__legend">
                  <span class="ov-mem__key"><span class="ov-mem__swatch ov-mem__swatch--app"></span>CryoClaw ${formatBytes(info.memory.appBytes)}</span>
                  <span class="ov-mem__key"><span class="ov-mem__swatch ov-mem__swatch--sys"></span>${t("settings.overview.mem.other")}</span>
                </div>
              </div>
            ` : nothing}
            ${renderRow(t("settings.overview.cpu"), info.cpu ? `${info.cpu.model} · ${t("settings.overview.cpu.cores").replace("{n}", String(info.cpu.cores))}` : "—")}
          </div>

          <div class="oc-settings__card">
            <div class="oc-settings__card-title">${t("settings.overview.runtime")}</div>
            ${renderRow("Electron", info.versions?.electron ?? "—")}
            ${renderRow("Chromium", info.versions?.chromium ?? "—")}
            ${renderRow("Node.js", info.versions?.node ?? "—")}
            ${renderRow(t("settings.overview.kernel"), info.kernelVersion)}
            ${info.kernelUpdate?.latest
              ? renderRow(
                  t("settings.overview.kernel.latest"),
                  info.kernelUpdate.latest + (info.kernelUpdate.updateAvailable ? ` · ${t("settings.overview.kernel.canUpdate")}` : ` · ${t("settings.overview.kernel.isLatest")}`),
                )
              : nothing}
            ${info.kernelUpdate?.rollbackAvailable ? renderRow(t("settings.overview.kernel.rollback"), t("settings.overview.kernel.rollbackAvailable")) : nothing}
          </div>
        </div>

        <!-- 网关 -->
        <div class="oc-settings__card">
          <div class="oc-settings__card-title">${t("settings.overview.gateway")}</div>
          ${renderRow(t("settings.overview.port"), String(info.gatewayPort))}
          ${renderRow(t("settings.overview.bind"), info.gatewayBind)}
          ${renderRow(t("settings.overview.reloadMode"), info.gatewayReloadMode)}
          ${info.gatewayRuntime?.pid != null ? renderRow("PID", String(info.gatewayRuntime.pid)) : nothing}
          ${info.gatewayRuntime?.uptimeSec != null ? renderRow(t("settings.overview.gateway.uptime"), formatUptime(info.gatewayRuntime.uptimeSec)) : nothing}
        </div>

        <!-- 路径 -->
        ${info.paths ? html`
          <div class="oc-settings__card">
            <div class="oc-settings__card-title">${t("settings.overview.paths")}</div>
            ${renderPathRow("config", t("settings.overview.path.config"), info.paths.config, state)}
            ${renderPathRow("dataDir", t("settings.overview.path.dataDir"), info.paths.dataDir, state)}
            ${renderPathRow("installDir", t("settings.overview.path.installDir"), info.paths.installDir, state)}
            ${info.paths.kernelDir ? renderPathRow("kernelDir", t("settings.overview.path.kernelDir"), info.paths.kernelDir, state) : nothing}
            ${info.paths.gatewayLog ? renderPathRow("gatewayLog", t("settings.overview.path.gatewayLog"), info.paths.gatewayLog, state) : nothing}
          </div>
        ` : nothing}

        ${info.providerKeys.length > 0 ? html`
          <div class="oc-settings__card">
            <div class="oc-settings__card-title">${t("settings.overview.providerList")}</div>
            <div class="ov-chips">
              ${info.providerKeys.map((k) => html`<span class="ov-chip">${k}</span>`)}
            </div>
          </div>
        ` : nothing}

        ${info.enabledChannels.length > 0 ? html`
          <div class="oc-settings__card">
            <div class="oc-settings__card-title">${t("settings.overview.channelList")}</div>
            <div class="ov-chips">
              ${info.enabledChannels.map((k) => html`<span class="ov-chip ov-chip--active">${k}</span>`)}
            </div>
          </div>
        ` : nothing}
      ` : nothing}
    </div>
  `;
}
