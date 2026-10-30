import { beforeEach, expect, test, vi } from "vitest";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { useTempStateDir } from "./test-support/vitest-state-dir";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<any>>(),
  calls: [] as { args: string[]; done: (error: Error | null, stdout: string, stderr: string) => void }[],
  inventory:vi.fn(),
  jsonGet: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getAppPath: () => process.cwd() },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => Promise<any>) => h.handlers.set(channel, handler) },
  dialog: {},
}));
vi.mock("child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: (_bin: string, args: string[], _options: unknown, done: (error: Error | null, stdout: string, stderr: string) => void) => {
    h.calls.push({ args, done });
    return { pid: 40000 + h.calls.length, killed: false, kill() { this.killed = true; } };
  },
}));
vi.mock("./logger", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("./plugin-demand",()=>({currentChannelPluginInventory:(...args:unknown[])=>h.inventory(...args)}));
vi.mock("./skill-store", async importOriginal => ({
  ...await importOriginal<typeof import("./skill-store")>(),
  jsonGet: (...args: unknown[]) => h.jsonGet(...args),
  readSkillStoreRegistry: () => "https://market.test",
}));

useTempStateDir("plugin-store-lifecycle-");
beforeEach(() => { vi.resetModules(); h.handlers.clear(); h.calls.length = 0;h.inventory.mockReset(); h.jsonGet.mockReset(); });

const trustedEvent = { senderFrame: { url: pathToFileURL(path.join(process.cwd(), "chat-ui", "dist", "index.html")).href } };
const output = JSON.stringify({ plugins: [{ id: "sample", name: "Sample", version: "1.2.3", enabled: true }] });

async function register() {
  const store = await import("./plugin-store");
  store.registerPluginStoreIpc();
  return store;
}

test("first extension visit loads the list once, shares concurrent visits and reuses the successful result", async () => {
  await register();
  expect(h.calls).toHaveLength(0);
  const list = h.handlers.get("plugin-store:list")!;
  const first = list(trustedEvent), second = list(trustedEvent);
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0].args.slice(-3)).toEqual(["plugins", "list", "--json"]);
  h.calls[0].done(null, output, "");
  expect(await first).toEqual({ success: true, data: [{ id: "sample", name: "Sample", version: "1.2.3", enabled: true, local: false }] });
  expect(await second).toEqual(await first);
  expect(await list(trustedEvent)).toEqual(await first);
  expect(h.calls).toHaveLength(1);
});

test("a failed first scan is retryable on the next extension visit", async () => {
  await register();
  const list = h.handlers.get("plugin-store:list")!;
  const first = list(trustedEvent);
  h.calls[0].done(new Error("temporary scan error"), "", "");
  expect(await first).toEqual({ success: false, message: "temporary scan error" });
  const retried = list(trustedEvent);
  expect(h.calls).toHaveLength(2);
  h.calls[1].done(null, output, "");
  expect((await retried).success).toBe(true);
});

test("quitting prevents late plugin requests from starting another kernel CLI process", async () => {
  const store = await register();
  const list = h.handlers.get("plugin-store:list")!;
  const pending = list(trustedEvent);
  store.preventKernelCliStartsForQuit();
  h.calls[0].done(new Error("scan stopped"), "", "");
  await pending;
  expect(await list(trustedEvent)).toEqual({ success: false, message: "Application is quitting" });
  expect(h.calls).toHaveLength(1);
});

test("stopping tracked CLI children before an installer handoff does not permanently disable a failed update session", async () => {
  const store = await register();
  const list = h.handlers.get("plugin-store:list")!;
  const pending = list(trustedEvent);
  store.killTrackedKernelCliChildren();
  h.calls[0].done(new Error("installer handoff stopped the scan"), "", "");
  await pending;
  const nextVisit = list(trustedEvent);
  expect(h.calls).toHaveLength(2);
  h.calls[1].done(null, output, "");
  expect((await nextVisit).success).toBe(true);
});

