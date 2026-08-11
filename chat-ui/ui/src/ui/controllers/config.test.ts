import assert from "node:assert/strict";
import {
  buildMergePatch,
  deriveConfiguredModels,
  getConfigSnapshot,
  invalidateConfigSnapshotCache,
  isRedactedValue,
  mapConfigPatchError,
  patchConfig,
  setPath,
  getPath,
  REDACTED_SENTINEL,
} from "./config.ts";

function makeClient(handler: (method: string, params: any) => unknown) {
  const calls: Array<{ method: string; params: any }> = [];
  const client = {
    request(method: string, params: any) {
      calls.push({ method, params });
      return Promise.resolve(handler(method, params));
    },
  };
  return { client: client as any, calls };
}

function makeClientWithErrors(
  handler: (method: string, params: any) => { ok: true; value: unknown } | { ok: false; message: string },
) {
  const calls: Array<{ method: string; params: any }> = [];
  const client = {
    request(method: string, params: any) {
      calls.push({ method, params });
      const result = handler(method, params);
      if (!result.ok) return Promise.reject(new Error(result.message));
      return Promise.resolve(result.value);
    },
  };
  return { client: client as any, calls };
}

const SNAPSHOT = {
  hash: "hash-1",
  config: {
    agents: { defaults: { model: { primary: "moonshot/kimi-k2.6" } } },
    models: {
      providers: {
        moonshot: {
          apiKey: REDACTED_SENTINEL,
          models: [
            { id: "kimi-k2.6", name: "K2.6" },
            { id: "kimi-k2.5", name: "kimi-k2.5" },
          ],
        },
      },
    },
  },
  raw: "{}",
};

/* ── setPath / getPath ── */

function testSetPathImmutable() {
  const base = { a: { b: 1 }, list: [1, 2] };
  const next = setPath(base, "a.c.d", 5);
  assert.deepEqual(next, { a: { b: 1, c: { d: 5 } }, list: [1, 2] });
  assert.deepEqual(base, { a: { b: 1 }, list: [1, 2] }, "入参不应被修改");
  assert.equal(base.list, (next as any).list, "未触及的分支应复用引用");
  const replaced = setPath(base, "a.b", 9);
  assert.deepEqual(replaced, { a: { b: 9 }, list: [1, 2] });
}

function testGetPath() {
  const obj = { a: { b: [{ c: 1 }] } };
  assert.equal(getPath(obj, "a.b"), obj.a.b);
  assert.equal(getPath(obj, "a.x.y"), undefined);
  assert.equal(getPath(null, "a"), undefined);
}

/* ── buildMergePatch ── */

function testBuildMergePatchBasic() {
  const base = { a: 1, b: { c: 2, d: 3 }, gone: "x" };
  const next = { a: 1, b: { c: 9, d: 3 } };
  const { patch, replacePaths } = buildMergePatch(base as any, next as any);
  assert.deepEqual(patch, { b: { c: 9 }, gone: null }, "未变字段不进 patch，删除键发 null");
  assert.deepEqual(replacePaths, []);
}

function testBuildMergePatchArrayAppendNoReplace() {
  const base = { models: [{ id: "a" }, { id: "b" }] };
  const next = { models: [{ id: "a" }, { id: "b" }, { id: "c" }] };
  const { patch, replacePaths } = buildMergePatch(base as any, next as any);
  assert.deepEqual(patch.models, next.models);
  assert.deepEqual(replacePaths, [], "纯追加可由内核按 id 合并，无需 replacePaths");
}

function testBuildMergePatchArrayRemoveAutoReplace() {
  const base = { models: { providers: { p: { models: [{ id: "a" }, { id: "b" }] } } } };
  const next = { models: { providers: { p: { models: [{ id: "a" }] } } } };
  const { replacePaths } = buildMergePatch(base as any, next as any);
  assert.deepEqual(replacePaths, ["models.providers.p.models"], "删条目必须自动标记 replacePaths");
}

function testBuildMergePatchArrayReorderAutoReplace() {
  const base = { models: [{ id: "a" }, { id: "b" }, { id: "c" }] };
  const next = { models: [{ id: "c" }, { id: "a" }, { id: "b" }] };
  const { replacePaths } = buildMergePatch(base as any, next as any);
  assert.deepEqual(replacePaths, ["models"], "重排必须自动标记 replacePaths（内核 merge 保留 base 顺序）");
}

