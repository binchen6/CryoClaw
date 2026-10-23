import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeGatewayNode } from "./gateway-runtime";

test("explicit native runtime resolves bundled Node and refuses missing or inconsistent artifacts", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(nativeGatewayNode(root), null);
  const runtime = path.join(root, "runtime"); fs.mkdirSync(runtime);
  const marker = path.join(runtime, "cryoclaw-runtime.json");
  fs.writeFileSync(marker, JSON.stringify({ kind: "node", gatewayMode: "loose" }));
  assert.throws(() => nativeGatewayNode(root, "win32"));
  fs.writeFileSync(path.join(runtime, "node.exe"), "node");
  assert.equal(nativeGatewayNode(root, "win32"), path.join(runtime, "node.exe"));
  fs.writeFileSync(marker, JSON.stringify({ kind: "node", gatewayMode: "asar" }));
  assert.throws(() => nativeGatewayNode(root, "win32"), /policy/);
});
