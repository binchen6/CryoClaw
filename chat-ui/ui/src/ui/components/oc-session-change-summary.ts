import { LitElement, html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import type { FileChange } from "../chat/file-changes.ts";
import { summarizeTurnStats, type TurnStatsLookup } from "../chat/turn-file-stats.ts";
import { icons } from "../icons.ts";
import { t } from "../i18n.ts";

const STATS_DEBOUNCE_MS = 100;
const STATS_RETRY_MS = 1000;

function sameRevision(previous: unknown, next: unknown): boolean {
  return previous === next || (Array.isArray(previous) && Array.isArray(next) &&
    previous.length === next.length && previous.every((item, index) => item === next[index]));
}

@customElement("oc-session-change-summary")
export class OcSessionChangeSummary extends LitElement {
  static properties = {
    files: { attribute: false },
    statsLoader: { attribute: false },
    statsContext: { attribute: false },
    changeRevision: { attribute: false },
    historyRevision: { attribute: false },
    runId: { attribute: false },
    onOpenChanges: { attribute: false },
  };

  files: FileChange[] = [];
  statsLoader?: (paths: string[]) => Promise<TurnStatsLookup>;
  statsContext = "";
  changeRevision?: unknown;
  historyRevision?: unknown;
  runId: string | null = null;
  onOpenChanges?: () => void;
  private added = 0;
  private deleted = 0;
  private complete = false;
  private generation = 0;
  private sourceRevision = 0;
  private previousChangeRevision?: unknown;
  private previousHistoryRevision?: unknown;
  private desiredSignature = "";
  private loadedSignature = "";
  private inFlight = false;
  private retryAfter = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  createRenderRoot() {
    return this;
  }

  protected willUpdate(changed: Map<PropertyKey, unknown>) {
    // 前台 run 投影也会复制数组；只有消息项变动才代表文件可能再次被写入。
    if (!sameRevision(this.previousChangeRevision, this.changeRevision) ||
      !sameRevision(this.previousHistoryRevision, this.historyRevision)) this.sourceRevision += 1;
    this.previousChangeRevision = this.changeRevision;
    this.previousHistoryRevision = this.historyRevision;
    const signature = JSON.stringify([this.statsContext, this.runId, this.sourceRevision, Boolean(this.statsLoader),
      this.files.map(file => [file.path, file.kind])]);
    if (signature !== this.desiredSignature) {
      this.desiredSignature = signature;
      this.retryAfter = 0;
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = undefined;
    }
    // 新闭包/新数组不是新业务数据。在途只记最新签名，完成后最多补拉一次。
    this.scheduleLoad();
  }

  disconnectedCallback() {
    this.generation += 1;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.desiredSignature = "";
    this.loadedSignature = "";
    super.disconnectedCallback();
  }

  private scheduleLoad() {
    if (!this.desiredSignature || this.inFlight || this.timer !== undefined ||
      this.loadedSignature === this.desiredSignature || Date.now() < this.retryAfter) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.load();
    }, STATS_DEBOUNCE_MS);
  }

  private async load() {
    const generation = this.generation;
    const signature = this.desiredSignature;
    const files = this.files;
    const paths = this.files.map((file) => file.path);
    if (!this.statsLoader || paths.length === 0) {
      this.added = 0;
      this.deleted = 0;
      this.complete = false;
      this.loadedSignature = signature;
      this.requestUpdate();
      return;
    }
    this.inFlight = true;
    try {
      let lookup: TurnStatsLookup;
      try { lookup = await this.statsLoader(paths); }
      catch { lookup = { byPath: {}, complete: false }; }
      if (generation !== this.generation || signature !== this.desiredSignature) return;
      const summary = summarizeTurnStats(files, lookup);
      this.added = summary.additions;
      this.deleted = summary.deletions;
      this.complete = summary.lineStatsAvailable;
      if (lookup.complete) this.loadedSignature = signature;
      else this.retryAfter = Date.now() + STATS_RETRY_MS;
      this.requestUpdate();
    } finally {
      this.inFlight = false;
      this.scheduleLoad();
    }
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
