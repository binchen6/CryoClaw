import test from "node:test";
import assert from "node:assert/strict";
import { resolveVirtualPathReload, ERR_FILE_NOT_FOUND } from "./virtual-path-reload.ts";

const ENTRY = "file:///C:/app/chat-ui/dist/index.html?gatewayUrl=ws%3A%2F%2F127.0.0.1%3A18789&token=secret";

test("虚拟路径（/chat）刷新 404 → 回退入口并保留 session", () => {
  const r = resolveVirtualPathReload(
    ERR_FILE_NOT_FOUND,
    "file:///C:/app/chat-ui/dist/chat?session=agent%3Amain%3Amain",
    ENTRY,
  );
  assert.equal(r.recover, true);
  assert.ok(r.recoveryUrl);
  const u = new URL(r.recoveryUrl!);
  assert.equal(u.pathname, "/C:/app/chat-ui/dist/index.html", "回退目标是真实入口");
  assert.equal(u.searchParams.get("session"), "agent:main:main", "session 参数保留");
  assert.equal(u.searchParams.get("gatewayUrl"), "ws://127.0.0.1:18789", "gatewayUrl 沿用首载");
  assert.equal(u.searchParams.get("token"), "secret", "token 沿用首载");
});

test("入口 index.html 自身失败不兜底（防循环）", () => {
  const r = resolveVirtualPathReload(
    ERR_FILE_NOT_FOUND,
    "file:///C:/app/chat-ui/dist/index.html",
    ENTRY,
  );
  assert.equal(r.recover, false);
  assert.equal(r.recoveryUrl, null);
});

test("目录外 URL 不兜底（外部导航另有拦截职责）", () => {
  const r = resolveVirtualPathReload(
    ERR_FILE_NOT_FOUND,
    "file:///C:/Windows/system32/chat",
    ENTRY,
  );
  assert.equal(r.recover, false);
});

test("非 ERR_FILE_NOT_FOUND 错误码不兜底", () => {
  const r = resolveVirtualPathReload(
    -3, // ERR_ABORTED
    "file:///C:/app/chat-ui/dist/chat",
    ENTRY,
  );
  assert.equal(r.recover, false);
});

test("无 entry 记录 / URL 解析失败 → 不兜底", () => {
  assert.equal(resolveVirtualPathReload(ERR_FILE_NOT_FOUND, "file:///x/chat", null).recover, false);
  assert.equal(resolveVirtualPathReload(ERR_FILE_NOT_FOUND, "not a url", ENTRY).recover, false);
  assert.equal(resolveVirtualPathReload(ERR_FILE_NOT_FOUND, "file:///x/chat", "::bad::").recover, false);
});

test("无 session 参数的虚拟路径 → 回退且不附加空参数", () => {
  const r = resolveVirtualPathReload(
    ERR_FILE_NOT_FOUND,
    "file:///C:/app/chat-ui/dist/settings",
    ENTRY,
  );
  assert.equal(r.recover, true);
  assert.ok(r.recoveryUrl);
  assert.equal(new URL(r.recoveryUrl!).searchParams.has("session"), false);
});
