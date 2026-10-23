import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { BOARD_WIDGET_SANDBOX, type BoardState, type BoardWidget } from "../controllers/board.ts";
import { t } from "../i18n.ts";

/** One active document at a time; generated documents keep an opaque origin. */
@customElement("oc-board-panel")
export class OcBoardPanel extends LitElement {
  static properties = {
    board: {attribute:false}, onRefresh: {attribute:false},
    collapsed: {state:true}, selected: {state:true}, expanded: {state:true},
  };
  board: BoardState | null = null;
  onRefresh?: () => Promise<void>;
  private collapsed = false;
  private selected = "";
  private expanded = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  createRenderRoot() { return this; }

  connectedCallback() {
    super.connectedCallback();
    // Tickets live for 20 minutes. Refresh visible boards before expiry, without
    // creating background activity for hidden windows or collapsed panels.
    this.refreshTimer = setInterval(() => {
      if (!this.collapsed && document.visibilityState === "visible") void this.onRefresh?.();
    }, 15 * 60_000);
  }
  disconnectedCallback() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    super.disconnectedCallback();
  }
  willUpdate(changed: PropertyValues) {
    const previous = changed.get("board") as BoardState | null | undefined;
    if (changed.has("board") && previous?.sessionKey !== this.board?.sessionKey) {
      this.selected = "";this.collapsed = false;this.expanded = false;
    }
    if (!this.board?.widgets.some(widget => widget.name === this.selected)) this.selected = this.board?.widgets[0]?.name ?? "";
  }
  updated() {
    const dialog = this.querySelector("dialog");
    if (this.expanded && dialog && !dialog.open) dialog.showModal();
    else if (!this.expanded && dialog?.open) dialog.close();
  }
  private refresh() { void this.onRefresh?.(); }
  private toggle() {
    this.collapsed = !this.collapsed;
    if (!this.collapsed) this.refresh();
  }
  private frame(widget: BoardWidget) {
    return keyed(widget.name + widget.src, html`<iframe class="chat-board__frame"
      src=${widget.src} title=${widget.name} sandbox=${BOARD_WIDGET_SANDBOX}
      referrerpolicy="no-referrer"></iframe>`);
  }
  private navigation() {
    return html`<div class="chat-board__tabs" role="group" aria-label=${t("chat.board.panels")}>
      ${this.board?.widgets.map(widget => html`<button type="button" class="chat-board__tab"
        aria-pressed=${this.selected === widget.name} @click=${() => {this.selected = widget.name;}}
        title=${widget.kindLabel ?? widget.title ?? widget.name}>${widget.title ?? widget.name}</button>`)}
    </div>`;
  }
  render() {
    const board = this.board;
    const widget = board?.widgets.find(item => item.name === this.selected) ?? board?.widgets[0];
    if (!board || !widget) return nothing;
    const refresh = html`<button type="button" class="btn btn--sm" ?disabled=${board.loading}
      @click=${this.refresh}>${board.loading ? t("chat.board.refreshing") : t("chat.board.refresh")}</button>`;
    const error = board.error ? html`<div class="chat-board__error" role="status">${t("chat.board.refreshFailed")}</div>` : nothing;
    return html`<section class="chat-board" aria-label=${t("chat.board.title")} aria-busy=${board.loading}>
      <div class="chat-board__toolbar">
        <button type="button" class="chat-board__toggle" aria-expanded=${!this.collapsed}
          @click=${this.toggle}><span aria-hidden="true">${this.collapsed ? "▸" : "▾"}</span>
          ${t("chat.board.title")} <span class="chat-board__count">${board.widgets.length}</span></button>
        <div class="chat-board__actions">${refresh}<button type="button" class="btn btn--sm"
          @click=${() => {this.expanded = true;this.refresh();}}>${t("chat.board.expand")}</button></div>
      </div>
      ${!this.collapsed && !this.expanded ? html`${this.navigation()}${error}<div class="chat-board__stage">${this.frame(widget)}</div>` : nothing}
      <dialog class="chat-board__dialog" aria-label=${t("chat.board.title")}
        @close=${() => {this.expanded = false;}} @cancel=${() => {this.expanded = false;}}>
        ${this.expanded ? html`<div class="chat-board__toolbar"><strong>${t("chat.board.title")}</strong>
          <div class="chat-board__actions">${refresh}<button type="button" class="btn btn--sm"
            @click=${() => {this.expanded = false;}}>${t("chat.board.restore")}</button></div></div>
          ${this.navigation()}${error}<div class="chat-board__stage">${this.frame(widget)}</div>` : nothing}
      </dialog>
    </section>`;
  }
}
