import { beforeEach, expect, test, vi } from "vitest";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { useTempStateDir } from "./test-support/vitest-state-dir";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<any>>(),
  calls: [] as { args: string[]; done: (error: Error | null, stdout: string, stderr: string) => void }[],
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

useTempStateDir("plugin-store-lifecycle-");
beforeEach(() => { vi.resetModules(); h.handlers.clear(); h.calls.length = 0; });

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
