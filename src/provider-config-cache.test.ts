// readUserConfig 原文缓存（R77）的失效语义：键控 (mtimeMs, size)，
// 外部改写/原子替换必须让缓存失效，读-改-写仍拿到独立对象。
// 另覆盖 readUserConfig 的读失败语义（ENOENT → {}，其他 I/O 错误抛错）、
// writeUserConfig 保险丝（损坏 JSON/根节点非对象保留原位、拒绝写入）
// 与 baseSnapshot 并发写守卫（磁盘在窗口期被第三方改写 → 拒绝覆盖）。
import { test, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// vitest 4 无法直接 spyOn Node 内置模块的 ESM namespace：
// mock 整个 fs，仅把需要模拟故障的两个导出包装成 vi.fn（默认透传 actual）。
// actual 引用保存在 hoisted 容器里，供拦截实现透传（不能调用被 mock 的 vi.fn 自身，会递归）
const actualFsRef = vi.hoisted(() => ({ current: null as null | typeof import("fs") }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  actualFsRef.current = actual;
  return {
    ...actual,
    statSync: vi.fn(actual.statSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-cache-test-"));
const cfgPath = path.join(tmpDir, "openclaw.json");

vi.mock("./constants", () => ({
  resolveUserConfigPath: () => cfgPath,
  resolveUserStateDir: () => tmpDir,
}));
// 隔离依赖链：writeUserConfig 会触达的旁路模块与本测试无关
vi.mock("./openclaw-health-state", () => ({ syncOpenClawStateAfterWrite: () => {} }));
vi.mock("./config-backup", () => ({ backupCurrentUserConfig: () => {} }));
vi.mock("./provider-image-probe", () => ({ probeImageSupport: async () => null }));
vi.mock("./wecom-config", () => ({ verifyWecom: async () => {} }));

test("readUserConfig 缓存：外部改写失效 + 返回独立对象", async () => {
  const { readUserConfig } = await import("./provider-config");

  // 1) 无文件 → {}
  expect(readUserConfig()).toEqual({});

  // 2) 首次写入后可读
  fs.writeFileSync(cfgPath, JSON.stringify({ version: 1 }), "utf-8");
  expect(readUserConfig()).toEqual({ version: 1 });

  // 3) 同一内容重复读：返回独立对象（调用方改写互不可见）
  const a = readUserConfig();
  const b = readUserConfig();
  expect(a).not.toBe(b);
  a.injected = true;
  expect(b.injected).toBeUndefined();
  expect(readUserConfig().injected).toBeUndefined();

  // 4) 外部改写（mtime/size 变化）→ 缓存失效
  fs.writeFileSync(cfgPath, JSON.stringify({ version: 2, extra: "x".repeat(64) }), "utf-8");
  expect(readUserConfig()).toEqual({ version: 2, extra: "x".repeat(64) });

  // 5) 文件删除 → 回到 {}
  fs.rmSync(cfgPath, { force: true });
  expect(readUserConfig()).toEqual({});

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("readUserConfig 对非 ENOENT 读失败（statSync EBUSY）抛错而非吞成 {}", async () => {
  const { readUserConfig } = await import("./provider-config");
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.rmSync(cfgPath, { force: true });

  const spy = vi.mocked(fs.statSync);
  spy.mockImplementationOnce(() => {
    throw Object.assign(new Error("resource busy or locked, stat"), { code: "EBUSY" });
  });
  // 杀软瞬时锁：必须让调用方知晓并中止「读-改-写」，而不是合并进 {} 覆盖全量配置
  expect(() => readUserConfig()).toThrow(/杀毒软件/);
  expect(fs.existsSync(cfgPath)).toBe(false);
});

test("readUserConfig 对非 ENOENT 读失败（readFileSync EBUSY）抛错而非吞成 {}", async () => {
  const { readUserConfig } = await import("./provider-config");
  fs.mkdirSync(tmpDir, { recursive: true });
  // 唯一 marker 保证 size 与历史写入不同，强制走 readFileSync 路径（缓存必失效）
  const marker = `busy-${Date.now()}-${"x".repeat(32)}`;
  fs.writeFileSync(cfgPath, JSON.stringify({ marker }), "utf-8");

  vi.mocked(fs.readFileSync).mockImplementation(((p: any, ...rest: any[]) => {
    if (String(p) === cfgPath) {
      throw Object.assign(new Error("resource busy or locked, read"), { code: "EBUSY" });
    }
    return (actualFsRef.current!.readFileSync as any)(p, ...rest);
  }) as any);
  expect(() => readUserConfig()).toThrow(/杀毒软件/);
  vi.mocked(fs.readFileSync).mockRestore();
  fs.rmSync(cfgPath, { force: true });
});

test("writeUserConfig 保险丝：损坏 JSON 保留原位、抛错、不产生 .corrupt-* 文件", async () => {
  const { writeUserConfig } = await import("./provider-config");
  fs.mkdirSync(tmpDir, { recursive: true });
  const corruptRaw = "{ \"providers\": 这是损坏的 JSON";
  fs.writeFileSync(cfgPath, corruptRaw, "utf-8");

  expect(() => writeUserConfig({ injected: true })).toThrow(/内容损坏/);
  // 文件保留原位（字节不变）——启动期 inspectUserConfigHealth 的恢复判定是
  // 「文件原位存在且 JSON 非法」，rename 移走会让恢复入口永不触发
  expect(fs.readFileSync(cfgPath, "utf-8")).toBe(corruptRaw);
  expect(fs.readdirSync(tmpDir).some((f) => f.includes(".corrupt-"))).toBe(false);
  fs.rmSync(cfgPath, { force: true });
});

test("readUserConfigForWrite：绕过原文缓存，快照始终反映此刻磁盘", async () => {
  const { readUserConfig, readUserConfigForWrite } = await import("./provider-config");
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify({ version: 1 }), "utf-8");
  expect(readUserConfig()).toEqual({ version: 1 }); // 填充原文缓存
  const st1 = fs.statSync(cfgPath);

  // 同毫秒同字节数替换（缓存键 (mtimeMs, size) 不失效）——缓存会命中旧原文，
  // 若快照取自缓存，写前比对就会把"自己的旧读"误判成第三方写入
  fs.writeFileSync(cfgPath, JSON.stringify({ version: 2 }), "utf-8");
  vi.mocked(fs.statSync).mockImplementation(((p: any, ...rest: any[]) => {
    if (String(p) === cfgPath) return { mtimeMs: st1.mtimeMs, size: st1.size } as any;
    return (actualFsRef.current!.statSync as any)(p, ...rest);
  }) as any);
  expect(readUserConfig()).toEqual({ version: 1 }); // 缓存命中的旧原文（即风险本身）
  expect(readUserConfigForWrite().config).toEqual({ version: 2 }); // 快照走真实磁盘
  vi.mocked(fs.statSync).mockRestore();

  fs.rmSync(cfgPath, { force: true });
});

test("writeUserConfig 正常路径：健康配置仍可整文件写回", async () => {
  const { readUserConfig, writeUserConfig } = await import("./provider-config");
  fs.mkdirSync(tmpDir, { recursive: true });
  writeUserConfig({ version: 7, note: "guard-test" });
  expect(readUserConfig()).toEqual({ version: 7, note: "guard-test" });
  fs.rmSync(cfgPath, { force: true });
});

test("根节点为合法 JSON 标量/数组时按内容损坏处理：保险丝拒绝写入 + 读取返回 {}", async () => {
  const { readUserConfig, writeUserConfig } = await import("./provider-config");
  fs.mkdirSync(tmpDir, { recursive: true });

  for (const raw of ['"hello"', "123", "[]", "null"]) {
    fs.writeFileSync(cfgPath, raw, "utf-8");
    // 放行的话调用方 `config.models ??= {}` 在 strict mode 抛裸 TypeError
    // （"Cannot create property" 直接暴露给用户），保存全线失败
    expect(() => writeUserConfig({ injected: true })).toThrow(/内容损坏/);
    // 文件保留原位（字节不变）：恢复流程的判定是「原位存在且内容非法」
    expect(fs.readFileSync(cfgPath, "utf-8")).toBe(raw);
    // 读取侧同口径：标量/数组视为损坏 → {}，不把标量交给调用方
    expect(readUserConfig()).toEqual({});
  }

  fs.rmSync(cfgPath, { force: true });
});

test("writeUserConfig baseSnapshot：窗口期内磁盘被第三方（gateway）改写则拒绝覆盖", async () => {
  const { readUserConfigForWrite, writeUserConfig } = await import("./provider-config");
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify({ version: 1, providers: { a: {} } }), "utf-8");

  const { config, baseSnapshot } = readUserConfigForWrite();
  config.version = 2; // 本次要落盘的改动
  // 窗口期内 gateway 内核把前端渠道配置 config.patch 落盘
  const gatewayWrite = { version: 1, providers: { a: {} }, channels: { feishu: {} } };
  fs.writeFileSync(cfgPath, JSON.stringify(gatewayWrite), "utf-8");

  let err: any = null;
  try {
    writeUserConfig(config, { baseSnapshot });
  } catch (e) {
    err = e;
  }
  // 错误文案用户可见（settings 保存路径会原样展示）
  expect(err?.message).toMatch(/已被其他流程/);
  expect(err?.message).toMatch(/请重试/);
  expect(err?.message).toMatch(/channels/); // 顶层字段差异写进文案，便于定位是谁写的
  // 未发生覆盖：对方写入的 channels 仍在原位
  expect(JSON.parse(fs.readFileSync(cfgPath, "utf-8"))).toEqual(gatewayWrite);

  // 按提示重试（重新取快照）即可成功，且保留对方改动
  const retry = readUserConfigForWrite();
  retry.config.version = 2;
  writeUserConfig(retry.config, { baseSnapshot: retry.baseSnapshot });
  expect(JSON.parse(fs.readFileSync(cfgPath, "utf-8"))).toEqual({
    version: 2,
    providers: { a: {} },
    channels: { feishu: {} },
  });

  fs.rmSync(cfgPath, { force: true });
});

test("writeUserConfig baseSnapshot：readUserConfigForWrite 的快照与 config 相互独立", async () => {
  const { readUserConfigForWrite, writeUserConfig } = await import("./provider-config");
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify({ hooks: {} }), "utf-8");

  const { config, baseSnapshot } = readUserConfigForWrite();
  // 调用方的常见形态就是原地改：快照必须不被这次改动带上，否则写前比对退化成
  // 「拿待写内容比对磁盘」，任何有意义的改动都会被误判成并发写入
  config.hooks = { internal: { enabled: true } };
  expect(baseSnapshot).toEqual({ hooks: {} });

  writeUserConfig(config, { baseSnapshot });
  expect(JSON.parse(fs.readFileSync(cfgPath, "utf-8"))).toEqual({
    hooks: { internal: { enabled: true } },
  });

  fs.rmSync(cfgPath, { force: true });
});

test("writeUserConfig baseSnapshot：文件不存在时快照 {} 与磁盘一致，首次写入不报错", async () => {
  const { readUserConfigForWrite, writeUserConfig } = await import("./provider-config");
  fs.rmSync(cfgPath, { force: true });

  const { config, baseSnapshot } = readUserConfigForWrite();
  expect(baseSnapshot).toEqual({});
  config.version = 1;
  writeUserConfig(config, { baseSnapshot });

  expect(JSON.parse(fs.readFileSync(cfgPath, "utf-8"))).toEqual({ version: 1 });
  fs.rmSync(cfgPath, { force: true });
});

test("writeUserConfig baseSnapshot：未传快照的路径不做比对（启动期迁移等）", async () => {
  const { writeUserConfig } = await import("./provider-config");
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify({ version: 1 }), "utf-8");

  // 无 baseSnapshot：即便磁盘内容与任何快照无关也照写（迁移路径的既有语义）
  writeUserConfig({ version: 9 });
  expect(JSON.parse(fs.readFileSync(cfgPath, "utf-8"))).toEqual({ version: 9 });

  fs.rmSync(cfgPath, { force: true });
});
