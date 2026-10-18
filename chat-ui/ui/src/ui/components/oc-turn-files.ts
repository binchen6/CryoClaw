import { LitElement, html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { buildChatItemsMemoized, computeSessionFileChangesMemoized } from "./oc-chat-history.ts";
import { icons } from "../icons.ts";
import { t } from "../i18n.ts";

/** Shares the history memo; draft and stream frames do not rescan the transcript. */
@customElement("oc-turn-files")
export class OcTurnFiles extends LitElement {
  static properties = {
    messages: { attribute: false }, toolMessages: { attribute: false },
    visibleHistoryCount: { attribute: false }, gitAvailable: { attribute: false },
    onOpenGit: { attribute: false }, onOpenFile: { attribute: false }, locale: { attribute: false },
  };
  messages: unknown[] = []; toolMessages: unknown[] = []; visibleHistoryCount = 0;
  gitAvailable = false; locale = ""; onOpenGit?: () => void; onOpenFile?: (path: string) => void;
  createRenderRoot() { return this; }
  shouldUpdate(changed: Map<PropertyKey, unknown>) { return [...changed.keys()].some(key => key !== "onOpenGit" && key !== "onOpenFile"); }
  render() {
    const items = buildChatItemsMemoized(this);
    const byGroup = computeSessionFileChangesMemoized(items);
    // Only this turn: starting a new user turn must not show the previous turn's files.
    const latest = items.filter(item => item.kind === "group").at(-1);
    const files = latest ? byGroup.get(latest.key) ?? [] : [];
    if (!files.length) return nothing;
    return html`<details class="chat-turn-files">
      <summary>${icons.diff}<span>${t("chat.fileChanges").replace("{n}", String(files.length))}</span>${icons.chevronDown}</summary>
      <div class="chat-turn-files__popover">
        <div class="chat-turn-files__list">${files.map(file => html`<div class="chat-turn-files__row">
          <span class="chat-file-change__badge chat-file-change__badge--${file.kind}">${t(`chat.fileChange.${file.kind}`)}</span>
          <button type="button" class="chat-turn-files__path" title=${file.path} @click=${() => this.onOpenFile?.(file.path)}>${file.path}</button>
        </div>`)}</div>
        ${this.gitAvailable ? html`<button type="button" class="btn btn--sm" @click=${() => this.onOpenGit?.()}>${icons.diff}${t("chat.viewInGit")}</button>` : nothing}
      </div>
    </details>`;
  }
}
