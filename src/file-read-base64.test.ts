// file-read-base64.test.ts — file:read-base64 的纯函数部分 + 主进程/preload 接线审计
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FILE_READ_MAX_BYTES,
  evaluateFileReadTarget,
  isAbsoluteFilePath,
  mimeTypeForPath,
} from "./file-read-base64";

test("mimeTypeForPath: 常见扩展名映射", () => {
  assert.equal(mimeTypeForPath("/tmp/a.pdf"), "application/pdf");
  assert.equal(mimeTypeForPath("C:\\docs\\报告.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(mimeTypeForPath("/tmp/a.xlsx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(mimeTypeForPath("/tmp/a.PNG"), "image/png", "扩展名大小写不敏感");
  assert.equal(mimeTypeForPath("/tmp/a.md"), "text/markdown");
  assert.equal(mimeTypeForPath("/tmp/a.json"), "application/json");
  assert.equal(mimeTypeForPath("/tmp/a.zip"), "application/zip");
  assert.equal(mimeTypeForPath("/tmp/a.7z"), "application/x-7z-compressed");
});

test("mimeTypeForPath: 未知/无扩展名兜底 octet-stream", () => {
  assert.equal(mimeTypeForPath("/tmp/a.xyz123"), "application/octet-stream");
  assert.equal(mimeTypeForPath("/tmp/noext"), "application/octet-stream");
  assert.equal(mimeTypeForPath("C:\\tmp\\"), "application/octet-stream");
});

test("isAbsoluteFilePath: POSIX / Windows 盘符 / UNC / 相对路径", () => {
  assert.equal(isAbsoluteFilePath("/Users/u/a.txt"), true);
  assert.equal(isAbsoluteFilePath("C:\\Users\\u\\a.txt"), true);
  assert.equal(isAbsoluteFilePath("c:/Users/u/a.txt"), true);
  assert.equal(isAbsoluteFilePath("\\\\server\\share\\a.txt"), true);
  assert.equal(isAbsoluteFilePath("a.txt"), false);
  assert.equal(isAbsoluteFilePath("./a.txt"), false);
  assert.equal(isAbsoluteFilePath("~/.openclaw/a.txt"), false, "~ 开头不算绝对路径");
});

test("evaluateFileReadTarget: 参数校验分支", () => {
  assert.deepEqual(evaluateFileReadTarget(undefined, null), { ok: false, error: "invalid-path" });
  assert.deepEqual(evaluateFileReadTarget("", null), { ok: false, error: "invalid-path" });
  assert.deepEqual(evaluateFileReadTarget("relative/a.txt", { isFile: true, size: 1 }), { ok: false, error: "invalid-path" });
  assert.deepEqual(evaluateFileReadTarget("/tmp/missing.txt", null), { ok: false, error: "not-found" });
  assert.deepEqual(evaluateFileReadTarget("/tmp/dir", { isFile: false, size: 0 }), { ok: false, error: "not-file" });
});

test("evaluateFileReadTarget: 大小上限分支（超限返回 too-large 而非 throw）", () => {
  assert.deepEqual(evaluateFileReadTarget("/tmp/big.bin", { isFile: true, size: FILE_READ_MAX_BYTES + 1 }), {
    ok: false,
    error: "too-large",
    size: FILE_READ_MAX_BYTES + 1,
  });
  assert.deepEqual(evaluateFileReadTarget("/tmp/ok.bin", { isFile: true, size: FILE_READ_MAX_BYTES }), { ok: true });
  assert.deepEqual(evaluateFileReadTarget("/tmp/empty.bin", { isFile: true, size: 0 }), { ok: true });
});

// 接线审计（main.ts 依赖 electron 不可在 node 下导入，钉源码不变量）
// 编译产物位于 .test-dist/（CJS），源文件位于 src/
function rootSrc(rel: string): string {
  return readFileSync(join(__dirname, "..", "src", rel), "utf8");
}

test("main.ts: file:read-base64 handler 走可信校验 + 纯函数判定", () => {
  const s = rootSrc("main.ts");
  assert.match(s, /ipcMain\.handle\("file:read-base64"/, "缺少 file:read-base64 handler");
  assert.match(s, /assertTrustedIpcSender\(event, "file:read-base64"\)/, "缺少可信 sender 校验");
  assert.match(s, /evaluateFileReadTarget\(/, "应复用纯函数做参数/大小判定");
  assert.match(s, /mimeTypeForPath\(/, "应复用 mime 映射");
});

test("preload.ts: 暴露 readFileBase64 桥", () => {
  const s = rootSrc("preload.ts");
  assert.match(s, /readFileBase64:\s*\(path:\s*string\)/, "preload 应暴露 readFileBase64(path)");
  assert.match(s, /invoke\("file:read-base64",\s*path\)/, "应 invoke file:read-base64 通道");
});
