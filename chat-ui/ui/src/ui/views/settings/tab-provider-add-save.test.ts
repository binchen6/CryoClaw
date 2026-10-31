import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

// Actual production handlers/controller, in-memory only; no browser or real IPC.
let root = dirname(fileURLToPath(import.meta.url));
while (!existsSync(resolve(root, "chat-ui/ui/src/ui/views/settings/tab-provider.ts"))) {
  const parent = dirname(root);
  assert.notEqual(parent, root);
  root = parent;
}
const require = createRequire(resolve(root, "package.json"));
const { transformSync } = require("esbuild");
const uiRoot = resolve(root, "chat-ui/ui/src/ui");
const source = readFileSync(resolve(uiRoot, "views/settings/tab-provider.ts"), "utf8");
function section(text: string, start: string, end: string) {
  const from = text.indexOf(start), to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Production source boundary missing: ${start}`);
  return text.slice(from, to);
}
function evaluate(text: string, globals: Record<string, unknown> = {}): any {
  const module = { exports: {} };
  runInNewContext(transformSync(text, { loader: "ts", format: "cjs", target: "es2023" }).code, {
    module, exports: module.exports, structuredClone, setTimeout,
    require: () => ({ t: (key: string) => key }), ...globals,
  });
  return module.exports;
}
function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
function harness(options: {
  kimi?: boolean; verify?: () => Promise<any>; write?: () => Promise<any>;
  confirm?: () => Promise<boolean>; patch?: () => Promise<any>;
  initialRead?: () => Promise<void>; refresh?: () => Promise<unknown>;
} = {}) {
  const controller = evaluate(readFileSync(resolve(uiRoot, "controllers/config.ts"), "utf8"));
  const providerState = evaluate(`let agentsLoadFailedAt=0;\n${section(source, "function createProviderState()", "/* ── helpers")}\nmodule.exports={s,resetProviderState};`, { emptyModelOrg: () => ({}) });
  const s = providerState.s;
  const key = options.kimi ? "kimi-coding" : "deepseek";
  const config = { models: { providers: { [key]: { apiKey: "__OPENCLAW_REDACTED__", baseUrl: "https://example.test/v1", models: [{ id: "m1" }] } } }, agents: { defaults: { model: { primary: `${key}/m1` } } } };
  const calls = { verify: [] as any[], sidecar: [] as any[], patch: [] as any[], patchOptions: [] as any[], toast: [] as any[], prune: 0, configuredLoads: 0 };
  let reads = 0;
  const state = { requestUpdate() {}, async loadConfiguredModels() { calls.configuredLoads++; }, client: { async request(method: string, params: any) {
    if (method === "config.get") {
      if (++reads === 1) await options.initialRead?.();
      return { hash: "rev-1", config };
    }
    assert.equal(method, "config.patch");
    calls.patch.push(params);
    return options.patch ? options.patch() : { ok: true };
  } } };
  const target = { providerKey: key, baseUrl: "https://example.test/v1", api: "openai-completions", catalogProvider: key };
  const selection = () => ({ provider: s.addProvider, subPlatform: s.addSubPlatform, customPreset: s.addCustomPreset, baseUrl: s.addBaseUrl, apiType: s.addApiType });
  const lib = readFileSync(resolve(uiRoot, "views/settings/tab-provider.lib.ts"), "utf8");
  const linkage = section(lib, "export function applyKimiCodeLinkage(", "// ── T6").replace("export function", "function");
  const code = [section(source, "async function refreshSnapshot(", "/** 清理指向"), section(source, "async function runPatch(", "/* ── 模型操作"), linkage,
    section(source, "async function handleAddSave(", "/* ── Kimi OAuth"),
    section(source, "async function handleAddToGroupSave(", "/* ── 模型能力编辑"),
    "module.exports={handleAddSave,handleAddToGroupSave};"].join("\n");
  const api = evaluate(code, {
    s, t: (key: string) => key, showToast: (...args: any[]) => calls.toast.push(args),
    patchConfig: (...args: any[]) => { calls.patchOptions.push(args[2]); return controller.patchConfig(...args); },
    getConfigSnapshot: () => options.refresh ? options.refresh() : controller.getConfigSnapshot(state.client),
    pruneOrgAgainstConfig: () => { calls.prune++; }, getProviderSnapshot: () => ({ config }),
    currentAddSelection: selection, resolveAddTarget: () => target, getAddModelId: () => s.addModelId,
    isKimiCodeAdd: () => options.kimi === true, isValidHttpBaseUrl: () => true,
    catalogProviderForKey: () => key, catalogModelSupportsImage: () => false,
    buildModelEntry: (_provider: string, id: string, name: string, image: boolean, overrides: unknown) => ({ id, name, input: image ? ["text", "image"] : ["text"], ...(overrides ? { overrides } : {}) }),
    buildOverridesFromCaps: (caps: any) => ({ maxTokens: caps.maxTokens, thinkingLevels: [...caps.thinkingLevels] }),
    reasoningBudgetWarningText: () => "confirm budget", showConfirm: () => options.confirm ? options.confirm() : Promise.resolve(true),
    AUTH_PROXY_API_KEY_SENTINEL: "proxy-managed",
    ipc: {
      async settingsVerifyKey(params: any) { calls.verify.push(params); return options.verify ? options.verify() : { success: true }; },
      async settingsWriteKimiApiKey(params: any) { calls.sidecar.push(params); return options.write ? options.write() : { proxyPort: 12345 }; },
      async kimiOAuthLogout() {},
    },
  });
  function open(group = false) {
    Object.assign(s, { addOpen: true, addProvider: options.kimi ? "moonshot" : "deepseek", addSubPlatform: options.kimi ? "kimi-code" : "", addApiKey: "new-secret", addModelId: "m2", addAlias: "Captured alias", addToProviderKey: group ? key : null });
  }
  open();
  return { s, calls, key, open, reset: () => providerState.resetProviderState(), save: () => api.handleAddSave(state), groupSave: () => api.handleAddToGroupSave(state) };
}

test("add saves captured selection/alias and clears secret state after success", async () => {
  const verify = deferred();
  const h = harness({ verify: () => verify.promise });
  const pending = h.save();
  h.s.addAlias = "Changed while waiting";
  h.s.addProvider = "google";
  verify.resolve({ success: true });
  await pending;
  assert.equal(h.calls.patch.length, 1);
  const patch = JSON.parse(h.calls.patch[0].raw).models.providers.deepseek;
  assert.equal(patch.models.at(-1).name, "Captured alias");
  assert.equal(patch.apiKey, "new-secret");
  assert.equal(h.calls.verify[0].provider, "deepseek");
  assert.equal(h.s.addOpen, false);
  assert.equal(h.s.addApiKey, "");
  assert.equal(h.s.addAlias, "");
  assert.equal(h.s.pendingOAuthToken, null);
  assert.equal(h.s.addSaveToken, null);
  assert.equal(h.s.saving, false);
  assert.equal(h.calls.patchOptions[0], undefined, "View callbacks must not enter the patch protocol");
});

test("current verification failure releases only its save lock and retains retry credentials", async () => {
  const h = harness({ verify: async () => ({ success: false, message: "invalid credential" }) });
  await h.save();
  assert.equal(h.calls.patch.length, 0);
  assert.equal(h.s.error, "invalid credential");
  assert.equal(h.s.saving, false);
  assert.equal(h.s.addSaveToken, null);
  assert.equal(h.s.addOpen, true);
  assert.equal(h.s.addApiKey, "new-secret");
});

test("reset revokes verification and old finally cannot unlock a new add save", async () => {
  const first = deferred(), second = deferred();
  let count = 0;
  const h = harness({ verify: () => (++count === 1 ? first.promise : second.promise) });
  const old = h.save();
  h.reset(); h.open();
  const current = h.save();
  const token = h.s.addSaveToken;
  first.resolve({ success: true });
  await old;
  assert.equal(h.calls.patch.length, 0);
  assert.equal(h.s.addSaveToken, token);
  assert.equal(h.s.saving, true);
  assert.equal(h.s.addOpen, true);
  second.resolve({ success: true });
  await current;
  assert.equal(h.calls.patch.length, 1);
});

test("reset suppresses stale rejected verification and stale failure messages", async () => {
  for (const rejection of [false, true]) {
    const verify = deferred();
    const h = harness({ verify: () => verify.promise });
    const pending = h.save();
    h.reset(); h.open();
    if (rejection) verify.reject(new Error("old IPC"));
    else verify.resolve({ success: false, message: "old failure" });
    await pending;
    assert.equal(h.s.error, null);
    assert.equal(h.calls.patch.length, 0);
    assert.equal(h.s.addApiKey, "new-secret");
  }
});

test("Kimi success keeps the real key out of config and clears pending OAuth", async () => {
  const h = harness({ kimi: true });
  h.s.pendingOAuthToken = "oauth-secret";
  await h.save();
  assert.equal(h.calls.sidecar[0].apiKey, "oauth-secret");
  const raw = h.calls.patch[0].raw;
  assert.ok(!raw.includes("oauth-secret"));
  assert.equal(JSON.parse(raw).models.providers["kimi-coding"].apiKey, "proxy-managed");
  assert.equal(h.s.pendingOAuthToken, null);
});

test("reset during Kimi sidecar write blocks a late config patch", async () => {
  const write = deferred(), entered = deferred();
  const h = harness({ kimi: true, write: () => { entered.resolve(undefined); return write.promise; } });
  const pending = h.save();
  await entered.promise;
  h.reset(); h.open();
  write.resolve({ proxyPort: 12345 });
  await pending;
  assert.equal(h.calls.sidecar.length, 1); // Already-issued sidecar writes cannot be undone.
  assert.equal(h.calls.patch.length, 0);
  assert.equal(h.s.addOpen, true);
});

test("group confirmation is exclusive and reset revokes the pending confirmation", async () => {
  const confirmation = deferred<boolean>();
  const h = harness({ confirm: () => confirmation.promise });
  h.open(true); h.s.addCaps = { maxTokens: "100", thinkingLevels: ["high"] };
  const pending = h.groupSave();
  assert.equal(h.s.saving, true);
  await h.groupSave();
  h.reset(); h.open(true);
  confirmation.resolve(true);
  await pending;
  assert.equal(h.calls.patch.length, 0);
  assert.equal(h.s.addOpen, true);
});

test("group add captures capabilities before confirmation and closes only its own operation", async () => {
  const confirmation = deferred<boolean>();
  const h = harness({ confirm: () => confirmation.promise });
  h.open(true); h.s.addCaps = { maxTokens: "100", thinkingLevels: ["high"] };
  const pending = h.groupSave();
  h.s.addAlias = "Later alias";
  h.s.addCaps.maxTokens = "200";
  h.s.addCaps.thinkingLevels.push("low");
  confirmation.resolve(true);
  await pending;
  const entry = JSON.parse(h.calls.patch[0].raw).models.providers.deepseek.models.at(-1);
  assert.equal(entry.name, "Captured alias");
  assert.equal(entry.overrides.maxTokens, "100");
  assert.deepEqual(entry.overrides.thinkingLevels, ["high"]);
  assert.equal(h.s.addToProviderKey, null);
  assert.equal(h.s.addCaps, null);
  assert.equal(h.s.addOpen, false);
});

test("an already-issued patch completing after reset cannot close a new add panel", async () => {
  const patch = deferred(), entered = deferred();
  const h = harness({ patch: () => { entered.resolve(undefined); return patch.promise; } });
  const pending = h.save();
  await entered.promise;
  h.reset(); h.open();
  patch.resolve({ ok: true });
  await pending;
  assert.equal(h.calls.patch.length, 1);
  assert.equal(h.s.addOpen, true);
  assert.equal(h.s.addApiKey, "new-secret");
});

test("runPatch late success/failure cannot mutate a new view or release its busy lock", async () => {
  for (const failure of [false, true]) {
    const patch = deferred(), entered = deferred();
    const h = harness({ patch: () => { entered.resolve(undefined); return patch.promise; } });
    const pending = h.save();
    await entered.promise;
    h.reset(); h.open();
    Object.assign(h.s, { busy: true, saving: true, error: "new error", successMsg: "new success" });
    if (failure) patch.reject(new Error("old write failed"));
    else patch.resolve({ ok: true });
    await pending;
    assert.equal(h.s.busy, true);
    assert.equal(h.s.saving, true);
    assert.equal(h.s.error, "new error");
    assert.equal(h.s.successMsg, "new success");
    assert.equal(h.calls.toast.length, 0);
    assert.equal(h.calls.prune, 0);
  }
});

test("snapshot completion after reset cannot prune new organization or emit late UI success", async () => {
  const refresh = deferred(), entered = deferred();
  const h = harness({ refresh: () => { entered.resolve(undefined); return refresh.promise; } });
  const pending = h.save();
  await entered.promise;
  h.reset(); h.open();
  h.s.busy = true;
  const org = h.s.org;
  refresh.resolve(null);
  await pending;
  assert.equal(h.calls.prune, 0);
  assert.equal(h.s.org, org);
  assert.equal(h.s.busy, true);
  assert.equal(h.s.successMsg, null);
  assert.equal(h.s.addOpen, true);
  assert.equal(h.calls.configuredLoads, 1, "Actual configured-model refresh is independent of the retired view");
});

test("reset while awaiting the initial snapshot prevents an unsent patch", async () => {
  const read = deferred<void>(), entered = deferred();
  const h = harness({ initialRead: () => { entered.resolve(undefined); return read.promise; } });
  const pending = h.save();
  await entered.promise;
  h.reset(); h.open();
  read.resolve();
  await pending;
  assert.equal(h.calls.patch.length, 0);
  assert.equal(h.s.addOpen, true);
});

// 按钮调用点必须接住 handler 的 rethrow：当前 token 的 verify/写盘失败会被 handler 重新抛出
// （旧 token 的错误才该被吞掉），没有 .catch 就变成 unhandled rejection——按钮弹回、零提示。
test("add save buttons surface a current failure instead of rejecting unhandled", async () => {
  const h = harness();
  h.s.addSaveToken = {};
  h.s.saving = false;
  const token = {};

  const submitSection = section(source, "function submitAddSave(", "async function handleAddToGroupSave(");
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const submit = evaluate(`${submitSection}\nmodule.exports={submitAddSave};`, {
      s: h.s, tWithDetail: (key: string, detail: string) => `${key}: ${detail}`,
    }).submitAddSave as (handler: () => Promise<void>, state: unknown) => void;
    const state = { requestUpdate() {} };
    // 当前 token 失败 → handler 重新抛出；入口必须把它变成可见错误。
    h.open();
    h.s.addSaveToken = token;
    submit(async () => { throw new Error("ipc rejected"); }, state);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(unhandled, []);
    assert.match(String(h.s.error), /ipc rejected/);

    // 成功路径不写错误。
    h.s.error = null;
    submit(async () => {}, state);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(h.s.error, null);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
