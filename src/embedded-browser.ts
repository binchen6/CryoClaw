import { BrowserWindow, dialog, ipcMain, shell, WebContentsView } from "electron";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { assertTrustedIpcSender } from "./ipc-sender-guard";
import { browserAnnotate, interactionScript, snapshotScript } from "./embedded-browser-page";

type Bounds = { x: number; y: number; width: number; height: number };
type BrowserPriority = "builtin" | "webbridge" | "kernel";
type Preferences = {
  downloadPath?: string;
  askSavePath?: boolean;
  maxBytes?: number;
  zoom?: number;
  userAgent?: string;
};
type EmbeddedState = {
  owner: BrowserWindow;
  view: WebContentsView;
  visible: boolean;
  defaultUserAgent: string;
  preferences: Preferences;
  visibilityRevision: number;
  navigationRevision: number;
  error: string;
  id: number;
  dispose?: () => void;
  bounds?: Bounds;
  device?: { width: number; height: number };
  overlay?: boolean;
  annotationRevision?: number;
  annotationRequest?: string;
  picking?: boolean;
};
type AgentPolicy = { enabled: boolean; priority: BrowserPriority };
export type EmbeddedBrowserCommand = {
  action?: unknown;
  url?: unknown;
  script?: unknown;
  selector?: unknown;
  text?: unknown;
  x?: unknown;
  y?: unknown;
  tabId?: unknown;
  width?: unknown;
  height?: unknown;
  key?: unknown;
};

const views = new Map<number, EmbeddedState>();
const tabs = new Map<number, EmbeddedState[]>();
let nextTabId = 1;
const history: Array<{ url: string; title: string; time: number }> = [];
const downloads: Array<{ id: number; name: string; path: string; state: string; received: number; total: number }> = [];
const agentPolicies = new Map<number, AgentPolicy>();
const agentAccess = new Map<number, AbortController>();
const commandQueues = new Map<number, Promise<unknown>>();
const managedWindows = new Set<number>();

function ownerWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) throw new Error("Embedded browser owner not found");
  return window;
}

function publishState(state: EmbeddedState) {
  if (!state.owner.isDestroyed() && !state.owner.webContents.isDestroyed()) {
    state.owner.webContents.send("embedded-browser:state-changed", statePayload(views.get(state.owner.webContents.id) ?? state));
  }
}

