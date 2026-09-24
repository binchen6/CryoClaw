import test from "node:test";
import assert from "node:assert/strict";

import {
  configureManagedMedia,
  fetchManagedImageObjectUrl,
  fetchWithTokenFallback,
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

// ── 候选凭证回退（回归：设备 token 优先导致 HTTP 媒体端点全量 401 → ⚠ 占位）──

test("fetchWithTokenFallback：首个凭证 401 → 回退下一凭证并命中", async () => {
  resetManagedMedia();
  const tried: string[] = [];
  const restore = stubFetch(async (_url, init) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
    tried.push(auth);
    if (auth === "Bearer device-token") {
      return new Response("unauthorized", { status: 401 });
    }
    return new Response(new Blob(["img"]), { status: 200 });
  });
  try {
    const res = await fetchWithTokenFallback("http://127.0.0.1:18789/api/chat/media/x", [
      "device-token",
      "shared-token",
    ]);
    assert.ok(res?.ok, "第二凭证应命中 200");
    assert.deepEqual(tried, ["Bearer device-token", "Bearer shared-token"]);
  } finally {
    restore();
    resetManagedMedia();
  }
});

test("fetchWithTokenFallback：命中凭证被记忆，下一请求不再先撞 401", async () => {
  resetManagedMedia();
  const tried: string[] = [];
  const restore = stubFetch(async (_url, init) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
    tried.push(auth);
    return auth === "Bearer good"
      ? new Response(new Blob(["img"]), { status: 200 })
      : new Response("no", { status: 401 });
  });
  try {
    const tokens = ["bad", "good"];
    assert.ok((await fetchWithTokenFallback("http://x/1", tokens))?.ok);
    tried.length = 0;
    assert.ok((await fetchWithTokenFallback("http://x/2", tokens))?.ok);
    assert.deepEqual(tried, ["Bearer good"], "命中的候选应被记忆为起始凭证");
  } finally {
    restore();
    resetManagedMedia();
  }
});

test("fetchWithTokenFallback：404 不换凭证直接返回；全部 401 返回最后一次响应", async () => {
  resetManagedMedia();
  let calls404 = 0;
  const restore404 = stubFetch(async () => {
    calls404 += 1;
    return new Response("missing", { status: 404 });
  });
  try {
    const res = await fetchWithTokenFallback("http://x/missing", ["a", "b"]);
    assert.equal(res?.status, 404);
    assert.equal(calls404, 1, "404 换凭证无意义，不得重试");
  } finally {
    restore404();
  }
  let calls401 = 0;
  const restore401 = stubFetch(async () => {
    calls401 += 1;
    return new Response("no", { status: 401 });
  });
  try {
    const res = await fetchWithTokenFallback("http://x/denied", ["a", "b"]);
    assert.equal(res?.status, 401, "全部候选被拒应返回最后一次响应（调用方记录状态码）");
    assert.equal(calls401, 2, "两个候选都应被尝试");
  } finally {
    restore401();
    resetManagedMedia();
  }
});

test("fetchManagedImageObjectUrl：失败时输出诊断日志（status 可见）", async () => {
  resetManagedMedia();
  configureManagedMedia({ httpOrigin: "http://127.0.0.1:18789", sharedToken: "t" });
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  const restore = stubFetch(async () => new Response("no", { status: 401 }));
  try {
    const result = await fetchManagedImageObjectUrl("/api/chat/media/denied");
    assert.equal(result, null);
    assert.ok(
      warnings.some((w) => w.includes("[managed-media] fetch failed") && w.includes("401")),
      "失败应带状态码告警（渲染层 console 转发进 app.log，便于诊断）",
    );
  } finally {
    restore();
    console.warn = originalWarn;
    resetManagedMedia();
  }
});
