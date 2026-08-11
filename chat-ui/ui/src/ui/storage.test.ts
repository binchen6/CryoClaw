import test from "node:test";
import assert from "node:assert/strict";
import { parseUiSettings, saveSettings, type UiSettings } from "./storage.ts";

test("file 协议下应优先信任主进程注入的 gatewayUrl，覆盖旧缓存", () => {
  const settings = parseUiSettings(
    JSON.stringify({
      gatewayUrl: "ws://127.0.0.1:19466",
      token: "cached-token",
    }),
    {
      protocol: "file:",
      host: "",
      search: "?gatewayUrl=ws%3A%2F%2F127.0.0.1%3A18789",
      hash: "",
    },
  );

  assert.equal(settings.gatewayUrl, "ws://127.0.0.1:18789");
  assert.equal(settings.token, "cached-token");
});

test("网页场景不应静默信任 query 中的 gatewayUrl，仍应保留原配置", () => {
  const settings = parseUiSettings(
    JSON.stringify({
      gatewayUrl: "wss://persisted.example/ws",
    }),
    {
      protocol: "https:",
      host: "control.example",
      search: "?gatewayUrl=wss%3A%2F%2Foverride.example%2Fws",
      hash: "",
    },
  );

  assert.equal(settings.gatewayUrl, "wss://persisted.example/ws");
});

test("file 协议下应从 URL fragment 读取首屏视图，确保 Setup 直接首帧生效", () => {
  const settings = parseUiSettings(null, {
    protocol: "file:",
    host: "",
    search: "",
    hash: "#view=setup",
  });

  assert.equal(settings.cryoclawView, "setup");
});

test("网页场景不应信任 URL 注入的 cryoclawView", () => {
  const settings = parseUiSettings(null, {
    protocol: "https:",
    host: "control.example",
    search: "",
    hash: "#view=setup",
  });

  assert.equal(settings.cryoclawView, "chat");
});

test("saveSettings 不持久化 cryoclawView（初始视图由主进程 URL/IPC 决定）", () => {
  const store = new Map<string, string>();
  const original = (globalThis as Record<string, unknown>).localStorage;
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  try {
    saveSettings({
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "t",
      sessionKey: "s",
      lastActiveSessionKey: "s",
      cryoclawView: "settings",
      theme: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navGroupsCollapsed: {},
    } as UiSettings);
    const raw = store.get("openclaw.control.settings.v1");
    assert.ok(raw, "应写入 localStorage");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.equal("cryoclawView" in parsed, false, "cryoclawView 不应落盘");
    assert.equal(parsed.gatewayUrl, "ws://127.0.0.1:18789", "其余字段应照常持久化");
  } finally {
    (globalThis as Record<string, unknown>).localStorage = original;
  }
});
