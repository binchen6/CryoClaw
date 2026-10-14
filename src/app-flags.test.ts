// app-flags.test.ts — 远端特性开关清单：parse 宽松正向、缓存新鲜期、
// force 绕缓存、过期缓存兜底、内置默认兜底、非法清单整体作废。
// node:test（与 webbridge-pins.test.ts 同框架；经 tsconfig.test.json 编译到 .test-dist 运行）。
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  BUNDLED_DEFAULT_FLAGS,
  loadAppFlags,
  parseFlagsJson,
} from "./app-flags";

// 缓存文件名与 app-flags.ts 的 CACHE_FILE_NAME 保持一致（模块未导出）
const CACHE_FILE = "app-flags.json";

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("parseFlagsJson：布尔解析；未知键忽略；未提的键沿用内置默认", () => {
  assert.deepEqual(parseFlagsJson(JSON.stringify({ flags: { differentialDownload: false } })), {
    differentialDownload: false,
  });
  // 未知键前向兼容：忽略，不炸
  assert.deepEqual(
    parseFlagsJson(JSON.stringify({ flags: { differentialDownload: true, futureFlag: false } })),
    { differentialDownload: true },
  );
  // 空 flags = 全默认
  assert.deepEqual(parseFlagsJson(JSON.stringify({ flags: {} })), BUNDLED_DEFAULT_FLAGS);
});

test("parseFlagsJson：已知键非布尔 / 缺 flags / 非 JSON → 整体作废（null）", () => {
  assert.equal(parseFlagsJson(JSON.stringify({ flags: { differentialDownload: "yes" } })), null);
  assert.equal(parseFlagsJson(JSON.stringify({ flags: { differentialDownload: 1 } })), null);
  assert.equal(parseFlagsJson(JSON.stringify({ version: 1 })), null);
  assert.equal(parseFlagsJson(JSON.stringify({ flags: [true] })), null);
  assert.equal(parseFlagsJson("not json"), null);
  assert.equal(parseFlagsJson(JSON.stringify([1, 2])), null);
});

test("loadAppFlags：拉取成功写缓存；新鲜缓存不触网", async () => {
  const dir = mkTempDir("app-flags-");
  let calls = 0;
  const fetchText = async () => {
    calls++;
    return JSON.stringify({ flags: { differentialDownload: false } });
  };
  const r1 = await loadAppFlags({ dataDir: dir, urls: ["https://x.test/flags.json"], fetchText });
  assert.equal(r1.flags.differentialDownload, false);
  assert.equal(r1.source, "https://x.test/flags.json");
  assert.equal(calls, 1);
  // 缓存文件已写
  assert.ok(fs.existsSync(path.join(dir, CACHE_FILE)));
  // 第二次：新鲜缓存命中，不再触网
  const r2 = await loadAppFlags({ dataDir: dir, urls: ["https://x.test/flags.json"], fetchText });
  assert.equal(r2.flags.differentialDownload, false);
  assert.equal(r2.source, "cache");
  assert.equal(calls, 1);
});

test("loadAppFlags：force 绕缓存重新拉取", async () => {
  const dir = mkTempDir("app-flags-force-");
  let calls = 0;
  const fetchText = async () => {
    calls++;
    return JSON.stringify({ flags: { differentialDownload: true } });
  };
  await loadAppFlags({ dataDir: dir, urls: ["https://x.test/f.json"], fetchText });
  await loadAppFlags({
    dataDir: dir,
    urls: ["https://x.test/f.json"],
    fetchText,
    forceRefresh: true,
  });
  assert.equal(calls, 2);
});

test("loadAppFlags：全部 URL 失败 → 过期缓存兜底；无缓存 → 内置默认", async () => {
  const dir = mkTempDir("app-flags-stale-");
  const goodFetch = async () => JSON.stringify({ flags: { differentialDownload: false } });
  await loadAppFlags({ dataDir: dir, urls: ["https://x.test/f.json"], fetchText: goodFetch });
  // 把缓存时间戳改旧 → 过期
  const cachePath = path.join(dir, CACHE_FILE);
  const cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
  cache.fetchedAt = Date.now() - 48 * 60 * 60 * 1000;
  fs.writeFileSync(cachePath, JSON.stringify(cache), "utf-8");
  const badFetch = async () => {
    throw new Error("network down");
  };
  const r = await loadAppFlags({ dataDir: dir, urls: ["https://x.test/f.json"], fetchText: badFetch });
  assert.equal(r.flags.differentialDownload, false);
  assert.equal(r.source, "stale-cache");

  // 完全无缓存且拉不到 → 内置默认
  const dir2 = mkTempDir("app-flags-default-");
  const r2 = await loadAppFlags({ dataDir: dir2, urls: ["https://x.test/f.json"], fetchText: badFetch });
  assert.deepEqual(r2.flags, BUNDLED_DEFAULT_FLAGS);
  assert.equal(r2.source, "bundled-default");
});

test("loadAppFlags：非法清单不落缓存、不覆盖旧缓存", async () => {
  const dir = mkTempDir("app-flags-invalid-");
  const goodFetch = async () => JSON.stringify({ flags: { differentialDownload: false } });
  await loadAppFlags({ dataDir: dir, urls: ["https://x.test/f.json"], fetchText: goodFetch });
  // 过期后拉到非法清单 → 回退过期缓存（旧值仍生效）
  const cachePath = path.join(dir, CACHE_FILE);
  const cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
  cache.fetchedAt = Date.now() - 48 * 60 * 60 * 1000;
  fs.writeFileSync(cachePath, JSON.stringify(cache), "utf-8");
  const badJson = async () => JSON.stringify({ flags: { differentialDownload: "yes" } });
  const r = await loadAppFlags({ dataDir: dir, urls: ["https://x.test/f.json"], fetchText: badJson });
  assert.equal(r.flags.differentialDownload, false);
  assert.equal(r.source, "stale-cache");
});
