// Electron console-message 的 legacy 数字 level 语义是 0-3（verbose/info/warning/error）
// （gotcha #47）。此前的 LOG/WARNING/ERROR/DEBUG/INFO 标注是错误版本。
export function formatConsoleLevel(level: number): string {
  const map = ["VERBOSE", "INFO", "WARNING", "ERROR"];
  return map[level] ?? `LEVEL_${level}`;
}
