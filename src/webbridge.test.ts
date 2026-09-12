// webbridge.test.ts — 关键链路：CDN 下载 / setup 编排 / 状态聚合 / precheck
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import {
  getWebbridgeInstallState,
  getWebbridgePrecheck,
  installWebbridge,
  installWebbridgeSkill,
  readCacheManifest,
  runWebbridgeSetupTask,
  verifyWebbridgeBinarySha256,
  writeCacheManifest,
  type WebbridgeSetupTaskDeps,
} from "./webbridge";
import { resolveWebbridgeDataDir } from "./constants";

const EXT = "abcdef0123456789abcdef0123456789";
const OK_CHROME = {
  browserId: "chrome", browserName: "Chrome",
  installed: true, configured: true, blocklisted: false,
  presentInChrome: true, extensionPendingEnable: false, running: false,
} as const;

function startCdn(body: Buffer, etag: string, onGet?: () => void): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.method === "HEAD") {
        res.writeHead(200, { ETag: etag, "Content-Length": String(body.length) }); res.end();
      } else { onGet?.(); res.writeHead(200, { "Content-Length": String(body.length) }); res.end(body); }
    });
    s.listen(0, "127.0.0.1", () => {
      const a = s.address(); if (!a || typeof a === "string") throw new Error("no addr");
      resolve({ url: `http://127.0.0.1:${a.port}`, close: () => new Promise((r) => s.close(() => r())) });
    });
  });
}

test("路径：resolveWebbridgeDataDir → HOME/.kimi-webbridge", () => {
  // 与实现同序（Win 下 USERPROFILE 优先）——MSYS/Git Bash 可能注入 POSIX 形态 HOME，
  // 顺序不一致时开发机上会算出与实现不同的根。
  const home =
    (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) ||
    os.homedir();
  assert.equal(resolveWebbridgeDataDir(), path.join(home, ".kimi-webbridge"));
});

