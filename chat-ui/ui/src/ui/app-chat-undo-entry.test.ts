import test, { mock } from "node:test";
import assert from "node:assert/strict";

const globals = globalThis as Record<string, unknown>;
globals.customElements ??= { define() {}, get() { return undefined; } };
globals.CSSStyleSheet ??= class { replaceSync() {} };
globals.document = { nodeType: 9, currentScript: null, adoptedStyleSheets: [], createElement: () => ({}), querySelector: () => null, querySelectorAll: () => [],
  createTreeWalker: () => ({}), addEventListener() {}, removeEventListener() {}, hidden: true };
globals.window = { document: globals.document, Element: class {}, addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: true }), requestAnimationFrame: () => 1, cancelAnimationFrame() {} };
const { buildChatProps } = await import("./app-chat-props.ts");
const { renderChat } = await import("./views/chat.ts");
const { renderConfirmDialog } = await import("./views/confirm-dialog.ts");
const { OcTurnDiffCard } = await import("./components/oc-turn-diff-card.ts");

function binding(node: any, name: string, tag = ""): any {
  if (Array.isArray(node)) {
    for (const child of node) { const found = binding(child, name, tag); if (found !== undefined) return found; }
  } else if (node && Array.isArray(node.values) && node.strings) {
    for (let i = 0; i < node.values.length; i += 1) {
      if ((!tag || node.strings.some((part: string) => part.includes(`<${tag}`))) &&
        node.strings[i].trimEnd().endsWith(`${name}=`)) return node.values[i];
      const found = binding(node.values[i], name, tag); if (found !== undefined) return found;
    }
  }
  return undefined;
}
async function settle() { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }

for (const entry of ["dock", "history"] as const) {
  test(`${entry} production undo callback awaits confirmation and Git writes before refreshing stats`, async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const workspace = `C:/undo-${entry}`;
    const state: any = {
      sessionKey: `undo-entry-${entry}`, settings: { pinnedWorkspaces: [{ id: "workspace", path: workspace }],
        sessionWorkspaceMap: { [`undo-entry-${entry}`]: "workspace" }, dockCollapsed: true },
      chatMessages: [{ role: "assistant", timestamp: 1, content: [
        { type: "toolCall", id: "edit-file", name: "edit", arguments: { path: "a.ts", oldText: "old", newText: "new" } },
      ] }], chatToolMessages: [], chatVisibleMessageCount: 1,
      chatAttachments: [], chatQueue: [], chatStream: null, chatMessage: "", configuredModels: [],
      sessionsResult: { sessions: [] }, gitRepoOptions: [], gitRepoPath: workspace, gitAvailable: true,
      questionPrompts: [], questionResolvingIds: [], connected: true, requestUpdate() {},
    };
    const props = buildChatProps(state);
    const onDiscard = entry === "dock" ? binding(props.dockChangesContent, ".onDiscard", "oc-turn-diff-card") :
      binding(renderChat(props), ".onDiscard", "oc-chat-history");
    assert.equal(typeof onDiscard, "function", "fixture must use the callback from the real production template");
    let discardStarted = false;
    let undone = false;
    let resolveDiscard!: (value: unknown) => void;
    (globalThis as any).window.cryoclaw = {
      gitStatus: async () => ({ success: true, data: { entries: [] } }),
      gitClean: async () => ({ success: true }),
      gitDiscard: async () => { discardStarted = true; return new Promise(resolve => { resolveDiscard = value => { undone = true; resolve(value); }; }); },
    };
    const component: any = new OcTurnDiffCard();
    component.requestUpdate = () => {};
    component.files = [{ path: "a.ts", kind: "modified" }];
    component.workspacePath = workspace;
    component.gitAvailable = true;
    component.onDiscard = onDiscard;
    let calls = 0;
    component.statsLoader = async () => { calls += 1; return { byPath: { "a.ts": { path: "a.ts", additions: undone ? 0 : 10, deletions: 0 } }, complete: true }; };
    try {
      component.willUpdate(new Map([["files", undefined]])); mock.timers.tick(250); await settle();
      assert.equal(component.statsLookup.byPath["a.ts"].additions, 10);
      const undo = component.onUndoClick();
      await settle();
      // showConfirm requests a root render; production assembly supplies fresh
      // arrays/loaders while the dialog may remain open longer than the TTL.
      component.files = [{ path: "a.ts", kind: "modified" }];
      component.willUpdate(new Map([["files", undefined], ["statsLoader", undefined]]));
      mock.timers.tick(1500); mock.timers.tick(250); await settle();
      assert.equal(component.undoing, true, "card must stay busy while the real confirmation is pending");
      assert.equal(calls, 1, "no post-undo query may run before confirmation");
      assert.equal(discardStarted, false);
      const dialog: any = renderConfirmDialog(state);
      // The danger confirmation button is the second click binding in this template.
      const clickHandlers: Array<() => void> = [];
      for (let i = 0; i < dialog.values.length; i += 1) if (dialog.strings[i].trimEnd().endsWith("@click=")) clickHandlers.push(dialog.values[i]);
      assert.equal(clickHandlers.length, 2);
      clickHandlers[1]!();
      await settle(); mock.timers.tick(250); await settle();
      assert.equal(discardStarted, true);
      assert.equal(component.undoing, true, "card must stay busy until the actual Git write finishes");
      assert.equal(calls, 1);
      resolveDiscard({ success: true });
      await undo; await settle(); mock.timers.tick(250); await settle();
      assert.equal(component.undoing, false);
      assert.equal(calls, 2);
      assert.equal(component.statsLookup.byPath["a.ts"].additions, 0);
    } finally {
      const dialog: any = renderConfirmDialog(state);
      if (dialog?.values) binding(dialog, "@click")?.();
      component.disconnectedCallback(); mock.timers.reset();
    }
  });
}
