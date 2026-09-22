// file-read-base64.test.ts — file:read-base64 的纯函数部分 + 主进程/preload 接线审计
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FILE_READ_MAX_BYTES,
  evaluateFileReadTarget,
  isAbsoluteFilePath,
  isCredentialPathDenied,
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

// ── 凭据路径 denylist（P0-9：渲染层 XSS 时 file:read-base64 是文件外带原语）──

const DENY_STATE = join("/home", "u", ".openclaw");
const DENY_HOME = join("/home", "u");

test("isCredentialPathDenied: 状态目录凭据路径命中（credentials/ 整目录 + 敏感文件 + *.log）", () => {
  assert.equal(isCredentialPathDenied(join(DENY_STATE, "credentials", "kimi-oauth-token.json"), DENY_STATE, DENY_HOME), true);
  assert.equal(isCredentialPathDenied(join(DENY_STATE, "credentials"), DENY_STATE, DENY_HOME), true, "credentials 目录本身也拒绝");
  assert.equal(isCredentialPathDenied(join(DENY_STATE, "openclaw.json"), DENY_STATE, DENY_HOME), true);
  assert.equal(isCredentialPathDenied(join(DENY_STATE, "cryoclaw.config.json"), DENY_STATE, DENY_HOME), true);
  assert.equal(isCredentialPathDenied(join(DENY_STATE, "logs", "gateway.log"), DENY_STATE, DENY_HOME), true, "状态目录内 *.log 拒绝");
  // 状态目录内非凭据文件放行（workspace 附件等正常场景）
  assert.equal(isCredentialPathDenied(join(DENY_STATE, "workspace", "附件.png"), DENY_STATE, DENY_HOME), false);
  assert.equal(isCredentialPathDenied(join(DENY_STATE, "workspace", "notes", "a.md"), DENY_STATE, DENY_HOME), false);
  // 精确匹配：不在清单内的相邻文件名不得误伤
  assert.equal(isCredentialPathDenied(join(DENY_STATE, "openclaw.last-known-good.json"), DENY_STATE, DENY_HOME), false);
  assert.equal(isCredentialPathDenied(join(DENY_STATE, "credentials-backup", "x.json"), DENY_STATE, DENY_HOME), false, "credentials-backup 不是 credentials/");
});

test("isCredentialPathDenied: 主目录常见凭据目录命中（.ssh/ .aws/ .gnupg/ 整目录）", () => {
  assert.equal(isCredentialPathDenied(join(DENY_HOME, ".ssh", "id_rsa"), DENY_STATE, DENY_HOME), true);
  assert.equal(isCredentialPathDenied(join(DENY_HOME, ".ssh"), DENY_STATE, DENY_HOME), true);
  assert.equal(isCredentialPathDenied(join(DENY_HOME, ".aws", "credentials"), DENY_STATE, DENY_HOME), true);
  assert.equal(isCredentialPathDenied(join(DENY_HOME, ".gnupg", "pubring.kbx"), DENY_STATE, DENY_HOME), true);
  // 前缀相似但不同的目录不得误伤
  assert.equal(isCredentialPathDenied(join(DENY_HOME, ".ssh-backup", "id_rsa"), DENY_STATE, DENY_HOME), false);
  assert.equal(isCredentialPathDenied(join(DENY_HOME, "Documents", "key.txt"), DENY_STATE, DENY_HOME), false);
  // 无关路径 + 其他用户主目录放行
  assert.equal(isCredentialPathDenied("/opt/data/report.csv", DENY_STATE, DENY_HOME), false);
  assert.equal(isCredentialPathDenied(join("/home", "other", ".ssh", "id_rsa"), DENY_STATE, DENY_HOME), false);
});

test("isCredentialPathDenied: 大小写归一（win32/darwin 大小写不敏感，其他平台区分大小写）", () => {
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  // /HOME/U/.SSH/ID_RSA 与 /HOME/U/.OPENCLAW/CREDENTIALS/X 是同一路径的纯大小写变体
  assert.equal(
    isCredentialPathDenied("/HOME/U/.SSH/ID_RSA", "/HOME/U/.OPENCLAW", "/HOME/U"),
    caseInsensitive,
    `平台 ${process.platform} 上大小写变体应${caseInsensitive ? "命中（归一后相等）" : "放行（大小写敏感文件系统）"}`,
  );
  assert.equal(
    isCredentialPathDenied("/HOME/U/.OPENCLAW/CREDENTIALS/X.JSON", "/HOME/U/.OPENCLAW", "/HOME/U"),
    caseInsensitive,
  );
});

test("evaluateFileReadTarget: denylist 接线（OPENCLAW_STATE_DIR 指临时目录，凭据拒绝/附件放行）", () => {
  const dir = mkdtempSync(join(tmpdir(), "claw-deny-test-"));
  const prev = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = dir;
  try {
    assert.deepEqual(
      evaluateFileReadTarget(join(dir, "credentials", "kimi-oauth-token.json"), { isFile: true, size: 10 }),
      { ok: false, error: "denied" },
    );
    assert.deepEqual(
      evaluateFileReadTarget(join(dir, "openclaw.json"), { isFile: true, size: 10 }),
      { ok: false, error: "denied" },
    );
    assert.deepEqual(
      evaluateFileReadTarget(join(dir, "cryoclaw.config.json"), { isFile: true, size: 10 }),
      { ok: false, error: "denied" },
    );
    assert.deepEqual(
      evaluateFileReadTarget(join(dir, "logs", "app.log"), { isFile: true, size: 10 }),
      { ok: false, error: "denied" },
    );
    // 凭据文件不存在同样拒绝（denylist 先于存在性检查，不存在的敏感路径也是探测目标）
    assert.deepEqual(
      evaluateFileReadTarget(join(dir, "credentials", "missing.json"), null),
      { ok: false, error: "denied" },
    );
    // workspace 下正常附件放行
    assert.deepEqual(
      evaluateFileReadTarget(join(dir, "workspace", "report.docx"), { isFile: true, size: 10 }),
      { ok: true },
    );
  } finally {
    if (prev === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
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
