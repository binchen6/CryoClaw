import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { transpileModule, ModuleKind } from "typescript";
import * as http from "node:http";
import { runGit } from "./git-run";

// Execute the compiled production modules with only Electron/external transport
// replaced. Filesystem guards and registered IPC handlers remain the real code.
function isolated(name: string, overrides: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const filename = path.join(__dirname, `${name}.js`);
  const nativeRequire = createRequire(filename);
  const module = { exports: {} as any };
  runInNewContext(`(function(require,module,exports,__dirname){${fs.readFileSync(filename, "utf8")}\n})`, {
    process, Buffer, console, URL, setTimeout, clearTimeout, ...globals,
  })((id: string) => id in overrides ? overrides[id] : nativeRequire(id), module, module.exports, __dirname);
  return module.exports;
}

const noop = () => {};
const deps = {
  "./constants": { resolveUserConfigPath: () => "unused", resolveUserStateDir: () => "unused" },
  "./openclaw-health-state": {}, "./config-backup": {}, "./wecom-config": {},
};

function transport() {
  const response = Object.assign(new EventEmitter(), { statusCode: 200, complete: false, destroy: noop });
  const request = Object.assign(new EventEmitter(), { write: noop, end: noop, destroy: noop });
  let callback: ((res: typeof response) => void) | undefined;
  const mod = { request: (_opts: unknown, cb: typeof callback) => { callback = cb; return request; } };
  return { response, request, mod, start: () => callback!(response) };
}

for (const protocol of ["anthropic-messages", "openai-responses"]) {
  for (const suffix of ["", "/", "/v1", "/v1/"]) {
    test(`verifyCustom ${protocol} resolves base ${suffix || "root"} once`, async () => {
      let requested = "";
      const t = transport();
      const mod = { request: (opts: { path: string }, cb: any) => { requested = opts.path; return t.mod.request(opts, cb); } };
      const provider = isolated("provider-config", { ...deps, http: mod, https: mod });
      const result = provider.verifyCustom("key", `http://fixture.invalid${suffix}`, protocol, "model");
      t.start(); t.response.emit("end");
      await result;
      assert.equal(requested, protocol === "anthropic-messages" ? "/v1/messages" : suffix.startsWith("/v1") ? "/v1/responses" : "/responses");
    });
    test(`image probe ${protocol} resolves base ${suffix || "root"} once`, async () => {
      let requested = "";
      const probe = isolated("provider-image-probe", {});
      const outcome = await probe.probeImageSupport({ apiType: protocol, baseURL: `https://fixture.invalid${suffix}`,
        modelID: "model", apiKey: "key", auth: "bearer", request: async (url: string) => { requested = url; } });
      assert.equal(outcome.kind, "supported");
      assert.equal(requested, "https://fixture.invalid" + (protocol === "anthropic-messages" ? "/v1/messages" : suffix.startsWith("/v1") ? "/v1/responses" : "/responses"));
    });
  }
}

