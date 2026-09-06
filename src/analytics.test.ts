// analytics 构建配置单元测试（vitest）：
// 原实现经 ts.transpileModule + vm.runInContext 沙箱加载 src/analytics.ts，
// 属动态代码执行面；现改为 vitest 原生 TS 导入 + vi.mock 模块桩，覆盖等价：
//   - ./build-config → 指向测试临时 build-config.json（config 注入）
//   - ./cryoclaw-config → 固定 deviceId / 空 channelId
//   - ./logger → 捕获 info/warn/error
//   - electron → 固定 app version
// fetch / setInterval 用 spy/stub，真实定时器由 shutdown 回收。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ── 模块桩（vi.mock 提升，经 hoisted state 与用例通信） ──
const state = vi.hoisted(() => ({
  configPath: null as string | null,
  infoLogs: [] as string[],
  warnLogs: [] as string[],
  errorLogs: [] as string[],
}));

vi.mock("./build-config", () => ({
  buildConfigPathCandidates: () => (state.configPath ? [state.configPath] : []),
}));

vi.mock("./cryoclaw-config", () => ({
  ensureDeviceId: () => "12345678-1234-5678-9abc-def012345678",
  getChannelId: () => "",
}));

vi.mock("./logger", () => ({
  info: (message: unknown) => state.infoLogs.push(String(message)),
  warn: (message: unknown) => state.warnLogs.push(String(message)),
  error: (message: unknown) => state.errorLogs.push(String(message)),
}));

vi.mock("./analytics-events", () => ({
  buildActionResultProps: () => ({}),
  buildActionStartedProps: () => ({}),
  classifyAnalyticsErrorType: () => "unknown",
}));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "2026.420.0",
    getAppPath: () => "/Applications/CryoClaw.app/Contents/Resources/app.asar",
  },
}));

// electron_version 断言期望 40.2.1（原沙箱 process.versions 形态）
const ORIGINAL_ELECTRON_VERSION = process.versions.electron;

import {
  parseAnalyticsBuildConfig,
  normalizeVolcanoConfig,
  createVolcanoSink,
  init,
  track,
  shutdown,
} from "./analytics.ts";

// 测试夹具常量：值非真实凭据，仅用于解析/归一化断言
const FX_POSTHOG_KEY = "test-posthog-placeholder";
const FX_VOLCANO_KEY = "test-volcano-placeholder";
const FX_COLLECTOR_URL = "https://collector.example/v2/event/json";

// 沙箱对象与宿主不同 realm 的历史问题已随 vm 移除；保留深拷贝以稳定断言
function plain(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}

