// ipc-sender-guard.test.ts — 可信 IPC sender 判定（纯函数部分）
import test from "node:test";
import assert from "node:assert/strict";
import { isTrustedChatUiUrl } from "./ipc-sender-guard";

// Windows 风格 file:// 前缀：chat-ui/dist 目录（CJS 下 pathToFileURL href 形如 file:///C:/...）
const WIN_PREFIX = "file:///C:/Users/u/AppData/Local/Programs/CryoClaw/resources/app.asar/chat-ui/dist/";

test("isTrustedChatUiUrl: 精确入口 index.html 可信", () => {
  assert.equal(isTrustedChatUiUrl(`${WIN_PREFIX}index.html`, WIN_PREFIX), true);
});

test("isTrustedChatUiUrl: history 路由改写后的 URL 可信（/dist/chat?session=...）", () => {
  // renderer 的 history API 会把 pathname 从 /dist/index.html 改写为 /dist/<route>
  assert.equal(isTrustedChatUiUrl(`${WIN_PREFIX}chat?session=agent%3Amain%3Amain`, WIN_PREFIX), true);
  assert.equal(isTrustedChatUiUrl(`${WIN_PREFIX}chat`, WIN_PREFIX), true);
  assert.equal(isTrustedChatUiUrl(`${WIN_PREFIX}settings#tab=provider`, WIN_PREFIX), true);
  // 当前全部合法视图路由
  for (const route of ["setup", "workspace", "tasks", "skills", "cron"]) {
    assert.equal(isTrustedChatUiUrl(`${WIN_PREFIX}${route}`, WIN_PREFIX), true, `route=${route}`);
  }
  // 部署 base 路径：最多 1 个前缀段 + 已知入口
  assert.equal(isTrustedChatUiUrl(`${WIN_PREFIX}cryoclaw/chat?session=x`, WIN_PREFIX), true);
});

test("isTrustedChatUiUrl: 带 ?query 与 #hash 可信（loadURL 注入 gatewayUrl/token/view）", () => {
  assert.equal(isTrustedChatUiUrl(`${WIN_PREFIX}index.html?gatewayUrl=ws%3A%2F%2F127.0.0.1%3A18789&token=abc`, WIN_PREFIX), true);
  assert.equal(isTrustedChatUiUrl(`${WIN_PREFIX}index.html?gatewayUrl=ws%3A%2F%2F127.0.0.1%3A18789#view=setup`, WIN_PREFIX), true);
  assert.equal(isTrustedChatUiUrl(`${WIN_PREFIX}index.html#view=setup`, WIN_PREFIX), true);
  assert.equal(isTrustedChatUiUrl(`${WIN_PREFIX}index.html?`, WIN_PREFIX), true);
});

test("isTrustedChatUiUrl: 非 Chat UI 页面 / 未知路由 / 伪装文件 / 路径穿越一律拒绝", () => {
  assert.equal(isTrustedChatUiUrl("file:///C:/evil/index.html", WIN_PREFIX), false);
  assert.equal(isTrustedChatUiUrl("https://evil.example/index.html", WIN_PREFIX), false);
  // 未知路由（非 KNOWN 集合）拒绝
  assert.equal(isTrustedChatUiUrl(`${WIN_PREFIX}evil`, WIN_PREFIX), false);
  assert.equal(isTrustedChatUiUrl(`${WIN_PREFIX}chat.evil`, WIN_PREFIX), false);
  // 伪装文件：前缀相同但入口带后缀
  assert.equal(isTrustedChatUiUrl(`${WIN_PREFIX}index.html2`, WIN_PREFIX), false);
  // 路径穿越 / 多余路径段
  assert.equal(isTrustedChatUiUrl(`${WIN_PREFIX}chat/../index.html`, WIN_PREFIX), false);
  assert.equal(isTrustedChatUiUrl(`${WIN_PREFIX}a/b/chat`, WIN_PREFIX), false);
  // 1 个 base 前缀段 + 已知入口 → 可信（部署 base 场景）；入口未知才拒绝
  assert.equal(isTrustedChatUiUrl(`${WIN_PREFIX}evil/chat`, WIN_PREFIX), true);
  assert.equal(isTrustedChatUiUrl(`${WIN_PREFIX}evil/evil2`, WIN_PREFIX), false);
  // 大小写敏感（URL 路径大小写敏感，file:// 前缀必须精确一致）
  assert.equal(isTrustedChatUiUrl(WIN_PREFIX.toUpperCase(), WIN_PREFIX), false);
});

test("isTrustedChatUiUrl: 已删除的历史路由一律拒绝", () => {
  // sessions/agents/overview/channels/instances/usage/nodes/config/debug/logs 与 feedback 已从 Chat UI 移除，
  // 白名单同步收口后这些 pathname 不再可信。
  for (const route of ["sessions", "agents", "overview", "channels", "instances", "usage", "nodes", "config", "debug", "logs", "feedback"]) {
    assert.equal(isTrustedChatUiUrl(`${WIN_PREFIX}${route}`, WIN_PREFIX), false, `route=${route}`);
  }
});

test("isTrustedChatUiUrl: 空串与异常输入不抛错", () => {
  assert.equal(isTrustedChatUiUrl("", WIN_PREFIX), false);
});