for (const kind of ["provider", "channel"]) {
  for (const event of ["aborted", "close", "error"]) {
    test(`${kind} verification rejects partial response ${event}`, async () => {
      const t = transport();
      const provider = isolated("provider-config", { ...deps, http: t.mod, https: t.mod });
      const pending = kind === "provider" ? provider.jsonRequest("http://fixture.invalid", {}) : provider.verifyFeishu("id", "secret");
      const observed = pending.then(() => "resolved", () => "rejected");
      t.start(); t.response.emit("data", Buffer.from('{"code":'));
      assert.doesNotThrow(() => t.response.emit(event, new Error("body failed")));
      assert.equal(await Promise.race([observed, new Promise(resolve => setTimeout(() => resolve("pending"), 40))]), "rejected");
    });
  }
  test(`${kind} verification has a whole-request deadline despite partial data`, async () => {
    const t = transport();
    const timers: Array<() => void> = [];
    const provider = isolated("provider-config", { ...deps, http: t.mod, https: t.mod }, {
      setTimeout: (fn: () => void) => { timers.push(fn); return 1; }, clearTimeout: noop,
    });
    const pending = kind === "provider" ? provider.jsonRequest("http://fixture.invalid", {}) : provider.verifyFeishu("id", "secret");
    const observed = pending.then(() => "resolved", () => "rejected");
    t.start(); t.response.emit("data", Buffer.from("partial"));
    for (const timer of timers) timer();
    assert.equal(await Promise.race([observed, new Promise(resolve => setTimeout(() => resolve("pending"), 40))]), "rejected");
  });
  test(`${kind} response cap rejects before an oversized body can finish`, async () => {
    const t = transport();
    const provider = isolated("provider-config", { ...deps, http: t.mod, https: t.mod });
    const pending = kind === "provider" ? provider.jsonRequest("http://fixture.invalid", {}) : provider.verifyFeishu("id", "secret");
    const rejection = assert.rejects(pending, /8MB/);
    t.start(); t.response.emit("data", Buffer.alloc(8 * 1024 * 1024 + 1));
    await rejection;
  });
  test(`${kind} completed response stays successful when its connection closes`, async () => {
    const t = transport();
    const provider = isolated("provider-config", { ...deps, http: t.mod, https: t.mod });
    const pending = kind === "provider" ? provider.jsonRequest("http://fixture.invalid", {}) : provider.verifyFeishu("id", "secret");
    t.start(); t.response.emit("data", Buffer.from('{"code":0}')); t.response.emit("end"); t.response.emit("close");
    await pending;
  });
}

test("provider response failures keep status and API-key error semantics", async () => {
  for (const status of [401, 403, 429, 500]) {
    const t = transport(); t.response.statusCode = status;
    const provider = isolated("provider-config", { ...deps, http: t.mod });
    const pending = provider.jsonRequest("http://fixture.invalid", {});
    const rejection = assert.rejects(pending, (error: any) => error.status === status &&
      (status === 401 || status === 403 ? /API Key 无效/.test(error.message) : /upstream failed/.test(error.message)));
    t.start(); t.response.emit("data", Buffer.from('{"error":{"message":"upstream failed"}}')); t.response.emit("end");
    await rejection;
  }
});

function workspaceHandler(spawn: (...args: any[]) => unknown, env: Record<string, string> = {}, exists: (p: string) => boolean = () => true, missing = false) {
  const handlers = new Map<string, any>();
  const dir = path.win32.resolve(".cache", "workspace & test");
  const filesystem = { realpathSync: (p: string) => p, statSync: () => {if(missing)throw Error("ENOENT file disappeared");return { isDirectory: () => true, isFile: () => true };}, existsSync: exists,
    promises: { ...fs.promises, realpath: async (p: string) => p } };
  const module = isolated("workspace-ipc", {
    path: path.win32,
    electron: { ipcMain: { handle: (key: string, fn: unknown) => handlers.set(key, fn) }, shell: {} },
    fs: filesystem, "./logger": { error: noop }, "./constants": { resolveUserStateDir: () => path.dirname(dir) },
    "./ipc-sender-guard": { assertTrustedIpcSender: () => true },
    "./provider-config": { readUserConfig: () => ({ agents: { defaults: { workspace: dir } } }) },
    "./cryoclaw-config": { readCryoclawConfig: () => ({}) }, "node:child_process": { spawn },
  }, { process: { ...process, platform: "win32", env } });
  module.registerWorkspaceIpc();
  return { call: (target: string) => handlers.get("workspace:open-with")({}, { path: dir, target }), dir };
}

test("workspace open returns a structured error when the file disappears after admission",async()=>{
  const handler=workspaceHandler(()=>{throw Error("must not spawn");},{},()=>true,true);
  const result=await handler.call("vscode");
  assert.equal(result.success,false);assert.match(result.message,/ENOENT/);
});

