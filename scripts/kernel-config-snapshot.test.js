// kernel-config-snapshot.js 单元测试
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const kcs = require("./lib/kernel-config-snapshot.js");

function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-cfg-snap-test-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("snapshotOpenclawConfig 复制 openclaw.json 到备份目录", () => {
  const root = makeTmp();
  const stateDir = path.join(root, "state");
  const backupDir = path.join(root, "backup");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify({ models: { x: 1 } }));

  const dst = kcs.snapshotOpenclawConfig(backupDir, stateDir);
  assert.equal(dst, path.join(backupDir, "openclaw.json"));
  assert.deepEqual(JSON.parse(fs.readFileSync(dst, "utf8")), { models: { x: 1 } });
});

test("snapshotOpenclawConfig 源文件不存在时返回 null（跳过）", () => {
  const root = makeTmp();
  const stateDir = path.join(root, "state");
  const backupDir = path.join(root, "backup");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  assert.equal(kcs.snapshotOpenclawConfig(backupDir, stateDir), null);
  assert.ok(!fs.existsSync(path.join(backupDir, "openclaw.json")));
});

test("resolveOpenclawStateDir 优先 OPENCLAW_STATE_DIR", () => {
  assert.equal(kcs.resolveOpenclawStateDir({ OPENCLAW_STATE_DIR: path.join("x", "state") }), path.join("x", "state"));
});

test("resolveOpenclawStateDir 无环境变量时回落 home 下 .openclaw", () => {
  const home = process.platform === "win32" ? "C:\\Users\\someone" : "/home/someone";
  const env = process.platform === "win32" ? { USERPROFILE: home } : { HOME: home };
  assert.equal(kcs.resolveOpenclawStateDir(env), path.join(home, ".openclaw"));
});
