// kernel-prune.js 单元测试：运行时内核升级的树裁剪必须与打包期口径一致，
// 且任何缺失目录/文件都应静默跳过（幂等）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createKernelPrune = require("./lib/kernel-prune");

function makeGateway(t) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-kernel-prune-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  const gatewayDir = path.join(tmpRoot, "gateway");
  const nmDir = path.join(gatewayDir, "node_modules");
  fs.mkdirSync(nmDir, { recursive: true });
  return { gatewayDir, nmDir };
}

function touch(filePath, content = "x") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test("koffi 仅保留目标平台目录", (t) => {
  const { gatewayDir, nmDir } = makeGateway(t);
  const koffiDir = path.join(nmDir, "koffi", "build", "koffi");
  for (const plat of ["win32_x64", "win32_arm64", "darwin_x64", "darwin_arm64", "linux_x64"]) {
    touch(path.join(koffiDir, plat, "koffi.node"));
  }

  const stats = createKernelPrune(fs).pruneGatewayTree(gatewayDir, { platform: "win32", arch: "x64" });

  assert.equal(fs.existsSync(path.join(koffiDir, "win32_x64")), true);
  for (const plat of ["win32_arm64", "darwin_x64", "darwin_arm64", "linux_x64"]) {
    assert.equal(fs.existsSync(path.join(koffiDir, plat)), false, `${plat} 应被删除`);
  }
  assert.ok(stats.removedDirs >= 4);
  assert.ok(stats.bytes > 0);
});

test("ffmpeg/ffprobe 预编译二进制被移除", (t) => {
  const { gatewayDir, nmDir } = makeGateway(t);
  touch(path.join(nmDir, "@ffmpeg-installer", "win32-x64", "ffmpeg.exe"));
  touch(path.join(nmDir, "@ffprobe-installer", "win32-x64", "ffprobe.exe"));

  createKernelPrune(fs).pruneGatewayTree(gatewayDir, { platform: "win32", arch: "x64" });

  assert.equal(fs.existsSync(path.join(nmDir, "@ffmpeg-installer")), false);
  assert.equal(fs.existsSync(path.join(nmDir, "@ffprobe-installer")), false);
});

test("pdf-parse 仅保留语义最新的 pdf.js 版本", (t) => {
  const { gatewayDir, nmDir } = makeGateway(t);
  const pdfJsDir = path.join(nmDir, "pdf-parse", "lib", "pdf.js");
  for (const ver of ["v1.9.426", "v1.10.100", "v1.10.88", "v2.0.1"]) {
    touch(path.join(pdfJsDir, ver, "build", "pdf.js"));
  }

  createKernelPrune(fs).pruneGatewayTree(gatewayDir, { platform: "win32", arch: "x64" });

  assert.equal(fs.existsSync(path.join(pdfJsDir, "v2.0.1")), true);
  assert.equal(fs.existsSync(path.join(pdfJsDir, "v1.10.100")), false);
  assert.equal(fs.existsSync(path.join(pdfJsDir, "v1.10.88")), false);
  assert.equal(fs.existsSync(path.join(pdfJsDir, "v1.9.426")), false);
});

test("prebuilds 仅保留目标平台", (t) => {
  const { gatewayDir, nmDir } = makeGateway(t);
  const prebuilds = path.join(nmDir, "node-pty", "prebuilds");
  for (const plat of ["win32-x64", "darwin-arm64", "linux-x64"]) {
    touch(path.join(prebuilds, plat, "pty.node"));
  }

  createKernelPrune(fs).pruneGatewayTree(gatewayDir, { platform: "win32", arch: "x64" });

  assert.equal(fs.existsSync(path.join(prebuilds, "win32-x64")), true);
  assert.equal(fs.existsSync(path.join(prebuilds, "darwin-arm64")), false);
  assert.equal(fs.existsSync(path.join(prebuilds, "linux-x64")), false);
});

