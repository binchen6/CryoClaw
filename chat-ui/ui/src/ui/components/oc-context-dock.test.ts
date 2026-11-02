import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const globals = globalThis as Record<string, unknown>;
globals.customElements ??= { define() {}, get() { return undefined; } };
globals.CSSStyleSheet ??= class { replaceSync() {} };
globals.document = { nodeType: 9, currentScript: null, adoptedStyleSheets: [], createElement: () => ({}), querySelector: () => null, querySelectorAll: () => [],
  createTreeWalker: () => ({}), addEventListener() {}, removeEventListener() {}, hidden: true };
globals.window = { document: globals.document, Element: class {}, addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: true }), requestAnimationFrame: () => 1, cancelAnimationFrame() {} };
const { nothing, html } = await import("lit");
const { renderChat } = await import("../views/chat.ts");
const { OcContextDock } = await import("./oc-context-dock.ts");
const { toggleDock, openDockTab } = await import("../controllers/dock.ts");
const { configureShortcuts } = await import("../keyboard-shortcuts.ts");

function templateText(node: any): string {
  if (Array.isArray(node)) return node.map(templateText).join("");
  if (node?.strings && Array.isArray(node.values)) return node.strings.reduce((text: string, part: string, index: number) => text + part + templateText(node.values[index]), "");
  return typeof node === "string" ? node : "";
}

function props(collapsed: boolean): any {
  return { sessionKey: "dock-rail-removal", dockCollapsed: collapsed, messages: [], toolMessages: [], stream: null,
    thinkingLevel: null, showThinking: false, loading: false, sending: false, streamStartedAt: null,
    draft: "", queue: [], connected: true, canSend: true, error: null, sessions: null,
    assistantName: "Assistant", assistantAvatar: null, configuredModels: [], visibleHistoryCount: 0,
    onDraftChange() {}, onSend() {}, onAbort() {}, onRefresh() {}, onToggleDock() {} };
}

function elements(markup: string) {
  type Element = { tag: string; classes: string[]; parent?: Element };
  const result: Element[] = [], stack: Element[] = [];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  for (const match of markup.matchAll(/<(\/?)([a-z][\w-]*)([^>]*)>/gi)) {
    const [, closing, tag, attributes] = match;
    if (closing) { const index = stack.findLastIndex(node => node.tag === tag); if (index >= 0) stack.splice(index); continue; }
    const node: Element = { tag, classes: attributes.match(/\bclass="([^"]*)"/)?.[1].split(/\s+/) ?? [], parent: stack.at(-1) };
    result.push(node);
    if (!voidTags.has(tag) && !/\/\s*$/.test(attributes)) stack.push(node);
  }
  return result;
}

test("the entire conversation column narrows beside full-height Dock, including composer, commands and progress", () => {
  const options = props(false);
  options.progressCard = { sessionKey: options.sessionKey, card: { sessionKey: options.sessionKey, steps: [{ step: "Working", status: "in_progress" }] } };
  options.attachments = [{ id: "attachment", fileName: "notes.txt", filePath: "/workspace/notes.txt" }];
  const nodes = elements(templateText(renderChat(options)));
  const main = nodes.find(node => node.classes.includes("chat-main"));
  assert.ok(main);
  const descendsFromMain = (node: typeof main) => { for (let parent = node?.parent; parent; parent = parent.parent) if (parent === main) return true; return false; };
  for (const className of ["chat-thread", "chat-compose", "chat-progress-card", "chat-attachments"]) {
    const node = nodes.find(item => item.classes.includes(className));
    assert.ok(node, `${className} must remain rendered`);
    assert.equal(descendsFromMain(node), true, `${className} must shrink inside the same left column`);
  }
  const commands = nodes.find(node => node.tag === "oc-command-jobs");
  assert.ok(commands); assert.equal(descendsFromMain(commands), true);
  const dock = nodes.find(node => node.tag === "oc-context-dock");
  const divider = nodes.find(node => node.tag === "oc-resizable-divider");
  assert.ok(dock); assert.ok(divider);
  assert.equal(dock.parent, main.parent); assert.equal(divider.parent, main.parent);
  assert.equal(main.parent?.classes.includes("chat-split-container"), true);
  const css = readFileSync("chat-ui/ui/src/styles/chat.css", "utf8");
  const mainRule = css.match(/\.chat-main\s*\{([^}]+)\}/)?.[1] ?? "";
  assert.match(mainRule, /position:\s*relative/, "floating conversation controls must anchor to the narrowed column");
  const shellRule = css.match(/\.cryoclaw-content\s*>\s*\.card\.chat\s*\{([^}]+)\}/)?.[1] ?? "";
  assert.match(shellRule, /padding:\s*0\s*;/, "Dock must reach the content edges, with spacing owned by the conversation column");
  assert.match(mainRule, /padding:/, "the conversation keeps its previous spacing inside its own column");
});

