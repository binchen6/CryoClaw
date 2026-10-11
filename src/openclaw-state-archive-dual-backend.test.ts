// 双 backend 同测：同构的 .openclaw 夹具分别经纯 JS（fflate）与 Rust sidecar
// 导出/校验/解压，互相交叉验证，断言清单级等价（entry 名 + CRC32 + 未压缩
// 长度 + 解压后内容字节）与两侧对损坏归档的一致拒绝。
//
// Rust backend 不可用时（未 cargo build）整体 skip——纯 JS 行为由
// openclaw-state-archive.test.ts 等契约测试覆盖，sidecar 缺失时行为 = 现状
// 由 archive-backend.test.ts 的禁用开关用例显式覆盖。
import test from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { probeArchiveTool, resetArchiveToolProbeForTests, resolveArchiveToolCandidates } from "./archive-backend.ts";
import { exportOpenclawStateToArchive, validateOpenclawStateArchive } from "./openclaw-state-archive.ts";
import { readArchive, readArchiveWithJs, readCentralEntriesForTests } from "./openclaw-state-archive-zip.ts";

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

function findRustBinary(): string | null {
  for (const candidate of resolveArchiveToolCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function forceBackend(mode: "rust" | "js", rustBin: string | null) {
  if (mode === "rust") {
    assert.ok(rustBin, "forceBackend('rust') 需要已构建的 sidecar 二进制");
    delete process.env.CRYOCLAW_ARCHIVE_TOOL;
    process.env.CRYOCLAW_ARCHIVE_TOOL_BIN = rustBin;
  } else {
    process.env.CRYOCLAW_ARCHIVE_TOOL = "off";
  }
  resetArchiveToolProbeForTests();
}

// 夹具：嵌套目录 + unicode 名称 + 空文件 + 伪随机二进制（确定性，两侧同构）+
// 空目录 + 大可压缩文件
function buildFixtureStateDir(root: string): void {
  fs.mkdirSync(path.join(root, "sessions", "2026-10", "子目录"), { recursive: true });
  fs.mkdirSync(path.join(root, "empty-dir"), { recursive: true });
  fs.mkdirSync(path.join(root, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(root, "openclaw.json"), JSON.stringify({ gateway: { port: 18789 }, 名称: "值" }));
  fs.writeFileSync(path.join(root, "sessions", "2026-10", "a.json"), JSON.stringify({ role: "user", text: "你好，世界".repeat(64) }));
  // 确定性伪随机：sha256 计数器流（randomBytes 每次不同，清单 CRC 无法跨 backend 比对）
  const randBlocks: Buffer[] = [];
  for (let i = 0; i < 1024; i++) {
    randBlocks.push(crypto.createHash("sha256").update(String(i)).digest());
  }
  fs.writeFileSync(path.join(root, "sessions", "2026-10", "子目录", "b.bin"), Buffer.concat(randBlocks));
  fs.writeFileSync(path.join(root, "zero.txt"), "");
  fs.writeFileSync(path.join(root, "workspace", "big.log"), "line-of-logs abcdefg\n".repeat(128 * 1024));
}

// entry 名 + CRC32 + 未压缩长度（排序后比对；zip 内条目物理顺序两侧允许不同，
// 读取器按 central directory 语义工作，不依赖物理序）
function manifestDetailed(zipPath: string, stateDir: string) {
  return readCentralEntriesForTests(zipPath, stateDir)
    .map((entry) => ({ name: entry.name, crc32: entry.crc32, size: entry.uncompressedSize }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// 递归比对两目录内容字节（含空目录的存在性）
function compareTrees(expected: string, actual: string): void {
  const walk = (dir: string, rel: string, acc: Map<string, Buffer | "dir">) => {
    for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${child.name}` : child.name;
      const full = path.join(dir, child.name);
      if (child.isDirectory()) {
        acc.set(`${childRel}/`, "dir");
        walk(full, childRel, acc);
      } else if (child.isFile()) {
        acc.set(childRel, fs.readFileSync(full));
      }
    }
    return acc;
  };
  const expectedMap = walk(expected, "", new Map());
  const actualMap = walk(actual, "", new Map());
  // 归档 marker 是导出期注入的条目：完整导入流程（importOpenclawStateFromArchive）
  // 会删除它，但本测试直接调 readArchive 解压，比对时跳过
  actualMap.delete(".oneclaw-openclaw-state-archive");
  assert.deepEqual([...actualMap.keys()].sort(), [...expectedMap.keys()].sort());
  for (const [name, content] of expectedMap) {
    if (content === "dir") continue;
    const actualContent = actualMap.get(name);
    assert.ok(actualContent instanceof Buffer, `missing file: ${name}`);
    assert.deepEqual(actualContent, content, `content mismatch: ${name}`);
  }
}

test("双 backend：JS/Rust 产物互相校验且清单级等价", async (t) => {
  const rustBin = findRustBinary();
  if (!rustBin) {
    t.skip("Rust backend 未构建（cargo build --release 后重跑）；纯 JS 行为由 openclaw-state-archive.test.ts 契约测试覆盖");
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-dual-backend-"));
  const stateJs = path.join(tmpRoot, "state-js");
  const stateRust = path.join(tmpRoot, "state-rust");
  const stateJsOut = path.join(tmpRoot, "state-js-out");
  const stateRustOut = path.join(tmpRoot, "state-rust-out");
  try {
    buildFixtureStateDir(stateJs);
    buildFixtureStateDir(stateRust);

    const zipJs = path.join(tmpRoot, "export-js.zip");
    const zipRust = path.join(tmpRoot, "export-rust.zip");

    // 两侧各自导出（JS 侧显式禁用 sidecar，与环境无关）
    forceBackend("js", rustBin);
    await exportOpenclawStateToArchive(stateJs, zipJs);
    forceBackend("rust", rustBin);
    assert.ok(await probeArchiveTool(), "CRYOCLAW_ARCHIVE_TOOL_BIN 已指向产物，探测必须成功");
    await exportOpenclawStateToArchive(stateRust, zipRust);

    // 1) 交叉校验：Rust 产物被纯 JS 读取器完整校验；JS 产物经分发器走 Rust backend 校验
    await readArchiveWithJs(zipRust, stateJs, undefined, new Set());
    const rustReadsJs = await readArchive(zipJs, stateRust, undefined, new Set());
    assert.ok(rustReadsJs.entryNames.length > 0);

    // 2) 清单级等价：entry 名 + CRC32 + 未压缩长度逐一相等
    assert.deepEqual(manifestDetailed(zipRust, stateRust), manifestDetailed(zipJs, stateJs));

    // 3) 解压等价：Rust 解 JS 产物、JS 解 Rust 产物，树内容字节相等
    fs.mkdirSync(stateJsOut, { recursive: true });
    await readArchive(zipJs, stateJsOut, stateJsOut); // dispatcher → Rust
    compareTrees(stateJs, stateJsOut);
    fs.mkdirSync(stateRustOut, { recursive: true });
    await readArchiveWithJs(zipRust, stateRustOut, stateRustOut);
    compareTrees(stateRust, stateRustOut);

    // 4) validate 路径（capture marker + openclaw.json）两侧都通过
    forceBackend("rust", rustBin);
    await validateOpenclawStateArchive(zipJs, stateJs);
    forceBackend("js", rustBin);
    await validateOpenclawStateArchive(zipRust, stateRust);
  } finally {
    restoreEnv();
    resetArchiveToolProbeForTests();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("双 backend：CRC 损坏归档两侧都拒绝", async (t) => {
  const rustBin = findRustBinary();
  if (!rustBin) {
    t.skip("Rust backend 未构建；损坏拒绝行为由契约测试的 JS 路径覆盖");
    return;
  }
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-dual-corrupt-"));
  try {
    const stateDir = path.join(tmpRoot, "state");
    buildFixtureStateDir(stateDir);
    const zipPath = path.join(tmpRoot, "export.zip");
    forceBackend("js", rustBin);
    await exportOpenclawStateToArchive(stateDir, zipPath);

    // 翻转数据区中段的一个字节（避开 local header 与 EOCD 区域）
    const buf = fs.readFileSync(zipPath);
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    fs.writeFileSync(zipPath, buf);

    // Rust backend 拒绝后由分发器静默回退 JS 重跑——最终必然拒绝，
    // 错误文案由 JS 权威产生（这正是回退语义的断言点）
    forceBackend("rust", rustBin);
    await assert.rejects(() => readArchive(zipPath, stateDir, undefined, new Set()));
    forceBackend("js", rustBin);
    await assert.rejects(() => readArchiveWithJs(zipPath, stateDir, undefined, new Set()));
  } finally {
    restoreEnv();
    resetArchiveToolProbeForTests();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
