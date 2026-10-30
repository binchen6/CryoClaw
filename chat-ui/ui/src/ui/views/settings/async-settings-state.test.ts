import test from "node:test";
import assert from "node:assert/strict";
import { html } from "lit";
import type { AppViewState } from "../../app-view-state.ts";

type View = { strings: readonly string[]; values: unknown[] };
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function tick() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function flatten(value: unknown): string {
  return typeof value === "string" ? value : Array.isArray(value) ? value.map(flatten).join(" ")
    : value && typeof value === "object" && "values" in value ? flatten((value as View).values) : "";
}
const original = { window: globalThis.window, document: globalThis.document, CSSStyleSheet: globalThis.CSSStyleSheet };
// Templates and their actual callbacks are exercised without mounting an app.
Object.assign(globalThis, {
  CSSStyleSheet: class { replaceSync() {} }, document: { adoptedStyleSheets: [] },
  window: { cryoclaw: {} },
});
void html;
const modules = Promise.all([import("./tab-advanced.ts"), import("./tab-plugins.ts")]);
test.after(() => { Object.assign(globalThis, original); });

test("advanced settings cannot save default placeholders while their initial IPC read is pending", async () => {
  const [{ renderTabAdvanced, resetAdvancedTab }] = await modules;
  const pending = deferred(); const saved: unknown[] = [];
  Object.assign(window, { cryoclaw: {
    settingsGetAdvanced: () => pending.promise,
    settingsGetCliStatus: async () => ({ success: true, data: { installed: false } }),
    settingsSaveAdvanced: async (value: unknown) => { saved.push(value); return { success: true }; },
  } });
  const state = { client: { request: async () => ({ hash: "config", config: {} }) }, connected: true, requestUpdate() {} } as unknown as AppViewState;
  resetAdvancedTab(); const view = renderTabAdvanced(state) as unknown as View;
  await tick();
  const index = view.strings.findIndex(text => text.includes('btn primary" ?disabled='));
  assert.ok(index >= 0);
  await (view.values[index + 1] as () => Promise<void>)();
  assert.deepEqual(saved, []);
  assert.equal(view.values[index], true);
  pending.resolve({ success: true, data: { browserMode: "openclaw", clawHubRegistry: "CUSTOM_REGISTRY" } });
  await tick();
});

test("advanced settings ignore an earlier initialization after leaving and reopening the tab", async () => {
  const [{ renderTabAdvanced, resetAdvancedTab }] = await modules;
  const old = deferred(), current = deferred(); let calls = 0;
  Object.assign(window, { cryoclaw: {
    settingsGetAdvanced: () => ++calls === 1 ? old.promise : current.promise,
    settingsGetCliStatus: async () => ({ success: true, data: { installed: false } }),
  } });
  const state = { client: null, connected: false, requestUpdate() {} } as unknown as AppViewState;
  resetAdvancedTab(); renderTabAdvanced(state); resetAdvancedTab(); renderTabAdvanced(state);
  current.resolve({ success: true, data: { browserMode: "openclaw", clawHubRegistry: "CURRENT_REGISTRY" } }); await tick();
  assert.ok(flatten(renderTabAdvanced(state)).includes("CURRENT_REGISTRY"));
  old.resolve({ success: true, data: { browserMode: "openclaw", clawHubRegistry: "OLD_REGISTRY" } }); await tick();
  const result = flatten(renderTabAdvanced(state));
  assert.ok(result.includes("CURRENT_REGISTRY"));
  assert.equal(result.includes("OLD_REGISTRY"), false);
});

test("advanced settings restart a pending initialization when the gateway connection changes", async () => {
  const [{ renderTabAdvanced, resetAdvancedTab }] = await modules;
  const old = deferred();
  Object.assign(window, { cryoclaw: {
    settingsGetAdvanced: async () => ({ success: true, data: { browserMode: "openclaw", clawHubRegistry: "CURRENT_CONNECTION" } }),
    settingsGetCliStatus: async () => ({ success: true, data: { installed: false } }),
  } });
  const state = { client: { request: () => old.promise }, connected: true, requestUpdate() {} } as unknown as AppViewState;
  resetAdvancedTab(); renderTabAdvanced(state);
  state.client = { request: async () => ({ hash: "current", config: {} }) } as never;
  renderTabAdvanced(state); await tick();
  old.resolve({ hash: "old", config: {} }); await tick();
  assert.ok(flatten(renderTabAdvanced(state)).includes("CURRENT_CONNECTION"));
  const view = renderTabAdvanced(state) as unknown as View;
  const index = view.strings.findIndex(text => text.includes('btn primary" ?disabled='));
  assert.equal(view.values[index], false);
});

test("installed plugins ignore an earlier list after leaving and reopening extensions", async () => {
  const [, { renderPluginsView, resetPluginsView }] = await modules;
  const old = deferred(), current = deferred(); let calls = 0;
  Object.assign(window, { cryoclaw: { pluginStoreList: () => ++calls === 1 ? old.promise : current.promise } });
  const state = { requestUpdate() {} } as unknown as AppViewState;
  resetPluginsView(); renderPluginsView(state); resetPluginsView(); renderPluginsView(state);
  current.resolve({ success: true, data: [{ id: "current", name: "CURRENT_PLUGIN", enabled: true }] }); await tick();
  assert.ok(flatten(renderPluginsView(state)).includes("CURRENT_PLUGIN"));
  old.resolve({ success: true, data: [{ id: "old", name: "OLD_PLUGIN", enabled: true }] }); await tick();
  const result = flatten(renderPluginsView(state));
  assert.ok(result.includes("CURRENT_PLUGIN"));
  assert.equal(result.includes("OLD_PLUGIN"), false);
});