test("startup and error callouts stay in the left column; maximize and restore preserve the conversation", () => {
  for (const connected of [false, true]) {
    const options = props(false);
    options.connected = connected;
    options.error = connected ? "fixture error" : null;
    options.gatewayConnection = { phase: "starting", progress: null };
    const nodes = elements(templateText(renderChat(options)));
    const main = nodes.find(node => node.classes.includes("chat-main"));
    const callout = nodes.find(node => node.classes.includes(connected ? "chat-error-callout" : "chat-conn-callout"));
    assert.ok(main); assert.ok(callout);
    assert.equal(callout.parent, main, "the Dock starts above the connection callout, at the content area's top edge");
  }
  const options = props(false);
  options.dockMaximized = true;
  const maximized = templateText(renderChat(options));
  assert.match(maximized, /class="chat-main" style="[^"]*display:none/);
  assert.doesNotMatch(maximized, /<oc-resizable-divider\b/);
  assert.match(maximized, /<oc-context-dock\b/);
  assert.match(maximized, /class="chat-compose"/, "maximize hides the conversation without losing its draft or handlers");
  options.dockMaximized = false;
  const restored = templateText(renderChat(options));
  assert.match(restored, /class="chat-main" style="flex: 0 1 60%/);
  assert.doesNotMatch(restored, /display:none/);
  assert.match(restored, /<oc-resizable-divider\b/);
});

test("collapsed chat leaves no Dock host, separator, icon rail or reserved sidebar", () => {
  const rendered = templateText(renderChat(props(true)));
  assert.doesNotMatch(rendered, /<oc-context-dock\b/, "collapsed chat must not allocate a sidebar host");
  assert.doesNotMatch(rendered, /<oc-resizable-divider\b/, "collapsed chat must not allocate its divider");
  assert.doesNotMatch(rendered, /chat-sidebar|context-dock__collapsed-tabs/);
  assert.match(rendered, /1 1 100%/, "the main conversation owns the entire available width");
  const dock = new OcContextDock();
  dock.collapsed = true;
  assert.equal(dock.render(), nothing, "standalone collapsed Dock also renders no rail");
});

test("existing top toggle expands and collapses Dock; expanded tab contents remain available", () => {
  const host: any = { settings: { dockCollapsed: true }, dockActiveTab: "changes", applySettings(next: any) { this.settings = next; } };
  toggleDock(host);
  assert.equal(host.settings.dockCollapsed, false);
  assert.match(templateText(renderChat(props(host.settings.dockCollapsed))), /<oc-context-dock\b/);
  assert.match(templateText(renderChat(props(false))), /<oc-resizable-divider\b/);
  const dock = new OcContextDock();
  dock.collapsed = false;
  (dock as any).launcherOpen = false;
  dock.browserEnabled = true;
  dock.onToggleCollapsed = () => toggleDock(host);
  for (const [tab, field] of [["changes", "changesContent"], ["files", "filesContent"], ["terminal", "terminalContent"], ["browser", "browserContent"]] as const) {
    dock.activeTab = tab;
    (dock as any)[field] = html`<div>retained-${tab}</div>`;
    const rendered = templateText(dock.render());
    assert.match(rendered, new RegExp(`retained-${tab}`));
    assert.match(rendered, /context-dock__tabs/);
    assert.match(rendered, /context-dock__new-tab-menu/);
  }
  dock.activeTab = "subagent";
  dock.subagentCards = [{ sessionKey: "child", title: "Retained subagent", active: true, status: "running" } as any];
  assert.match(templateText(dock.render()), /Retained subagent/);
  dock.onToggleCollapsed();
  assert.equal(host.settings.dockCollapsed, true);
  assert.doesNotMatch(templateText(renderChat(props(true))), /<oc-context-dock\b/);
  openDockTab(host, "files");
  assert.equal(host.settings.dockCollapsed, false, "existing direct tab navigation can still reopen Dock");
  assert.equal(host.dockActiveTab, "files");
});

