/**
 * 共享类型守卫：宽容解析（内核 payload / 持久化 JSON）统一入口。
 * 原先 7 份本地实现（controllers/*、views/settings/*）合并于此，
 * 语义取最严格变体——数组不算 record。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