test("嵌套 node_modules 里的非本机平台原生包被移除（@lydell/node-pty-*）", (t) => {
  const { gatewayDir, nmDir } = makeGateway(t);
  const nestedNm = path.join(nmDir, "openclaw", "node_modules");
  for (const plat of ["win32-x64", "win32-arm64", "darwin-arm64", "linux-x64"]) {
    touch(path.join(nestedNm, "@lydell", `node-pty-${plat}`, "pty.node"), "x".repeat(64));
  }
  // 顶层同理也要清
  touch(path.join(nmDir, "sharp-darwin-arm64", "sharp.node"));
  touch(path.join(nmDir, "sharp-win32-x64", "sharp.node"));

  const stats = createKernelPrune(fs).pruneGatewayTree(gatewayDir, { platform: "win32", arch: "x64" });

  assert.equal(fs.existsSync(path.join(nestedNm, "@lydell", "node-pty-win32-x64")), true, "目标平台嵌套包必须保留");
  for (const plat of ["win32-arm64", "darwin-arm64", "linux-x64"]) {
    assert.equal(fs.existsSync(path.join(nestedNm, "@lydell", `node-pty-${plat}`)), false, `${plat} 应被删除`);
  }
  assert.equal(fs.existsSync(path.join(nmDir, "sharp-win32-x64")), true);
  assert.equal(fs.existsSync(path.join(nmDir, "sharp-darwin-arm64")), false);
  assert.ok(stats.bytes >= 64 * 3, "删除字节数应计入统计");
});

test("darwin-universal 原生包：darwin 目标移除 universal，保留精确架构匹配包", (t) => {
  const { gatewayDir, nmDir } = makeGateway(t);
  touch(path.join(nmDir, "clipboard-darwin-universal", "index.js"));
  touch(path.join(nmDir, "clipboard-darwin-arm64", "index.js"));

  // darwin 目标：移除 universal（架构不精确匹配），保留 arm64
  createKernelPrune(fs).pruneGatewayTree(gatewayDir, { platform: "darwin", arch: "arm64" });
  assert.equal(fs.existsSync(path.join(nmDir, "clipboard-darwin-universal")), false);
  assert.equal(fs.existsSync(path.join(nmDir, "clipboard-darwin-arm64")), true);

  // 非 darwin 目标：darwin 平台包整体属于非目标平台，同样移除（与打包期口径一致）
  touch(path.join(nmDir, "clipboard-darwin-universal", "index.js"));
  createKernelPrune(fs).pruneGatewayTree(gatewayDir, { platform: "win32", arch: "x64" });
  assert.equal(fs.existsSync(path.join(nmDir, "clipboard-darwin-universal")), false);
  assert.equal(fs.existsSync(path.join(nmDir, "clipboard-darwin-arm64")), false);
});

test("llama 依赖按 keepLlama 标志决定去留", (t) => {
  const { gatewayDir, nmDir } = makeGateway(t);
  touch(path.join(nmDir, "node-llama-cpp", "dist", "index.js"));
  touch(path.join(nmDir, "@node-llama-cpp", "mac-arm64-metal", "bins", "llama.dll"));

  // keepLlama=true：保留
  createKernelPrune(fs).pruneGatewayTree(gatewayDir, { keepLlama: true });
  assert.equal(fs.existsSync(path.join(nmDir, "node-llama-cpp")), true);
  assert.equal(fs.existsSync(path.join(nmDir, "@node-llama-cpp")), true);

  // keepLlama=false：移除
  createKernelPrune(fs).pruneGatewayTree(gatewayDir, { keepLlama: false });
  assert.equal(fs.existsSync(path.join(nmDir, "node-llama-cpp")), false);
  assert.equal(fs.existsSync(path.join(nmDir, "@node-llama-cpp")), false);
});

