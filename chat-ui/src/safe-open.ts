/**
 * shell.openPath 安全打开扩展名白名单（聊天 UI 侧副本）。
 *
 * 唯一事实源在仓库根 src/safe-open.ts（主进程 app:open-path / workspace:open-file）。
 * 本文件存在的原因：chat-ui 的测试编译（chat-ui/tsconfig.test.json）rootDir 限定在
 * chat-ui/ 内，无法引用仓库根 src/；vite 构建虽不受限，但类型检查/测试都需要可解析。
 * **修改白名单时必须两处同步**——chat-ui/ui/src/ui/chat/media-enhance.sync.test.ts
 * 会在测试期比对两侧清单，漂移即红灯。
 */

// 安全面：shell.openPath 会用系统默认程序打开任意文件，可执行文件会被直接运行。
// 仅允许明确的"安全打开"扩展名（文档/图片/媒体），拒绝可执行文件与其他未明确允许的类型。
export const SAFE_OPEN_EXTS = new Set([
  // 图片（svg 除外：浏览器以 file:// 打开 svg 会执行内嵌脚本，存在本地读文件风险）
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff",
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
