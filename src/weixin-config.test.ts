import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ensureWeixinPluginReady,
  isWeixinPluginBundled,
  persistWeixinLoginSuccess,
  saveWeixinLoginResult,
  WEIXIN_CHANNEL_ID,
  WEIXIN_PLUGIN_ID,
} from "./weixin-config";

// 创建临时 OPENCLAW_STATE_DIR 并登记环境还原与目录清理（各用例共用）。
function setupTempStateDir(t: TestContext): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-weixin-"));
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

test("persistWeixinLoginSuccess 应同时写入账号凭据并启用微信 channel", (t) => {
  const stateDir = setupTempStateDir(t);

  const config: Record<string, any> = {
    plugins: {
      entries: {
        [WEIXIN_PLUGIN_ID]: {
          customFlag: true,
        },
      },
    },
    channels: {
      [WEIXIN_CHANNEL_ID]: {
        routeTag: "route-a",
      },
    },
  };

  const normalizedId = persistWeixinLoginSuccess(config, {
    status: "confirmed",
    accountId: "Bot@im.bot",
    botToken: "token-123",
    baseUrl: "https://ilinkai.weixin.qq.com",
    userId: "user-1",
  });

  assert.equal(normalizedId, "bot-im-bot");
  assert.equal(config.plugins.entries[WEIXIN_PLUGIN_ID].enabled, true);
  assert.equal(config.plugins.entries[WEIXIN_PLUGIN_ID].customFlag, true);
  assert.equal(config.channels[WEIXIN_CHANNEL_ID].enabled, true);
  assert.equal(config.channels[WEIXIN_CHANNEL_ID].routeTag, "route-a");

  const indexPath = path.join(stateDir, "openclaw-weixin", "accounts.json");
  const accountPath = path.join(stateDir, "openclaw-weixin", "accounts", "bot-im-bot.json");
  const savedAccount = JSON.parse(fs.readFileSync(accountPath, "utf-8"));

  assert.deepEqual(JSON.parse(fs.readFileSync(indexPath, "utf-8")), ["bot-im-bot"]);
  assert.equal(typeof savedAccount.savedAt, "string");
  assert.deepEqual(savedAccount, {
    token: "token-123",
    savedAt: savedAccount.savedAt,
    baseUrl: "https://ilinkai.weixin.qq.com",
    userId: "user-1",
  });
});

test("ensureWeixinPluginReady 应先执行 reconcile 再检查微信插件目录", async (t) => {
  const stateDir = setupTempStateDir(t);

  let reconciled = false;
  assert.equal(isWeixinPluginBundled(), false);

  await ensureWeixinPluginReady(async () => {
    reconciled = true;
    const pluginDir = path.join(stateDir, "extensions", WEIXIN_PLUGIN_ID);
    // 边界守卫：夹具插件目录必须仍在状态目录内
    const rel = path.relative(stateDir, pluginDir);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("夹具路径越界");
    fs.mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "openclaw.plugin.json"), "{}\n", "utf-8");
    fs.writeFileSync(path.join(pluginDir, "dist", "index.js"), "module.exports = {};\n", "utf-8");
  });

  assert.equal(reconciled, true);
  assert.equal(isWeixinPluginBundled(), true);
});

test("ensureWeixinPluginReady 应在 reconcile 后仍缺插件时拒绝启用微信", async (t) => {
  const stateDir = setupTempStateDir(t);

  let reconciled = false;

  await assert.rejects(
    ensureWeixinPluginReady(async () => {
      reconciled = true;
    }),
    /微信插件未安装/,
  );

  assert.equal(reconciled, true);
  assert.equal(isWeixinPluginBundled(), false);
});

// L6：accounts.json 索引与 gateway 内微信插件进程共享，且由 listWeixinAccountIds() 整体
// JSON.parse——半写/截断的索引会被 catch 吞掉返回空列表（账号文件还在但列表不展示）。
// 因此本侧写入必须是 tmp + rename 的原子写，且写前重读磁盘。

test("saveWeixinLoginResult 应原子写账号索引（不直接覆写 accounts.json）", (t) => {
  const stateDir = setupTempStateDir(t);
  const indexPath = path.join(stateDir, "openclaw-weixin", "accounts.json");

  const writeTargets: string[] = [];
  const renameCalls: Array<[string, string]> = [];
  const originalWriteFileSync = (fs as any).writeFileSync;
  const originalRenameSync = (fs as any).renameSync;
  // 原子写内部走 openSync+writeSync(fd)+fsync+renameSync，故用 renameSync 观测落位
  (fs as any).writeFileSync = (target: unknown, ...rest: unknown[]) => {
    writeTargets.push(typeof target === "string" ? target : String(target));
    return (originalWriteFileSync as (...args: unknown[]) => unknown)(target, ...rest);
  };
  (fs as any).renameSync = (from: string, to: string) => {
    renameCalls.push([from, to]);
    return (originalRenameSync as (a: string, b: string) => void)(from, to);
  };
  t.after(() => {
    (fs as any).writeFileSync = originalWriteFileSync;
    (fs as any).renameSync = originalRenameSync;
  });

  const normalizedId = saveWeixinLoginResult({
    status: "confirmed",
    accountId: "Bot@im.bot",
    botToken: "token-123",
  });

  assert.equal(normalizedId, "bot-im-bot");
  // 索引走 .tmp + rename；不得把半成品直接写到 accounts.json
  assert.equal(writeTargets.includes(indexPath), false);
  assert.deepEqual(
    renameCalls.filter(([, to]) => to === indexPath),
    [[`${indexPath}.tmp`, indexPath]],
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(indexPath, "utf-8")), ["bot-im-bot"]);
  assert.equal(fs.existsSync(`${indexPath}.tmp`), false);
});

test("saveWeixinLoginResult 应保留索引里插件已注册的其他账号（写前重读磁盘）", (t) => {
  const stateDir = setupTempStateDir(t);
  const weixinDir = path.join(stateDir, "openclaw-weixin");
  fs.mkdirSync(weixinDir, { recursive: true });
  // 模拟 gateway 内微信插件（registerWeixinAccountId）先写入的索引条目
  fs.writeFileSync(
    path.join(weixinDir, "accounts.json"),
    JSON.stringify(["plugin-registered"]),
    "utf-8",
  );

  assert.equal(
    saveWeixinLoginResult({ status: "confirmed", accountId: "Bot@im.bot", botToken: "token-123" }),
    "bot-im-bot",
  );

  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(weixinDir, "accounts.json"), "utf-8")),
    ["plugin-registered", "bot-im-bot"],
  );
});