for (const target of ["git-bash", "terminal", "vscode"]) {
  test(`workspace opens ${target} with literal arguments and cwd`, async () => {
    let invocation: any[] = [];
    const child = Object.assign(new EventEmitter(), { unref: noop });
    const handler = workspaceHandler((...args) => { invocation = args; queueMicrotask(() => child.emit("spawn")); return child; });
    const result = await handler.call(target);
    assert.equal(result.success, true);
    const [command, args, options] = invocation;
    assert.equal(options.shell, false);
    assert.equal(options.cwd, handler.dir);
    if (target === "terminal") assert.ok(!args.some((arg: string) => arg.includes(handler.dir)), "directory must never be shell code");
    if (target === "vscode") { assert.match(command, /Code\.exe$/i); assert.deepEqual(Array.from(args), [handler.dir]); }
    else if (target === "git-bash") assert.equal(command, "C:\\Program Files\\Git\\git-bash.exe");
    assert.equal(options.windowsHide, target === "vscode");
  });
}

test("workspace returns asynchronous spawn failure without an unhandled error", async () => {
  const child = Object.assign(new EventEmitter(), { unref: noop });
  const handler = workspaceHandler(() => child);
  const pending = handler.call("git-bash");
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotThrow(() => child.emit("error", new Error("ENOENT helper")));
  assert.equal((await pending).success, false);
});

test("Git executes a pinned absolute program rather than searching the repository cwd", async () => {
  let executable = "";
  const git = isolated("git-run", { child_process: { execFile: (command: string, _args: unknown, _opts: unknown, cb: any) => { executable = command; cb(null, "", ""); } } });
  await git.runGit(path.resolve(".cache"), ["status"], 1000, 1000);
  assert.equal(path.isAbsolute(executable), true);
  assert.notEqual(path.dirname(executable), path.resolve(".cache"));
});

test("Git detection and execution share the same cached PATH executable and ignore cwd bait", async () => {
  const trusted = path.resolve(".cache", "trusted-git-bin");
  const chosen = path.join(trusted, "git.exe");
  const checked: string[] = [];
  const resolver = isolated("git-executable", { fs: {
    statSync: (file: string) => { checked.push(file); return { isFile: () => file === chosen }; },
    realpathSync: (file: string) => file,
  } }, { process: { ...process, platform: "win32", env: { PATH: `.${path.delimiter}${trusted}` } } });
  const launched: string[] = [];
  const childProcess = { execFile: (command: string, _args: unknown, _opts: unknown, cb: any) => {
    launched.push(command); cb(null, "git version 2.49.0", "");
  } };
  const overrides = { "./git-executable": resolver, child_process: childProcess, "./logger": { info: noop, warn: noop } };
  await isolated("git-detector", overrides).detectGit();
  await isolated("git-run", overrides).runGit(path.resolve(".cache", "repository-with-git.exe"), ["status"], 1000, 1000);
  assert.deepEqual(launched, [chosen, chosen]);
  assert.deepEqual(checked, [chosen]);
});

test("Windows terminal uses an absolute system host and creates a new interactive console", async () => {
  let invocation: any[] = [];
  const child = Object.assign(new EventEmitter(), { unref: noop });
  const handler = workspaceHandler((...args) => { invocation = args; queueMicrotask(() => child.emit("spawn")); return child; }, { SystemRoot: "C:\\Windows" });
  await handler.call("terminal");
  assert.equal(invocation[0], "C:\\Windows\\System32\\cmd.exe");
  assert.ok(invocation[1].includes("start"));
  assert.ok(!invocation[1].some((arg: string) => arg.includes(handler.dir)));
});

test("VS Code does not search a PATH entry's unrelated parent directory", async () => {
  let spawned = false;
  const handler = workspaceHandler(() => { spawned = true; throw Error("must not spawn"); }, { PATH: "C:\\Tools\\OtherTool\\bin" },
    p => p === "C:\\Tools\\OtherTool\\Code.exe");
  assert.equal((await handler.call("vscode")).success, false);
  assert.equal(spawned, false);
});

