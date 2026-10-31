import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

let root = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(root, "chat-ui/ui/src/ui/views/settings/tab-provider.ts"))) {
  const parent = dirname(root);
  if (parent === root) throw new Error("Repository root not found");
  root = parent;
}
const { transformSync } = createRequire(join(root, "package.json"))("esbuild");
const source = readFileSync(join(root, "chat-ui/ui/src/ui/views/settings/tab-provider.ts"), "utf8");
const from = source.indexOf("async function handleAddFetchModels(");
const to = source.indexOf("/** 目录 + 在线拉取", from);
assert.ok(from >= 0 && to > from);
function harness() {
  let finish!: (reply: unknown) => void;
  const s: any = { addOpen: true, addFetchBusy: false, addFetchToken: null, addFetchError: null,
    addProvider: "custom", addCustomPreset: "deepseek", addApiKey: "", addModelId: "",
    liveModels: {}, addShowCustomModelInput: true };
  const module = { exports: {} as any };
  const code = transformSync(`${source.slice(from, to)}\nmodule.exports={handleAddFetchModels};`, {loader:"ts",format:"cjs"}).code;
  runInNewContext(code, { module, exports: module.exports, s,
    isKimiCodeAdd: () => false,
    resolveAddTarget: () => ({providerKey:s.addCustomPreset}),
    currentAddSelection: () => ({provider:s.addProvider,customPreset:s.addCustomPreset,baseUrl:s.addBaseUrl}),
    getAddModelOptions: () => (s.liveModels[s.addCustomPreset]?.models ?? []).map((model: any) => model.id),
    t: (key: string) => key,
    ipc: { settingsFetchProviderModels: () => new Promise(resolve => { finish=resolve; }) },
  });
  return {s, run: () => module.exports.handleAddFetchModels({requestUpdate(){}}),
    finish: () => finish({success:true,data:{models:[{id:"old-provider-model"}]}}) };
}

test("late model fetch cannot populate the next provider preset", async () => {
  const h=harness(); const pending=h.run();
  h.s.addCustomPreset="other";
  h.finish(); await pending;
  assert.equal(h.s.liveModels.other, undefined);
  assert.equal(h.s.addModelId, "");
});

test("closed add flow rejects its late model list", async () => {
  const h=harness(); const pending=h.run();
  h.s.addOpen=false; h.s.addFetchToken=null; h.s.addFetchBusy=false;
  h.finish(); await pending;
  assert.equal(Object.keys(h.s.liveModels).length, 0);
});

test("old request finally must not release a newer request's lock", async () => {
  const h=harness(); const pending=h.run(); const nextToken={};
  h.s.addFetchToken=nextToken; h.s.addFetchBusy=true;
  h.finish(); await pending;
  assert.equal(h.s.addFetchBusy,true);
  assert.equal(h.s.addFetchToken,nextToken);
});

test("current model fetch updates only its captured provider and releases its lock", async () => {
  const h=harness(); const pending=h.run();
  h.finish(); await pending;
  assert.equal(h.s.liveModels.deepseek.models[0].id,"old-provider-model");
  assert.equal(h.s.addModelId,"old-provider-model");
  assert.equal(h.s.addFetchBusy,false);
});
