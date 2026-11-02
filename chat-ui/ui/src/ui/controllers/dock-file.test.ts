import test from "node:test";
import assert from "node:assert/strict";
import { resolveDockFilePath } from "./dock-file.ts";
import { openDockFile } from "./dock-file.ts";
import { workspaceViewState as ws } from "./workspace.ts";

test("Dock changes resolve relative tool paths against the selected session workspace", () => {
  assert.equal(resolveDockFilePath("src/foo.ts", "C:\\project"), "C:\\project\\src\\foo.ts");
  assert.equal(resolveDockFilePath("src\\foo.ts", "/workspace/project"), "/workspace/project/src/foo.ts");
  assert.equal(resolveDockFilePath("README.md", "C:/project/"), "C:/project/README.md");
  assert.equal(resolveDockFilePath("src/foo.ts", null), null);
});

test("opening a changed file preserves a dirty draft and moves preview/editing to the session root", async () => {
  const globals = globalThis as any;
  const oldWindow = globals.window;
  const oldState = { ...ws };
  const reads: string[] = []; const roots: string[] = []; const clearedTimers: number[] = [];
  let saveDraft = false, authorizeRoot = false;
  globals.window = { cryoclaw: {
    workspaceSaveDraft: async () => ({ success: saveDraft }),
    workspaceSetRoot: async (root: string) => { roots.push(root); return { success: authorizeRoot }; },
    workspaceListDir: async () => ({ success: true, data: { items: [] } }),
    workspaceReadFile: async (path: string) => { reads.push(path); return { success: true, data: { content: "loaded", hash: "hash", size: 6 } }; },
  }, clearTimeout: (id: number) => { clearedTimers.push(id); } };
  const state: any = { settings: { dockCollapsed: true }, dockOpenedTabs: [], dockActiveTab: "changes", connected: false, client: null,
    sidebarOpen: true, sidebarContent: "previous tool output", sidebarError: "previous tool error", sidebarLeaving: true, sidebarCloseTimer: 17,
    requestUpdate() {}, applySettings(next: any) { this.settings = next; } };
  const oldSidebar = () => {
    assert.equal(state.sidebarOpen, true); assert.equal(state.sidebarContent, "previous tool output"); assert.equal(state.sidebarError, "previous tool error");
    assert.equal(state.sidebarLeaving, true); assert.equal(state.sidebarCloseTimer, 17); assert.deepEqual(clearedTimers, []);
  };
  Object.assign(ws, { root: "C:\\previous", currentPath: "C:\\previous", selectedFile: "C:\\previous\\draft.ts", fileContent: "old", draft: "unsaved", baseHash: "old-hash", fileHash: "old-hash", fileSaving: false });
  try {
    ws.fileSaving = true;
    assert.equal(await openDockFile(state, "draft.ts", "C:\\previous"), false);
    oldSidebar();
    ws.fileSaving = false;
    assert.equal(await openDockFile(state, "src/foo.ts", "C:\\project"), false);
    assert.equal(ws.draft, "unsaved"); assert.deepEqual(reads, []); assert.deepEqual(roots, []);
    assert.equal(state.settings.dockCollapsed, true);
    oldSidebar();
    saveDraft = true;
    assert.equal(await openDockFile(state, "src/foo.ts", "C:\\project"), false);
    assert.deepEqual(reads, []); oldSidebar();
    authorizeRoot = true;
    assert.equal(await openDockFile(state, "src/foo.ts", "C:\\project"), true);
    assert.deepEqual(roots, ["C:\\project", "C:\\project"]);
    assert.deepEqual(reads, ["C:\\project\\src\\foo.ts"]);
    assert.equal(ws.root, "C:\\project"); assert.equal(ws.selectedFile, reads[0]);
    assert.equal(state.dockActiveTab, "files"); assert.equal(state.dockLauncherOpen, false);
    assert.equal(state.sidebarOpen, false); assert.equal(state.sidebarContent, null); assert.equal(state.sidebarError, null);
    assert.equal(state.sidebarLeaving, false); assert.equal(state.sidebarCloseTimer, null); assert.deepEqual(clearedTimers, [17]);
  } finally { Object.assign(ws, oldState); globals.window = oldWindow; }
});

test("absolute tool paths stay intact and traversal is still checked by the main-process guard", () => {
  assert.equal(resolveDockFilePath("D:\\other\\a.ts", "C:\\project"), "D:\\other\\a.ts");
  assert.equal(resolveDockFilePath("/absolute/a.ts", "C:\\project"), "/absolute/a.ts");
  assert.equal(resolveDockFilePath("\\\\server\\share\\a.ts", "C:\\project"), "\\\\server\\share\\a.ts");
  assert.equal(resolveDockFilePath("../outside.ts", "C:\\project"), "C:\\project\\..\\outside.ts");
});
