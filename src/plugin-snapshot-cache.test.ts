import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PLUGIN_SNAPSHOT_CACHE_TTL_MS,
  invalidatePluginSnapshotCaches,
  pluginSnapshotCachePath,
  pluginSnapshotFingerprint,
  readPluginSnapshotCache,
  writePluginSnapshotCache,
} from "./plugin-snapshot-cache.ts";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-plugin-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageDir = path.join(root, "gateway");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ version: "2026.10.9" }));
  const options = { packageDir, stateDir, config: { plugins: { installs: { sample: { version: "1.0.0" } } } }, extraEnv: { Z: "last", A: "first" }, allowErrors: false };
  const fingerprint = pluginSnapshotFingerprint(options);
  return { root, stateDir, fingerprint, options };
}

test("snapshot cache returns identical metadata and expires at the TTL boundary", t => {
  const f = fixture(t);
  const value = [{ id: "sample", channels: ["one"], enabled: true }];
  writePluginSnapshotCache({ stateDir: f.stateDir, kind: "channel-inventory", fingerprint: f.fingerprint, value });
  const read = () => readPluginSnapshotCache({ stateDir: f.stateDir, kind: "channel-inventory", fingerprint: f.fingerprint });
  assert.deepEqual(read(), value);
  assert.equal(fs.existsSync(`${pluginSnapshotCachePath(f.stateDir, "channel-inventory")}.tmp`), false);
  const envelope = JSON.parse(fs.readFileSync(pluginSnapshotCachePath(f.stateDir, "channel-inventory"), "utf8"));
  assert.equal(readPluginSnapshotCache({ stateDir: f.stateDir, kind: "channel-inventory", fingerprint: f.fingerprint, now: envelope.at + PLUGIN_SNAPSHOT_CACHE_TTL_MS - 1 }) !== null, true);
  assert.equal(readPluginSnapshotCache({ stateDir: f.stateDir, kind: "channel-inventory", fingerprint: f.fingerprint, now: envelope.at + PLUGIN_SNAPSHOT_CACHE_TTL_MS }), null);
  assert.equal(readPluginSnapshotCache({ stateDir: f.stateDir, kind: "channel-inventory", fingerprint: f.fingerprint, now: envelope.at - 1 }), null);
});

test("config, kernel, state and inventory policy changes invalidate snapshots", t => {
  const f = fixture(t);
  for (const changed of [
    { ...f.options, config: { plugins: { installs: {} } } },
    { ...f.options, stateDir: path.join(f.root, "other-state") },
    { ...f.options, allowErrors: true },
    { ...f.options, extraEnv: { A: "different" } },
  ]) {
    writePluginSnapshotCache({ stateDir: f.stateDir, kind: "plugin-list", fingerprint: f.fingerprint, value: [{ id: "sample" }] });
    const changedFingerprint = pluginSnapshotFingerprint(changed);
    assert.notEqual(changedFingerprint, f.fingerprint);
    assert.equal(readPluginSnapshotCache({ stateDir: f.stateDir, kind: "plugin-list", fingerprint: changedFingerprint }), null);
  }
  const otherPackage = path.join(f.root, "other-gateway");
  fs.mkdirSync(otherPackage);
  fs.writeFileSync(path.join(otherPackage, "package.json"), JSON.stringify({ version: "2026.10.8" }));
  assert.notEqual(pluginSnapshotFingerprint({ ...f.options, packageDir: otherPackage }), f.fingerprint);
});

test("corrupt files fall back and explicit invalidation clears both cache families", t => {
  const f = fixture(t);
  for (const kind of ["channel-inventory", "plugin-list"] as const) {
    const file = pluginSnapshotCachePath(f.stateDir, kind);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{broken");
    assert.equal(readPluginSnapshotCache({ stateDir: f.stateDir, kind, fingerprint: f.fingerprint }), null);
    writePluginSnapshotCache({ stateDir: f.stateDir, kind, fingerprint: f.fingerprint, value: [{ id: kind }] });
    assert.ok(readPluginSnapshotCache({ stateDir: f.stateDir, kind, fingerprint: f.fingerprint }));
  }
  invalidatePluginSnapshotCaches(f.stateDir);
  for (const kind of ["channel-inventory", "plugin-list"] as const) {
    assert.equal(readPluginSnapshotCache({ stateDir: f.stateDir, kind, fingerprint: f.fingerprint }), null);
  }
});
