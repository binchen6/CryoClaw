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

test("healLegacyProxyProviders 改写带旧 secret 段的遗留代理 provider", async () => {
  const { healLegacyProxyProviders } = await import("./kimi-config");
  const config: any = {
    models: {
      providers: {
        "kimi-coding": { baseUrl: "http://127.0.0.1:18790/coding", apiKey: "proxy-managed" },
        kimi: { baseUrl: "http://127.0.0.1:18790/OLDSECRET/coding", apiKey: "proxy-managed" },
      },
    },
  };
  expect(healLegacyProxyProviders(config, 18790)).toBe(true);
  expect(config.models.providers.kimi.baseUrl).toBe("http://127.0.0.1:18790/coding");
  // skipKey 默认跳过 kimi-coding（由 ensureProxyConfig 主逻辑负责）
  expect(config.models.providers["kimi-coding"].baseUrl).toBe("http://127.0.0.1:18790/coding");
});

test("healLegacyProxyProviders 改写旧端口的遗留条目", async () => {
  const { healLegacyProxyProviders } = await import("./kimi-config");
  const config: any = {
    models: {
      providers: {
        kimi: { baseUrl: "http://127.0.0.1:18790/OLDSECRET/coding", apiKey: "proxy-managed" },
        kimi2: { baseUrl: "http://127.0.0.1:9999/coding/", apiKey: "proxy-managed" },
      },
    },
  };
  expect(healLegacyProxyProviders(config, 18790)).toBe(true);
  expect(config.models.providers.kimi.baseUrl).toBe("http://127.0.0.1:18790/coding");
  expect(config.models.providers.kimi2.baseUrl).toBe("http://127.0.0.1:18790/coding");
});

test("healLegacyProxyProviders 已正确的条目不重复改写（幂等）", async () => {
  const { healLegacyProxyProviders } = await import("./kimi-config");
  const config: any = {
    models: {
      providers: {
        kimi: { baseUrl: "http://127.0.0.1:18790/coding", apiKey: "proxy-managed" },
      },
    },
  };
  expect(healLegacyProxyProviders(config, 18790)).toBe(false);
});

test("healLegacyProxyProviders 不动非本地代理的 provider", async () => {
  const { healLegacyProxyProviders } = await import("./kimi-config");
  const config: any = {
    models: {
      providers: {
        "kimi-coding": { baseUrl: "http://127.0.0.1:18790/coding", apiKey: "proxy-managed" },
        kimi: { baseUrl: "https://api.kimi.com/coding", apiKey: "real-key" },
        deepseek: { baseUrl: "https://api.deepseek.com", apiKey: "sk-x" },
        ollama: { baseUrl: "http://127.0.0.1:11434/v1", apiKey: "ollama" },
      },
    },
  };
  expect(healLegacyProxyProviders(config, 18790)).toBe(false);
  expect(config.models.providers.kimi.baseUrl).toBe("https://api.kimi.com/coding");
  expect(config.models.providers.ollama.baseUrl).toBe("http://127.0.0.1:11434/v1");
});

test("healLegacyProxyProviders 边界：端口非法/providers 缺失时返回 false", async () => {
  const { healLegacyProxyProviders } = await import("./kimi-config");
  expect(healLegacyProxyProviders({ models: { providers: { kimi: { baseUrl: "http://127.0.0.1:1/coding" } } } }, 0)).toBe(false);
  expect(healLegacyProxyProviders({}, 18790)).toBe(false);
  expect(healLegacyProxyProviders(null, 18790)).toBe(false);
});

test("healLegacyProxyProviders 不改写 apiKey 非 proxy-managed 的本地匹配条目（防误伤自建服务）", async () => {
  const { healLegacyProxyProviders } = await import("./kimi-config");
  const config: any = {
    models: { providers: { "my-local": { baseUrl: "http://127.0.0.1:8080/coding", apiKey: "sk-user-own-key" } } },
  };
  expect(healLegacyProxyProviders(config, 18790)).toBe(false);
  expect(config.models.providers["my-local"].baseUrl).toBe("http://127.0.0.1:8080/coding");
});

// ── ensureMemorySearchProxyConfig（所有权规则：只自愈端口，不回滚用户配置） ──
// readKernelVersionParts 读取真实网关包，测试环境不可控 → mock 固定内核版本。

