import test from "node:test";
import assert from "node:assert/strict";

import {
  configureManagedMedia,
  fetchManagedImageObjectUrl,
  isManagedMediaUrl,
  resetManagedMedia,
  toAbsoluteMediaUrl,
  wsUrlToHttpOrigin,
} from "./managed-media.ts";

// ── wsUrlToHttpOrigin ──

test("wsUrlToHttpOrigin：ws → http", () => {
  assert.equal(wsUrlToHttpOrigin("ws://127.0.0.1:18789"), "http://127.0.0.1:18789");
});

test("wsUrlToHttpOrigin：wss → https", () => {
  assert.equal(wsUrlToHttpOrigin("wss://gw.example.com"), "https://gw.example.com");
});

test("wsUrlToHttpOrigin：非 ws 协议原样返回", () => {
  assert.equal(wsUrlToHttpOrigin("http://127.0.0.1:18789"), "http://127.0.0.1:18789");
});

// ── isManagedMediaUrl / toAbsoluteMediaUrl ──

test("isManagedMediaUrl：识别网关托管媒体相对路径", () => {
  assert.equal(isManagedMediaUrl("/api/chat/media/outgoing/main/abc/full"), true);
  assert.equal(isManagedMediaUrl("https://example.com/x.png"), false);
  assert.equal(isManagedMediaUrl("data:image/png;base64,AAAA"), false);
});

test("toAbsoluteMediaUrl：未配置时原样返回", () => {
  resetManagedMedia();
  const url = "/api/chat/media/outgoing/main/abc/full";
  assert.equal(toAbsoluteMediaUrl(url), url);
});

test("toAbsoluteMediaUrl：配置后拼接 HTTP origin，直链不受影响", () => {
  configureManagedMedia({ httpOrigin: "http://127.0.0.1:18789" });
  assert.equal(
    toAbsoluteMediaUrl("/api/chat/media/outgoing/main/abc/full"),
    "http://127.0.0.1:18789/api/chat/media/outgoing/main/abc/full",
  );
  assert.equal(toAbsoluteMediaUrl("https://example.com/x.png"), "https://example.com/x.png");
  resetManagedMedia();
});

// ── fetchManagedImageObjectUrl（mock globalThis.fetch）──

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("fetchManagedImageObjectUrl：成功拉取转 object URL 且带 Bearer 头", async () => {
  resetManagedMedia();
  configureManagedMedia({ httpOrigin: "http://127.0.0.1:18789", sharedToken: "shared-token" });
  const calls: Array<{ url: string; auth?: string }> = [];
  const restore = stubFetch(async (url, init) => {
    calls.push({
      url,
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
    });
    return new Response(new Blob(["fake-png"], { type: "image/png" }), { status: 200 });
  });
  try {
    const result = await fetchManagedImageObjectUrl("/api/chat/media/outgoing/main/abc/full");
    assert.ok(result, "应返回 object URL");
    assert.match(result ?? "", /^blob:/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:18789/api/chat/media/outgoing/main/abc/full");
    assert.ok(calls[0].auth?.startsWith("Bearer "), "必须携带 Bearer 头");
  } finally {
    restore();
    resetManagedMedia();
  }
});

test("fetchManagedImageObjectUrl：同 URL 命中缓存不重复拉取", async () => {
  resetManagedMedia();
  configureManagedMedia({ httpOrigin: "http://127.0.0.1:18789", sharedToken: "t" });
  let count = 0;
  const restore = stubFetch(async () => {
    count += 1;
    return new Response(new Blob(["x"]), { status: 200 });
  });
  try {
    const first = await fetchManagedImageObjectUrl("/api/chat/media/a");
    const second = await fetchManagedImageObjectUrl("/api/chat/media/a");
    assert.equal(count, 1);
    assert.equal(first, second);
  } finally {
    restore();
    resetManagedMedia();
  }
});

test("fetchManagedImageObjectUrl：HTTP 失败与网络异常都返回 null", async () => {
  resetManagedMedia();
  configureManagedMedia({ httpOrigin: "http://127.0.0.1:18789", sharedToken: "t" });
  const restore404 = stubFetch(async () => new Response("nope", { status: 404 }));
  try {
    assert.equal(await fetchManagedImageObjectUrl("/api/chat/media/missing"), null);
  } finally {
    restore404();
  }
  const restoreThrow = stubFetch(async () => {
    throw new Error("network down");
  });
  try {
    assert.equal(await fetchManagedImageObjectUrl("/api/chat/media/err"), null);
  } finally {
    restoreThrow();
    resetManagedMedia();
  }
});

test("resetManagedMedia：清空配置与缓存", async () => {
  resetManagedMedia();
  configureManagedMedia({ httpOrigin: "http://127.0.0.1:18789", sharedToken: "t" });
  const restore = stubFetch(
    async () => new Response(new Blob(["x"]), { status: 200 }),
  );
  try {
    const first = await fetchManagedImageObjectUrl("/api/chat/media/once");
    assert.ok(first);
    resetManagedMedia();
    assert.equal(toAbsoluteMediaUrl("/api/chat/media/once"), "/api/chat/media/once");
  } finally {
    restore();
    resetManagedMedia();
  }
});
