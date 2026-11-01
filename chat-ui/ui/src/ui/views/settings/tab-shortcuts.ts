import {html} from "lit";
import type {AppViewState} from "../../app-view-state.ts";
import {t} from "../../i18n.ts";
import {icons} from "../../icons.ts";
import {
  BUILTIN_SHORTCUTS, FIXED_SHORTCUTS, filterShortcuts, formatShortcut, getShortcutBinding,
  shortcutFromKeyboardEvent, type ShortcutId,
} from "../../keyboard-shortcuts.ts";

let query = "";
let editingId: ShortcutId | null = null;
let captureError = "";
let statusText = "";

export function resetShortcutsTab() {
  query = "";
  editingId = null;
  captureError = "";
  statusText = "";
}

function saveBinding(state: AppViewState, id: ShortcutId, binding: string) {
  state.applySettings({...state.settings, keyboardShortcuts: {...state.settings.keyboardShortcuts, [id]: binding}});
  statusText = binding ? t("settings.shortcuts.updated") : t("settings.shortcuts.unassigned");
  editingId = null;
  captureError = "";
}

function beginEdit(state: AppViewState, id: ShortcutId) {
  editingId = id;
  captureError = "";
  statusText = "";
  state.requestUpdate();
  requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-shortcut-recorder]")?.focus());
}

function captureBinding(event: KeyboardEvent, state: AppViewState, id: ShortcutId) {
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") {
    editingId = null;
    captureError = "";
    state.requestUpdate();
    return;
  }
  const binding = shortcutFromKeyboardEvent(event);
  if (!binding) {
    captureError = t("settings.shortcuts.invalid");
    state.requestUpdate();
    return;
  }
  const conflict = BUILTIN_SHORTCUTS.find(row => row.id !== id && getShortcutBinding(row.id) === binding);
  if (conflict) {
    captureError = `${t("settings.shortcuts.conflict")}: ${t(`settings.shortcuts.${conflict.id}`)}`;
    state.requestUpdate();
    return;
  }
  saveBinding(state, id, binding);
}

function renderRow(state: AppViewState, id: ShortcutId) {
  const binding = getShortcutBinding(id);
  const keys = formatShortcut(binding);
  const editing = editingId === id;
  return html`<div class="oc-shortcuts__row ${editing ? "is-editing" : ""}" role="listitem">
    <div class="oc-shortcuts__copy"><strong>${t(`settings.shortcuts.${id}`)}</strong><p>${t(`settings.shortcuts.${id}.desc`)}</p></div>
    <div class="oc-shortcuts__binding">
      ${editing ? html`<button type="button" class="oc-shortcuts__recorder" data-shortcut-recorder
        aria-label=${t("settings.shortcuts.pressKeys")} @keydown=${(event: KeyboardEvent) => captureBinding(event, state, id)}>${t("settings.shortcuts.pressKeys")}</button>
        <button type="button" class="icon-btn icon-btn--sm" aria-label=${t("settings.cancel")} @click=${() => {editingId = null; captureError = ""; state.requestUpdate();}}>${icons.x}</button>`
      : html`<span class="oc-shortcuts__keys">${keys.length ? keys.map(key => html`<kbd>${key}</kbd>`) : html`<span class="oc-shortcuts__unassigned">${t("settings.shortcuts.unassigned")}</span>`}</span>
        <button type="button" class="icon-btn icon-btn--sm" aria-label=${t("settings.shortcuts.edit")} title=${t("settings.shortcuts.edit")} @click=${() => beginEdit(state, id)}>${icons.edit}</button>
        <button type="button" class="icon-btn icon-btn--sm" aria-label=${t("settings.shortcuts.clear")} title=${t("settings.shortcuts.clear")} ?disabled=${!binding} @click=${() => saveBinding(state, id, "")}>${icons.x}</button>`}
    </div>
    ${editing ? html`<p class="oc-shortcuts__capture-hint ${captureError ? "is-error" : ""}" role=${captureError ? "alert" : "status"}>${captureError || t("settings.shortcuts.captureHint")}</p>` : ""}
  </div>`;
}

export function renderTabShortcuts(state: AppViewState) {
  const rows = filterShortcuts(BUILTIN_SHORTCUTS.map(row => ({...row,
    label: t(`settings.shortcuts.${row.id}`),
    description: t(`settings.shortcuts.${row.id}.desc`),
    keys: formatShortcut(getShortcutBinding(row.id)),
  })), query);
  return html`<section class="oc-shortcuts" data-page-id="settings:shortcuts" data-load-state="ready" aria-busy="false" aria-labelledby="oc-shortcuts-title">
    <header class="oc-shortcuts__header">
      <div><h2 id="oc-shortcuts-title">${t("settings.nav.shortcuts")}</h2><p class="oc-settings__hint">${t("settings.shortcuts.hint")}</p></div>
      <button type="button" class="btn btn--sm" @click=${() => {state.applySettings({...state.settings, keyboardShortcuts: {}}); editingId = null; captureError = ""; statusText = t("settings.shortcuts.restored");}}>${icons.rotateCcw}${t("settings.shortcuts.restoreDefaults")}</button>
    </header>
    <label class="oc-shortcuts__search">
      ${icons.search}
      <input type="search" class="oc-settings__input" .value=${query}
        aria-label=${t("settings.shortcuts.search")} placeholder=${t("settings.shortcuts.search")}
        @input=${(event: Event) => { query = (event.target as HTMLInputElement).value; state.requestUpdate(); }} />
    </label>
    <p class="oc-settings__hint" role="status" aria-live="polite">${statusText}</p>
    <div class="oc-shortcuts__list" role="list" aria-label=${t("settings.nav.shortcuts")}>
      ${rows.map(row => renderRow(state, row.id))}
    </div>
    <p class="oc-settings__hint" role="status" aria-live="polite">${rows.length ? "" : t("settings.shortcuts.noResults")}</p>
    <h3 class="oc-shortcuts__fixed-title">${t("settings.shortcuts.fixedTitle")}</h3>
    <p class="oc-settings__hint">${t("settings.shortcuts.fixedHint")}</p>
    <div class="oc-shortcuts__list oc-shortcuts__list--fixed" role="list">
      ${FIXED_SHORTCUTS.map(row => html`<div class="oc-shortcuts__row" role="listitem">
        <div class="oc-shortcuts__copy"><strong>${t(`settings.shortcuts.${row.id}`)}</strong><p>${t(`settings.shortcuts.${row.id}.desc`)}</p></div>
        <span class="oc-shortcuts__keys">${row.keys.map(key => html`<kbd>${key}</kbd>`)}</span>
      </div>`)}
    </div>
  </section>`;
}
