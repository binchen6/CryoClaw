/**
 * Worktrees 管理视图 —— 内核 worktrees.list / remove / restore / gc。
 * 布局复用 panel/btn/chip/callout 通用类，卡片样式为 wt-*（misc.css，全 token）。
 * R42 第二期：新增 compact 变体（工作区页左导航区块注入用），隐藏面板级 header，
 * 卡片压成紧凑行，保留 GC/恢复/删除/打开能力；并支持 onSelectRepo 联动切仓库。
 */
import { html, nothing } from "lit";
import { formatRelativeTimestamp } from "../format.ts";
import { icons } from "../icons.ts";
import { t } from "../i18n.ts";
import {
  isLiveWorktree,
  isRestorableWorktree,
  type WorktreeRecord,
} from "../controllers/worktrees.ts";

export type WorktreesProps = {
  loading: boolean;
  error: string | null;
  worktrees: WorktreeRecord[];
  busyIds: ReadonlySet<string>;
  gcBusy: boolean;
  connected: boolean;
  // null = 未探测（无 bridge 的浏览器 dev）；false 时展示降级提示
  gitAvailable: boolean | null;
  onRefresh: () => void;
  onGc: () => void;
  onRemove: (id: string) => void;
  onRestore: (id: string) => void;
  onOpenFolder: (path: string) => void;
  onOpenChat: (sessionKey: string) => void;
  /** 工作区页 compact 卡片行点击 → 切换仓库上下文（worktree→git 联动） */
  onSelectRepo?: (path: string) => void;
};

function ownerLabel(ownerKind: string): string {
  switch (ownerKind) {
    case "session":
      return t("worktrees.owner.session");
    case "workboard":
      return t("worktrees.owner.workboard");
    default:
      return t("worktrees.owner.manual");
  }
}

function renderWorktreeCard(props: WorktreesProps, w: WorktreeRecord, compact: boolean) {
  const live = isLiveWorktree(w);
  const restorable = isRestorableWorktree(w);
  const busy = props.busyIds.has(w.id);
  const timestamp = live ? w.lastActiveAt : (w.removedAt ?? w.lastActiveAt);

  if (compact) {
    return html`
      <div
        class="wt-card wt-card--compact ${live ? "" : "wt-card--removed"}"
        @click=${() => live && props.onSelectRepo?.(w.path)}
      >
        <div class="wt-card__main">
          <div class="wt-card__title">${w.name}</div>
          <div class="chip-row">
            <span class="chip">${icons.gitBranch} ${w.branch}</span>
            <span class="chip">${ownerLabel(w.ownerKind)}</span>
            ${live
              ? html`<span class="chip chip-ok">${t("worktrees.statusLive")}</span>`
              : restorable
                ? html`<span class="chip chip-warn">${t("worktrees.statusRestorable")}</span>`
                : nothing}
          </div>
        </div>
        <div class="wt-card__actions">
          ${live && w.ownerKind === "session" && w.ownerId
            ? html`<button
                class="btn btn--sm wt-card__icon-btn"
                type="button"
                title=${t("worktrees.openChat")}
                @click=${(e: Event) => {
                  e.stopPropagation();
                  props.onOpenChat(w.ownerId!);
                }}
              >${icons.messagePlus}</button>`
            : nothing}
          ${live
            ? html`<button
                class="btn btn--sm wt-card__icon-btn"
                type="button"
                title=${t("worktrees.openFolder")}
                @click=${(e: Event) => {
                  e.stopPropagation();
                  props.onOpenFolder(w.path);
                }}
              >${icons.folderOpen}</button>`
            : nothing}
          ${restorable
            ? html`<button
                class="btn btn--sm wt-card__icon-btn"
                type="button"
                title=${t("worktrees.restore")}
                ?disabled=${busy || !props.connected}
                @click=${(e: Event) => {
                  e.stopPropagation();
                  props.onRestore(w.id);
                }}
              >${busy ? icons.loader : icons.archiveRestore}</button>`
            : nothing}
          ${live
            ? html`<button
                class="btn btn--sm danger wt-card__icon-btn"
                type="button"
                title=${t("worktrees.remove")}
                ?disabled=${busy || !props.connected}
                @click=${(e: Event) => {
                  e.stopPropagation();
                  props.onRemove(w.id);
                }}
              >${busy ? icons.loader : icons.trash}</button>`
            : nothing}
        </div>
      </div>
    `;
  }

  return html`
    <div class="wt-card ${live ? "" : "wt-card--removed"}">
      <div class="wt-card__main">
        <div class="wt-card__title">${w.name}</div>
        <div class="chip-row">
          <span class="chip">${icons.gitBranch} ${w.branch}</span>
          <span class="chip">${ownerLabel(w.ownerKind)}</span>
          ${live
            ? html`<span class="chip chip-ok">${t("worktrees.statusLive")}</span>`
            : restorable
              ? html`<span class="chip chip-warn">${t("worktrees.statusRestorable")}</span>`
              : nothing}
        </div>
        <div class="wt-card__detail" title=${w.path}>${w.path}</div>
      </div>
      <div class="wt-card__meta">
        <span class="wt-card__time">${formatRelativeTimestamp(timestamp)}</span>
        ${live && w.ownerKind === "session" && w.ownerId
          ? html`<button
              class="btn btn--sm"
              type="button"
              @click=${() => props.onOpenChat(w.ownerId!)}
            >
              ${t("worktrees.openChat")}
            </button>`
          : nothing}
        ${live
          ? html`<button
              class="btn btn--sm"
              type="button"
              @click=${() => props.onOpenFolder(w.path)}
            >
              ${t("worktrees.openFolder")}
            </button>`
          : nothing}
        ${restorable
          ? html`<button
              class="btn btn--sm"
              type="button"
              ?disabled=${busy || !props.connected}
              @click=${() => props.onRestore(w.id)}
            >
              ${busy ? icons.loader : nothing}
              ${t("worktrees.restore")}
            </button>`
          : nothing}
        ${live
          ? html`<button
              class="btn danger btn--sm"
              type="button"
              ?disabled=${busy || !props.connected}
              @click=${() => props.onRemove(w.id)}
            >
              ${busy ? icons.loader : nothing}
              ${t("worktrees.remove")}
            </button>`
          : nothing}
      </div>
    </div>
  `;
}

