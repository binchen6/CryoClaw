import { BrowserWindow, ipcMain, shell, WebContentsView } from "electron";
import * as path from "node:path";
import { assertTrustedIpcSender } from "./ipc-sender-guard";

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
};

const views = new Map<number, EmbeddedState>();
const agentPolicies = new Map<number, AgentPolicy>();

function ownerWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) throw new Error("Embedded browser owner not found");
  return window;
}

function publishState(state: EmbeddedState) {
  if (!state.owner.isDestroyed() && !state.owner.webContents.isDestroyed()) {
    state.owner.webContents.send("embedded-browser:state-changed", statePayload(state));
  }
}

function stateForWindow(window: BrowserWindow, create = false): EmbeddedState | null {
  const key = window.webContents.id;
  let state = views.get(key) ?? null;
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
    state = { owner: window, view, visible: false, defaultUserAgent: view.webContents.getUserAgent(), preferences: {} };
    views.set(key, state);
    window.contentView.addChildView(view);
    view.setVisible(false);
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    const publish = () => publishState(state!);
    view.webContents.on("did-navigate", publish);
    view.webContents.on("did-navigate-in-page", publish);
    view.webContents.on("page-title-updated", publish);
    view.webContents.on("did-start-loading", publish);
    view.webContents.on("did-stop-loading", publish);
    const onDownload = (_event: Electron.Event, item: Electron.DownloadItem) => {
      const prefs = state!.preferences;
      const exceedsLimit = () => Boolean(prefs.maxBytes && (
        (item.getTotalBytes() > 0 && item.getTotalBytes() > prefs.maxBytes) || item.getReceivedBytes() > prefs.maxBytes
      ));
      if (exceedsLimit()) {
        item.cancel();
        return;
      }
      item.on("updated", () => { if (exceedsLimit()) item.cancel(); });
      if (prefs.askSavePath === false && prefs.downloadPath) {
        item.setSavePath(path.join(prefs.downloadPath, path.basename(item.getFilename())));
      }
    };
    view.webContents.session.on("will-download", onDownload);
    window.once("closed", () => {
      view.webContents.session.removeListener("will-download", onDownload);
      if (!view.webContents.isDestroyed()) view.webContents.close();
      views.delete(key);
      agentPolicies.delete(key);
    });
  }
  return state;
}

function stateFor(event: Electron.IpcMainInvokeEvent, create = false): EmbeddedState | null {
  return stateForWindow(ownerWindow(event), create);
}

function safeUrl(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : "about:blank";
  if (raw === "about:blank" || /^https?:\/\//i.test(raw)) return raw;
  throw new Error("Only HTTP(S) URLs are allowed");
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
  state.view.setVisible(visible);
  state.view.webContents.setAudioMuted(!visible);
  publishState(state);
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

async function evaluate(state: EmbeddedState, script: string): Promise<unknown> {
  const result = await state.view.webContents.executeJavaScript(script, true);
  return boundedResult(result);
}

async function waitForVisible(state: EmbeddedState): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!state.visible && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!state.visible) throw new Error("Open the Browser dock tab to use the embedded browser");
}