function stateForWindow(window: BrowserWindow, create = false, newTab = false): EmbeddedState | null {
  const key = window.webContents.id;
  let state = newTab ? null : views.get(key) ?? null;
  if (!state && create) {
    const view = new WebContentsView({
      webPreferences: {
        partition: "persist:cryoclaw-embedded-browser",
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    state = { owner: window, view, visible: false, defaultUserAgent: view.webContents.getUserAgent(), preferences: {}, visibilityRevision: 0, navigationRevision: 0, error: "", id: nextTabId++ };
    views.set(key, state);
    tabs.set(key, [...(tabs.get(key) ?? []), state]);
    window.contentView.addChildView(view);
    view.setVisible(false);
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isSafeUrl(url)) void browserUtility(window, { action: "new-tab", url }).catch(() => {});
      return { action: "deny" };
    });
    const guardNavigation = (event: Electron.Event, url: string) => { if (!isSafeUrl(url)) event.preventDefault(); };
    view.webContents.on("will-navigate", guardNavigation);
    view.webContents.on("will-redirect", guardNavigation);
    view.webContents.session.setPermissionRequestHandler?.((_contents, _permission, callback) => callback(false));
    view.webContents.session.setPermissionCheckHandler?.(() => false);
    view.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) { state!.error = description; publishState(state!); }
    });
    view.webContents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) state!.error = "";
    });
    const publish = () => { refreshNativeVisibility(state!); publishState(state!); };
    view.webContents.on("did-navigate", publish);
    view.webContents.on("did-navigate", (_event, url) => {
      if (!/^https?:/i.test(url)) return;
      history.unshift({ url, title: view.webContents.getTitle(), time: Date.now() });
      history.splice(200);
    });
    view.webContents.on("did-navigate-in-page", publish);
    view.webContents.on("page-title-updated", publish);
    view.webContents.on("did-start-loading", publish);
    view.webContents.on("did-stop-loading", publish);
    const onDownload = (_event: Electron.Event, item: Electron.DownloadItem, source: Electron.WebContents) => {
      if (source !== view.webContents) return;
      const prefs = state!.preferences;
      const exceedsLimit = () => Boolean(prefs.maxBytes && (
        (item.getTotalBytes() > 0 && item.getTotalBytes() > prefs.maxBytes) || item.getReceivedBytes() > prefs.maxBytes
      ));
      if (exceedsLimit()) {
        item.cancel();
        return;
      }
      const entry = { id: Date.now() + Math.random(), name: item.getFilename(), path: "", state: "progressing", received: 0, total: item.getTotalBytes() };
      downloads.unshift(entry); downloads.splice(100);
      item.on("updated", () => { entry.received = item.getReceivedBytes(); entry.total = item.getTotalBytes(); if (exceedsLimit()) item.cancel(); });
      item.once("done", (_event, status) => {
        entry.state = status; entry.path = item.getSavePath();
        const current = views.get(key);
        if (current && !current.view.webContents.isDestroyed()) publishState(current);
      });
      if (prefs.askSavePath === false && prefs.downloadPath) {
        item.setSavePath(path.join(prefs.downloadPath, path.basename(item.getFilename())));
      }
    };
    view.webContents.session.on("will-download", onDownload);
    state.dispose = () => {
      view.webContents.session.removeListener("will-download", onDownload);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    };
    if (!managedWindows.has(key)) {
      managedWindows.add(key);
      window.once("closed", () => {
      for (const tab of tabs.get(key) ?? []) tab.dispose?.();
      views.delete(key);
      tabs.delete(key);
      agentPolicies.delete(key);
      agentAccess.get(key)?.abort(new Error("Browser window closed"));
      agentAccess.delete(key);
      commandQueues.delete(key);
      managedWindows.delete(key);
      });
    }
  }
  return state;
}

function stateFor(event: Electron.IpcMainInvokeEvent, create = false): EmbeddedState | null {
  return stateForWindow(ownerWindow(event), create);
}

function safeUrl(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : "about:blank";
  if (raw.length <= 8192 && isSafeUrl(raw)) return raw;
  throw new Error("Only HTTP(S) URLs are allowed");
}

function isSafeUrl(raw: string): boolean {
  if (raw === "about:blank") return true;
  try { const url = new URL(raw); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}

async function limited<T>(operation: Promise<T>, signal?: AbortSignal, timeout = 10000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("Browser operation timed out")); }, timeout);
    const abort = () => { cleanup(); reject(signal?.reason ?? new Error("Browser operation canceled")); };
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    operation.then(resolve, reject).finally(cleanup);
  });
}

