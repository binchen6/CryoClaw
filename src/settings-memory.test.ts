import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  stateDir: "",
  config: {} as any,
  handlers: new Map<string, (...args: any[]) => any>(),
  code: 0 as number | null,
  stdout: '{"results":[]}',
  stderr: "",
}));
vi.mock("electron", () => ({ ipcMain: { handle: (name: string, handler: any) => h.handlers.set(name, handler) }, shell: {} }));
vi.mock("./constants", () => ({ resolveUserStateDir: () => h.stateDir, resolveNodeBin: () => "node", resolveGatewayEntry: () => "gateway.mjs", resolveGatewayCwd: () => h.stateDir }));
vi.mock("./provider-config", () => ({ readUserConfig: () => h.config, readUserConfigForWrite: () => ({ config: h.config, baseSnapshot: h.config }), writeUserConfig: vi.fn() }));
vi.mock("./cryoclaw-config", () => ({ readCryoclawConfig: () => ({}), writeCryoclawConfig: vi.fn() }));
vi.mock("./ipc-sender-guard", () => ({ assertTrustedIpcSender: () => true }));
vi.mock("./kimi-config", () => ({ syncPluginAllowOnEnable: vi.fn() }));
vi.mock("./logger", () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }));
vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(() => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(h.stdout));
      child.stderr.emit("data", Buffer.from(h.stderr));
      child.emit("close", h.code);
    });
    return child;
  }),
}));

import { registerMemoryIpc } from "./settings/memory";

beforeEach(() => {
  h.stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-memory-ipc-"));
  h.config = {};
  h.code = 0;
  h.stdout = '{"results":[]}';
  h.stderr = "";
  h.handlers.clear();
  registerMemoryIpc();
});
afterEach(() => fs.rmSync(h.stateDir, { recursive: true, force: true }));

test("memory list and append follow the configured main-agent workspace", async () => {
  const custom = path.join(h.stateDir, "configured");
  h.config = { agents: { defaults: { workspace: path.join(h.stateDir, "defaults") }, list: [{ id: "main", workspace: custom }] } };
  fs.mkdirSync(custom);
  fs.writeFileSync(path.join(custom, "MEMORY.md"), "## Existing\n\nSaved memory");
  const list = await h.handlers.get("memory:list")!({});
  expect(list.data.entries.some((entry: any) => entry.title === "Existing")).toBe(true);
  expect(await h.handlers.get("memory:append")!({}, { title: "Added", content: "New memory" })).toEqual({ success: true, data: { appended: true } });
  expect(fs.readFileSync(path.join(custom, "MEMORY.md"), "utf8")).toContain("New memory");
  expect(fs.existsSync(path.join(h.stateDir, "workspace", "MEMORY.md"))).toBe(false);
});

test.each(["memory:recall-test", "memory:reindex"])("%s rejects a failed CLI even when stdout contains JSON", async channel => {
  h.code = 1;
  h.stdout = '{"results":[{"content":"partial result"}]}';
  h.stderr = "index failed: database is locked";
  expect(await h.handlers.get(channel)!({}, { query: "example" })).toEqual({ success: false, message: h.stderr });
});

test("successful recall preserves parsed results", async () => {
  h.stdout = '[memory] warning\n{"results":[{"content":"found"}]}';
  const result = await h.handlers.get("memory:recall-test")!({}, { query: "example" });
  expect(result.success).toBe(true);
  expect(result.data.results).toEqual([{ content: "found" }]);
});
