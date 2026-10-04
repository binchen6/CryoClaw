// plugin-allow-sync.test.ts — T2 白名单同步纯逻辑（node:test + 临时 OPENCLAW_STATE_DIR）：
//   - syncPluginAllowOnEnable：allow 非空才并入 / 空与缺失不动 / 幂等
//   - reconcilePluginsAllowWithEnabled：enabled !== false 的 entry 全量并入；
//     allow 为空 no-op；disabled 不并入；无变化不写盘（mtime 不变）
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { reconcilePluginsAllowWithEnabled, syncPluginAllowOnEnable } from "./plugin-allow-sync";

function setupTempStateDir(t: TestContext): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-allow-sync-"));
  const prevStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  t.after(() => {
    if (prevStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = prevStateDir;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  return stateDir;
}

function writeConfig(stateDir: string, config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify(config, null, 2), "utf-8");
}

function readConfig(stateDir: string): any {
  return JSON.parse(fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf-8"));
}

test("syncPluginAllowOnEnable：allow 非空才并入，空/缺失不动，幂等", () => {
  const withAllow: any = { plugins: { allow: ["a"], entries: {} } };
  syncPluginAllowOnEnable(withAllow, "b");
  assert.deepEqual(withAllow.plugins.allow, ["a", "b"]);
  syncPluginAllowOnEnable(withAllow, "b");
  assert.deepEqual(withAllow.plugins.allow, ["a", "b"], "幂等");

  const emptyAllow: any = { plugins: { allow: [], entries: {} } };
  syncPluginAllowOnEnable(emptyAllow, "b");
  assert.deepEqual(emptyAllow.plugins.allow, [], "空 allow 语义=未启用白名单，不动");

  const noAllow: any = { plugins: { entries: {} } };
  syncPluginAllowOnEnable(noAllow, "b");
  assert.equal(noAllow.plugins.allow, undefined, "缺失 allow 不创建");
});

test("reconcilePluginsAllowWithEnabled：allow 非空时 enabled 条目全量并入", (t) => {
  const stateDir = setupTempStateDir(t);
  writeConfig(stateDir, {
    plugins: {
      allow: ["mirrored-ext"],
      entries: {
        "mirrored-ext": { enabled: true },
        "market-plugin": { enabled: true },
        "ui-enabled": {},
        "user-disabled": { enabled: false },
      },
    },
  });
  const added = reconcilePluginsAllowWithEnabled();
  assert.deepEqual(added.sort(), ["market-plugin", "ui-enabled"]);
  const allow = readConfig(stateDir).plugins.allow as string[];
  assert.deepEqual(allow.sort(), ["market-plugin", "mirrored-ext", "ui-enabled"]);
  assert.ok(!allow.includes("user-disabled"), "disabled 不并入");
});

test("reconcilePluginsAllowWithEnabled：allow 为空/缺失 no-op，无变化不写盘", (t) => {
  const stateDir = setupTempStateDir(t);
  writeConfig(stateDir, { plugins: { entries: { a: { enabled: true } } } });
  assert.deepEqual(reconcilePluginsAllowWithEnabled(), []);

  writeConfig(stateDir, { plugins: { allow: ["a"], entries: { a: { enabled: true } } } });
  const configPath = path.join(stateDir, "openclaw.json");
  const before = fs.statSync(configPath).mtimeMs;
  assert.deepEqual(reconcilePluginsAllowWithEnabled(), [], "已对齐返回空");
  const after = fs.statSync(configPath).mtimeMs;
  assert.equal(after, before, "无变化不得写盘");
});

test("reconcilePluginsAllowWithEnabled：配置缺失/损坏不抛", (t) => {
  const stateDir = setupTempStateDir(t);
  assert.deepEqual(reconcilePluginsAllowWithEnabled(), [], "配置不存在不抛");
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{ not json", "utf-8");
  assert.deepEqual(reconcilePluginsAllowWithEnabled(), [], "配置损坏不抛");
});
