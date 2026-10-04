import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateLegacyFeishuPluginEntry, isFeishuPluginBundled, FEISHU_PLUGIN_ID } from "./feishu-config";

// 创建临时 OPENCLAW_STATE_DIR 并登记环境还原与目录清理（对齐 weixin-config.test.ts）。
function setupTempStateDir(t: TestContext): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-feishu-"));
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

test("migrateLegacyFeishuPluginEntry 应把旧插件开关迁移到 channels.feishu.enabled 并移除插件开关", () => {
  const config: Record<string, any> = {
    channels: {
      feishu: {
        enabled: true,
        appId: "cli_a",
        dmPolicy: "pairing",
      },
    },
    plugins: {
      allow: ["openclaw-weixin", "wecom-openclaw-plugin", "kimi", "browser"],
      entries: {
        feishu: { enabled: true },
        kimi: { enabled: true },
      },
    },
  };

  const changed = migrateLegacyFeishuPluginEntry(config);

  assert.equal(changed, true);
  assert.equal(config.channels.feishu.enabled, true);
  assert.equal(config.channels.feishu.appId, "cli_a");
  assert.deepEqual(config.plugins.allow, ["openclaw-weixin", "wecom-openclaw-plugin", "kimi", "browser"]);
  assert.equal(config.plugins.entries.feishu, undefined);
  assert.equal(config.plugins.entries.kimi.enabled, true);
});

test("migrateLegacyFeishuPluginEntry 应以旧插件开关为准，避免用户禁用后被 channels 旧值重新启用", () => {
  const config: Record<string, any> = {
    channels: {
      feishu: {
        enabled: true,
        appId: "cli_disabled",
      },
    },
    plugins: {
      entries: {
        feishu: { enabled: false },
      },
    },
  };

  const changed = migrateLegacyFeishuPluginEntry(config);

  assert.equal(changed, true);
  assert.equal(config.channels.feishu.enabled, false);
  assert.equal(config.channels.feishu.appId, "cli_disabled");
  assert.equal(config.plugins.entries.feishu, undefined);
});

/* ── isFeishuPluginBundled 四根判定（T5） ──
 * node:test 环境无 Electron：gateway dist/extensions（vendored 主来源）与 mirror
 * 根解析失败被跳过，可布置的是 state extensions 根与 npm/projects 受管安装根。
 * feishu 走清单探针（同 qqbot）：vendored 官方扩展入口布局与 mirror 插件不同，
 * 只要求 openclaw.plugin.json 存在。 */

test("isFeishuPluginBundled 四根全空应返回 false", (t) => {
  setupTempStateDir(t);
  assert.equal(isFeishuPluginBundled(), false);
});

test("isFeishuPluginBundled 在 state extensions 根有清单即 true（无需入口文件）", (t) => {
  const stateDir = setupTempStateDir(t);
  const pluginDir = path.join(stateDir, "extensions", FEISHU_PLUGIN_ID);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({ id: FEISHU_PLUGIN_ID, channels: ["feishu"] }),
    "utf-8",
  );
  assert.equal(isFeishuPluginBundled(), true);
});

test("isFeishuPluginBundled 在 npm/projects 受管安装存在时也应 true", (t) => {
  const stateDir = setupTempStateDir(t);
  const projectDir = path.join(stateDir, "npm", "projects", "proj-feishu");
  const pkgDir = path.join(projectDir, "node_modules", "@openclaw", "feishu");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "package.json"),
    JSON.stringify({ dependencies: { "@openclaw/feishu": "2026.8.2" } }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pkgDir, "openclaw.plugin.json"),
    JSON.stringify({ id: FEISHU_PLUGIN_ID, channels: ["feishu"] }),
    "utf-8",
  );
  assert.equal(isFeishuPluginBundled(), true);
});