function channelConfig(){
 const file=path.join(process.env.OPENCLAW_STATE_DIR!,'openclaw.json');
 fs.writeFileSync(file,JSON.stringify({plugins:{entries:{'wecom-openclaw-plugin':{enabled:true}}},channels:{wecom:{enabled:true,secret:'preserved'}}}));
 return file;
}
test('disabling remains available when metadata cannot be read and preserves credentials',async()=>{
 const file=channelConfig();h.inventory.mockRejectedValue(new Error('broken third-party manifest'));await register();
 const result=await h.handlers.get('plugin-store:set-enabled')!(trustedEvent,{id:'wecom-openclaw-plugin',enabled:false});
 expect(result.success).toBe(true);const config=JSON.parse(fs.readFileSync(file,'utf8'));expect(config.plugins.entries['wecom-openclaw-plugin'].enabled).toBe(false);expect(config.channels.wecom).toEqual({enabled:false,secret:'preserved'});expect(h.inventory.mock.calls[0][1]).toBe(true);
});
test('enabling rejects incomplete metadata instead of changing configuration',async()=>{
 const file=channelConfig(),before=fs.readFileSync(file,'utf8');h.inventory.mockRejectedValue(new Error('broken metadata'));await register();
 const result=await h.handlers.get('plugin-store:set-enabled')!(trustedEvent,{id:'wecom-openclaw-plugin',enabled:true});
 expect(result.success).toBe(false);expect(fs.readFileSync(file,'utf8')).toBe(before);expect(h.inventory.mock.calls[0][1]).toBe(false);
});
test('valid partial metadata governs disabling without guessing a selected provider is a channel',async()=>{
 const file=channelConfig();h.inventory.mockResolvedValue({installed:new Set(['wecom-openclaw-plugin']),channels:new Map()});await register();
 const result=await h.handlers.get('plugin-store:set-enabled')!(trustedEvent,{id:'wecom-openclaw-plugin',enabled:false});
 expect(result.success).toBe(true);expect(JSON.parse(fs.readFileSync(file,'utf8')).channels.wecom.enabled).toBe(true);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const marketResult = (name: string) => ({ results: [{ score: 1, package: { name, family: "code-plugin" } }] });

test("concurrent cold market visits share one complete set of 28 requests and its cached result", async () => {
  const pending = deferred<ReturnType<typeof marketResult>>();
  h.jsonGet.mockReturnValue(pending.promise);
  const store = await register(), browse = h.handlers.get("plugin-store:market-browse")!;
  const requestCount = Object.values(store.PLUGIN_MARKET_CATEGORY_KEYWORDS).flat().length * 2;
  expect(requestCount).toBe(28);
  const first = browse(trustedEvent, { limit: 20 }), second = browse(trustedEvent, { limit: 20 });
  const coldRequests = h.jsonGet.mock.calls.length;
  pending.resolve(marketResult("shared"));
  const [a, b] = await Promise.all([first, second]);
  expect(coldRequests).toBe(requestCount);
  expect(a.success).toBe(true); expect(b).toEqual(a);
  expect(a.data.items[0].categories).toEqual(Object.keys(store.PLUGIN_MARKET_CATEGORY_KEYWORDS));
  expect(await browse(trustedEvent, { limit: 20 })).toEqual(a);
  expect(h.jsonGet).toHaveBeenCalledTimes(requestCount);
  expect(h.calls).toHaveLength(0);
});

test("different market limits own independent pending requests", async () => {
  const twenty = deferred<ReturnType<typeof marketResult>>(), thirty = deferred<ReturnType<typeof marketResult>>();
  h.jsonGet.mockImplementation((url: string) => new URL(url).searchParams.get("limit") === "20" ? twenty.promise : thirty.promise);
  await register(); const browse = h.handlers.get("plugin-store:market-browse")!;
  const first = browse(trustedEvent, { limit: 20 }), second = browse(trustedEvent, { limit: 30 });
  expect(h.jsonGet).toHaveBeenCalledTimes(56);
  twenty.resolve(marketResult("limit-20")); thirty.resolve(marketResult("limit-30"));
  const [a, b] = await Promise.all([first, second]);
  expect(a.data.items[0].name).toBe("limit-20"); expect(b.data.items[0].name).toBe("limit-30");
});

for (const oldFinishesFirst of [false, true]) {
  test(`market invalidation retires an old request when it finishes ${oldFinishesFirst ? "before" : "after"} the current one`, async () => {
    const old = deferred<ReturnType<typeof marketResult>>(), current = deferred<ReturnType<typeof marketResult>>();
    h.jsonGet.mockImplementation(() => h.jsonGet.mock.calls.length <= 28 ? old.promise : current.promise);
    await register(); const browse = h.handlers.get("plugin-store:market-browse")!;
    const first = browse(trustedEvent, { limit: 20 });
    const uninstall = h.handlers.get("plugin-store:uninstall")!(trustedEvent, { id: "sample" });
    h.calls[0].done(null, "", ""); expect((await uninstall).success).toBe(true);
    const next = browse(trustedEvent, { limit: 20 });
    let additional: Promise<any> | null = null;
    if (oldFinishesFirst) {
      old.resolve(marketResult("old")); await first;
      additional = browse(trustedEvent, { limit: 20 });
    }
    current.resolve(marketResult("current")); const fresh = await next;
    if (additional) expect(await additional).toEqual(fresh);
    if (!oldFinishesFirst) { old.resolve(marketResult("old")); await first; }
    expect((await browse(trustedEvent, { limit: 20 })).data.items[0].name).toBe("current");
    expect(h.jsonGet).toHaveBeenCalledTimes(56);
  });
}