test("manual expansion opens the feature launcher; linked tabs open content and retain real open tabs", async () => {
  const host: any = { settings: { dockCollapsed: true }, dockActiveTab: "changes", dockOpenedTabs: [], dockLauncherOpen: true, applySettings(next: any) { this.settings = next; } };
  toggleDock(host);
  assert.equal(host.dockLauncherOpen, true);
  openDockTab(host, "browser");
  assert.equal(host.dockLauncherOpen, false);
  assert.deepEqual(host.dockOpenedTabs, ["browser"]);
  openDockTab(host, "files");
  openDockTab(host, "browser");
  assert.deepEqual(host.dockOpenedTabs, ["browser", "files"], "switching cannot duplicate tabs");
  toggleDock(host); toggleDock(host);
  assert.equal(host.dockLauncherOpen, true, "manual reopen returns to launcher while keeping tabs available");
  const { closeDockTab } = await import("../controllers/dock.ts") as any;
  closeDockTab(host, "browser");
  assert.deepEqual(host.dockOpenedTabs, ["files"]);
  assert.equal(host.dockActiveTab, "files");
  closeDockTab(host, "files");
  assert.equal(host.dockLauncherOpen, true);
  assert.equal(host.settings.dockCollapsed, false, "closing the last tab returns to the blank launcher");
});

test("blank Dock shows only supported launcher entries with actual bound shortcut keycaps", () => {
  const dock: any = new OcContextDock();
  dock.collapsed = false; dock.launcherOpen = true; dock.openedTabs = []; dock.browserEnabled = true;
  configureShortcuts({ dockFiles: "" });
  try {
    const result = dock.render();
    const rendered = templateText(result);
    assert.match(rendered, /context-dock__launcher/);
    assert.doesNotMatch(rendered, /role="tab"/);
    assert.doesNotMatch(rendered, /oc-subagent-panel|侧边聊天/);
    const entries: any[] = [];
    const walk = (node: any) => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node?.strings && Array.isArray(node.values)) {
        const index = node.strings.findIndex((part: string) => part.trimEnd().endsWith("data-dock-open="));
        if (index >= 0) entries.push({ id: node.values[index], text: templateText(node) });
        node.values.forEach(walk);
      }
    };
    walk(result);
    assert.deepEqual([...new Set(entries.map(e => e.id))], ["changes", "browser", "terminal", "files", "subagent"]);
    assert.ok(entries.filter(e => e.id === "files").every(e => !e.text.includes("<kbd")), "unbound shortcuts have no invented keycaps");
    assert.match(entries.find(e => e.id === "changes")?.text ?? "", /Ctrl/);
    dock.browserEnabled = false;
    assert.doesNotMatch(templateText(dock.render()), /data-dock-open="?browser/);
  } finally { configureShortcuts(undefined); }
});

