// webbridge-extension-update.test.ts — 浏览器扩展运行时更新管线（schema v3）：
// CRX 解析、版本比较、运行时 spec 采纳、apply 管线（钉定/错版/落盘/重指）。
// node:test（与 webbridge.test.ts 同框架；经 tsconfig.test.json 编译到 .test-dist 运行）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { zipSync } from "fflate";
import {
  compareExtensionVersions,
  parseCrxManifestVersion,
  readRuntimeExtensionSpec,
  applyWebbridgeExtensionUpdate,
  resolveRuntimeExtensionDir,
} from "./webbridge-extension-update";
import { parseExtensionBlock, extensionCrxUrls } from "./webbridge-pins";

const EXT_ID = "fldmhceldgbpfpkbgopacenieobmligc";
const h = (ch: string) => ch.repeat(64);

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 造一个最小合法 CRX3：Cr24 头 + 假 header + zip(manifest.json)。 */
function buildCrx3(version: string): Buffer {
  const zip = Buffer.from(
    zipSync({ "manifest.json": Buffer.from(JSON.stringify({ manifest_version: 3, version })) }),
  );
  const fakeHeader = Buffer.alloc(8, 0xab); // 假 protobuf header（解析器跳过即可）
  const head = Buffer.alloc(12);
  head.write("Cr24", 0, "latin1");
  head.writeUInt32LE(3, 4);
  head.writeUInt32LE(fakeHeader.length, 8);
  return Buffer.concat([head, fakeHeader, zip]);
}

// ── parseCrxManifestVersion ──

test("parseCrxManifestVersion：CRX3 提取内嵌 version", () => {
  const crx = buildCrx3("1.9.0");
  assert.equal(parseCrxManifestVersion(crx), "1.9.0");
});

test("parseCrxManifestVersion：非 CRX / 截断 / 无 manifest → null", () => {
  assert.equal(parseCrxManifestVersion(Buffer.from("not a crx at all.....")), null);
  assert.equal(parseCrxManifestVersion(buildCrx3("1.0.0").subarray(0, 20)), null);
  const noManifest = Buffer.from(zipSync({ "other.txt": Buffer.from("x") }));
  const head = Buffer.alloc(12);
  head.write("Cr24", 0, "latin1");
  head.writeUInt32LE(3, 4);
  head.writeUInt32LE(0, 8);
  assert.equal(parseCrxManifestVersion(Buffer.concat([head, noManifest])), null);
});

// ── compareExtensionVersions ──

test("compareExtensionVersions：数字段比较", () => {
  assert.equal(compareExtensionVersions("1.9.0", "1.8.4"), 1);
  assert.equal(compareExtensionVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareExtensionVersions("1.8.4", "1.8.4"), 0);
  assert.equal(compareExtensionVersions("1.8", "1.8.0"), 0);
  assert.equal(compareExtensionVersions("2.0.0", "10.0.0"), -1);
});

// ── parseExtensionBlock（pins v3）──

test("parseExtensionBlock：合法块解析；非法形态整体 null", () => {
  const good = {
    extension: {
      id: EXT_ID,
      version: "1.9.0",
      file: "resources/webbridge/extension/kimi-webbridge-1.9.0.crx",
      sha256: [h("a")],
      minDaemonVersion: "2.0.0",
    },
  };
  assert.deepEqual(parseExtensionBlock(JSON.stringify(good)), {
    id: EXT_ID,
    version: "1.9.0",
    file: "resources/webbridge/extension/kimi-webbridge-1.9.0.crx",
    sha256: [h("a")],
    minDaemonVersion: "2.0.0",
  });
  // id 非 Chrome 字母表 / version 非数字段 / file 越出镜像目录 / sha 非法 → null
  assert.equal(parseExtensionBlock(JSON.stringify({ extension: { ...good.extension, id: "XYZ" } })), null);
  assert.equal(parseExtensionBlock(JSON.stringify({ extension: { ...good.extension, version: "v1.9-beta" } })), null);
  assert.equal(
    parseExtensionBlock(JSON.stringify({ extension: { ...good.extension, file: "../../evil.crx" } })),
    null,
  );
  assert.equal(parseExtensionBlock(JSON.stringify({ extension: { ...good.extension, sha256: ["zz"] } })), null);
  assert.equal(parseExtensionBlock(JSON.stringify({ pins: {} })), null);
});

test("extensionCrxUrls：由清单 URL 同基址推导 CRX URL", () => {
  assert.equal(
    extensionCrxUrls(
      "https://cdn.jsdelivr.net/gh/binchen6/CryoClaw@main/resources/webbridge-pins.json",
      "resources/webbridge/extension/kimi-webbridge-1.9.0.crx",
    ),
    "https://cdn.jsdelivr.net/gh/binchen6/CryoClaw@main/resources/webbridge/extension/kimi-webbridge-1.9.0.crx",
  );
});

// ── readRuntimeExtensionSpec ──

