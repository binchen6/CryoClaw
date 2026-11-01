import {afterEach,beforeEach,describe,expect,test,vi} from "vitest";

const state = vi.hoisted(() => ({
  handlers: new Map<string,(event:any,payload?:any)=>any>(),
  window: null as any,
  view: null as any,
  nextId: 1,
}));

class FakeWebContents {
  private url = "";
  private title = "";
  private loading = false;
  destroyed = false;
  defaultUserAgent = "CryoClaw default";
  userAgent = this.defaultUserAgent;
  zoom = 1;
  muted = false;
  navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
    goBack: vi.fn(),
    goForward: vi.fn(),
  };
  session = { on: vi.fn(), removeListener: vi.fn() };
  getURL() { return this.url; }
  getTitle() { return this.title; }
  isLoading() { return this.loading; }
  isDestroyed() { return this.destroyed; }
  getUserAgent() { return this.userAgent; }
  setUserAgent(value: string) { this.userAgent = value; }
  setZoomFactor(value: number) { this.zoom = value; }
  setAudioMuted(value: boolean) { this.muted = value; }
  setWindowOpenHandler() {}
  on() {}
  close() { this.destroyed = true; }
  send() {}
  reload = vi.fn();
  async loadURL(url: string) { this.url = url; this.title = `Title for ${url}`; }
  async executeJavaScript(script: string) {
    if (script.includes("document.body")) return { url: this.url, title: this.title, text: "Readable page", elements: [] };
    return { ok: true, scriptLength: script.length };
  }
}

class FakeWebContentsView {
  webContents = new FakeWebContents();
  visible = false;
  bounds: unknown = null;
  constructor() { state.view = this; }
  setVisible(value: boolean) { this.visible = value; }
  setBounds(value: unknown) { this.bounds = value; }
}

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => state.window },
  WebContentsView: FakeWebContentsView,
  ipcMain: { handle: (channel: string, handler: any) => state.handlers.set(channel, handler) },
  shell: { openExternal: vi.fn() },
}));
vi.mock("./ipc-sender-guard", () => ({ assertTrustedIpcSender: () => true }));

function makeWindow() {
  state.window = {
    webContents: { id: state.nextId++, isDestroyed: () => false, send: vi.fn() },
    contentView: { addChildView: vi.fn() },
    isDestroyed: () => false,
    once: vi.fn(),
  };
  return state.window;
}

function event() {
  return { sender: {}, senderFrame: { url: "file:///chat/index.html" } };
}

async function enable(owner: any, priority: "builtin" | "webbridge" | "kernel" = "builtin") {
  await state.handlers.get("embedded-browser:agent-policy")!(event(), { enabled: true, priority });
}

async function show() {
  await state.handlers.get("embedded-browser:show")!(event(), {
    bounds: { x: 10, y: 20, width: 640, height: 480 },
    url: "about:blank",
    preferences: {},
  });
}

describe("embedded browser Agent control", () => {
  beforeEach(async () => {
    vi.resetModules();
    state.handlers.clear();
    state.view = null;
    const { registerEmbeddedBrowserIpc } = await import("./embedded-browser");
    registerEmbeddedBrowserIpc();
  });
  afterEach(() => { vi.useRealTimers(); });

  test("rejects Agent access until the user enables it, then reports coexistence priority", async () => {
    const { controlEmbeddedBrowser } = await import("./embedded-browser");
    const owner = makeWindow();
    await expect(controlEmbeddedBrowser(owner, { action: "status" }, () => {})).rejects.toThrow("Enable the embedded browser");
    await enable(owner, "kernel");
    await expect(controlEmbeddedBrowser(owner, { action: "status" }, () => {})).resolves.toMatchObject({ enabled: true, priority: "kernel", visible: false });
  });

  test("navigates after revealing the Dock and reads the same live page", async () => {
    const { controlEmbeddedBrowser } = await import("./embedded-browser");
    const owner = makeWindow();
    await enable(owner);
    let revealed = 0;
    const reveal = () => { revealed++; void show(); };
    await expect(controlEmbeddedBrowser(owner, { action: "navigate", url: "https://example.com" }, reveal)).resolves.toMatchObject({ visible: true, url: "https://example.com" });
    expect(revealed).toBe(1);
    await expect(controlEmbeddedBrowser(owner, { action: "snapshot" }, reveal)).resolves.toMatchObject({ url: "https://example.com", text: "Readable page" });
    expect(state.view.visible).toBe(true);
  });

  test("hide preserves the page, user actions remain available and UA resets to default", async () => {
    const { controlEmbeddedBrowser } = await import("./embedded-browser");
    const owner = makeWindow();
    await enable(owner);
    await show();
    await controlEmbeddedBrowser(owner, { action: "navigate", url: "https://example.com" }, () => {});
    await state.handlers.get("embedded-browser:preferences")!(event(), { userAgent: "Custom Agent" });
    expect(state.view.webContents.userAgent).toBe("Custom Agent");
    await state.handlers.get("embedded-browser:preferences")!(event(), { userAgent: "" });
    expect(state.view.webContents.userAgent).toBe("CryoClaw default");
    await state.handlers.get("embedded-browser:hide")!(event());
    expect(state.view.visible).toBe(false);
    expect(state.view.webContents.muted).toBe(true);
    await state.handlers.get("embedded-browser:action")!(event(), "reload");
    expect(state.view.webContents.getURL()).toBe("https://example.com");
  });

  test("blocks non-HTTP navigation and oversized scripts", async () => {
    const { controlEmbeddedBrowser } = await import("./embedded-browser");
    const owner = makeWindow();
    await enable(owner);
    await show();
    await expect(controlEmbeddedBrowser(owner, { action: "navigate", url: "file:///etc/passwd" }, () => {})).rejects.toThrow("Only HTTP(S)");
    await expect(controlEmbeddedBrowser(owner, { action: "evaluate", script: "x".repeat(50_001) }, () => {})).rejects.toThrow("at most 50000");
  });
});
