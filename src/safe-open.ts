/**
 * shell.openPath 安全打开扩展名白名单（main.ts app:open-path 与
 * workspace-ipc.ts workspace:open-file 共用）。
 */

// 安全面：shell.openPath 会用系统默认程序打开任意文件，可执行文件会被直接运行。
// 仅允许明确的"安全打开"扩展名（文档/图片/媒体），拒绝可执行文件与其他未明确允许的类型。
export const SAFE_OPEN_EXTS = new Set([
  // 图片
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tiff",
  // 文档
  "pdf", "txt", "md", "markdown", "json", "csv", "tsv", "log",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf",
  // 音视频
  "mp3", "wav", "flac", "aac", "ogg", "m4a",
  "mp4", "mkv", "webm", "avi", "mov", "m4v", "mpg", "mpeg",
  // 压缩包（仅打开不执行）
  "zip", "tar", "gz", "bz2", "7z", "rar",
]);

// 判定小写扩展名（不含点）是否允许"安全打开"。
export function isSafeOpenExt(ext: string): boolean {
  return ext !== "" && SAFE_OPEN_EXTS.has(ext);
}