test("readRuntimeExtensionSpec：指针+文件+id 一致才采纳；任缺即 null", () => {
  const dir = mkTempDir("wb-ext-spec-");
  assert.equal(readRuntimeExtensionSpec(dir, EXT_ID), null); // 无指针

  const extDir = resolveRuntimeExtensionDir(dir);
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, "kimi-webbridge-1.9.0.crx"), buildCrx3("1.9.0"));
  fs.writeFileSync(
    path.join(extDir, "current.json"),
    JSON.stringify({ extensionId: EXT_ID, version: "1.9.0", file: "kimi-webbridge-1.9.0.crx" }),
  );
  const spec = readRuntimeExtensionSpec(dir, EXT_ID);
  assert.equal(spec?.crxVersion, "1.9.0");
  assert.ok(spec?.crxPath.endsWith("kimi-webbridge-1.9.0.crx"));

  // id 不一致 → null（伪造/串台拒绝）
  assert.equal(readRuntimeExtensionSpec(dir, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), null);
  // 指针指向不存在的文件 → null
  fs.writeFileSync(
    path.join(extDir, "current.json"),
    JSON.stringify({ extensionId: EXT_ID, version: "9.9.9", file: "missing.crx" }),
  );
  assert.equal(readRuntimeExtensionSpec(dir, EXT_ID), null);
  // 目录穿越 → null
  fs.writeFileSync(
    path.join(extDir, "current.json"),
    JSON.stringify({ extensionId: EXT_ID, version: "1.9.0", file: "../evil.crx" }),
  );
  assert.equal(readRuntimeExtensionSpec(dir, EXT_ID), null);
});

// ── applyWebbridgeExtensionUpdate ──

function pinFor(crx: Buffer, version: string) {
  return {
    id: EXT_ID,
    version,
    file: `resources/webbridge/extension/kimi-webbridge-${version}.crx`,
    sha256: [createHash("sha256").update(crx).digest("hex")],
    minDaemonVersion: null,
  };
}

test("apply：下载→钉定→落盘→指针→重指 全链路；版本不再更新时 no-update", async () => {
  const dir = mkTempDir("wb-ext-apply-");
  const crx = buildCrx3("1.9.0");
  const pin = pinFor(crx, "1.9.0");
  const repointed: string[] = [];
  // 测试环境无内置 sidecar（electron 不在）——用注入的 currentSpec 模拟真实生效版本
  const currentSpec = () => readRuntimeExtensionSpec(dir, EXT_ID);

  const result = await applyWebbridgeExtensionUpdate({
    dataDir: dir,
    currentSpecProvider: currentSpec,
    extensionPinProvider: async () => ({ extension: pin, source: "test" }),
    downloadCrx: async (_urls, dest) => {
      fs.writeFileSync(dest, crx);
    },
    repointBrowsers: async () => {
      repointed.push("chrome");
      return repointed;
    },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.to, "1.9.0");
    assert.deepEqual(result.browsersRepointed, ["chrome"]);
  }
  // 落盘 + 指针
  const spec = readRuntimeExtensionSpec(dir, EXT_ID);
  assert.equal(spec?.crxVersion, "1.9.0");
  assert.ok(fs.existsSync(spec!.crxPath));

  // 第二次：清单版本 == 当前版本 → no-update
  const again = await applyWebbridgeExtensionUpdate({
    dataDir: dir,
    currentSpecProvider: currentSpec,
    extensionPinProvider: async () => ({ extension: pin, source: "test" }),
    downloadCrx: async () => {
      throw new Error("不应走到下载");
    },
    repointBrowsers: async () => [],
  });
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.reason, "no-update");
});

test("apply：sha256 不命中 → pin-stale，旧扩展不动", async () => {
  const dir = mkTempDir("wb-ext-pin-");
  const crx = buildCrx3("1.9.0");
  const badPin = { ...pinFor(crx, "1.9.0"), sha256: [h("f")] };
  const result = await applyWebbridgeExtensionUpdate({
    dataDir: dir,
    extensionPinProvider: async () => ({ extension: badPin, source: "test" }),
    downloadCrx: async (_urls, dest) => {
      fs.writeFileSync(dest, crx);
    },
    repointBrowsers: async () => [],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "pin-stale");
  assert.equal(readRuntimeExtensionSpec(dir, EXT_ID), null);
});

test("apply：CRX 内嵌 version ≠ 清单宣告 → crx-invalid", async () => {
  const dir = mkTempDir("wb-ext-badcrx-");
  const crx = buildCrx3("1.8.0"); // 内嵌 1.8.0
  const pin = pinFor(crx, "1.9.0"); // 清单宣告 1.9.0
  const result = await applyWebbridgeExtensionUpdate({
    dataDir: dir,
    extensionPinProvider: async () => ({ extension: pin, source: "test" }),
    downloadCrx: async (_urls, dest) => {
      fs.writeFileSync(dest, crx);
    },
    repointBrowsers: async () => [],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "crx-invalid");
  assert.equal(readRuntimeExtensionSpec(dir, EXT_ID), null);
});

test("apply：清单无扩展信息 → manifest-unavailable", async () => {
  const dir = mkTempDir("wb-ext-nomf-");
  const result = await applyWebbridgeExtensionUpdate({
    dataDir: dir,
    extensionPinProvider: async () => ({ extension: null, source: null }),
    repointBrowsers: async () => [],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "manifest-unavailable");
});
