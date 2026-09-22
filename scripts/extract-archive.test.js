// extract-archive.test.js — zip 解压条目类型判定的回归护栏（审计缺陷 F16）：
// 旧启发式把「无扩展名的空文件」误判为目录（内容丢失 + 后续 EISDIR），
// 修复后目录判定只认尾斜杠。fixture 用 fflate zipSync 手工构造。
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { zipSync } = require("fflate");
const { extractZipArchive } = require("./lib/extract-archive");

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "extract-archive-test-"));
}

function writeZip(dir, entries) {
  const zipPath = path.join(dir, "fixture.zip");
  // zipSync 输入形态：{ "路径": Uint8Array 内容 }；"dir/" 空数组即目录条目
  const data = {};
  for (const [name, content] of Object.entries(entries)) {
    data[name] = content == null ? new Uint8Array(0) : content;
  }
  fs.writeFileSync(zipPath, zipSync(data));
  return zipPath;
}

test("zip: 无扩展名的空文件解出为文件而非目录", () => {
  const dir = makeTmpDir();
  const dest = path.join(dir, "out");
  fs.mkdirSync(dest);
  const zipPath = writeZip(dir, {
    "LICENSE": null, // 空文件、无扩展名——旧启发式会建成目录
    "bin/foo": null,
  });

  extractZipArchive(zipPath, dest);

  const license = path.join(dest, "LICENSE");
  const foo = path.join(dest, "bin", "foo");
  assert.ok(fs.statSync(license).isFile(), "LICENSE 必须是文件");
  assert.ok(fs.statSync(foo).isFile(), "bin/foo 必须是文件");
  assert.equal(fs.readFileSync(license, "utf-8"), "");
});

test("zip: 带扩展名的空文件不受影响（回归）", () => {
  const dir = makeTmpDir();
  const dest = path.join(dir, "out");
  fs.mkdirSync(dest);
  const zipPath = writeZip(dir, { "empty.txt": null });

  extractZipArchive(zipPath, dest);

  assert.ok(fs.statSync(path.join(dest, "empty.txt")).isFile());
});

test("zip: 目录条目仍解为目录（回归）", () => {
  const dir = makeTmpDir();
  const dest = path.join(dir, "out");
  fs.mkdirSync(dest);
  const zipPath = writeZip(dir, {
    "pkg/": null,
    "pkg/index.js": new Uint8Array([109, 111, 100, 117, 108, 101]),
  });

  extractZipArchive(zipPath, dest);

  assert.ok(fs.statSync(path.join(dest, "pkg")).isDirectory(), "pkg/ 必须是目录");
  assert.equal(fs.readFileSync(path.join(dest, "pkg", "index.js"), "utf-8"), "module");
});

test("zip: 正常文件内容完整解出（回归）", () => {
  const dir = makeTmpDir();
  const dest = path.join(dir, "out");
  fs.mkdirSync(dest);
  const content = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
  const zipPath = writeZip(dir, { "README": content, "docs/guide.md": content });

  extractZipArchive(zipPath, dest);

  assert.equal(fs.readFileSync(path.join(dest, "README"), "utf-8"), "hello");
  assert.equal(fs.readFileSync(path.join(dest, "docs", "guide.md"), "utf-8"), "hello");
});