test("通用垃圾清理：.map/.d.ts/测试与文档文件、垃圾目录", (t) => {
  const { gatewayDir, nmDir } = makeGateway(t);
  touch(path.join(nmDir, "some-pkg", "dist", "index.js"), "keep");
  touch(path.join(nmDir, "some-pkg", "dist", "index.js.map"));
  touch(path.join(nmDir, "some-pkg", "dist", "index.d.ts"));
  touch(path.join(nmDir, "some-pkg", "dist", "types.d.mts"));
  touch(path.join(nmDir, "some-pkg", "dist", "foo.test.js"));
  touch(path.join(nmDir, "some-pkg", "dist", "bar.spec.mjs"));
  touch(path.join(nmDir, "some-pkg", "README.md"));
  touch(path.join(nmDir, "some-pkg", "CHANGELOG.txt"));
  touch(path.join(nmDir, "some-pkg", "changelog.js"), "keep"); // 非文档扩展，必须保留
  touch(path.join(nmDir, "some-pkg", "tests", "test.js"));
  touch(path.join(nmDir, "some-pkg", "examples", "demo.js"));
  touch(path.join(nmDir, "some-pkg", ".ignored_old", "junk.js"));

  createKernelPrune(fs).pruneGatewayTree(gatewayDir, { platform: "win32", arch: "x64" });

  const keep = (p) => assert.equal(fs.existsSync(p), true, `${p} 应保留`);
  const gone = (p) => assert.equal(fs.existsSync(p), false, `${p} 应删除`);

  keep(path.join(nmDir, "some-pkg", "dist", "index.js"));
  keep(path.join(nmDir, "some-pkg", "changelog.js"));
  gone(path.join(nmDir, "some-pkg", "dist", "index.js.map"));
  gone(path.join(nmDir, "some-pkg", "dist", "index.d.ts"));
  gone(path.join(nmDir, "some-pkg", "dist", "types.d.mts"));
  gone(path.join(nmDir, "some-pkg", "dist", "foo.test.js"));
  gone(path.join(nmDir, "some-pkg", "dist", "bar.spec.mjs"));
  gone(path.join(nmDir, "some-pkg", "README.md"));
  gone(path.join(nmDir, "some-pkg", "CHANGELOG.txt"));
  gone(path.join(nmDir, "some-pkg", "tests"));
  gone(path.join(nmDir, "some-pkg", "examples"));
  gone(path.join(nmDir, "some-pkg", ".ignored_old"));
});

test("openclaw/docs 整目录豁免（保留运行时模板）", (t) => {
  const { gatewayDir, nmDir } = makeGateway(t);
  touch(path.join(nmDir, "openclaw", "docs", "reference", "templates", "BOOTSTRAP.md"));
  touch(path.join(nmDir, "openclaw", "docs", "guide.md"));
  touch(path.join(nmDir, "openclaw", "dist", "chunk.js.map"));

  createKernelPrune(fs).pruneGatewayTree(gatewayDir, { platform: "win32", arch: "x64" });

  assert.equal(fs.existsSync(path.join(nmDir, "openclaw", "docs", "reference", "templates", "BOOTSTRAP.md")), true);
  assert.equal(fs.existsSync(path.join(nmDir, "openclaw", "docs", "guide.md")), true);
  // openclaw 包内部的 .map 仍会被清理（只有 docs 目录豁免）
  assert.equal(fs.existsSync(path.join(nmDir, "openclaw", "dist", "chunk.js.map")), false);
});

test("node_modules 缺失时返回零统计且不抛错", (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-kernel-prune-empty-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const stats = createKernelPrune(fs).pruneGatewayTree(path.join(tmpRoot, "gateway"));

  assert.deepEqual(stats, { removedDirs: 0, removedFiles: 0, bytes: 0, errors: [] });
});

test("裁剪幂等：重复执行结果一致", (t) => {
  const { gatewayDir, nmDir } = makeGateway(t);
  touch(path.join(nmDir, "koffi", "build", "koffi", "linux_x64", "koffi.node"));
  touch(path.join(nmDir, "pkg", "index.js.map"));

  const prune = createKernelPrune(fs);
  const first = prune.pruneGatewayTree(gatewayDir, { platform: "win32", arch: "x64" });
  const second = prune.pruneGatewayTree(gatewayDir, { platform: "win32", arch: "x64" });

  assert.ok(first.bytes > 0);
  assert.equal(second.bytes, 0);
  assert.equal(second.removedDirs, 0);
  assert.equal(second.removedFiles, 0);
});
