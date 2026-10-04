// webbridge-pins.test.ts — T8 schema v2（多哈希钉定）专项：
// parse v1/v2 兼容、force 绕缓存、v1 缓存归一化、force 时 raw 优先、
// verifyWebbridgeBinarySha256 的多哈希接受/未知哈希 fail-closed。
// node:test（与 webbridge.test.ts 同框架；经 tsconfig.test.json 编译到 .test-dist 运行）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  loadRemotePins,
  parsePinsJson,
  pinValuesOf,
  MAX_PINS_PER_FILE,
} from "./webbridge-pins";
import { verifyWebbridgeBinarySha256 } from "./webbridge";

// 缓存文件名与 webbridge-pins.ts 的 CACHE_FILE_NAME 保持一致（模块未导出）
const CACHE_FILE = "remote-pins.json";

const h = (ch: string) => ch.repeat(64);

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("parsePinsJson v2：多哈希数组解析（小写归一/去重）；非法形态整体丢弃", () => {
  const a = h("a");
  const b = h("b").toUpperCase(); // 大写 hex → 归一化成小写
  assert.deepEqual(
    parsePinsJson(JSON.stringify({ pins: { f: [a, b] }, version: 2 })),
    { f: [a, b.toLowerCase()] },
  );
  // 重复项去重
  assert.deepEqual(parsePinsJson(JSON.stringify({ f: [a, a] })), { f: [a] });
  // 超过每文件上限 → 整体丢弃（防清单被塞爆放宽校验面）
  const many = Array.from({ length: MAX_PINS_PER_FILE + 1 }, (_, i) =>
    (String(i) + "c".repeat(63)).slice(0, 64),
  );
  assert.equal(parsePinsJson(JSON.stringify({ f: many })), null);
  // 空数组 / 混入非法项 / 混入非字符串 → 整体丢弃
  assert.equal(parsePinsJson(JSON.stringify({ f: [] })), null);
  assert.equal(parsePinsJson(JSON.stringify({ f: [a, "zz"] })), null);
  assert.equal(parsePinsJson(JSON.stringify({ f: [a, 1] })), null);
  // v1 单串与 v2 数组混合在同一份清单 → 各自归一化
  assert.deepEqual(parsePinsJson(JSON.stringify({ x: a, y: [a] })), { x: [a], y: [a] });
});

test("pinValuesOf：宽容归一化（校验侧）——非法/缺失 → 空数组", () => {
  assert.deepEqual(pinValuesOf(h("A")), [h("a")]);
  assert.deepEqual(pinValuesOf([h("a"), h("b")]), [h("a"), h("b")]);
  assert.deepEqual(pinValuesOf(undefined), []);
  assert.deepEqual(pinValuesOf(null), []);
  assert.deepEqual(pinValuesOf("zz"), []);
  assert.deepEqual(pinValuesOf({}), []);
});

