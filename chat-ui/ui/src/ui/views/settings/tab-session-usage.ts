import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { loadSessionUsage } from "../../controllers/session-usage.ts";
import { t } from "../../i18n.ts";
import "../../components/message-box.ts";
import { formatTokens } from "../usage-metrics.ts";
import {
  resolveSessionUsageDisplayLabel,
  type SessionUsageRow,
  type UsageTotals,
} from "./tab-session-usage.lib.ts";

const s = {
  rows: [] as SessionUsageRow[],
  totals: null as UsageTotals | null,
  totalSessions: 0,
  loading: false,
  error: null as string | null,
  initialized: false,
  wasConnected: false,
};

async function init(state: AppViewState) {
  await loadSessionUsage(s, state, () => state.requestUpdate());
}

export function resetSessionUsageTab() {
  s.initialized = false;
  s.rows = [];
  s.totals = null;
  s.totalSessions = 0;
  s.error = null;
  s.loading = false;
  s.wasConnected = false;
}

function formatDateTime(ms: number): string {
  return ms ? new Date(ms).toLocaleString() : "";
}

function formatToken(n: number | null): string {
  return n == null || !Number.isFinite(n) ? "—" : formatTokens(n);
}

// cacheWrite is intentionally omitted from totals/rows — see tab-session-usage.lib.ts.
function renderTotals(totals: UsageTotals) {
  return html`
    <div class="oc-session-usage__totals">
      <div class="oc-session-usage__totals-label">${t("settings.sessionUsage.totals.label")}</div>
      <div class="oc-session-usage__totals-tokens">
        <span><span class="oc-session-usage__tag">${t("settings.sessionUsage.tokenIn")}</span> ${formatToken(totals.input)}</span>
        <span class="oc-session-usage__sep">·</span>
        <span><span class="oc-session-usage__tag">${t("settings.sessionUsage.tokenOut")}</span> ${formatToken(totals.output)}</span>
        <span class="oc-session-usage__sep">·</span>
        <span><span class="oc-session-usage__tag">${t("settings.sessionUsage.tokenCacheRead")}</span> ${formatToken(totals.cacheRead)}</span>
      </div>
    </div>
  `;
}

function renderRow(row: SessionUsageRow) {
  const displayLabel = resolveSessionUsageDisplayLabel(row);
  return html`
    <div class="oc-session-usage__row">
      <span
        class="oc-session-usage__label"
        title=${displayLabel}
      >${displayLabel}</span>
      <div class="oc-session-usage__row-tokens">
        <span><span class="oc-session-usage__tag">${t("settings.sessionUsage.tokenIn")}</span> ${formatToken(row.input)}</span>
        <span class="oc-session-usage__sep">·</span>
        <span><span class="oc-session-usage__tag">${t("settings.sessionUsage.tokenOut")}</span> ${formatToken(row.output)}</span>
        <span class="oc-session-usage__sep">·</span>
        <span><span class="oc-session-usage__tag">${t("settings.sessionUsage.tokenCacheRead")}</span> ${formatToken(row.cacheRead)}</span>
      </div>
      <span class="oc-session-usage__time">${formatDateTime(row.updatedAt)}</span>
    </div>
  `;
}

function renderDetailsBody(rows: SessionUsageRow[], loading: boolean) {
  if (loading) return html`<div class="oc-session-usage__empty">…</div>`;
  if (!rows.length) return html`<div class="oc-session-usage__empty">${t("settings.sessionUsage.empty")}</div>`;
  return html`<div class="oc-session-usage__list">${rows.map(renderRow)}</div>`;
}

export function renderTabSessionUsage(state: AppViewState) {
  // Reset on disconnect so a stale "load failed" doesn't persist after the gateway comes back.
  if (s.wasConnected && !state.connected) s.initialized = false;
  s.wasConnected = state.connected;
  if (!s.initialized && !s.loading && state.connected && state.client) init(state);

  return html`
    <div class="oc-settings__section">
      <h2 class="oc-settings__section-title">${t("settings.sessionUsage.pageTitle")}</h2>
      <p class="oc-settings__hint">${t("settings.sessionUsage.pageDesc")}</p>

      ${s.totals && s.rows.length ? renderTotals(s.totals) : nothing}

      <div class="oc-settings__card">
        <div class="oc-settings__card-title oc-session-usage__details-title">${t("settings.sessionUsage.details.title")}</div>
        ${renderDetailsBody(s.rows, s.loading)}
      </div>

      <oc-message-box .message=${s.error ?? ""} .type=${"error"} .visible=${!!s.error}></oc-message-box>
    </div>
  `;
}