test("opened Dock uses closable chips and keeps plus, maximize and collapse controls", () => {
  const dock: any = new OcContextDock();
  dock.collapsed = false; dock.launcherOpen = false; dock.openedTabs = ["files", "terminal"]; dock.activeTab = "files";
  const rendered = templateText(dock.render());
  assert.match(rendered, /context-dock__chip/);
  assert.match(rendered, /data-dock-close="?files/);
  assert.match(rendered, /data-dock-close="?terminal/);
  assert.equal((rendered.match(/role="tab"/g) ?? []).length, 2);
  const actions = rendered.split('<div class="context-dock__actions">')[1]?.split('</div>')[0] ?? "";
  assert.equal((actions.match(/<button\b/g) ?? []).length, 3);
});

test("Dock browser shows its address bar directly for one page and retains multiple real web tabs", async () => {
  const { OcEmbeddedBrowser } = await import("./oc-embedded-browser.ts");
  const browser: any = new OcEmbeddedBrowser();
  browser.compactInDock = true;
  browser.state = { url: "https://example.test", tabs: [{ id: 1, title: "First", url: "https://example.test" }], tabId: 1 };
  const single = templateText(browser.render());
  assert.doesNotMatch(single, /class="embedded-browser__tabs"/);
  assert.match(single, /embedded-browser__address/);
  assert.match(single, /aria-label="?新标签页|title="?新标签页/);
  browser.state.tabs.push({ id: 2, title: "Second", url: "https://second.test" });
  const multiple = templateText(browser.render());
  assert.match(multiple, /class="embedded-browser__tabs"/);
  assert.match(multiple, /Second/);
});

test("outer Dock menu overlay uses the captured web view and rejects late capture after close or tab change", async () => {
  const { OcEmbeddedBrowser } = await import("./oc-embedded-browser.ts");
  const browser: any = new OcEmbeddedBrowser();
  browser.active = true; browser.state = { tabId: 7 }; browser.requestUpdate = () => {};
  Object.defineProperty(browser, "updateComplete", { value: Promise.resolve(true) });
  const calls: any[] = []; let resolveCapture!: (value: unknown) => void;
  browser.utility = async (action: string, params: any) => {
    calls.push({ action, ...params });
    return params.visible ? new Promise(resolve => { resolveCapture = resolve; }) : { preview: null };
  };
  const opening = browser.setChromeOverlay(true);
  await browser.setChromeOverlay(false);
  resolveCapture({ preview: "old-preview" }); await opening;
  assert.equal(browser.preview, null);
  assert.deepEqual(calls.map(call => [call.action, call.visible, call.viewId]), [["overlay", true, 7], ["overlay", false, 7]]);
  const next = browser.setChromeOverlay(true);
  browser.state = { tabId: 8 };
  resolveCapture({ preview: "wrong-view" }); await next;
  assert.equal(browser.preview, null);
  const captured = browser.setChromeOverlay(true);
  resolveCapture({ preview: "captured-current-page" }); await captured;
  assert.equal(browser.preview, "captured-current-page");
  const closing = browser.setChromeOverlay(false);
  browser.state = { tabId: 9, url: "about:blank" };
  await closing;
  assert.equal(browser.preview, null, "closing after creating a new page cannot leave an old preview over its welcome screen");
});

test("Dock changes use the real branch, status/path list and switch to a directory tree", async () => {
  const { OcTurnDiffCard } = await import("./oc-turn-diff-card.ts");
  const card: any = new OcTurnDiffCard();
  card.dockMode = true; card.branch = "feature/real-branch";
  card.files = [{ path: "src/feature.ts", kind: "modified" }, { path: "src/new.ts", kind: "added" }, { path: "docs/old.md", kind: "deleted" }];
  const list = templateText(card.render());
  assert.match(list, /feature\/real-branch/);
  assert.match(list, /src\/feature\.ts/);
  assert.match(list, /context-dock__change-status/);
  assert.match(list, /data-change-view="?list/);
  card.viewMode = "tree";
  const tree = templateText(card.render());
  assert.match(tree, /context-dock__change-directory/);
  assert.match(tree, /data-path=src\/feature\.ts/);
  assert.match(tree, />src<|>src<\/span>/);
  card.files = [];
  assert.match(templateText(card.render()), /feature\/real-branch/, "empty changes still retain the real branch toolbar");
});

test("top-right Dock entry remains wired and obsolete collapsed-width styles are removed", () => {
  const appRender = readFileSync("chat-ui/ui/src/ui/app-render.ts", "utf8");
  assert.match(appRender, /class="cc-contextbar__toggle"[\s\S]*?@click=\$\{\(\) => toggleDock\(state\)\}/);
  const css = readFileSync("chat-ui/ui/src/styles/chat.css", "utf8");
  assert.doesNotMatch(css, /\.chat-sidebar--collapsed\s*\{|\.context-dock--collapsed\s*\{|\.context-dock__collapsed-tabs\b|\.context-dock__collapse\b/);
});