async function navigate(state: EmbeddedState, url: string, signal?: AbortSignal) {
  const revision = ++state.navigationRevision;
  state.error = "";
  try {
    await limited(state.view.webContents.loadURL(safeUrl(url)), signal);
    if (revision !== state.navigationRevision) return;
    refreshNativeVisibility(state);
    if (url !== "about:blank") await limited(state.view.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'), signal, 1000).catch(() => signal?.throwIfAborted());
  }
  catch (error) {
    // A superseded load belongs to an earlier reveal/navigation. Its abort
    // must not stop the newer request or overwrite the current page's error.
    if (revision !== state.navigationRevision) return;
    state.view.webContents.stop();
    state.error = error instanceof Error ? error.message : String(error);
    publishState(state);
    throw error;
  }
}

function safeBounds(value: unknown): Bounds {
  const input = (value ?? {}) as Record<string, unknown>;
  const number = (key: string) => {
    const value = input[key];
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid bounds.${key}`);
    return value;
  };
  const bounds = { x: number("x"), y: number("y"), width: number("width"), height: number("height") };
  if (bounds.width < 1 || bounds.height < 1) throw new Error("Embedded browser bounds are too small");
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
}

function statePayload(state: EmbeddedState) {
  return {
    visible: state.visible,
    url: state.view.webContents.getURL(),
    title: state.view.webContents.getTitle(),
    loading: state.view.webContents.isLoading(),
    canGoBack: state.view.webContents.navigationHistory.canGoBack(),
    canGoForward: state.view.webContents.navigationHistory.canGoForward(),
    error: state.error,
    tabId: state.id,
    tabs: (tabs.get(state.owner.webContents.id) ?? []).map(tab => ({ id: tab.id, url: tab.view.webContents.getURL(), title: tab.view.webContents.getTitle() })),
    zoom: state.view.webContents.getZoomFactor?.() ?? state.preferences.zoom ?? 1,
    device: state.device ?? null,
  };
}

function applyPreferences(state: EmbeddedState, next: Preferences) {
  state.preferences = { ...state.preferences, ...next };
  const contents = state.view.webContents;
  const zoom = state.preferences.zoom;
  if (typeof zoom === "number" && Number.isFinite(zoom)) {
    contents.setZoomFactor(Math.min(2, Math.max(0.5, zoom)));
  }
  if (typeof state.preferences.userAgent === "string") {
    contents.setUserAgent(state.preferences.userAgent.trim() || state.defaultUserAgent);
  }
}

function setVisible(state: EmbeddedState, visible: boolean) {
  state.visible = visible;
  refreshNativeVisibility(state);
  state.view.webContents.setAudioMuted(!visible);
  publishState(state);
}

function refreshNativeVisibility(state: EmbeddedState) {
  const url = state.view.webContents.getURL();
  state.view.setVisible(state.visible && !state.overlay && Boolean(url && url !== "about:blank"));
}

function applyDevice(state: EmbeddedState) {
  if (!state.device || !state.bounds) return;
  const { width, height } = state.device;
  state.view.webContents.enableDeviceEmulation({
    screenPosition: width < 768 ? "mobile" : "desktop", screenSize: { width, height }, deviceScaleFactor: 1,
    viewPosition: { x: 0, y: 0 }, viewSize: { width, height },
    scale: Math.min(1, state.bounds.width / width, state.bounds.height / height),
  });
}

function requiredSelector(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) throw new Error("A valid CSS selector is required");
  return value;
}

function boundedResult(value: unknown): unknown {
  const serialized = JSON.stringify(value ?? null);
  if (Buffer.byteLength(serialized ?? "null") > 60_000) throw new Error("Browser result is too large");
  return value ?? null;
}

async function evaluate(state: EmbeddedState, script: string, signal?: AbortSignal): Promise<unknown> {
  const result = await limited(state.view.webContents.executeJavaScript(script, true), signal);
  if (result && typeof result === "object" && typeof result.__cryoclawError === "string") throw new Error(result.__cryoclawError);
  return boundedResult(result);
}

async function waitForVisible(state: EmbeddedState, check: () => void): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!state.visible && Date.now() < deadline) {
    check();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  check();
  if (!state.visible) throw new Error("Open the Browser dock tab to use the embedded browser");
}

export async function controlEmbeddedBrowser(
  window: BrowserWindow,
  command: EmbeddedBrowserCommand,
  reveal: () => void,
  signal?: AbortSignal,
): Promise<unknown> {
  const key = window.webContents.id;
  const access = agentAccess.get(key);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("Browser operation timed out")), 18000);
  const current = AbortSignal.any([deadline.signal, ...signal ? [signal] : [], ...access ? [access.signal] : []]);
  const previous = commandQueues.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(() => executeCommand(window, command, reveal, current));
  commandQueues.set(key, operation);
  const cleanup = () => { if (commandQueues.get(key) === operation) commandQueues.delete(key); };
  void operation.then(cleanup, cleanup);
  try { return await limited(operation, current, 18000); }
  finally { clearTimeout(timer); }
}

async function executeCommand(window: BrowserWindow, command: EmbeddedBrowserCommand, reveal: () => void, signal?: AbortSignal): Promise<unknown> {
  const check = () => {
    signal?.throwIfAborted();
    if (window.isDestroyed() || window.webContents.isDestroyed()) throw new Error("Browser window closed");
    if (!agentPolicies.get(window.webContents.id)?.enabled) throw new Error("Enable the embedded browser and Agent access in Settings → Browser");
  };
  check();
  const policy = agentPolicies.get(window.webContents.id) ?? { enabled: false, priority: "builtin" };
  if (!policy.enabled) throw new Error("Enable the embedded browser and Agent access in Settings → Browser");
  const action = typeof command?.action === "string" ? command.action : "status";
  if (action === "status") {
    const state = stateForWindow(window);
    return { enabled: true, priority: policy.priority, ...(state ? statePayload(state) : { visible: false, url: "about:blank" }) };
  }
  if (!["navigate", "back", "forward", "reload", "snapshot", "evaluate", "click", "type", "scroll", "screenshot", "new-tab", "select-tab", "close-tab", "device", "history", "downloads", "press"].includes(action)) {
    throw new Error("Unsupported embedded browser action");
  }
  const state = stateForWindow(window, true)!;
  reveal();
  await waitForVisible(state, check);
  const contents = state.view.webContents;
  if (state.overlay || state.picking) throw new Error("Browser controls are open; let the user finish or close the menu");
  if (["new-tab", "select-tab", "close-tab", "device", "history", "downloads"].includes(action)) {
    return browserUtility(window, { ...command, action }, signal);
  } else if (action === "screenshot") {
    const image = (await limited(contents.capturePage(), signal)).toPNG();
    if (image.length > 6 * 1024 * 1024) throw new Error("Browser screenshot is too large; use a smaller viewport");
    return { image: { mimeType: "image/png", data: image.toString("base64") }, url: contents.getURL() };
  } else if (action === "press") {
    const keys = ["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"];
    if (typeof command.key !== "string" || !keys.includes(command.key)) throw new Error("Unsupported browser key");
    contents.sendInputEvent({ type: "keyDown", keyCode: command.key });
    contents.sendInputEvent({ type: "keyUp", keyCode: command.key });
  } else if (action === "navigate") {
    await navigate(state, safeUrl(command.url), signal);
  } else if (action === "back") {
    contents.navigationHistory.goBack();
  } else if (action === "forward") {
    contents.navigationHistory.goForward();
  } else if (action === "reload") {
    contents.reload();
  } else if (action === "snapshot") {
    return evaluate(state, snapshotScript(), signal);
  } else if (action === "evaluate") {
    if (typeof command.script !== "string" || !command.script.trim() || command.script.length > 50_000) {
      throw new Error("A browser script of at most 50000 characters is required");
    }
    return evaluate(state, command.script, signal);
  } else if (action === "click") {
    return evaluate(state, interactionScript("click", requiredSelector(command.selector)), signal);
  } else if (action === "type") {
    if (typeof command.text !== "string" || command.text.length > 100_000) throw new Error("Invalid browser text");
    return evaluate(state, interactionScript("type", requiredSelector(command.selector), command.text), signal);
  } else if (action === "scroll") {
    const x = typeof command.x === "number" && Number.isFinite(command.x) ? command.x : 0;
    const y = typeof command.y === "number" && Number.isFinite(command.y) ? command.y : 0;
    return evaluate(state, `(() => { window.scrollBy({ left: ${Math.max(-20000, Math.min(20000, x))}, top: ${Math.max(-20000, Math.min(20000, y))}, behavior: "instant" }); return { x: scrollX, y: scrollY }; })()`, signal);
  }
  publishState(state);
  return statePayload(state);
}

async function browserUtility(owner: BrowserWindow, params: Record<string, unknown>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    let state = stateForWindow(owner, true)!;
    if (params.viewId !== undefined && ["overlay", "annotate", "clear-annotation"].includes(String(params.action))) {
      const target = tabs.get(owner.webContents.id)?.find(tab => tab.id === params.viewId);
      if (!target) return { closed: true };
      state = target;
    }
    const contents = state.view.webContents;
    const action = params?.action;
    const wasVisible = state.visible;
    if (action === "new-tab") {
      const list = tabs.get(owner.webContents.id) ?? [];
      if (list.length >= 8) throw new Error("Close a tab before opening another (maximum 8)");
      const visible = wasVisible;
      setVisible(state, false);
      const previous = state;
      state = stateForWindow(owner, true, true)!;
      applyPreferences(state, previous.preferences);
      if (previous.bounds) { state.bounds = previous.bounds; state.view.setBounds(previous.bounds); }
      setVisible(state, visible);
      await navigate(state, safeUrl(params.url), signal);
    } else if (action === "select-tab" || action === "close-tab") {
      const list = tabs.get(owner.webContents.id) ?? [];
      const target = list.find(tab => tab.id === params.tabId);
      if (!target) throw new Error("Browser tab not found");
      if (action === "close-tab") {
        if (list.length === 1) { await navigate(target, "about:blank"); return statePayload(target); }
        tabs.set(owner.webContents.id, list.filter(tab => tab !== target));
        if (target === state) setVisible(target, false);
        target.dispose?.(); owner.contentView.removeChildView(target.view);
        if (target !== state) { publishState(state); return statePayload(state); }
      }
      const next = action === "select-tab" ? target : (tabs.get(owner.webContents.id) ?? [])[0];
      const visible = wasVisible;
      if (!state.view.webContents.isDestroyed()) setVisible(state, false);
      if (state.bounds) { next.bounds = state.bounds; next.view.setBounds(state.bounds); }
      views.set(owner.webContents.id, next); state = next;
      setVisible(state, visible);
    } else if (action === "overlay") {
      state.overlay = params.visible === true;
      let preview: string | null = null;
      if (state.overlay && state.visible && contents.getURL() !== "about:blank") {
        try {
          const capturePromise = contents.capturePage();
          refreshNativeVisibility(state);
          const capture = await limited(capturePromise, undefined, 2000);
          const png = capture.toPNG();
          if (png.length < 4 * 1024 * 1024) preview = `data:image/png;base64,${png.toString("base64")}`;
        } catch { /* The menu must remain usable when page capture fails. */ }
      }
      refreshNativeVisibility(state);
      return { preview };
    } else if (action === "history") return history.slice();
    else if (action === "downloads") return downloads.map(({ path: _path, ...entry }) => entry);
    else if (action === "show-download") {
      const entry = downloads.find(item => item.id === params.id && item.state === "completed");
      if (entry?.path) shell.showItemInFolder(entry.path);
    } else if (action === "find") {
      if (typeof params.text !== "string" || params.text.length > 1000) throw new Error("Invalid search text");
      if (params.text) contents.findInPage(params.text, { forward: params.forward !== false, findNext: params.next === true });
      else contents.stopFindInPage("clearSelection");
    } else if (action === "stop-find") contents.stopFindInPage("clearSelection");
    else if (action === "print") await new Promise<void>((resolve, reject) => contents.print({}, (success, reason) => success ? resolve() : reject(new Error(reason || "Printing canceled"))));
    else if (action === "screenshot") {
      const capture = await contents.capturePage();
      const result = await dialog.showSaveDialog(owner, { defaultPath: "webpage.png", filters: [{ name: "PNG", extensions: ["png"] }] });
      if (!result.canceled && result.filePath) await fs.writeFile(result.filePath, capture.toPNG());
      return { saved: !result.canceled };
    } else if (action === "clear-annotation") {
      if (params.requestId && params.requestId !== state.annotationRequest) return statePayload(state);
      state.annotationRevision = (state.annotationRevision ?? 0) + 1;
      state.annotationRequest = undefined; state.picking = false;
      await evaluate(state, 'document.dispatchEvent(new Event("cryoclaw-cancel-annotation")); document.querySelectorAll("[data-cryoclaw-annotation]").forEach(element => element.remove())');
    } else if (action === "annotate") {
      if (!state.visible) throw new Error("Open a web page before annotating");
      const revision = state.annotationRevision = (state.annotationRevision ?? 0) + 1;
      state.annotationRequest = typeof params.requestId === "string" ? params.requestId.slice(0, 100) : undefined;
      state.picking = true;
      try {
        const options = { reducedMotion: params.reducedMotion === true, duration: 140, accent: typeof params.accent === "string" ? params.accent.slice(0, 100) : undefined };
        const result = await limited(contents.executeJavaScript(`(${browserAnnotate.toString()})(${JSON.stringify(options)})`, true), undefined, 31000);
        if (!result) return null;
        // Capture the painted marker rather than the frame before the click.
        await limited(contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'), undefined, 1000).catch(() => {});
        return revision === state.annotationRevision && state.visible ? { ...result, zoom: contents.getZoomFactor() } : null;
      } finally { if (revision === state.annotationRevision) state.picking = false; }
    } else if (action === "device") {
      if (params.width === 0) { contents.disableDeviceEmulation(); state.device = undefined; }
      else {
        const width = Number(params.width), height = Number(params.height);
        if (![width, height].every(value => Number.isInteger(value) && value >= 240 && value <= 2560)) throw new Error("Device dimensions must be between 240 and 2560");
        state.device = { width, height };
        applyDevice(state);
      }
    } else if (action === "focus") contents.focus();
    else if (action === "clear-data") {
      const confirm = await dialog.showMessageBox(owner, { type: "question", message: "清空内置浏览器数据 / Clear embedded browser data?", detail: "登录状态、缓存、本次历史和下载记录将被清空；下载文件保留。\nSign-ins, cache and session records will be cleared. Downloaded files are kept.", buttons: ["取消 / Cancel", "清空 / Clear"], defaultId: 0, cancelId: 0 });
      if (confirm.response !== 1) return { cleared: false };
      // Stop every tab before clearing the shared isolated partition.
      for (const tab of tabs.get(owner.webContents.id) ?? []) { await navigate(tab, "about:blank"); tab.view.webContents.navigationHistory.clear(); }
      await contents.session.clearStorageData(); await contents.session.clearCache();
      history.length = 0; downloads.length = 0;
    } else throw new Error("Unsupported browser utility");
    publishState(state);
    refreshNativeVisibility(state);
    return statePayload(views.get(owner.webContents.id) ?? state);
}

export function registerEmbeddedBrowserIpc(): void {
  ipcMain.handle("embedded-browser:utility", (event, params: Record<string, unknown>) => {
    if (!assertTrustedIpcSender(event, "embedded-browser:utility")) throw new Error("IPC sender not trusted");
    return browserUtility(ownerWindow(event), params);
  });
  ipcMain.handle("embedded-browser:show", async (event, params: { bounds: unknown; url?: unknown; preferences?: Preferences }) => {
    if (!assertTrustedIpcSender(event, "embedded-browser:show")) throw new Error("IPC sender not trusted");
    const state = stateFor(event, true)!;
    applyPreferences(state, params?.preferences ?? {});
    state.view.setBounds(safeBounds(params?.bounds));
    state.bounds = safeBounds(params?.bounds); applyDevice(state);
    setVisible(state, true);
    const revision = ++state.visibilityRevision;
    if (params?.url && state.navigationRevision === 0 && !state.view.webContents.getURL()) await navigate(state, safeUrl(params.url));
    if (revision !== state.visibilityRevision) return statePayload(state);
    return statePayload(state);
  });

  ipcMain.handle("embedded-browser:hide", (event) => {
    if (!assertTrustedIpcSender(event, "embedded-browser:hide")) throw new Error("IPC sender not trusted");
    const state = stateFor(event);
    if (state) {
      state.visibilityRevision++; state.overlay = false;
      state.annotationRevision = (state.annotationRevision ?? 0) + 1;
      state.annotationRequest = undefined; state.picking = false;
      void evaluate(state, 'document.dispatchEvent(new Event("cryoclaw-cancel-annotation")); document.querySelectorAll("[data-cryoclaw-annotation]").forEach(element => element.remove())').catch(() => {});
      setVisible(state, false);
    }
    return state ? statePayload(state) : { visible: false };
  });

  ipcMain.handle("embedded-browser:bounds", (event, bounds: unknown) => {
    if (!assertTrustedIpcSender(event, "embedded-browser:bounds")) throw new Error("IPC sender not trusted");
    const state = stateFor(event);
    if (state) { state.bounds = safeBounds(bounds); state.view.setBounds(state.bounds); applyDevice(state); }
    return state ? statePayload(state) : { visible: false };
  });

  ipcMain.handle("embedded-browser:navigate", async (event, url: unknown) => {
    if (!assertTrustedIpcSender(event, "embedded-browser:navigate")) throw new Error("IPC sender not trusted");
    const state = stateFor(event, true)!;
    await navigate(state, safeUrl(url));
    return statePayload(views.get(state.owner.webContents.id) ?? state);
  });

  ipcMain.handle("embedded-browser:action", (event, action: unknown) => {
    if (!assertTrustedIpcSender(event, "embedded-browser:action")) throw new Error("IPC sender not trusted");
    const state = stateFor(event);
    if (!state) return { visible: false };
    const contents = state.view.webContents;
    if (action === "back") contents.navigationHistory.goBack();
    else if (action === "forward") contents.navigationHistory.goForward();
    else if (action === "reload") contents.reload();
    else throw new Error("Unsupported embedded browser action");
    publishState(state);
    return statePayload(state);
  });

  ipcMain.handle("embedded-browser:preferences", (event, preferences: Preferences) => {
    if (!assertTrustedIpcSender(event, "embedded-browser:preferences")) throw new Error("IPC sender not trusted");
    const state = stateFor(event, true)!;
    for (const tab of tabs.get(state.owner.webContents.id) ?? []) applyPreferences(tab, preferences);
    return statePayload(state);
  });

  ipcMain.handle("embedded-browser:evaluate", async (event, script: unknown) => {
    if (!assertTrustedIpcSender(event, "embedded-browser:evaluate")) throw new Error("IPC sender not trusted");
    if (typeof script !== "string" || script.length > 50_000) throw new Error("Invalid browser script");
    const state = stateFor(event);
    if (!state?.visible) throw new Error("Embedded browser is not visible");
    return evaluate(state, script);
  });

  ipcMain.handle("embedded-browser:agent-policy", (event, policy: AgentPolicy) => {
    if (!assertTrustedIpcSender(event, "embedded-browser:agent-policy")) throw new Error("IPC sender not trusted");
    const window = ownerWindow(event);
    const priority = policy?.priority === "webbridge" || policy?.priority === "kernel" ? policy.priority : "builtin";
    const key = window.webContents.id;
    const enabled = policy?.enabled === true;
    if (!enabled) { agentAccess.get(key)?.abort(new Error("Agent browser access disabled")); agentAccess.delete(key); }
    else if (!agentAccess.has(key)) agentAccess.set(key, new AbortController());
    agentPolicies.set(key, { enabled, priority });
    return { success: true };
  });
}
