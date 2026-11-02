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
  events = new Map<string, Function[]>();
  navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
    goBack: vi.fn(),
    goForward: vi.fn(),
  };
  session = { on: vi.fn(), removeListener: vi.fn() };
  getURL() { if (this.destroyed) throw new Error("Object has been destroyed"); return this.url; }
  getTitle() { return this.title; }
  isLoading() { return this.loading; }
  isDestroyed() { return this.destroyed; }
  getUserAgent() { return this.userAgent; }
  setUserAgent(value: string) { this.userAgent = value; }
  setZoomFactor(value: number) { this.zoom = value; }
  setAudioMuted(value: boolean) { this.muted = value; }
  setWindowOpenHandler() {}
  on(name: string, handler: Function) { this.events.set(name, [...(this.events.get(name) ?? []), handler]); }
  emit(name: string, ...args: any[]) { for (const handler of this.events.get(name) ?? []) handler(...args); }
  stop = vi.fn();
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
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
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

  test("revoking access while waiting for the Dock prevents navigation", async () => {
    vi.useFakeTimers();
    const { controlEmbeddedBrowser } = await import("./embedded-browser");
    const owner = makeWindow();
    await enable(owner);
    const command = controlEmbeddedBrowser(owner, { action: "navigate", url: "https://example.com" }, () => {});
    const rejected = command.catch(error => error);
    await state.handlers.get("embedded-browser:agent-policy")!(event(), { enabled: false });
    await show();
    await vi.advanceTimersByTimeAsync(100);
    expect(await rejected).toMatchObject({ message: expect.stringMatching(/disabled|Enable/) });
    expect(state.view.webContents.getURL()).not.toBe("https://example.com");
  });

  test("closing the Dock during initial load cannot reveal the native view later", async () => {
    makeWindow();
    await state.handlers.get("embedded-browser:preferences")!(event(), {});
    let finish!: () => void;
    state.view.webContents.loadURL = () => new Promise<void>(resolve => { finish = resolve; });
    const opening = show();
    await state.handlers.get("embedded-browser:hide")!(event());
    finish();
    await opening;
    expect(state.view.visible).toBe(false);
  });

  test("blocks page-initiated local navigation and isolates download listeners", async () => {
    makeWindow();
    await show();
    const prevented = vi.fn();
    state.view.webContents.emit("will-navigate", { preventDefault: prevented }, "file:///secret");
    expect(prevented).toHaveBeenCalledOnce();
    const download = state.view.webContents.session.on.mock.calls.find(([name]: any[]) => name === "will-download")![1];
    const item = { getTotalBytes: () => 100, getReceivedBytes: () => 100, cancel: vi.fn(), on: vi.fn() };
    await state.handlers.get("embedded-browser:preferences")!(event(), { maxBytes: 10 });
    download({}, item, {});
    expect(item.cancel).not.toHaveBeenCalled();
    download({}, item, state.view.webContents);
    expect(item.cancel).toHaveBeenCalledOnce();
  });

  test("hung page evaluation fails within a bounded deadline", async () => {
    vi.useFakeTimers();
    const { controlEmbeddedBrowser } = await import("./embedded-browser");
    const owner = makeWindow();
    await enable(owner); await show();
    state.view.webContents.executeJavaScript = () => new Promise(() => {});
    const rejected = expect(controlEmbeddedBrowser(owner, { action: "evaluate", script: "new Promise(() => {})" }, () => {})).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(16000);
    await rejected;
  });

  test("closing the active tab leaves its successor visible", async () => {
    const { controlEmbeddedBrowser } = await import("./embedded-browser");
    const owner = makeWindow(); await enable(owner); await show();
    await controlEmbeddedBrowser(owner, { action: "navigate", url: "https://first.test" }, () => {});
    const second: any = await state.handlers.get("embedded-browser:utility")!(event(), { action: "new-tab", url: "https://second.test" });
    const result = await state.handlers.get("embedded-browser:utility")!(event(), { action: "close-tab", tabId: second.tabId });
    expect(result).toMatchObject({ visible: true, url: "https://first.test" });
    await expect(controlEmbeddedBrowser(owner, { action: "snapshot" }, () => {})).resolves.toMatchObject({ url: "https://first.test" });
  });

  test("canceling a queued command cannot let a newer command overtake the running one", async () => {
    const { controlEmbeddedBrowser } = await import("./embedded-browser");
    const owner = makeWindow(); await enable(owner); await show();
    let release!: (value: unknown) => void;
    const execute = vi.fn((script: string) => script === "first" ? new Promise(resolve => { release = resolve; }) : Promise.resolve(script));
    state.view.webContents.executeJavaScript = execute;
    const first = controlEmbeddedBrowser(owner, { action: "evaluate", script: "first" }, () => {});
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const abort = new AbortController();
    const second = controlEmbeddedBrowser(owner, { action: "evaluate", script: "second" }, () => {}, abort.signal).catch(error => error);
    abort.abort(new Error("canceled")); await second;
    const third = controlEmbeddedBrowser(owner, { action: "evaluate", script: "third" }, () => {});
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(execute).toHaveBeenCalledOnce();
    release("done"); await first; await third;
    expect(execute.mock.calls.map(call => call[0])).toEqual(["first", "third"]);
  });

  test("download completion after closing its source tab never reads destroyed contents", async () => {
    makeWindow(); await show();
    const source = state.view.webContents;
    const download = source.session.on.mock.calls.find(([name]: any[]) => name === "will-download")![1];
    let done!: Function;
    const item = { getTotalBytes: () => 2, getReceivedBytes: () => 2, getFilename: () => "qa.txt", getSavePath: () => "qa.txt", cancel: vi.fn(), on: vi.fn(), once: (_name: string, callback: Function) => { done = callback; } };
    download({}, item, source);
    const before = await state.handlers.get("embedded-browser:bounds")!(event(), { x: 0, y: 0, width: 500, height: 500 });
    await state.handlers.get("embedded-browser:utility")!(event(), { action: "new-tab" });
    await state.handlers.get("embedded-browser:utility")!(event(), { action: "close-tab", tabId: before.tabId });
    expect(source.destroyed).toBe(true);
    expect(() => done({}, "completed")).not.toThrow();
  });

  test("browser preferences apply to existing background tabs", async () => {
    makeWindow(); await show();
    const first = state.view.webContents;
    await state.handlers.get("embedded-browser:utility")!(event(), { action: "new-tab" });
    await state.handlers.get("embedded-browser:preferences")!(event(), { userAgent: "Updated", maxBytes: 10 });
    expect(first.userAgent).toBe("Updated");
    const download = first.session.on.mock.calls.find(([name]: any[]) => name === "will-download")![1];
    const item = { getTotalBytes: () => 100, getReceivedBytes: () => 0, cancel: vi.fn() };
    download({}, item, first);
    expect(item.cancel).toHaveBeenCalledOnce();
  });

  test("repeated dock reveals do not initialize a second blank navigation while the first loads", async () => {
    makeWindow();
    await state.handlers.get("embedded-browser:preferences")!(event(), {});
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const load = state.view.webContents.loadURL = vi.fn(() => pending);
    const first = show(), second = show();
    const calls = load.mock.calls.length;
    finish(); await Promise.all([first, second]);
    expect(calls).toBe(1);
  });

  test("an aborted initial blank load cannot stop or report an error on the newer Agent navigation", async () => {
    const { controlEmbeddedBrowser } = await import("./embedded-browser");
    const owner = makeWindow(); await enable(owner);
    await state.handlers.get("embedded-browser:preferences")!(event(), {});
    const contents = state.view.webContents;
    const originalLoad = contents.loadURL.bind(contents);
    let rejectBlank!: (error: Error) => void, finishPage!: () => void;
    contents.loadURL = vi.fn((url: string) => url === "about:blank"
      ? new Promise<void>((_resolve, reject) => { rejectBlank = reject; })
      : new Promise<void>(resolve => { finishPage = () => { void originalLoad(url).then(resolve); }; }));
    const initial = show().catch(() => {});
    const navigation = controlEmbeddedBrowser(owner, { action: "navigate", url: "https://current.test" }, () => {});
    await vi.waitFor(() => expect(contents.loadURL).toHaveBeenCalledTimes(2));
    rejectBlank(new Error("ERR_ABORTED")); await initial;
    const stops = contents.stop.mock.calls.length;
    finishPage(); const result = await navigation;
    expect(stops).toBe(0);
    expect(result).toMatchObject({ url: "https://current.test", error: "" });
  });
});
