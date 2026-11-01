import { LitElement, html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import type { FileChange } from "../chat/file-changes.ts";
import { summarizeTurnStats, type TurnStatsLookup } from "../chat/turn-file-stats.ts";
import { icons } from "../icons.ts";
import { t } from "../i18n.ts";

@customElement("oc-session-change-summary")
export class OcSessionChangeSummary extends LitElement {
  static properties = {
    files: { attribute: false },
    statsLoader: { attribute: false },
    onOpenChanges: { attribute: false },
  };

  files: FileChange[] = [];
  statsLoader?: (paths: string[]) => Promise<TurnStatsLookup>;
  onOpenChanges?: () => void;
  private added = 0;
  private deleted = 0;
  private complete = false;
  private generation = 0;

  createRenderRoot() {
    return this;
  }

  protected willUpdate(changed: Map<PropertyKey, unknown>) {
    if (changed.has("files") || changed.has("statsLoader")) void this.load();
  }

  disconnectedCallback() {
    this.generation += 1;
    super.disconnectedCallback();
  }

  private async load() {
    const generation = ++this.generation;
    const paths = this.files.map((file) => file.path);
    if (!this.statsLoader || paths.length === 0) {
      this.added = 0;
      this.deleted = 0;
      this.complete = false;
      return;
    }
    const lookup = await this.statsLoader(paths);
    if (generation !== this.generation) return;
    const summary = summarizeTurnStats(this.files, lookup);
    this.added = summary.additions;
    this.deleted = summary.deletions;
    this.complete = summary.lineStatsAvailable;
    this.requestUpdate();
  }

  render() {
    if (this.files.length === 0) return nothing;
    const title = this.complete
      ? t("chat.editedFiles").replace("{n}", String(this.files.length))
      : t("chat.fileChange.linesUnavailable");
    return html`<button class="cc-contextbar__changes" type="button" title=${title}
      aria-label=${title} @click=${() => this.onOpenChanges?.()}>
      ${this.complete
        ? html`<span class="cc-contextbar__change-added">+${this.added}</span><span class="cc-contextbar__change-deleted">−${this.deleted}</span>`
        : html`${icons.diff}<span>${this.files.length}</span>`}
    </button>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "oc-session-change-summary": OcSessionChangeSummary;
  }
}
