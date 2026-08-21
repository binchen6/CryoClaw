import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { t } from "../../i18n.ts";
import "../../components/message-box.ts";
import {
  fetchApprovalHistory,
  listApprovalHistory,
  resolveApproval,
  type ApprovalHistoryEntry,
} from "../../controllers/approval-history.ts";

const s = {
  loading: false,
  error: null as string | null,
  initialized: false,
  wasConnected: false,
  busyId: null as string | null,
};

async function init(state: AppViewState) {
  const client = state.client;
  if (s.loading || !state.connected || !client) return;
  s.loading = true;
  s.initialized = true;
  s.error = null;
  state.requestUpdate();
  try {
    await fetchApprovalHistory(client);
  } catch {
    // RPC 不存在或报错时优雅降级：仅展示本地事件记录，没有则显示“暂无历史”
  } finally {
    s.loading = false;
    state.requestUpdate();
  }
}

export function resetApprovalsTab() {
  s.initialized = false;
  s.loading = false;
  s.error = null;
  s.busyId = null;
  s.wasConnected = false;
}

async function handleResolve(state: AppViewState, entry: ApprovalHistoryEntry, decision: "allow-once" | "deny") {
  const client = state.client;
  if (!client || s.busyId) return;
  s.busyId = entry.id;
  s.error = null;
  state.requestUpdate();
  try {
    await resolveApproval(client, entry.kind, entry.id, decision);
  } catch {
    s.error = t("settings.approvals.resolveFailed");
  } finally {
    s.busyId = null;
    state.requestUpdate();
  }
}

function formatDateTime(ms: number): string {
  return ms ? new Date(ms).toLocaleString() : "";
}

function statusLabel(status: ApprovalHistoryEntry["status"]): string {
  return t(`settings.approvals.status.${status}`);
}

function renderRow(state: AppViewState, entry: ApprovalHistoryEntry) {
  const isPending = entry.status === "pending";
  return html`
    <div class="oc-approvals__row">
      <div class="oc-approvals__row-main">
        <div class="oc-approvals__row-head">
          <span class="oc-approvals__kind oc-approvals__kind--${entry.kind}">
            ${t(`settings.approvals.kind.${entry.kind}`)}
          </span>
          <span class="oc-approvals__title" title=${entry.title}>${entry.title}</span>
          <span class="oc-approvals__status oc-approvals__status--${entry.status}">
            ${statusLabel(entry.status)}
          </span>
        </div>
        ${entry.detail
          ? html`<div class="oc-approvals__detail" title=${entry.detail}>${entry.detail}</div>`
          : nothing}
      </div>
      <div class="oc-approvals__row-side">
        <span class="oc-approvals__time">${formatDateTime(entry.resolvedAtMs ?? entry.createdAtMs)}</span>
        ${isPending
          ? html`
            <span class="oc-approvals__actions">
              <button
                class="oc-settings__btn oc-settings__btn--primary oc-settings__btn--compact"
                ?disabled=${s.busyId !== null}
                @click=${() => handleResolve(state, entry, "allow-once")}
              >${t("settings.approvals.allowOnce")}</button>
              <button
                class="oc-settings__btn oc-settings__btn--secondary oc-settings__btn--compact"
                ?disabled=${s.busyId !== null}
                @click=${() => handleResolve(state, entry, "deny")}
              >${t("settings.approvals.deny")}</button>
            </span>
          `
          : nothing}
      </div>
    </div>
  `;
}

function renderBody(state: AppViewState) {
  if (s.loading) return html`<div class="oc-approvals__empty">${t("chat.loading")}</div>`;
  const rows = listApprovalHistory();
  if (!rows.length) {
    return html`<div class="oc-approvals__empty">${t("settings.approvals.empty")}</div>`;
  }
  return html`<div class="oc-approvals__list">${rows.map((entry) => renderRow(state, entry))}</div>`;
}

export function renderTabApprovals(state: AppViewState) {
  // 断连后重置，网关恢复时重新拉取
  if (s.wasConnected && !state.connected) s.initialized = false;
  s.wasConnected = state.connected;
  if (!s.initialized && !s.loading && state.connected && state.client) init(state);

  return html`
    <div class="oc-settings__section">
      <h2 class="oc-settings__section-title">${t("settings.approvals.pageTitle")}</h2>
      <p class="oc-settings__hint">${t("settings.approvals.pageDesc")}</p>

      <div class="oc-settings__card">
        <div class="oc-approvals__card-head">
          <div class="oc-settings__card-title oc-approvals__list-title">${t("settings.approvals.listTitle")}</div>
          <button
            class="oc-settings__btn oc-settings__btn--secondary oc-settings__btn--compact"
            ?disabled=${s.loading || !state.connected}
            @click=${() => init(state)}
          >${t("settings.approvals.refresh")}</button>
        </div>
        ${renderBody(state)}
      </div>

      <oc-message-box .message=${s.error ?? ""} .type=${"error"} .visible=${!!s.error}></oc-message-box>
    </div>
  `;
}