function testBuildMergePatchExplicitReplacePathsUnion() {
  const base = { models: [{ id: "a" }] };
  const next = { models: [{ id: "a", name: "x" }] };
  const { replacePaths } = buildMergePatch(base as any, next as any, { replacePaths: ["custom.path"] });
  assert.deepEqual(replacePaths.sort(), ["custom.path"]);
}

function testBuildMergePatchNoop() {
  const base = { a: { b: 1 } };
  const { patch } = buildMergePatch(base as any, structuredClone(base) as any);
  assert.deepEqual(patch, {});
}

/* ── getConfigSnapshot 缓存与并发去重 ── */

async function testGetConfigSnapshotCachesAndDedups() {
  invalidateConfigSnapshotCache();
  let gets = 0;
  const { client } = makeClient(() => {
    gets++;
    return SNAPSHOT;
  });
  const [a, b] = await Promise.all([getConfigSnapshot(client), getConfigSnapshot(client)]);
  assert.equal(a?.hash, "hash-1");
  assert.equal(b?.hash, "hash-1");
  const c = await getConfigSnapshot(client);
  assert.equal(c?.hash, "hash-1");
  assert.equal(gets, 1, "并发与缓存命中都应去重为一次 RPC");
  invalidateConfigSnapshotCache();
}

async function testGetConfigSnapshotFailureReturnsNull() {
  invalidateConfigSnapshotCache();
  const { client } = makeClientWithErrors(() => ({ ok: false, message: "gateway not connected" }));
  const snap = await getConfigSnapshot(client);
  assert.equal(snap, null);
  invalidateConfigSnapshotCache();
}

/* ── patchConfig ── */

async function testPatchConfigWritesMinimalPatch() {
  invalidateConfigSnapshotCache();
  const { client, calls } = makeClient((method) => {
    if (method === "config.get") return SNAPSHOT;
    return { ok: true, sentinel: { payload: { stats: { requiresRestart: false } } } };
  });
  const result = await patchConfig(client, (draft) => {
    (draft.agents as any).defaults.model.primary = "moonshot/kimi-k2.5";
  });
  assert.equal(result.ok, true);
  assert.equal(result.requiresRestart, false);
  const patchCall = calls.find((c) => c.method === "config.patch");
  assert.ok(patchCall, "应发出 config.patch");
  assert.equal(patchCall.params.baseHash, "hash-1");
  assert.deepEqual(JSON.parse(patchCall.params.raw), {
    agents: { defaults: { model: { primary: "moonshot/kimi-k2.5" } } },
  });
  invalidateConfigSnapshotCache();
}

async function testPatchConfigNoopSkipsRpc() {
  invalidateConfigSnapshotCache();
  const { client, calls } = makeClient((method) => (method === "config.get" ? SNAPSHOT : {}));
  const result = await patchConfig(client, () => {});
  assert.equal(result.ok, true);
  assert.equal(result.noop, true);
  assert.equal(calls.filter((c) => c.method === "config.patch").length, 0, "无变更不应发 config.patch");
  invalidateConfigSnapshotCache();
}

async function testPatchConfigParsesRestartRequirement() {
  invalidateConfigSnapshotCache();
  const { client } = makeClient((method) =>
    method === "config.get"
      ? SNAPSHOT
      : { ok: true, sentinel: { payload: { stats: { requiresRestart: true } } } },
  );
  const result = await patchConfig(client, (draft) => {
    (draft.agents as any).defaults.model.primary = "moonshot/kimi-k2.5";
  });
  assert.equal(result.requiresRestart, true);
  assert.equal(result.restartScheduled, false);
  invalidateConfigSnapshotCache();
}

async function testPatchConfigParsesScheduledRestart() {
  invalidateConfigSnapshotCache();
  const { client } = makeClient((method) =>
    method === "config.get" ? SNAPSHOT : { ok: true, restart: { ok: true, signal: "SIGUSR1" } },
  );
  const result = await patchConfig(client, (draft) => {
    (draft.agents as any).defaults.model.primary = "moonshot/kimi-k2.5";
  });
  assert.equal(result.restartScheduled, true);
  invalidateConfigSnapshotCache();
}

