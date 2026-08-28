import { test, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-kimi-test-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

test("saveKimiSearchConfig allow 非空时把 kimi-search 同步 push 进 allow", async () => {
  const { saveKimiSearchConfig } = await import("./kimi-config");
  const config: any = {
    plugins: { allow: ["openclaw-weixin", "browser", "moonshot"], entries: {} },
  };
  saveKimiSearchConfig(config, { enabled: true });
  expect(config.plugins.allow).toContain("kimi-search");
  // 已有的不被移除
  expect(config.plugins.allow).toEqual(
    expect.arrayContaining(["openclaw-weixin", "browser", "moonshot", "kimi-search"]),
  );
});

test("saveKimiSearchConfig allow 为空数组或缺失时不主动创建/写入", async () => {
  const { saveKimiSearchConfig } = await import("./kimi-config");
  const c1: any = { plugins: { allow: [], entries: {} } };
  saveKimiSearchConfig(c1, { enabled: true });
  expect(c1.plugins.allow).toEqual([]);

  const c2: any = { plugins: { entries: {} } };
  saveKimiSearchConfig(c2, { enabled: true });
  expect(c2.plugins.allow).toBeUndefined();
});

test("saveKimiSearchConfig 重复 enable 时 allow 不重复 push", async () => {
  const { saveKimiSearchConfig } = await import("./kimi-config");
  const config: any = {
    plugins: { allow: ["browser", "kimi-search"], entries: {} },
  };
  saveKimiSearchConfig(config, { enabled: true });
  expect(config.plugins.allow.filter((x: string) => x === "kimi-search")).toHaveLength(1);
});

test("saveKimiSearchConfig disable 不从 allow 移除", async () => {
  const { saveKimiSearchConfig } = await import("./kimi-config");
  const config: any = {
    plugins: { allow: ["browser", "kimi-search"], entries: {} },
  };
  saveKimiSearchConfig(config, { enabled: false });
  expect(config.plugins.allow).toContain("kimi-search");
});

// ── healLegacyProxyProviders ──

test("healLegacyProxyProviders 改写无 secret 段的遗留代理 provider", async () => {
  const { healLegacyProxyProviders } = await import("./kimi-config");
  const config: any = {
    models: {
      providers: {
        "kimi-coding": { baseUrl: "http://127.0.0.1:18790/NEWSECRET/coding", apiKey: "proxy-managed" },
        kimi: { baseUrl: "http://127.0.0.1:18790/coding", apiKey: "proxy-managed" },
      },
    },
  };
  expect(healLegacyProxyProviders(config, 18790, "NEWSECRET")).toBe(true);
  expect(config.models.providers.kimi.baseUrl).toBe("http://127.0.0.1:18790/NEWSECRET/coding");
  // skipKey 默认跳过 kimi-coding（由 ensureProxyConfig 主逻辑负责）
});

test("healLegacyProxyProviders 改写旧 secret 和旧端口的遗留条目", async () => {
  const { healLegacyProxyProviders } = await import("./kimi-config");
  const config: any = {
    models: {
      providers: {
        kimi: { baseUrl: "http://127.0.0.1:18790/OLDSECRET/coding", apiKey: "proxy-managed" },
        kimi2: { baseUrl: "http://127.0.0.1:9999/coding/", apiKey: "proxy-managed" },
      },
    },
  };
  expect(healLegacyProxyProviders(config, 18790, "NEWSECRET")).toBe(true);
  expect(config.models.providers.kimi.baseUrl).toBe("http://127.0.0.1:18790/NEWSECRET/coding");
  expect(config.models.providers.kimi2.baseUrl).toBe("http://127.0.0.1:18790/NEWSECRET/coding");
});

test("healLegacyProxyProviders 已正确的条目不重复改写（幂等）", async () => {
  const { healLegacyProxyProviders } = await import("./kimi-config");
  const config: any = {
    models: {
      providers: {
        kimi: { baseUrl: "http://127.0.0.1:18790/NEWSECRET/coding", apiKey: "proxy-managed" },
      },
    },
  };
  expect(healLegacyProxyProviders(config, 18790, "NEWSECRET")).toBe(false);
});

test("healLegacyProxyProviders 不动非本地代理的 provider", async () => {
  const { healLegacyProxyProviders } = await import("./kimi-config");
  const config: any = {
    models: {
      providers: {
        "kimi-coding": { baseUrl: "http://127.0.0.1:18790/SEC/coding", apiKey: "proxy-managed" },
        kimi: { baseUrl: "https://api.kimi.com/coding", apiKey: "real-key" },
        deepseek: { baseUrl: "https://api.deepseek.com", apiKey: "sk-x" },
        ollama: { baseUrl: "http://127.0.0.1:11434/v1", apiKey: "ollama" },
      },
    },
  };
  expect(healLegacyProxyProviders(config, 18790, "SEC")).toBe(false);
  expect(config.models.providers.kimi.baseUrl).toBe("https://api.kimi.com/coding");
  expect(config.models.providers.ollama.baseUrl).toBe("http://127.0.0.1:11434/v1");
});

test("healLegacyProxyProviders 边界：端口非法/providers 缺失时返回 false", async () => {
  const { healLegacyProxyProviders } = await import("./kimi-config");
  expect(healLegacyProxyProviders({ models: { providers: { kimi: { baseUrl: "http://127.0.0.1:1/coding" } } } }, 0, "S")).toBe(false);
  expect(healLegacyProxyProviders({}, 18790, "S")).toBe(false);
  expect(healLegacyProxyProviders(null, 18790, "S")).toBe(false);
});

test("healLegacyProxyProviders 空 secret 时不改写（写出的 baseUrl 仍会被代理 401）", async () => {
  const { healLegacyProxyProviders } = await import("./kimi-config");
  const config: any = {
    models: { providers: { kimi: { baseUrl: "http://127.0.0.1:18790/coding", apiKey: "proxy-managed" } } },
  };
  expect(healLegacyProxyProviders(config, 18790, "")).toBe(false);
  expect(config.models.providers.kimi.baseUrl).toBe("http://127.0.0.1:18790/coding");
});

test("healLegacyProxyProviders 不改写 apiKey 非 proxy-managed 的本地匹配条目（防误伤自建服务）", async () => {
  const { healLegacyProxyProviders } = await import("./kimi-config");
  const config: any = {
    models: { providers: { "my-local": { baseUrl: "http://127.0.0.1:8080/coding", apiKey: "sk-user-own-key" } } },
  };
  expect(healLegacyProxyProviders(config, 18790, "SEC")).toBe(false);
  expect(config.models.providers["my-local"].baseUrl).toBe("http://127.0.0.1:8080/coding");
});
