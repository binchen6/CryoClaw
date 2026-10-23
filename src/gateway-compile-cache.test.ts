import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { gatewayCompileCacheDirectory } from "./gateway-compile-cache";

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