async function testPatchConfigRetriesOnceOnHashConflict() {
  invalidateConfigSnapshotCache();
  let patchAttempts = 0;
  const { client, calls } = makeClientWithErrors((method, params) => {
    if (method === "config.get") {
      return { ok: true, value: { ...SNAPSHOT, hash: patchAttempts === 0 ? "hash-1" : "hash-2" } };
    }
    patchAttempts++;
    if (patchAttempts === 1) {
      return { ok: false, message: "config changed since last load; re-run config.get and retry" };
    }
    assert.equal(params.baseHash, "hash-2", "重放应使用重新拉取的 hash");
    return { ok: true, value: { ok: true } };
  });
  const result = await patchConfig(client, (draft) => {
    (draft.agents as any).defaults.model.primary = "moonshot/kimi-k2.5";
  });
  assert.equal(result.ok, true);
  assert.equal(patchAttempts, 2, "冲突后应重取重放一次");
  assert.equal(calls.filter((c) => c.method === "config.get").length, 2);
  invalidateConfigSnapshotCache();
}

async function testPatchConfigDoubleConflictFails() {
  invalidateConfigSnapshotCache();
  const { client } = makeClientWithErrors((method) => {
    if (method === "config.get") return { ok: true, value: SNAPSHOT };
    return { ok: false, message: "config changed since last load; re-run config.get and retry" };
  });
  const result = await patchConfig(client, (draft) => {
    (draft.agents as any).defaults.model.primary = "moonshot/kimi-k2.5";
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "配置已被其他进程修改，请重试");
  invalidateConfigSnapshotCache();
}

async function testPatchConfigArrayRemovalSendsReplacePaths() {
  invalidateConfigSnapshotCache();
  const { client, calls } = makeClient((method) => (method === "config.get" ? SNAPSHOT : { ok: true }));
  const result = await patchConfig(client, (draft) => {
    const prov = (draft.models as any).providers.moonshot;
    prov.models = prov.models.filter((m: any) => m.id !== "kimi-k2.5");
  });
  assert.equal(result.ok, true);
  const patchCall = calls.find((c) => c.method === "config.patch");
  assert.ok(patchCall, "应发出 config.patch");
  assert.deepEqual(patchCall.params.replacePaths, ["models.providers.moonshot.models"]);
  invalidateConfigSnapshotCache();
}

/* ── 错误映射 ── */

function testMapConfigPatchError() {
  assert.equal(
    mapConfigPatchError(new Error("config changed since last load; re-run config.get and retry")),
    "配置已被其他进程修改，请重试",
  );
  assert.equal(
    mapConfigPatchError(new Error("config.patch would remove entries from array path(s): x")),
    "内核拒绝了数组删减操作（缺少 replacePaths 声明）",
  );
  assert.equal(mapConfigPatchError(new Error("gateway not connected")), "gateway 连接已断开，请稍后重试");
  assert.equal(mapConfigPatchError(new Error("some other failure")), "some other failure");
}

/* ── deriveConfiguredModels ── */

function testDeriveConfiguredModels() {
  const models = deriveConfiguredModels(SNAPSHOT.config as any);
  assert.deepEqual(
    models.map((m) => [m.key, m.name, m.provider, m.isDefault]),
    [
      ["moonshot/kimi-k2.6", "K2.6", "moonshot", true],
      ["moonshot/kimi-k2.5", "kimi-k2.5", "moonshot", false],
    ],
  );
  const custom = deriveConfiguredModels({
    models: { providers: { "custom-api-example-com": { baseUrl: "https://api.example.com/v1", models: [{ id: "m1" }] } } },
  } as any);
  assert.equal(custom[0].provider, "api.example.com", "custom provider 应用 hostname 显示");
  assert.deepEqual(deriveConfiguredModels(null), []);
}

function testIsRedactedValue() {
  assert.equal(isRedactedValue(REDACTED_SENTINEL), true);
  assert.equal(isRedactedValue("sk-real"), false);
  assert.equal(isRedactedValue(undefined), false);
}

async function main() {
  testSetPathImmutable();
  testGetPath();
  testBuildMergePatchBasic();
  testBuildMergePatchArrayAppendNoReplace();
  testBuildMergePatchArrayRemoveAutoReplace();
  testBuildMergePatchArrayReorderAutoReplace();
  testBuildMergePatchExplicitReplacePathsUnion();
  testBuildMergePatchNoop();
  await testGetConfigSnapshotCachesAndDedups();
  await testGetConfigSnapshotFailureReturnsNull();
  await testPatchConfigWritesMinimalPatch();
  await testPatchConfigNoopSkipsRpc();
  await testPatchConfigParsesRestartRequirement();
  await testPatchConfigParsesScheduledRestart();
  await testPatchConfigRetriesOnceOnHashConflict();
  await testPatchConfigDoubleConflictFails();
  await testPatchConfigArrayRemovalSendsReplacePaths();
  testMapConfigPatchError();
  testDeriveConfiguredModels();
  testIsRedactedValue();
  console.log("config controller tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
