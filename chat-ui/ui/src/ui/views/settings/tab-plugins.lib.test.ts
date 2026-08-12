import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidPluginName,
  mapInstalledPlugin,
  mapMarketPlugin,
  sortInstalledPlugins,
  sortMarketPlugins,
} from "./tab-plugins.lib.ts";

test("isValidPluginName：合法名称", () => {
  assert.equal(isValidPluginName("openclaw-weixin"), true);
  assert.equal(isValidPluginName("@scope/pkg"), true);
  assert.equal(isValidPluginName("feishu"), true);
});

test("isValidPluginName：拒绝非法输入", () => {
  assert.equal(isValidPluginName(""), false);
  assert.equal(isValidPluginName("--force"), false);
  assert.equal(isValidPluginName("../escape"), false);
  assert.equal(isValidPluginName("a b"), false);
  assert.equal(isValidPluginName("name|shell"), false);
});

test("mapInstalledPlugin：完整字段映射", () => {
  const v = mapInstalledPlugin({
    id: "feishu", name: "feishu", version: "2026.7.1", description: "飞书渠道",
    format: "openclaw", kind: "channel", source: "C:\\x", origin: "global",
    enabled: true, status: "ok",
  });
  assert.ok(v);
  assert.equal(v.id, "feishu");
  assert.equal(v.kind, "channel");
  assert.equal(v.enabled, true);
});

test("mapInstalledPlugin：缺失可选字段不抛错", () => {
  const v = mapInstalledPlugin({ id: "x", enabled: false });
  assert.ok(v);
  assert.equal(v.version, undefined);
  assert.equal(v.enabled, false);
});

test("mapInstalledPlugin：非法条目返回 null", () => {
  assert.equal(mapInstalledPlugin(null), null);
  assert.equal(mapInstalledPlugin({ id: "" }), null);
  assert.equal(mapInstalledPlugin("str"), null);
});

test("mapMarketPlugin：完整字段映射", () => {
  const v = mapMarketPlugin({
    name: "openclaw-wechat", displayName: "WeChat", family: "code-plugin",
    channel: "community", isOfficial: false, latestVersion: "3.1.4",
    summary: "summary", ownerHandle: "newfuture",
    downloads: 51, verificationTier: "source-linked",
  });
  assert.ok(v);
  assert.equal(v.name, "openclaw-wechat");
  assert.equal(v.downloads, 51);
});

test("mapMarketPlugin：非法条目返回 null", () => {
  assert.equal(mapMarketPlugin(null), null);
  assert.equal(mapMarketPlugin({ name: "" }), null);
});

test("sortMarketPlugins：官方优先，同官方按下载量降序", () => {
  const sorted = sortMarketPlugins([
    { name: "a", downloads: 10 },
    { name: "b", isOfficial: true, downloads: 1 },
    { name: "c", downloads: 99 },
  ]);
  assert.deepEqual(sorted.map((s) => s.name), ["b", "c", "a"]);
});

test("sortInstalledPlugins：按 kind 分组再按 id 排序", () => {
  const sorted = sortInstalledPlugins([
    { id: "memory-b", name: "memory-b", kind: "memory", enabled: true },
    { id: "channel-a", name: "channel-a", kind: "channel", enabled: true },
    { id: "memory-a", name: "memory-a", kind: "memory", enabled: false },
  ]);
  assert.deepEqual(sorted.map((s) => s.id), ["channel-a", "memory-a", "memory-b"]);
});
