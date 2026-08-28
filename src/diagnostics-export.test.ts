import test from "node:test";
import assert from "node:assert/strict";
import { redactSensitiveValues } from "./diagnostics-export.ts";

test("redactSensitiveValues：敏感键值替换为 ***", () => {
  const out = redactSensitiveValues({
    apiKey: "sk-real-key",
    nested: { oauth_token: "tok", list: [{ password: "pw" }] },
    name: "keep-me",
  }) as Record<string, unknown>;
  assert.equal(out.apiKey, "***");
  assert.equal((out.nested as Record<string, unknown>).oauth_token, "***");
  assert.equal(
    ((out.nested as Record<string, unknown>).list as Array<Record<string, unknown>>)[0].password,
    "***",
  );
  assert.equal(out.name, "keep-me");
});

test("redactSensitiveValues：回环代理 URL 中的 path secret 按值打码", () => {
  const out = redactSensitiveValues({
    baseUrl: "http://127.0.0.1:18790/AbCdEf123456_-xyz98765/coding",
    search: { baseUrl: "http://127.0.0.1:18790/AbCdEf123456_-xyz98765/coding/v1/search" },
  }) as Record<string, unknown>;
  assert.equal(out.baseUrl, "http://127.0.0.1:18790/***/coding");
  assert.equal(
    (out.search as Record<string, unknown>).baseUrl,
    "http://127.0.0.1:18790/***/coding/v1/search",
  );
});

test("redactSensitiveValues：非代理回环 URL 与短路径段不误伤", () => {
  const out = redactSensitiveValues({
    gateway: "http://127.0.0.1:18789/",
    upstream: "https://api.kimi.com/coding/v1",
    shortSeg: "http://127.0.0.1:18790/ab/coding",
  }) as Record<string, unknown>;
  assert.equal(out.gateway, "http://127.0.0.1:18789/");
  assert.equal(out.upstream, "https://api.kimi.com/coding/v1");
  assert.equal(out.shortSeg, "http://127.0.0.1:18790/ab/coding", "短段（<8 字符）不应视为 secret");
});