export async function controlEmbeddedBrowser(
  window: BrowserWindow,
  command: EmbeddedBrowserCommand,
  reveal: () => void,
): Promise<unknown> {
  const policy = agentPolicies.get(window.webContents.id) ?? { enabled: false, priority: "builtin" };
  if (!policy.enabled) throw new Error("Enable the embedded browser and Agent access in Settings → Browser");
  const action = typeof command?.action === "string" ? command.action : "status";
  if (action === "status") {
    const state = stateForWindow(window);
    return { enabled: true, priority: policy.priority, ...(state ? statePayload(state) : { visible: false, url: "about:blank" }) };
  }
  if (!["navigate", "back", "forward", "reload", "snapshot", "evaluate", "click", "type", "scroll"].includes(action)) {
    throw new Error("Unsupported embedded browser action");
  }
  const state = stateForWindow(window, true)!;
  reveal();
  await waitForVisible(state);
  const contents = state.view.webContents;
  if (action === "navigate") {
    await contents.loadURL(safeUrl(command.url));
  } else if (action === "back") {
    contents.navigationHistory.goBack();
  } else if (action === "forward") {
    contents.navigationHistory.goForward();
  } else if (action === "reload") {
    contents.reload();
  } else if (action === "snapshot") {
    return evaluate(state, `(() => {
      const text = (document.body?.innerText || "").replace(/\\n{3,}/g, "\\n\\n").slice(0, 24000);
      const elements = Array.from(document.querySelectorAll("a,button,input,textarea,select,[role=button]")).slice(0, 80).map((element) => {
        const attributes = {};
        for (const name of ["id", "name", "type", "href", "placeholder", "aria-label"]) {
          const value = element.getAttribute(name); if (value) attributes[name] = value.slice(0, 300);
        }
        const selector = element.id ? "#" + CSS.escape(element.id) : element.tagName.toLowerCase();
        return { selector, text: (element.innerText || element.value || "").trim().slice(0, 240), attributes };
      });
      return { url: location.href, title: document.title, text, elements };
    })()`);
  } else if (action === "evaluate") {
    if (typeof command.script !== "string" || !command.script.trim() || command.script.length > 50_000) {
      throw new Error("A browser script of at most 50000 characters is required");
    }
    return evaluate(state, command.script);
  } else if (action === "click") {
    return evaluate(state, `(() => { const element = document.querySelector(${JSON.stringify(requiredSelector(command.selector))}); if (!element) throw new Error("Element not found"); element.scrollIntoView({block:"center"}); element.click(); return { clicked: true }; })()`);
  } else if (action === "type") {
    if (typeof command.text !== "string" || command.text.length > 100_000) throw new Error("Invalid browser text");
    return evaluate(state, `(() => { const element = document.querySelector(${JSON.stringify(requiredSelector(command.selector))}); if (!element) throw new Error("Element not found"); element.focus(); const value = ${JSON.stringify(command.text)}; if ("value" in element) { element.value = value; } else { element.textContent = value; } element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value })); element.dispatchEvent(new Event("change", { bubbles: true })); return { typed: value.length }; })()`);
  } else if (action === "scroll") {
    const x = typeof command.x === "number" && Number.isFinite(command.x) ? command.x : 0;
    const y = typeof command.y === "number" && Number.isFinite(command.y) ? command.y : 0;
    return evaluate(state, `(() => { window.scrollBy({ left: ${Math.max(-20000, Math.min(20000, x))}, top: ${Math.max(-20000, Math.min(20000, y))}, behavior: "instant" }); return { x: scrollX, y: scrollY }; })()`);
  }
  publishState(state);
  return statePayload(state);
}

export function registerEmbeddedBrowserIpc(): void {
  ipcMain.handle("embedded-browser:show", async (event, params: { bounds: unknown; url?: unknown; preferences?: Preferences }) => {
    if (!assertTrustedIpcSender(event, "embedded-browser:show")) throw new Error("IPC sender not trusted");
    const state = stateFor(event, true)!;
    applyPreferences(state, params?.preferences ?? {});
    state.view.setBounds(safeBounds(params?.bounds));
    if (params?.url && !state.view.webContents.getURL()) await state.view.webContents.loadURL(safeUrl(params.url));
    setVisible(state, true);
    return statePayload(state);
  });

  ipcMain.handle("embedded-browser:hide", (event) => {
    if (!assertTrustedIpcSender(event, "embedded-browser:hide")) throw new Error("IPC sender not trusted");
    const state = stateFor(event);
    if (state) setVisible(state, false);
    return state ? statePayload(state) : { visible: false };
  });

  ipcMain.handle("embedded-browser:bounds", (event, bounds: unknown) => {
    if (!assertTrustedIpcSender(event, "embedded-browser:bounds")) throw new Error("IPC sender not trusted");
    const state = stateFor(event);
    if (state) state.view.setBounds(safeBounds(bounds));
    return state ? statePayload(state) : { visible: false };
  });

  ipcMain.handle("embedded-browser:navigate", async (event, url: unknown) => {
    if (!assertTrustedIpcSender(event, "embedded-browser:navigate")) throw new Error("IPC sender not trusted");
    const state = stateFor(event, true)!;
    await state.view.webContents.loadURL(safeUrl(url));
    return statePayload(state);
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
    applyPreferences(state, preferences);
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
    agentPolicies.set(window.webContents.id, { enabled: policy?.enabled === true, priority });
    return { success: true };
  });
}
