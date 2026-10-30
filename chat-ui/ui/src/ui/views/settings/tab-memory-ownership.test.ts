import test from "node:test";
import assert from "node:assert/strict";
import { html } from "lit";
import type { AppViewState } from "../../app-view-state.ts";

type View = { strings: readonly string[]; values: unknown[] };
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(done => { resolve = done; }); return { promise, resolve }; }
async function tick() { for (let n = 0; n < 12; n++) await Promise.resolve(); }
function templates(value: unknown): View[] {
  if (Array.isArray(value)) return value.flatMap(templates);
  if (!value || typeof value !== "object" || !("strings" in value)) return [];
  const view = value as View; return [view, ...view.values.flatMap(templates)];
}
function flatten(value: unknown): string {
  return typeof value === "string" ? value : Array.isArray(value) ? value.map(flatten).join(" ")
    : value && typeof value === "object" && "values" in value ? flatten((value as View).values) : "";
}
function click(view: View, marker: string, index = 0) {
  const target = templates(view).filter(row => row.strings.some(text => text.includes(marker)))[index];
  assert.ok(target, marker);
  const binding = target.strings.findIndex(text => text.includes("@click="));
  assert.ok(binding >= 0); return (target.values[binding] as () => unknown)();
}
const original = { window: globalThis.window, document: globalThis.document, CSSStyleSheet: globalThis.CSSStyleSheet };
Object.assign(globalThis, { CSSStyleSheet: class { replaceSync() {} }, document: { adoptedStyleSheets: [] }, window: { cryoclaw: {} } });
void html;
const module = import("./tab-memory.ts");
test.after(() => { Object.assign(globalThis, original); });
const state = { client: null, connected: false, configuredModels: [], requestUpdate() {} } as unknown as AppViewState;
const workspace = (title: string) => ({ success: true, data: { entries: [{ id: "same", kind: "long-term", title, snippet: "preview", mtimeMs: null }], longTermCount: 1, dailyCount: 0, hasLongTermFile: true } });
const dreams = (title: string) => ({ success: true, data: { found: true, entries: [{ index: 0, dateText: title, dateMs: null, snippet: title, chars: 10 }] } });

for (const kind of ["workspace", "dreams"] as const) {
  test(`${kind}: a previous view cannot overwrite a completed current list or surface an old failure`, async () => {
    const { renderTabMemory, resetMemoryTab } = await module;
    for (const failure of [false, true]) {
      const old = deferred(), fresh = deferred(); let calls = 0;
      Object.assign(window, { cryoclaw: {
        memoryListWorkspace: () => kind === "workspace" ? (++calls === 1 ? old.promise : fresh.promise) : Promise.resolve(workspace("other")),
        memoryListDreams: () => kind === "dreams" ? (++calls === 1 ? old.promise : fresh.promise) : Promise.resolve(dreams("other")),
      } });
      resetMemoryTab(); renderTabMemory(state); resetMemoryTab(); renderTabMemory(state);
      fresh.resolve(kind === "workspace" ? workspace("CURRENT_ENTRY") : dreams("CURRENT_ENTRY")); await tick();
      old.resolve(failure ? { success: false, message: "old failure" } : kind === "workspace" ? workspace("OLD_ENTRY") : dreams("OLD_ENTRY")); await tick();
      click(renderTabMemory(state) as unknown as View, "oc-memory-subtabs__btn", kind === "workspace" ? 1 : 2);
      const text = flatten(renderTabMemory(state));
      assert.ok(text.includes("CURRENT_ENTRY")); assert.equal(text.includes("OLD_ENTRY"), false);
    }
  });

  test(`${kind}: leaving and reopening rejects old IPC data and old completion flags`, async () => {
    const { renderTabMemory, resetMemoryTab } = await module;
    const old = deferred(), fresh = deferred(); let calls = 0;
    Object.assign(window, { cryoclaw: {
      memoryListWorkspace: () => kind === "workspace" ? (++calls === 1 ? old.promise : fresh.promise) : Promise.resolve(workspace("other")),
      memoryListDreams: () => kind === "dreams" ? (++calls === 1 ? old.promise : fresh.promise) : Promise.resolve(dreams("other")),
    } });
    resetMemoryTab(); renderTabMemory(state); resetMemoryTab(); renderTabMemory(state);
    old.resolve(kind === "workspace" ? workspace("OLD_ENTRY") : dreams("OLD_ENTRY")); await tick();
    click(renderTabMemory(state) as unknown as View, "oc-memory-subtabs__btn", kind === "workspace" ? 1 : 2);
    assert.equal(flatten(renderTabMemory(state)).includes("OLD_ENTRY"), false);
    assert.equal(calls, 2, "old finally cannot clear the new request's loading flag");
    fresh.resolve(kind === "workspace" ? workspace("CURRENT_ENTRY") : dreams("CURRENT_ENTRY")); await tick();
    assert.ok(flatten(renderTabMemory(state)).includes("CURRENT_ENTRY"));
  });

  test(`${kind}: expand, collapse, expand the same entry rejects the first response`, async () => {
    const { renderTabMemory, resetMemoryTab } = await module;
    const old = deferred(), fresh = deferred(); let calls = 0;
    Object.assign(window, { cryoclaw: {
      memoryListWorkspace: async () => workspace("memory"), memoryListDreams: async () => dreams("dream"),
      memoryReadEntry: () => ++calls === 1 ? old.promise : fresh.promise,
      memoryReadDream: () => ++calls === 1 ? old.promise : fresh.promise,
    } });
    resetMemoryTab(); renderTabMemory(state); await tick();
    click(renderTabMemory(state) as unknown as View, "oc-memory-subtabs__btn", kind === "workspace" ? 1 : 2);
    const marker = kind === "workspace" ? "oc-memory-item__head" : "oc-memory-dream__actions";
    const first = click(renderTabMemory(state) as unknown as View, marker);
    click(renderTabMemory(state) as unknown as View, marker);
    const current = click(renderTabMemory(state) as unknown as View, marker);
    old.resolve({ success: true, data: { title: "old", content: "OLD_BODY", dateText: "old", body: "OLD_BODY" } }); await first; await tick();
    assert.equal(flatten(renderTabMemory(state)).includes("OLD_BODY"), false);
    fresh.resolve({ success: true, data: { title: "current", content: "CURRENT_BODY", dateText: "current", body: "CURRENT_BODY" } }); await current; await tick();
    assert.ok(flatten(renderTabMemory(state)).includes("CURRENT_BODY"));
  });
}
