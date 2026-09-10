import test from "node:test";
import assert from "node:assert/strict";
import { isWebbridgePinStaleError } from "./webbridge-error.ts";

test("钉定校验失败特征命中（含内部哈希与逃生门说明的真实主进程消息）", () => {
  const real =
    "webbridge 二进制 sha256 校验失败: kimi-webbridge-windows-amd64.exe\n" +
    "  expected 2257775a…\n  actual   75f7f1b0…\n" +
    "（上游 latest 内容已变化或传输被污染；升级需更新钉定表）";
  assert.equal(isWebbridgePinStaleError(real), true);
  assert.equal(
    isWebbridgePinStaleError("webbridge 二进制缺少 sha256 钉定（kimi-webbridge-darwin-arm64）——拒绝执行未校验的下载产物；"),
    true,
  );
});

test("非钉定类错误不命中（普通网络/扩展失败保持原消息）", () => {
  assert.equal(isWebbridgePinStaleError("HTTP 500 — https://kimi-web-img.moonshot.cn/webbridge/latest/releases/x"), false);
  assert.equal(isWebbridgePinStaleError("浏览器扩展未安装：所有目标浏览器都失败"), false);
  assert.equal(isWebbridgePinStaleError(undefined), false);
  assert.equal(isWebbridgePinStaleError(null), false);
  assert.equal(isWebbridgePinStaleError(42), false);
});