function writeConfigFile(config: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "analytics-test-"));
  const configPath = path.join(dir, "build-config.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

function resetLogs() {
  state.infoLogs = [];
  state.warnLogs = [];
  state.errorLogs = [];
}

beforeEach(() => {
  resetLogs();
  state.configPath = null;
  Object.defineProperty(process.versions, "electron", {
    value: "40.2.1",
    configurable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(process.versions, "electron", {
    value: ORIGINAL_ELECTRON_VERSION,
    configurable: true,
  });
});

describe("parseAnalyticsBuildConfig", () => {
  it("应兼容旧版 analytics 嵌套字段", () => {
    const config = JSON.parse(JSON.stringify(parseAnalyticsBuildConfig({
      analytics: {
        enabled: true,
        captureURL: "https://posthog.example/capture",
        apiKey: FX_POSTHOG_KEY,
        requestTimeoutMs: 9000,
        retryDelaysMs: [0, 1000],
      },
      volcano: {
        enabled: true,
        appId: 1,
        appKey: FX_VOLCANO_KEY,
        endpoint: FX_COLLECTOR_URL,
      },
    })));

    expect(config).toEqual({
      posthog: {
        enabled: true,
        captureURL: "https://posthog.example/capture",
        apiKey: FX_POSTHOG_KEY,
        requestTimeoutMs: 9000,
        retryDelaysMs: [0, 1000],
      },
      volcano: {
        enabled: true,
        appId: 1,
        appKey: FX_VOLCANO_KEY,
        endpoint: FX_COLLECTOR_URL,
      },
    });
  });
});

describe("normalizeVolcanoConfig", () => {
  it("空入参时禁用并回填默认值", () => {
    expect(plain(normalizeVolcanoConfig({}))).toEqual({
      enabled: false,
      appId: 0,
      appKey: "",
      endpoint: "",
      fallbackEndpoint: "",
      requestTimeoutMs: 8000,
      retryDelaysMs: [0, 500, 1500],
    });
  });

  it("缺 appId/appKey/endpoint 任一时禁用", () => {
    expect(normalizeVolcanoConfig({ enabled: true, appId: 1, appKey: "only-key", endpoint: "" }).enabled).toBe(false);
    expect(normalizeVolcanoConfig({ enabled: true, appId: 1, appKey: "", endpoint: "https://ep.example" }).enabled).toBe(false);
    expect(normalizeVolcanoConfig({ enabled: true, appKey: "k", endpoint: "https://ep.example" }).enabled).toBe(false);
    expect(normalizeVolcanoConfig({ enabled: true, appId: 0, appKey: "k", endpoint: "https://ep.example" }).enabled).toBe(false);
  });

  it("完整配置时启用并用 endpoint 兜底 fallback", () => {
    expect(plain(normalizeVolcanoConfig({
      enabled: true,
      appId: 1,
      appKey: `  ${FX_VOLCANO_KEY}  `,
      endpoint: FX_COLLECTOR_URL,
      requestTimeoutMs: 5000,
      retryDelaysMs: [0, 200, 800],
    }))).toEqual({
      enabled: true,
      appId: 1,
      appKey: FX_VOLCANO_KEY,
      endpoint: FX_COLLECTOR_URL,
      fallbackEndpoint: FX_COLLECTOR_URL,
      requestTimeoutMs: 5000,
      retryDelaysMs: [0, 200, 800],
    });
  });

  it("命中客户端 SDK 域名时禁用并打 warn", () => {
    // 主端点踩坑：mcs.ctobsnssdk.com 是客户端 SDK 接收域名，server-side payload 会被拒。
    const result = normalizeVolcanoConfig({
      enabled: true,
      appId: 1,
      appKey: "k",
      endpoint: "https://mcs.ctobsnssdk.com/v1/list",
    });
    expect(result.enabled).toBe(false);
    expect(state.warnLogs.some((m) => m.includes("命中客户端 SDK 域名"))).toBe(true);

    // fallback 也得校验，否则用户主备同时配错时只在主域名上告警就漏报。
    const result2 = normalizeVolcanoConfig({
      enabled: true,
      appId: 1,
      appKey: "k",
      endpoint: "https://gator.volces.com/v2/event/json",
      fallbackEndpoint: "https://x.ctobsnssdk.com/v1",
    });
    expect(result2.enabled).toBe(false);
  });

  it("非法 retryDelaysMs 回退到默认值", () => {
    expect(normalizeVolcanoConfig({
      enabled: true,
      appId: 1,
      appKey: "k",
      endpoint: "https://ep.example",
      retryDelaysMs: ["bad", -1] as unknown as number[],
    }).retryDelaysMs).toEqual([0, 500, 1500]);
  });
});

describe("createVolcanoSink", () => {
  it("buildPayload 输出 DataFinder 期望的信封结构", () => {
    init();

    try {
      const sink = createVolcanoSink({
        enabled: true,
        appId: 1,
        appKey: FX_VOLCANO_KEY,
        endpoint: FX_COLLECTOR_URL,
        fallbackEndpoint: "https://collector-backup.example/v2/event/json",
        requestTimeoutMs: 8000,
        retryDelaysMs: [0, 500, 1500],
      });

      expect(sink.name).toBe("volcano");
      expect(sink.enabled).toBe(true);
      expect(sink.headers["X-MCS-AppKey"]).toBe(FX_VOLCANO_KEY);
      expect(sink.headers["Content-Type"]).toBe("application/json");
      expect(sink.headers["User-Agent"]).toMatch(/^CryoClaw\//);

      const payload = plain(sink.buildPayload("setup_action_started", { action: "verify_key", foo: "bar" }));

      expect(payload.user).toEqual({ user_unique_id: "" });
      expect(payload.header.app_id).toBe(1);
      expect(payload.header.app_name).toBe("cryoclaw");
      expect(payload.header.app_version).toBe("2026.420.0");
      // UUID 12345678-...-12345678 折叠出 0x8888888800000000，按 INT63_MASK 钳到 0x0888...0000。
      // 期望值不能是未 mask 的 9838263503687778304；analytics.ts 主动剥掉符号位避免服务端读成负数。
      expect(payload.header.device_id).toBe("614891466833002496");
      // os_name 由当前平台决定，这里只校验是枚举值之一
      expect(["mac", "windows", "linux"]).toContain(payload.header.os_name);
      // custom 必须是 JSON 字符串（DataFinder 协议要求）
      expect(typeof payload.header.custom).toBe("string");
      expect(JSON.parse(payload.header.custom)).toEqual({
        arch: process.arch,
        electron_version: "40.2.1",
      });

      expect(payload.events.length).toBe(1);
      const event = payload.events[0];
      expect(event.event).toBe("setup_action_started");
      expect(typeof event.params).toBe("string");
      expect(JSON.parse(event.params)).toEqual({ action: "verify_key", foo: "bar" });
      expect(typeof event.local_time_ms).toBe("number");
      expect(event.local_time_ms).toBeGreaterThan(0);
    } finally {
      // init() 启动了 heartbeat setInterval，必须回收，否则测试进程挂起
      shutdown();
    }
  });
});

describe("init/track/shutdown", () => {
  it("init 应记录 enabled sinks 的 fan-out 规模", () => {
    state.configPath = writeConfigFile({
      posthog: {
        enabled: true,
        captureURL: "https://posthog.example/capture",
        apiKey: FX_POSTHOG_KEY,
      },
      volcano: {
        enabled: true,
        appId: 1,
        appKey: FX_VOLCANO_KEY,
        endpoint: FX_COLLECTOR_URL,
      },
    });

    init();

    try {
      expect(state.infoLogs).toContain(`[analytics] posthog enabled config=${state.configPath}`);
      expect(state.infoLogs).toContain(`[analytics] volcano enabled config=${state.configPath}`);
      expect(state.infoLogs).toContain("[analytics] track fan-out=2 sinks=[posthog,volcano]");
    } finally {
      shutdown();
    }
  });

  it("init 的 fan-out 日志只统计 enabled sinks", () => {
    state.configPath = writeConfigFile({
      posthog: {
        enabled: true,
        captureURL: "https://posthog.example/capture",
        apiKey: FX_POSTHOG_KEY,
      },
      volcano: {
        enabled: false,
        appKey: FX_VOLCANO_KEY,
        endpoint: FX_COLLECTOR_URL,
      },
    });

    init();

    try {
      expect(state.infoLogs).toContain("[analytics] volcano disabled");
      expect(state.infoLogs).toContain("[analytics] track fan-out=1 sinks=[posthog]");
      expect(state.infoLogs).not.toContain("[analytics] track fan-out=2 sinks=[posthog,volcano]");
    } finally {
      shutdown();
    }
  });

  it("track 遇到不可 JSON 序列化的 Volcano 属性时只丢弃当前 sink", async () => {
    state.configPath = writeConfigFile({
      volcano: {
        enabled: true,
        appId: 1,
        appKey: FX_VOLCANO_KEY,
        endpoint: FX_COLLECTOR_URL,
      },
    });

    init();

    try {
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      track("bad_event", circular);
      await Promise.resolve();

      expect(state.errorLogs.some((message) => (
        message.includes("[analytics] drop event=bad_event sink=volcano")
        && message.includes("Converting circular structure to JSON")
      ))).toBe(true);
    } finally {
      await shutdown();
    }
  });

  it("shutdown 会等待短暂 flush 窗口以发送退出前已在途的埋点", async () => {
    let completed = false;
    vi.stubGlobal("fetch", async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      completed = true;
      return { ok: true };
    });

    state.configPath = writeConfigFile({
      posthog: {
        enabled: true,
        captureURL: "https://posthog.example/capture",
        apiKey: FX_POSTHOG_KEY,
        retryDelaysMs: [0],
      },
    });

    init();

    track("app_closed");
    await shutdown();

    expect(completed).toBe(true);
  });
});
