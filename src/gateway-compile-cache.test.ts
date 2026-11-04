import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { gatewayCompileCacheDirectory, gatewayCompileCacheEnvironment } from "./gateway-compile-cache";

test("launcher cache uses the native version and build identity; incomplete packages fall back", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, "cache");
  assert.equal(gatewayCompileCacheDirectory(root, base), base);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.10.5" }));
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "dist", "build-info.json"), JSON.stringify({ buildId: "native-build" }));
  const marker = createHash("sha256").update("native-build").digest("hex").slice(0, 16);
  assert.equal(gatewayCompileCacheDirectory(root, base), path.join(base, "openclaw", "2026.10.5", marker));
  fs.writeFileSync(path.join(root, "dist", "build-info.json"), "broken");
  const stat = fs.statSync(path.join(root, "package.json"));
  assert.equal(gatewayCompileCacheDirectory(root, base), path.join(base, "openclaw", "2026.10.5", `${Math.trunc(stat.mtimeMs)}-${stat.size}`));
});

test("worker cache handoff is version-bound and preserves an explicit cache disable",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-cache-handoff-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const base=path.join(root,'cache'),manifest=path.join(root,'package.json'),metadata=path.join(root,'cryoclaw-kernel-compat.json');
  fs.writeFileSync(manifest,JSON.stringify({version:'2026.10.10'}));
  fs.writeFileSync(metadata,JSON.stringify({version:'2026.10.10',foregroundCompileCache:'workers'}));
  const handoff=gatewayCompileCacheEnvironment(root,base,{});
  assert.equal(handoff.NODE_DISABLE_COMPILE_CACHE,'1');assert.equal(handoff.OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED,'gateway');
  assert.equal(gatewayCompileCacheEnvironment(root,base,{NODE_DISABLE_COMPILE_CACHE:'0'}).OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED,undefined);
  fs.writeFileSync(manifest,JSON.stringify({version:'2026.10.9'}));
  assert.equal(gatewayCompileCacheEnvironment(root,base,{}).NODE_DISABLE_COMPILE_CACHE,undefined);
  fs.unlinkSync(metadata);assert.equal(gatewayCompileCacheEnvironment(root,base,{}).NODE_DISABLE_COMPILE_CACHE,undefined);
});
