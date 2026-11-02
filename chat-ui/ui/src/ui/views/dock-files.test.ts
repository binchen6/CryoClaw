import test from "node:test";
import assert from "node:assert/strict";
import type {AppViewState} from "../app-view-state.ts";

const globals = globalThis as Record<string, unknown>;
globals.customElements ??= {define() {}, get() { return undefined; }};
globals.CSSStyleSheet ??= class { replaceSync() {} };
globals.document ??= {nodeType: 9, currentScript: null, adoptedStyleSheets: [], createElement: () => ({}), createTreeWalker: () => ({}), querySelector: () => null};
const {DockFiles, renderDockFiles} = await import("./dock-files.ts");
const {workspaceViewState: ws} = await import("../controllers/workspace.ts");
const {getLocale, setLocale} = await import("../i18n.ts");

const host = {requestUpdate() {}} as unknown as AppViewState;
const options = () => ({onAttachFile() {}, onOpenItemFolder() {}, onChooseRoot() {}});
function revision() { return renderDockFiles(host, options()).values[2]; }

test("unrelated chat frames keep one workspace visual revision", () => {
  const initial = revision();
  for (let frame = 0; frame < 1000; frame++) assert.equal(revision(), initial);
  const before = {...ws};
  try {
    for (const change of [{selectedFile: "/root/a.md"}, {draft: "updated draft"}, {searchResults: []}, {fileSaving: true}, {fileQuery: "find"}, {recentFiles: []}, {searchLoading: true}]) {
      const previous = revision();
      Object.assign(ws, change);
      assert.notEqual(revision(), previous, `visual change ${Object.keys(change)[0]} must invalidate`);
      assert.equal(revision(), revision());
    }
  } finally { Object.assign(ws, before); }
});

test("locale and in-place history growth invalidate without scanning document contents", () => {
  const beforeHistory = ws.history, locale = getLocale();
  try {
    ws.history = [...ws.history];
    const previous = revision();
    ws.history.push("/root/new");
    const next = revision();
    assert.notEqual(next, previous);
    setLocale(locale === "en" ? "zh" : "en");
    assert.notEqual(revision(), next);
  } finally { ws.history = beforeHistory; setLocale(locale); }
});

test("callback-only frames skip rendering while internal tree work and real visuals still update", () => {
  const component = new DockFiles() as any;
  component.hasUpdated = true;
  assert.equal(component.shouldUpdate(new Map([["options", options()]])), false);
  assert.equal(component.shouldUpdate(new Map([["viewRevision", undefined]])), true);
  assert.equal(component.shouldUpdate(new Map([["treeVisible", true]])), true);
  assert.equal(component.shouldUpdate(new Map([["hostState", undefined]])), true);
  component.invalidate();
  assert.equal(component.shouldUpdate(new Map([["options", options()]])), true, "coalesced callback changes cannot swallow a tree completion");
  assert.equal(component.shouldUpdate(new Map([["options", options()]])), false, "the explicit invalidation is consumed once");
});

test("preview and chooser callbacks read the newest options even when rendering is skipped", () => {
  const component = new DockFiles() as any;
  component.hasUpdated = true;
  const calls: string[] = [];
  component.options = {onChooseRoot: () => calls.push("old-root"), onAttachFile: () => calls.push("old-file"), onOpenItemFolder: () => calls.push("old-folder")};
  const handlers = component.previewOptions;
  component.options = {onChooseRoot: () => calls.push("new-root"), onAttachFile: () => calls.push("new-file"), onOpenItemFolder: () => calls.push("new-folder")};
  assert.equal(component.shouldUpdate(new Map([["options", undefined]])), false);
  handlers.onChooseRoot();
  handlers.onAttachFile("/root/a.md", "a.md");
  handlers.onOpenItemFolder("/root/a.md");
  assert.deepEqual(calls, ["new-root", "new-file", "new-folder"]);
});
