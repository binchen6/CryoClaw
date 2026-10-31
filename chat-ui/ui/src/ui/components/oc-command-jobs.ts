import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { commandHistory, filterCommandHistory, COMMAND_PAGE_SIZE, type CommandHistoryEntry, type CommandHistoryFilter } from "../chat/command-history.ts";
import { visibleToolCode } from "../chat/tool-presentation.ts";
import { icons } from "../icons.ts";
import { t } from "../i18n.ts";

/** Read-only command invocation history. No RPC, process polling or fake Kill. */
@customElement("oc-command-jobs")
export class OcCommandJobs extends LitElement {
  static properties = { messages: { attribute: false }, sessionKey: { type: String }, locale: { type: String }, filter: { state: true }, limit: { state: true } };
  messages: readonly unknown[] = [];
  sessionKey = "";
  locale = "";
  private filter: CommandHistoryFilter = "recent";
  private limit = COMMAND_PAGE_SIZE;
  private projectedMessages?: readonly unknown[];
  private entries: CommandHistoryEntry[] = [];
  createRenderRoot() { return this; }
  shouldUpdate(changed: PropertyValues) {
    return !this.hasUpdated || ["messages", "sessionKey", "locale", "filter", "limit"].some(key => changed.has(key));
  }
  willUpdate(changed: PropertyValues) {
    if (changed.has("sessionKey")) {
      this.filter = "recent";
      this.limit = COMMAND_PAGE_SIZE;
      // Native disclosure state must not leak between conversations.
      this.querySelectorAll<HTMLDetailsElement>("details[open]").forEach(details => { details.open = false; });
    }
    // app-tool-stream replaces changed messages AND the array; unchanged ticks
    // retain their references. Locale/filter/draft changes need no projection.
    if (this.projectedMessages !== this.messages) {
      this.projectedMessages = this.messages;
      this.entries = commandHistory(this.messages);
    }
  }
  render() {
    if (!this.entries.length) return nothing;
    const filtered = filterCommandHistory(this.entries, this.filter);
    const shown = filtered.slice(0, this.limit);
    const filters: Array<[CommandHistoryFilter, string]> = [
      ["recent", "chat.commandRecent"], ["running", "chat.commandRunning"],
      ["finished", "chat.commandFinished"], ["all", "chat.commandAll"],
    ];
    return html`<details class="chat-command-jobs">
      <summary>${icons.terminal}<span>${t("chat.commandHistory")}</span><span class="chat-command-jobs__count">${this.entries.length}</span>${icons.chevronDown}</summary>
      <div class="chat-command-jobs__body">
        <p class="chat-command-jobs__hint">${t("chat.commandHistoryHint")}</p>
        <div class="chat-command-jobs__filters" role="group" aria-label=${t("chat.commandHistory")}>
          ${filters.map(([filter, key]) => html`<button type="button" aria-pressed=${String(this.filter === filter)} @click=${() => { this.filter = filter; this.limit = COMMAND_PAGE_SIZE; }}>${t(key)}</button>`)}
        </div>
        <div class="chat-command-jobs__list">${shown.length ? repeat(shown, entry => entry.key, entry => html`<details class="chat-command-jobs__entry">
          <summary><span class="chat-command-jobs__state ${entry.failed ? "chat-command-jobs__state--failed" : ""}" aria-label=${entry.pending ? t("chat.commandRunning") : entry.failed ? t("chat.toolFailed") : t("chat.commandFinished")}>${entry.pending ? icons.clock : entry.failed ? icons.x : icons.check}</span><code title=${entry.command.slice(0, 160)}>$ ${entry.command.slice(0, 300)}</code>${entry.exitCode !== undefined ? html`<span class="chat-command-jobs__exit">exit ${entry.exitCode}</span>` : nothing}</summary>
          <button type="button" class="chat-command-jobs__copy" aria-label=${t("chat.codeCopy")} title=${t("chat.codeCopy")}
            @click=${async (event: Event) => {
              const button = event.currentTarget as HTMLButtonElement;
              try { await navigator.clipboard.writeText(entry.command); button.title = t("chat.codeCopied"); }
              catch { button.title = t("chat.codeCopyFailed"); }
              button.setAttribute("aria-label", button.title);
            }}>${icons.copy}</button>
          <pre>${visibleToolCode(entry.command)}</pre>
          ${entry.output ? html`<pre>${visibleToolCode(entry.output)}</pre>` : nothing}
        </details>`) : html`<p class="chat-command-jobs__hint">${t("chat.commandEmpty")}</p>`}</div>
        ${shown.length < filtered.length ? html`<button type="button" class="chat-command-jobs__more" @click=${() => { this.limit += COMMAND_PAGE_SIZE; }}>${t("chat.commandShowMore")}</button>` : nothing}
      </div>
    </details>`;
  }
}