export function renderWorktrees(props: WorktreesProps, opts?: { compact?: boolean }) {
  const compact = opts?.compact === true;
  return html`
    <div class="wt-layout ${compact ? "wt-layout--compact" : ""} panel">
      ${compact
        ? html`<div class="wt-compact-toolbar">
            <button class="btn btn--sm" type="button" ?disabled=${props.gcBusy || !props.connected}
              @click=${props.onGc}>
              ${props.gcBusy ? icons.loader : icons.trash}
              ${props.gcBusy ? t("worktrees.gcBusy") : t("worktrees.gc")}
            </button>
            <button class="btn btn--sm" type="button" ?disabled=${props.loading}
              @click=${props.onRefresh}>
              ${props.loading ? icons.loader : icons.refreshCw}
              ${t("worktrees.refresh")}
            </button>
          </div>`
        : html`
            <div class="wt-header panel__header">
              <div>
                <h2 class="wt-title panel__title">${t("worktrees.title")}</h2>
                <p class="wt-sub panel__subtitle">${t("worktrees.subtitle")}</p>
              </div>
              <div class="wt-toolbar panel__actions">
                <button
                  class="btn"
                  type="button"
                  ?disabled=${props.gcBusy || !props.connected}
                  @click=${props.onGc}
                >
                  ${props.gcBusy ? icons.loader : icons.trash}
                  ${props.gcBusy ? t("worktrees.gcBusy") : t("worktrees.gc")}
                </button>
                <button
                  class="btn"
                  type="button"
                  ?disabled=${props.loading}
                  @click=${props.onRefresh}
                >
                  ${props.loading ? icons.loader : icons.refreshCw}
                  ${t("worktrees.refresh")}
                </button>
              </div>
            </div>`}

      ${props.gitAvailable === false
        ? html`<div class="callout danger">${t("worktrees.gitUnavailable")}</div>`
        : nothing}
      ${props.error ? html`<div class="callout danger">${props.error}</div>` : nothing}

      ${props.worktrees.length === 0
        ? html`<p class="wt-empty panel__empty">${t("worktrees.empty")}</p>`
        : props.worktrees.map((w) => renderWorktreeCard(props, w, compact))}
    </div>
  `;
}