vi.mock("./openclaw-config-migration", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    readKernelVersionParts: () => ({ year: 2026, month: 9 }),
  };
});

test("ensureMemorySearchProxyConfig 节点缺失时首次应用完整 Kimi 预设", async () => {
  const { ensureMemorySearchProxyConfig } = await import("./kimi-config");
  const config: any = {};
  expect(ensureMemorySearchProxyConfig(config, 18790)).toBe(true);
  expect(config.memory.search).toEqual({
    enabled: true,
    provider: "openai",
    model: "bge_m3_embed",
    remote: { baseUrl: "http://127.0.0.1:18790/coding/v1/", apiKey: "proxy-managed" },
  });
});

test("ensureMemorySearchProxyConfig 用户改过 model（仍走代理）→ 只修端口漂移，不回滚 model", async () => {
  const { ensureMemorySearchProxyConfig } = await import("./kimi-config");
  const config: any = {
    memory: {
      search: {
        enabled: true,
        provider: "openai",
        model: "text-embedding-3-small",
        remote: { baseUrl: "http://127.0.0.1:40001/coding/v1/", apiKey: "proxy-managed" },
      },
    },
  };
  expect(ensureMemorySearchProxyConfig(config, 51705)).toBe(true);
  expect(config.memory.search.model).toBe("text-embedding-3-small");
  expect(config.memory.search.remote.baseUrl).toBe("http://127.0.0.1:51705/coding/v1/");
});

test("ensureMemorySearchProxyConfig 用户改过 provider/端点 → 整体不碰", async () => {
  const { ensureMemorySearchProxyConfig } = await import("./kimi-config");
  const config: any = {
    memory: {
      search: {
        enabled: true,
        provider: "ollama",
        model: "bge-m3",
        remote: { baseUrl: "http://127.0.0.1:11434/v1/", apiKey: "sk-own" },
      },
    },
  };
  expect(ensureMemorySearchProxyConfig(config, 18790)).toBe(false);
  expect(config.memory.search.provider).toBe("ollama");
  expect(config.memory.search.model).toBe("bge-m3");
  expect(config.memory.search.remote.baseUrl).toBe("http://127.0.0.1:11434/v1/");
});

test("ensureMemorySearchProxyConfig 用户禁用了语义搜索（仍指代理）→ 不重新启用", async () => {
  const { ensureMemorySearchProxyConfig } = await import("./kimi-config");
  const config: any = {
    memory: {
      search: {
        enabled: false,
        provider: "openai",
        model: "bge_m3_embed",
        remote: { baseUrl: "http://127.0.0.1:40001/coding/v1/", apiKey: "proxy-managed" },
      },
    },
  };
  expect(ensureMemorySearchProxyConfig(config, 51705)).toBe(true);
  expect(config.memory.search.enabled).toBe(false);
  expect(config.memory.search.remote.baseUrl).toBe("http://127.0.0.1:51705/coding/v1/");
});

test("ensureMemorySearchProxyConfig 预设完好且端口一致 → 幂等返回 false", async () => {
  const { ensureMemorySearchProxyConfig } = await import("./kimi-config");
  const config: any = {
    memory: {
      search: {
        enabled: true,
        provider: "openai",
        model: "bge_m3_embed",
        remote: { baseUrl: "http://127.0.0.1:18790/coding/v1/", apiKey: "proxy-managed" },
      },
    },
  };
  expect(ensureMemorySearchProxyConfig(config, 18790)).toBe(false);
});

test("ensureMemorySearchProxyConfig 只写过 query 等非 embedding 字段 → 视为未配置，应用预设", async () => {
  const { ensureMemorySearchProxyConfig } = await import("./kimi-config");
  const config: any = { memory: { search: { query: { maxResults: 8 } } } };
  expect(ensureMemorySearchProxyConfig(config, 18790)).toBe(true);
  expect(config.memory.search.provider).toBe("openai");
  expect(config.memory.search.query.maxResults).toBe(8);
});

test("ensureMemorySearchProxyConfig 端口非法 → false 且不创建节点", async () => {
  const { ensureMemorySearchProxyConfig } = await import("./kimi-config");
  const config: any = {};
  expect(ensureMemorySearchProxyConfig(config, 0)).toBe(false);
  expect(config.memory).toBeUndefined();
});