test("VS Code supports Code.exe directly in an absolute PATH entry", async () => {
  let executable = "";
  const child = Object.assign(new EventEmitter(), { unref: noop });
  const handler = workspaceHandler((command) => { executable = command; queueMicrotask(() => child.emit("spawn")); return child; },
    { PATH: "C:\\PortableVSCode" }, p => p === "C:\\PortableVSCode\\Code.exe");
  assert.equal((await handler.call("vscode")).success, true);
  assert.equal(executable, "C:\\PortableVSCode\\Code.exe");
});

test("VS Code accepts the parent executable only with its PATH bin/code.cmd launcher", async () => {
  let executable = "";
  const child = Object.assign(new EventEmitter(), { unref: noop });
  const handler = workspaceHandler(command => { executable = command; queueMicrotask(() => child.emit("spawn")); return child; },
    { PATH: "C:\\Tools\\VSCode\\bin" }, file => ["C:\\Tools\\VSCode\\Code.exe", "C:\\Tools\\VSCode\\bin\\code.cmd"].includes(file));
  assert.equal((await handler.call("vscode")).success, true);
  assert.equal(executable, "C:\\Tools\\VSCode\\Code.exe");
});

test("attachment denies direct physical credentials when protected roots themselves are junctions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attachment-reverse-"));
  const physical = path.join(dir, "physical"), state = path.join(dir, "state-link");
  fs.mkdirSync(physical); fs.writeFileSync(path.join(physical, "openclaw.json"), "fixture");
  fs.symlinkSync(physical, state, process.platform === "win32" ? "junction" : "dir");
  try {
    const policy = isolated("file-read-base64", { "./constants": { resolveUserStateDir: () => state } });
    await assert.rejects(attachmentHandler(fs, policy.evaluateFileReadTarget)({}, path.join(physical, "openclaw.json")), /denied/);
    const linkedCredentials = path.join(dir, "credentials"), external = path.join(dir, "external");
    fs.mkdirSync(external); fs.writeFileSync(path.join(external, "key"), "fixture");
    fs.symlinkSync(external, linkedCredentials, process.platform === "win32" ? "junction" : "dir");
    const policy2 = isolated("file-read-base64", { "./constants": { resolveUserStateDir: () => dir } });
    await assert.rejects(attachmentHandler(fs, policy2.evaluateFileReadTarget)({}, path.join(external, "key")), /denied/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("attachment refuses an object replaced between stat and open", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attachment-swap-"));
  const target = path.join(dir, "report.png"), replacement = path.join(dir, "replacement");
  fs.writeFileSync(target, "original"); fs.writeFileSync(replacement, "private");
  try {
    const handler = attachmentHandler({ promises: { ...fs.promises, open: async (p: string, flags: any) => {
      fs.unlinkSync(target); fs.renameSync(replacement, target); return fs.promises.open(p, flags);
    } } }, () => ({ ok: true }));
    await assert.rejects(handler({}, target), /changed|denied/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("attachment denylist canonicalizes protected home directories independently", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attachment-home-"));
  try {
    const home = path.join(dir, "home"); fs.mkdirSync(home);
    const policy = isolated("file-read-base64", { "./constants": { resolveUserStateDir: () => dir } });
    for (const name of [".ssh", ".aws", ".gnupg"]) {
      const physical = path.join(dir, `physical-${name}`); fs.mkdirSync(physical);
      fs.symlinkSync(physical, path.join(home, name), process.platform === "win32" ? "junction" : "dir");
      assert.equal(policy.isCredentialPathDenied(path.join(physical, "key"), dir, home), true);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("attachment bounds an unexpectedly growing file to 16MiB plus one byte", async () => {
  const limit = 16 * 1024 * 1024;
  let readBytes = 0;
  const stat = { isFile: () => true, size: 3n, dev: 1n, ino: 2n };
  const handler = attachmentHandler({ promises: {
    stat: async () => stat, realpath: async (p: string) => p,
    open: async () => ({ stat: async () => stat, close: async () => {},
      readFile: async () => Buffer.alloc(limit + 500),
      read: async (_buffer: Buffer, _offset: number, length: number) => { readBytes += length; return { bytesRead: length }; },
    }),
  } }, () => ({ ok: true }));
  const result = await handler({}, path.resolve(".cache", "growing.png"));
  assert.equal(result.error, "too-large"); assert.equal(result.size, limit + 1);
  assert.equal(readBytes, limit + 1);
});

test("Git workspace operations use root-relative status paths without accessing sibling trees", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-workspace-"));
  const sub = path.join(dir, "sub"); fs.mkdirSync(path.join(sub, "sub"), { recursive: true });
  const git = async (...args: string[]) => { const result = await runGit(dir, args, 5000, 1024 * 1024); assert.equal(result.code, 0, result.stderr); return result; };
  try {
    await git("init"); await git("config", "core.autocrlf", "false");
    for (const file of ["sub/file[1].txt", "sub/sub/file[1].txt", "outside.txt"]) fs.writeFileSync(path.join(dir, file), "original\n");
    await git("add", "--", "."); await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture");
    for (const file of ["sub/file[1].txt", "sub/sub/file[1].txt", "outside.txt"]) fs.writeFileSync(path.join(dir, file), "changed\n");
    const handlers = new Map<string, any>();
    isolated("git-ipc", { electron: { ipcMain: { handle: (key: string, fn: unknown) => handlers.set(key, fn) } },
      "./workspace-ipc": { resolveAllowedDir: async () => sub }, "./git-detector": { detectGitCached: async () => ({ available: true }) },
      "./ipc-sender-guard": { assertTrustedIpcSender: () => true }, "./logger": { error: noop },
    }).registerGitIpc();
    const status = await handlers.get("git:status")({}, sub);
    assert.ok(status.data.entries.every((entry: any) => entry.path.startsWith("sub/")));
    assert.equal((await handlers.get("git:stage")({}, sub, ["sub/file[1].txt"])).success, true);
    assert.equal((await git("diff", "--cached", "--name-only")).stdout.trim(), "sub/file[1].txt");
    assert.equal((await handlers.get("git:discard")({}, sub, ["sub/sub/file[1].txt"])).success, true);
    assert.equal(fs.readFileSync(path.join(sub, "sub/file[1].txt"), "utf8"), "original\n");
    assert.equal((await handlers.get("git:discard")({}, sub, ["outside.txt"])).success, false);
    assert.equal(fs.readFileSync(path.join(dir, "outside.txt"), "utf8"), "changed\n");
    const stats = await handlers.get("git:change-stats")({}, sub, ["sub/file[1].txt"]);
    assert.equal(stats.success, true); assert.equal(stats.data.stats[0].additions, 1);
    assert.equal(stats.data.stats[0].deletions, 1);
    const diff = await handlers.get("git:diff")({}, sub, { path: "sub/file[1].txt", cached: true });
    assert.equal(diff.success, true); assert.equal(diff.data.files.length, 1);
    const allDiff = await handlers.get("git:diff")({}, sub);
    assert.equal(allDiff.success, true); assert.equal(allDiff.data.files.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Responses verification preserves base query parameters and follows SDK base semantics", async () => {
  for (const base of ["http://fixture.invalid?api-version=preview", "http://fixture.invalid/v1?api-version=preview"]) {
    const t = transport(); let requested = "";
    const provider = isolated("provider-config", { ...deps, http: { request: (opts: any, cb: any) => { requested = opts.path; return t.mod.request(opts, cb); } } });
    const pending = provider.verifyCustom("key", base, "openai-responses", "model");
    t.start(); t.response.emit("end"); await pending;
    assert.equal(requested, base.includes("/v1?") ? "/v1/responses?api-version=preview" : "/responses?api-version=preview");
  }
});

test("Responses URLs match requests made by the bundled OpenAI SDK", async (context) => {
  const sdkPath = path.join(process.cwd(), "resources", "targets", "win32-x64", "gateway", "node_modules", "openai");
  if (!fs.existsSync(path.join(sdkPath, "package.json"))) return context.skip("Packaged runtime not installed");
  const Client = createRequire(__filename)(sdkPath).OpenAI;
  const { resolveV1Endpoint } = isolated("provider-api-url", {});
  for (const baseURL of ["https://fixture.invalid", "https://fixture.invalid/v1", "https://fixture.invalid/v1/?api-version=preview", "https://fixture.invalid/v1//"]) {
    let requested = "";
    const client = new Client({ apiKey: "fixture", baseURL, maxRetries: 0, fetch: async (input: any) => {
      requested = String(input);
      return new Response(JSON.stringify({ id: "fixture", object: "response", output: [] }), { headers: { "content-type": "application/json" } });
    } });
    await client.responses.create({ model: "fixture", input: "fixture" });
    assert.equal(resolveV1Endpoint(baseURL, "responses"), requested);
  }
});

test("provider rejects full request endpoints rather than validating an unusable SDK base", async () => {
  const provider = isolated("provider-config", deps);
  await assert.rejects(provider.verifyCustom("key", "https://fixture.invalid/v1/responses", "openai-responses", "model"), /Base URL|endpoint/i);
});

function attachmentHandler(fileSystem: unknown, evaluate: (...args: any[]) => unknown) {
  let handler: any;
  const source = fs.readFileSync(path.join(process.cwd(), "src/main.ts"), "utf8");
  const start = source.indexOf('ipcMain.handle("file:read-base64"');
  const end = source.indexOf("// ── Release Notes", start);
  const js = transpileModule(source.slice(start, end), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
  runInNewContext(js, { ipcMain: { handle: (_key: string, fn: unknown) => { handler = fn; } }, assertTrustedIpcSender: () => true,
    fs: fileSystem, evaluateFileReadTarget: evaluate, FILE_READ_MAX_BYTES: 16 * 1024 * 1024,
    mimeTypeForPath: () => "image/png", log: { warn: noop }, Buffer });
  return handler;
}

test("attachment rejects a benign alias that resolves to credentials before opening it", async () => {
  const denied = path.resolve(".cache", "credentials", "secret");
  const alias = path.resolve(".cache", "report.png");
  let opened = false;
  const handler = attachmentHandler({ promises: { stat: async () => ({ isFile: () => true, size: 3 }), realpath: async () => denied,
    readFile: async () => { opened = true; return Buffer.from("key"); }, open: async () => { opened = true; throw Error("must not open"); } } },
    (p: string) => p === denied ? { ok: false, error: "denied" } : { ok: true });
  await assert.rejects(handler({}, alias), /denied/);
  assert.equal(opened, false);
});

test("attachment opens the verified canonical file and preserves the response protocol", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attachment-read-"));
  const target = path.join(dir, "image.png");
  fs.writeFileSync(target, "abc");
  try {
    const handler = attachmentHandler(fs, () => ({ ok: true }));
    const result = await handler({}, target);
    assert.equal(result.base64, "YWJj"); assert.equal(result.size, 3); assert.equal(result.mimeType, "image/png");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("attachment rejects a real directory junction into the credential store", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attachment-junction-"));
  const secrets = path.join(dir, "credentials"), alias = path.join(dir, "alias");
  fs.mkdirSync(secrets); fs.writeFileSync(path.join(secrets, "secret.png"), "private");
  fs.symlinkSync(secrets, alias, process.platform === "win32" ? "junction" : "dir");
  try {
    const policy = isolated("file-read-base64", { "./constants": { resolveUserStateDir: () => dir } });
    const handler = attachmentHandler(fs, policy.evaluateFileReadTarget);
    await assert.rejects(handler({}, path.join(alias, "secret.png")), /denied/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("provider rejects a real HTTP connection interrupted after partial body", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" }); res.write('{"partial":');
    setTimeout(() => res.destroy(), 10);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const provider = isolated("provider-config", deps);
    const port = (server.address() as import("node:net").AddressInfo).port;
    const observed = provider.jsonRequest(`http://127.0.0.1:${port}/`, {}).then(() => "resolved", () => "rejected");
    assert.equal(await Promise.race([observed, new Promise(resolve => setTimeout(() => resolve("pending"), 500))]), "rejected");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
