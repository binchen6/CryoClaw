/**
 * 共享时间格式化工具。
 */

// 将 Date 格式化为 YYYYMMDD-HHMMSS（“日期+秒”命名规则），
// 用于备份文件名（config-backup）与状态归档文件名（openclaw-state-archive-paths）。
export function formatTimestamp(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}
