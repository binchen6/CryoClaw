import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

// Exercise the production handlers + config controller without importing the app's
// DOM graph. Transform only in memory: no shared test/build output or real IPC.
// Locate source from this module, including when it runs from an emitted test dir.
function repositoryRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(resolve(dir, "chat-ui/ui/src/ui/views/settings/tab-provider.ts"))) {
    const parent = dirname(dir);
    assert.notEqual(parent, dir, "Cannot locate provider production source");
    dir = parent;
  }
  return dir;
}
const root = repositoryRoot();
const require = createRequire(resolve(root, "package.json"));
const { transformSync } = require("esbuild");
const uiRoot = resolve(root, "chat-ui/ui/src/ui");
const providerSource = readFileSync(resolve(uiRoot, "views/settings/tab-provider.ts"), "utf8");
function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Production source boundary missing: ${start}`);
  return source.slice(from, to);
}
function evaluate(source: string, globals: Record<string, unknown> = {}) {
  const module = { exports: {} as any };
  const code = transformSync(source, { loader: "ts", format: "cjs", target: "es2023" }).code;
  runInNewContext(code, {
    module, exports: module.exports, structuredClone, setTimeout,
    require: (id: string) => {
      assert.equal(id, "../i18n.ts");
      return { t: (key: string) => key };
    },
    ...globals,
  });
  return module.exports;
}
function harness(providerKey = "deepseek", options: {
  verify?: () => Promise<any>;
  proxyPort?: number;
  write?: () => Promise<any>;
  patchError?: string;
} = {}) {
  const controller = evaluate(readFileSync(resolve(uiRoot, "controllers/config.ts"), "utf8"));
  const stateModule = section(providerSource, "function createProviderState()", "/* ── helpers");
  const providerState = evaluate(`let agentsLoadFailedAt=0;\n${stateModule}\nmodule.exports={s,resetProviderState};`, {
    emptyModelOrg: () => ({}),
  });
  const s = providerState.s;
  s.keyEditing = providerKey;
  s.keyDraft = "new-secret";
  const calls = { verify: [] as any[], sidecar: [] as any[], patches: [] as any[] };
  const config = { models: { providers: { [providerKey]: {
    apiKey: "__OPENCLAW_REDACTED__", baseUrl: "https://example.test/v1", models: [{ id: "m1", name: "M1" }],
  } } } };
  const state = { requestUpdate() {}, client: { async request(method: string, params: any) {
    if (method === "config.get") return { hash: "revision-1", config };
    assert.equal(method, "config.patch");
    calls.patches.push(params);
    if (options.patchError) throw new Error(options.patchError);
    return { ok: true };
  } } };
  const handlers = section(providerSource, "function startKeyEdit(", "/* ── 拖拽排序");
  const patch = section(providerSource, "async function runPatch(", "/* ── 模型操作");
  const lib = readFileSync(resolve(uiRoot, "views/settings/tab-provider.lib.ts"), "utf8");
  const linkage = section(lib, "export function applyKimiCodeLinkage(", "// ── T6").replace("export function", "function");
  const sentinel = "proxy-managed";
  const api = evaluate(`${patch}\n${linkage}\n${handlers}\nmodule.exports={handleKeySave,startKeyEdit};`, {
    s, t: (key: string) => key, showToast() {},
    patchConfig: controller.patchConfig,
    refreshSnapshot: () => controller.getConfigSnapshot(state.client),
    AUTH_PROXY_API_KEY_SENTINEL: sentinel,
    CUSTOM_PRESETS: {}, PROVIDERS: { deepseek: {} },
    ipc: {
      async settingsVerifyKey(params: any) { calls.verify.push(params); return options.verify ? options.verify() : { success: true }; },
      async settingsWriteKimiApiKey(params: any) { calls.sidecar.push(params); return options.write ? options.write() : { proxyPort: options.proxyPort ?? 12345 }; },
    },
  });
  const provider = { providerKey, models: [{ id: "m1" }], baseUrl: "https://example.test/v1", api: "openai-completions" };
  const detail = section(providerSource, "function renderProviderDetail(", "/* ── 自定义分组");
  const input = detail.match(/@input=\$\{(\(event: CustomEvent\) => \{\s*if \(!providerBusy\(\)\) \{[\s\S]*?\}\s*\})\}/);
  assert.ok(input, "Detail password input handler missing");
  const inputApi = evaluate(`module.exports={input:${input[1]}}`, {
    s, state, provider, providerBusy: () => s.busy || s.saving || s.keySaving || s.oauthLoading,
  });
  return { s, calls, sentinel, save: () => api.handleKeySave(provider, state),
    input: (value: string) => inputApi.input({ detail: { value } }),
    reset: () => providerState.resetProviderState(),
    reopen: () => { api.startKeyEdit(provider, state); s.keyDraft = "next-secret"; },
  };
}

test("verified key reaches config.patch exactly once and clears successful secret draft", async () => {
  const h = harness();
  await h.save();
  assert.equal(h.calls.verify.length, 1);
  assert.equal(h.calls.patches.length, 1);
  assert.equal(JSON.parse(h.calls.patches[0].raw).models.providers.deepseek.apiKey, "new-secret");
  assert.equal(h.calls.patches[0].baseHash, "revision-1");
  assert.equal(h.s.keyEditing, null);
  assert.equal(h.s.keyDraft, "");
  assert.equal(h.s.keySaving, false);
  assert.equal(h.s.busy, false);
});

test("detail can save a second independently edited key without reopening the page", async () => {
  const h = harness();
  await h.save();
  assert.equal(h.s.keyEditing, null);
  h.input("second-secret");
  assert.equal(h.s.keyEditing, "deepseek");
  await h.save();
  assert.equal(h.calls.patches.length, 2);
  assert.equal(JSON.parse(h.calls.patches[1].raw).models.providers.deepseek.apiKey, "second-secret");
  assert.equal(h.s.keyDraft, "");
});

test("verification failure never patches and retains an open draft for retry", async () => {
  const h = harness("deepseek", { verify: async () => ({ success: false, message: "invalid key" }) });
  await h.save();
  assert.equal(h.calls.patches.length, 0);
  assert.equal(h.s.error, "invalid key");
  assert.equal(h.s.keyDraft, "new-secret");
  assert.equal(h.s.keyEditing, "deepseek");
  assert.equal(h.s.keySaving, false);
});

test("overlapping saves verify once without taking the patch busy lock", async () => {
  let finish!: (result: any) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const h = harness("deepseek", { verify: () => pending });
  const first = h.save();
  assert.equal(h.s.keySaving, true);
  assert.equal(h.s.busy, false);
  await h.save();
  assert.equal(h.calls.verify.length, 1);
  finish({ success: true });
  await first;
  assert.equal(h.calls.patches.length, 1);
  assert.equal(h.s.keySaving, false);
});

test("verification rejection releases the key lock and never patches", async () => {
  const h = harness("deepseek", { verify: async () => { throw new Error("IPC unavailable"); } });
  await assert.rejects(h.save(), /IPC unavailable/);
  assert.equal(h.calls.patches.length, 0);
  assert.equal(h.s.keySaving, false);
  assert.equal(h.s.busy, false);
});

test("Kimi key only goes to sidecar while config.patch uses the proxy sentinel", async () => {
  const h = harness("kimi-coding");
  await h.save();
  assert.equal(h.calls.sidecar.length, 1);
  assert.equal(h.calls.sidecar[0].apiKey, "new-secret");
  assert.equal(h.calls.patches.length, 1);
  const raw = h.calls.patches[0].raw;
  assert.equal(raw.includes("new-secret"), false);
  const patched = JSON.parse(raw);
  assert.equal(patched.models.providers["kimi-coding"].apiKey, h.sentinel);
  assert.equal(patched.models.providers["kimi-coding"].baseUrl, "http://127.0.0.1:12345/coding");
  assert.equal(h.s.keyDraft, "");
});

test("Kimi sidecar failure does not patch or clear a retryable draft", async () => {
  const h = harness("kimi-coding", { proxyPort: 0 });
  await h.save();
  assert.equal(h.calls.patches.length, 0);
  assert.equal(h.s.keyDraft, "new-secret");
  assert.equal(h.s.keySaving, false);
});

test("reset and reopening the same provider revoke late verify and its finally", async () => {
  const finish: Array<(result: any) => void> = [];
  const h = harness("deepseek", { verify: () => new Promise(resolve => { finish.push(resolve); }) });
  const oldSave = h.save();
  h.reset();
  h.reopen();
  const currentSave = h.save();
  const currentToken = h.s.keySaveToken;
  finish[0]({ success: true });
  await oldSave;
  assert.equal(h.calls.patches.length, 0);
  assert.equal(h.s.keySaving, true);
  assert.equal(h.s.keySaveToken, currentToken);
  assert.equal(h.s.keyDraft, "next-secret");
  finish[1]({ success: true });
  await currentSave;
  assert.equal(h.calls.patches.length, 1);
  assert.equal(JSON.parse(h.calls.patches[0].raw).models.providers.deepseek.apiKey, "next-secret");
  assert.equal(h.s.keySaving, false);
  assert.equal(h.s.keySaveToken, null);
  assert.equal(h.s.keyDraft, "");
});

test("a rejected verification from a reset editor cannot surface in a new editor", async () => {
  let reject!: (reason: Error) => void;
  const h = harness("deepseek", { verify: () => new Promise((_resolve, fail) => { reject = fail; }) });
  const oldSave = h.save();
  h.reset();
  h.reopen();
  reject(new Error("old verification failed"));
  await oldSave;
  assert.equal(h.calls.patches.length, 0);
  assert.equal(h.s.error, null);
  assert.equal(h.s.keyDraft, "next-secret");
});

test("reset during Kimi sidecar write cannot publish a late config patch", async () => {
  let finish!: (result: any) => void;
  let started!: () => void;
  const sidecarStarted = new Promise<void>(resolve => { started = resolve; });
  const h = harness("kimi-coding", { write: () => {
    started();
    return new Promise(resolve => { finish = resolve; });
  } });
  const save = h.save();
  await sidecarStarted;
  h.reset();
  h.reopen();
  finish({ proxyPort: 12345 });
  await save;
  assert.equal(h.calls.sidecar.length, 1);
  assert.equal(h.calls.patches.length, 0);
  assert.equal(h.s.keyEditing, "kimi-coding");
  assert.equal(h.s.keyDraft, "next-secret");
  assert.equal(h.s.keySaving, false);
});

test("patch failure releases both locks and preserves the open retry draft", async () => {
  const h = harness("deepseek", { patchError: "write denied" });
  await h.save();
  assert.equal(h.calls.patches.length, 1);
  assert.equal(h.s.keyDraft, "new-secret");
  assert.equal(h.s.keyEditing, "deepseek");
  assert.equal(h.s.keySaving, false);
  assert.equal(h.s.busy, false);
});