test("installWebbridge: 首次下载 → installed + chmod + manifest；ETag 命中 → skipped 不发 GET", async () => {
  const body = Buffer.alloc(2048, 0x42);
  const bodySha = createHash("sha256").update(body).digest("hex");
  let getCalls = 0;
  const { url, close } = await startCdn(body, '"v1"', () => { getCalls++; });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-"));
  const bin = path.join(dir, "bin/kimi-webbridge");
  try {
    const fresh = await installWebbridge({ dataDir: dir, binaryPath: bin, platform: "darwin", arch: "arm64", cdnBaseUrl: url, expectedSha256: bodySha });
    assert.equal(fresh.installed, true);
    assert.equal(fs.statSync(bin).size, body.length);
    if (process.platform !== "win32") assert.equal(fs.statSync(bin).mode & 0o777, 0o755);
    assert.equal(readCacheManifest(dir)?.etag, '"v1"');
    assert.equal(getCalls, 1);

    writeCacheManifest(dir, { version: "latest", etag: '"v1"', lastModified: null, contentLength: null });
    const cached = await installWebbridge({ dataDir: dir, binaryPath: bin, platform: "darwin", arch: "arm64", cdnBaseUrl: url, expectedSha256: bodySha });
    assert.equal(cached.skipped, true);
    assert.equal(getCalls, 1, "ETag 命中不应再发 GET");
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("供应链钉定：哈希不匹配 → 拒装并删除落盘文件；未知文件名无钉 → fail closed；SKIP_PIN 逃生门放行", async () => {
  const body = Buffer.alloc(64, 0x43);
  const bodySha = createHash("sha256").update(body).digest("hex");
  const { url, close } = await startCdn(body, '"v1"');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-pin-"));
  const mkBin = () => path.join(dir, `bin/kimi-webbridge-${Math.random().toString(16).slice(2, 8)}`);
  try {
    // 1) 哈希不匹配（内置 pin 表：darwin-arm64 有钉定，fixture 不匹配）
    const bin1 = mkBin();
    await assert.rejects(
      installWebbridge({ dataDir: dir, binaryPath: bin1, platform: "darwin", arch: "arm64", cdnBaseUrl: url }),
      /sha256 校验失败/,
    );
    assert.equal(fs.existsSync(bin1), false, "校验失败必须删除落盘产物");

    // 2) verifyWebbridgeBinarySha256 直测：未知文件名 fail closed / 匹配通过 / SKIP_PIN 放行
    const bin2 = mkBin();
    fs.mkdirSync(path.dirname(bin2), { recursive: true });
    fs.writeFileSync(bin2, body);
    assert.throws(() => verifyWebbridgeBinarySha256(bin2, "totally-unknown-binary"), /缺少 sha256 钉定/);
    assert.equal(fs.existsSync(bin2), false);
    const bin3 = mkBin();
    fs.writeFileSync(bin3, body);
    verifyWebbridgeBinarySha256(bin3, "any-name", bodySha); // 显式期望 → 通过
    const prev = process.env.KIMI_WEBBRIDGE_SKIP_PIN;
    process.env.KIMI_WEBBRIDGE_SKIP_PIN = "1";
    try {
      const bin4 = mkBin();
      fs.writeFileSync(bin4, body);
      verifyWebbridgeBinarySha256(bin4, "totally-unknown-binary"); // 逃生门 → 放行
      fs.rmSync(bin4, { force: true });
    } finally {
      if (prev === undefined) delete process.env.KIMI_WEBBRIDGE_SKIP_PIN; else process.env.KIMI_WEBBRIDGE_SKIP_PIN = prev;
    }
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("供应链钉定：缓存命中但磁盘哈希不符 → 作废缓存重下并恢复匹配", async () => {
  const body = Buffer.alloc(128, 0x44);
  const bodySha = createHash("sha256").update(body).digest("hex");
  let getCalls = 0;
  const { url, close } = await startCdn(body, '"v1"', () => { getCalls++; });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-cache-"));
  const bin = path.join(dir, "bin/kimi-webbridge");
  try {
    // 首次正常安装（1 次 GET）
    const fresh = await installWebbridge({ dataDir: dir, binaryPath: bin, platform: "darwin", arch: "arm64", cdnBaseUrl: url, expectedSha256: bodySha });
    assert.equal(fresh.installed, true);
    assert.equal(getCalls, 1);
    // 篡改磁盘二进制（manifest 的 ETag 不变，模拟旧版落盘/被篡改场景）
    fs.writeFileSync(bin, Buffer.alloc(128, 0x99));
    // ETag 仍命中 → 复验发现不符 → 作废重下（再 1 次 GET）→ 下载后校验通过
    const repaired = await installWebbridge({ dataDir: dir, binaryPath: bin, platform: "darwin", arch: "arm64", cdnBaseUrl: url, expectedSha256: bodySha });
    assert.equal(repaired.installed, true, "缓存哈希不符必须走重下而非 skipped");
    assert.equal(getCalls, 2);
    assert.equal(fs.statSync(bin).size, body.length);
    assert.equal(sha256File(bin), bodySha);
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

function sha256File(p: string): string {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function setupDeps(over: Partial<WebbridgeSetupTaskDeps> = {}): WebbridgeSetupTaskDeps {
  return {
    installer: async () => ({ installed: true, skipped: false, version: "1", binaryPath: "/x/kimi", etag: null }),
    installExtensions: async () => [{ browserId: "chrome", browserName: "Chrome", result: "installed" }],
    readConfig: () => ({}), writeConfig: () => {}, applyMode: (c, m) => ({ ...c, _m: m }),
    extensionId: EXT, installSkill: async () => ({ success: true, output: "ok" }),
    logger: { info: () => {}, error: () => {} }, ...over,
  };
}

test("runWebbridgeSetupTask: 全 OK → webbridge-ready；installer 抛错 → fell-back-to-openclaw + 改写 config + 通知", async () => {
  const ok = await runWebbridgeSetupTask(setupDeps());
  assert.equal(ok.outcome, "webbridge-ready");
  assert.equal(ok.binaryPath, "/x/kimi");

  const writes: any[] = []; let notified = 0;
  const fb = await runWebbridgeSetupTask(setupDeps({
    installer: async () => { throw new Error("CDN 500"); },
    writeConfig: (c) => writes.push(c),
    onConfigRewritten: () => { notified++; },
  }));
  assert.equal(fb.outcome, "fell-back-to-openclaw");
  assert.match(fb.error ?? "", /CDN 500/);
  assert.equal(writes[0]._m, "openclaw");
  assert.equal(notified, 1);
});

test("runWebbridgeSetupTask: installExtensions 返回 [] / 全 browser-not-installed 都判失败并降级", async () => {
  // 默认浏览器不是 Chrome/Edge，installForDefaultBrowser 返回 [] —— 必须降级
  const empty = await runWebbridgeSetupTask(setupDeps({
    installExtensions: async () => [],
  }));
  assert.equal(empty.outcome, "fell-back-to-openclaw");
  assert.match(empty.error ?? "", /no extension target/);

  // 浏览器探测到了但实际没装上（browser-not-installed） —— 同样降级
  const bni = await runWebbridgeSetupTask(setupDeps({
    installExtensions: async () => [
      { browserId: "chrome", browserName: "Chrome", result: "browser-not-installed" },
    ],
  }));
  assert.equal(bni.outcome, "fell-back-to-openclaw");

  // 带 error 的 summary 即便 result 看起来 OK 也判失败（防御性写法）
  const errored = await runWebbridgeSetupTask(setupDeps({
    installExtensions: async () => [
      { browserId: "chrome", browserName: "Chrome", result: "installed", error: "EACCES" },
    ],
  }));
  assert.equal(errored.outcome, "fell-back-to-openclaw");
});

// 需要真实平台钉定条目（win32/darwin）；其它平台 safeResolveWebbridgePinFilename 返回
// null 会整体跳过校验，测不到这条路径。
const HAS_PIN = process.platform === "win32" || process.platform === "darwin";

test("runWebbridgeSetupTask: repair 既有二进制钉定不符 → 作废并自动重下（一次点击收敛，R66）",
  { skip: !HAS_PIN },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-repair-"));
    const stale = path.join(dir, "kimi-webbridge.exe");
    fs.writeFileSync(stale, Buffer.from("stale-binary-not-matching-pin"));
    let installerCalls = 0;
    const res = await runWebbridgeSetupTask(setupDeps({
      skipBinaryInstall: true,
      existingBinaryPath: stale,
      installer: async () => {
        installerCalls++;
        return { installed: true, skipped: false, version: "1", binaryPath: "/x/kimi-new", etag: null };
      },
    }));
    // 旧行为：直接 fail（用户要点两次才成功）。新行为：作废旧产物 → 重下 → ready。
    assert.equal(installerCalls, 1);
    assert.equal(res.outcome, "webbridge-ready");
    assert.equal(res.binaryPath, "/x/kimi-new");
    assert.equal(fs.existsSync(stale), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

test("runWebbridgeSetupTask: repair 校验不符且重下失败 → 仍降级（确定性失败，不留半成品）",
  { skip: !HAS_PIN },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-repair-"));
    const stale = path.join(dir, "kimi-webbridge.exe");
    fs.writeFileSync(stale, Buffer.from("stale-binary-not-matching-pin"));
    const writes: any[] = [];
    const res = await runWebbridgeSetupTask(setupDeps({
      skipBinaryInstall: true,
      existingBinaryPath: stale,
      fallbackOnFailure: false,
      installer: async () => { throw new Error("CDN 503"); },
      writeConfig: (c) => writes.push(c),
    }));
    assert.equal(res.outcome, "fell-back-to-openclaw");
    assert.match(res.error ?? "", /CDN 503/);
    assert.equal(writes.length, 0); // 调用方决定是否写 config
    fs.rmSync(dir, { recursive: true, force: true });
  });

test("getWebbridgeInstallState: binary 缺 → installed=false；存在 + manifest → version", async () => {
  const base = { binaryPath: "/x", dataDir: "/y", readExtensionStates: async () => [], extensionId: EXT };
  const miss = await getWebbridgeInstallState({ ...base, fileExists: () => false, readManifest: () => null });
  assert.equal(miss.installed, false);
  const ok = await getWebbridgeInstallState({
    ...base, fileExists: () => true,
    readManifest: () => ({ version: "1.2.3", etag: "W/abc", lastModified: null, contentLength: 1 }),
  });
  assert.equal(ok.installed, true); assert.equal(ok.version, "1.2.3");
});

test("installWebbridgeSkill: 调 install-skill -y；exec 抛错 → success=false", async () => {
  const calls: string[][] = [];
  const ok = await installWebbridgeSkill("/bin/kimi", {
    execFileAsync: async (_c, args) => { calls.push(args); return { stdout: "✓ ok", stderr: "" }; },
  });
  assert.equal(ok.success, true);
  assert.deepEqual(calls[0], ["install-skill", "-y"]);
  const fail = await installWebbridgeSkill("/bin/kimi", {
    execFileAsync: async () => { throw new Error("ENOENT"); },
  });
  assert.equal(fail.success, false);
  assert.match(fail.error ?? "", /ENOENT/);
});

test("getWebbridgePrecheck: 全 OK / binary 缺 / 默认浏览器不支持 / webbridge 漂移", async () => {
  const base = {
    binaryPath: "/x", extensionId: "id", skillPaths: ["/s"],
    getDefaultBrowser: async () => ({ target: { id: "chrome", name: "Chrome" } }),
    readExtensionStates: async () => [OK_CHROME],
  };
  assert.equal((await getWebbridgePrecheck({ ...base, fileExists: () => true })).ok, true);
  assert.equal((await getWebbridgePrecheck({ ...base, fileExists: (p) => p === "/s" })).missing.binary, true);
  const noBrowser = await getWebbridgePrecheck({ ...base, fileExists: () => true, getDefaultBrowser: async () => null });
  assert.equal(noBrowser.defaultUnsupported, true);
  assert.equal(noBrowser.missing.extension, true);
  const drift = await getWebbridgePrecheck({
    ...base, fileExists: () => true,
    readSkillEnabled: () => false, currentBrowserMode: "webbridge",
  });
  assert.equal(drift.missing.skill, true, "webbridge 模式下 skill enabled=false 算漂移");
});

// ── R68：可自动更新的远端钉定清单（上游反复重建 latest 的永久修复） ──

test("webbridge-pins：parsePinsJson 严格校验（合法/非法 hex/包裹形态/元数据键）", async () => {
  const { parsePinsJson } = await import("./webbridge-pins");
  const h = "a".repeat(64);
  assert.equal(parsePinsJson(JSON.stringify({ f: { x: 1 } })), null, "值为对象整体丢弃");
  assert.deepEqual(parsePinsJson(JSON.stringify({ f: h })), { f: h });
  assert.deepEqual(parsePinsJson(JSON.stringify({ pins: { f: h }, version: 1, updatedAt: "x" })), { f: h });
  assert.equal(parsePinsJson(JSON.stringify({ f: "zz" })), null, "非法 hex 整体丢弃");
  assert.equal(parsePinsJson(JSON.stringify({ f: 123 })), null, "非字符串整体丢弃");
  assert.equal(parsePinsJson("not json"), null);
  assert.equal(parsePinsJson("[]"), null);
  assert.equal(parsePinsJson("{}"), null, "空清单视为无效");
});

test("webbridge-pins：新鲜缓存不触网；过期缓存拉取失败时回退过期缓存", async () => {
  const { loadRemotePins } = await import("./webbridge-pins");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-pins-"));
  const h = "b".repeat(64);
  let calls = 0;
  const rt = async () => { calls++; return JSON.stringify({ f: h }); };

  // 首次：无缓存 → 拉取并写缓存
  const first = await loadRemotePins({ dataDir: dir, urls: ["https://x/pins.json"], fetchText: rt });
  assert.equal(first.source, "https://x/pins.json");
  assert.deepEqual(first.pins, { f: h });
  assert.equal(calls, 1);

  // 二次：新鲜缓存命中 → 不再拉取
  const second = await loadRemotePins({ dataDir: dir, urls: ["https://x/pins.json"], fetchText: rt });
  assert.equal(second.source, "cache");
  assert.equal(calls, 1, "24h 内不重复触网");

  // 强制刷新但全部 URL 失败 → 回退过期缓存（不返回 null）
  const stale = await loadRemotePins({
    dataDir: dir, forceRefresh: true, urls: ["https://x/pins.json"],
    fetchText: async () => { throw new Error("offline"); },
  });
  assert.equal(stale.source, "stale-cache");
  assert.deepEqual(stale.pins, { f: h });

  // 无缓存 + 全部失败 → null（调用方回退内置表）
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "wb-pins-"));
  const none = await loadRemotePins({
    dataDir: empty, urls: ["https://x/pins.json"],
    fetchText: async () => { throw new Error("offline"); },
  });
  assert.equal(none.pins, null);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});

test("verifyWebbridgeBinarySha256：远端清单命中即放行；都不匹配才 fail closed 并删产物", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-verify-"));
  const bin = path.join(dir, "kimi-webbridge-windows-amd64.exe");
  const body = Buffer.from("rebuilt-by-upstream");
  const actual = createHash("sha256").update(body).digest("hex");

  // 内置表不匹配、远端清单匹配 → 通过（上游重建窗口期）
  fs.writeFileSync(bin, body);
  verifyWebbridgeBinarySha256(bin, "kimi-webbridge-windows-amd64.exe", undefined, {
    "kimi-webbridge-windows-amd64.exe": actual,
  });
  assert.equal(fs.existsSync(bin), true, "远端命中不应删产物");

  // 两者都不匹配 → 抛错并删除
  fs.writeFileSync(bin, body);
  assert.throws(
    () => verifyWebbridgeBinarySha256(bin, "kimi-webbridge-windows-amd64.exe", undefined, {
      "kimi-webbridge-windows-amd64.exe": "c".repeat(64),
    }),
    /sha256 校验失败/,
  );
  assert.equal(fs.existsSync(bin), false, "fail closed 删除产物");
  fs.rmSync(dir, { recursive: true, force: true });
});
