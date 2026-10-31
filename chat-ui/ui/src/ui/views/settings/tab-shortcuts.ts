import {html} from "lit";
import type {AppViewState} from "../../app-view-state.ts";
import {t} from "../../i18n.ts";
import {icons} from "../../icons.ts";
import {BUILTIN_SHORTCUTS, filterShortcuts} from "../../keyboard-shortcuts.ts";

let query = "";
export function resetShortcutsTab() { query = ""; }

/** Document only working bindings. No decorative edit/delete controls without a binding backend. */
export function renderTabShortcuts(state: AppViewState) {
  const rows = filterShortcuts(BUILTIN_SHORTCUTS.map(row => ({...row,
    label: t(`settings.shortcuts.${row.id}`),
    description: t(`settings.shortcuts.${row.id}.desc`),
  })), query);
  return html`<section class="oc-shortcuts" data-page-id="settings:shortcuts" data-load-state="ready" aria-busy="false" aria-labelledby="oc-shortcuts-title">
    <header class="oc-shortcuts__header">
      <h2 id="oc-shortcuts-title">${t("settings.nav.shortcuts")}</h2>
      <p class="oc-settings__hint">${t("settings.shortcuts.hint")}</p>
    </header>
    <label class="oc-shortcuts__search">
      ${icons.search}
      <input type="search" class="oc-settings__input" .value=${query}
        aria-label=${t("settings.shortcuts.search")} placeholder=${t("settings.shortcuts.search")}
        @input=${(event: Event) => { query = (event.target as HTMLInputElement).value; state.requestUpdate(); }} />
    </label>
    <div class="oc-shortcuts__list" role="list" aria-label=${t("settings.nav.shortcuts")}>
      ${rows.map(row => html`<div class="oc-shortcuts__row" role="listitem">
        <div class="oc-shortcuts__copy"><strong>${row.label}</strong><p>${row.description}</p></div>
        <span class="oc-shortcuts__keys">${row.keys.map(key => html`<kbd>${key}</kbd>`)}</span>
      </div>`)}
    </div>
    <p class="oc-settings__hint" role="status" aria-live="polite">${rows.length ? "" : t("settings.shortcuts.noResults")}</p>
  </section>`;
}