test("loadRemotePins：force 绕过新鲜缓存并更新缓存；非 force 命中缓存不触网", async () => {
  const dir = mkTempDir("wb-pins-force-");
  try {
    // 预写一份"新鲜"缓存（fetchedAt=now，v2 数组形态）
    fs.writeFileSync(
      path.join(dir, CACHE_FILE),
      JSON.stringify({ fetchedAt: Date.now(), pins: { f: [h("a")] } }),
      "utf-8",
    );
    let calls = 0;
    const rt = async () => {
      calls++;
      return JSON.stringify({ f: [h("b")] });
    };
    // 非 force：新鲜缓存命中，不触网
    const cached = await loadRemotePins({ dataDir: dir, urls: ["https://x/pins.json"], fetchText: rt });
    assert.equal(cached.source, "cache");
    assert.deepEqual(cached.pins, { f: [h("a")] });
    assert.equal(calls, 0);
    // force（别名）：绕过缓存 → 拉取新清单并回写缓存
    const forced = await loadRemotePins({ dataDir: dir, force: true, urls: ["https://x/pins.json"], fetchText: rt });
    assert.equal(forced.source, "https://x/pins.json");
    assert.deepEqual(forced.pins, { f: [h("b")] });
    assert.equal(calls, 1);
    const rewritten = JSON.parse(fs.readFileSync(path.join(dir, CACHE_FILE), "utf-8"));
    assert.deepEqual(rewritten.pins, { f: [h("b")] }, "force 成功后缓存必须被新清单覆盖");
    // forceRefresh 与 force 语义一致
    const forced2 = await loadRemotePins({ dataDir: dir, forceRefresh: true, urls: ["https://x/pins.json"], fetchText: rt });
    assert.equal(forced2.source, "https://x/pins.json");
    assert.equal(calls, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRemotePins：v1 单串缓存文件读时归一化为数组（兼容旧 App 落盘）", async () => {
  const dir = mkTempDir("wb-pins-v1cache-");
  try {
    fs.writeFileSync(
      path.join(dir, CACHE_FILE),
      JSON.stringify({ fetchedAt: Date.now(), pins: { f: h("a") } }), // v1 形态
      "utf-8",
    );
    const res = await loadRemotePins({
      dataDir: dir,
      urls: ["https://x/pins.json"],
      fetchText: async () => { throw new Error("不应触网"); },
    });
    assert.equal(res.source, "cache");
    assert.deepEqual(res.pins, { f: [h("a")] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRemotePins：force 时 raw.githubusercontent 优先（jsDelivr 缓存滞后）", async () => {
  const dir = mkTempDir("wb-pins-order-");
  const prevEnv = process.env.CRYOCLAW_WEBBRIDGE_PINS_URL;
  delete process.env.CRYOCLAW_WEBBRIDGE_PINS_URL;
  try {
    const attempted: string[] = [];
    const fail = async (url: string) => {
      attempted.push(url);
      throw new Error("offline");
    };
    await loadRemotePins({ dataDir: dir, force: true, fetchText: fail });
    assert.ok(attempted.length >= 2, "默认清单源应逐个尝试");
    assert.match(attempted[0], /raw\.githubusercontent\.com/, "force 时 raw 必须排第一");
    // 非 force 维持 jsDelivr 优先（国内可达性）
    attempted.length = 0;
    await loadRemotePins({ dataDir: dir, fetchText: fail });
    assert.match(attempted[0], /cdn\.jsdelivr\.net/);
  } finally {
    if (prevEnv !== undefined) process.env.CRYOCLAW_WEBBRIDGE_PINS_URL = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyWebbridgeBinarySha256：多哈希清单任一枚命中即通过（含非首位）", () => {
  const dir = mkTempDir("wb-verify-multi-");
  try {
    const body = Buffer.from("rebuilt-again-by-upstream");
    const actual = createHash("sha256").update(body).digest("hex");
    const bin = path.join(dir, "kimi-webbridge-windows-amd64.exe");
    fs.writeFileSync(bin, body);
    // 内置表不匹配；远端 v2 数组第 2 枚命中 → 通过且不删产物
    verifyWebbridgeBinarySha256(bin, "kimi-webbridge-windows-amd64.exe", undefined, {
      "kimi-webbridge-windows-amd64.exe": [h("d"), actual, h("e")],
    });
    assert.equal(fs.existsSync(bin), true, "多哈希任一枚命中不应删产物");
    // v1 单串形态仍接受
    verifyWebbridgeBinarySha256(bin, "kimi-webbridge-windows-amd64.exe", undefined, {
      "kimi-webbridge-windows-amd64.exe": actual,
    });
    assert.equal(fs.existsSync(bin), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyWebbridgeBinarySha256：未知哈希 → 拒绝 + 删除产物 + 错误附「刷新钉定」指引", () => {
  const dir = mkTempDir("wb-verify-unknown-");
  try {
    const body = Buffer.from("totally-unknown-build");
    const bin = path.join(dir, "kimi-webbridge-darwin-arm64");
    fs.writeFileSync(bin, body);
    assert.throws(
      () =>
        verifyWebbridgeBinarySha256(bin, "kimi-webbridge-darwin-arm64", undefined, {
          "kimi-webbridge-darwin-arm64": [h("c"), h("d")],
        }),
      (err: Error) => {
        assert.match(err.message, /sha256 校验失败/, "保留 PIN_STALE 检测标记");
        assert.match(err.message, /刷新钉定/, "错误信息必须指向应用内刷新动作");
        assert.match(err.message, /c{64}/, "错误信息列出全部期望哈希");
        assert.match(err.message, /d{64}/);
        return true;
      },
    );
    assert.equal(fs.existsSync(bin), false, "fail closed 必须删除落盘产物");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
