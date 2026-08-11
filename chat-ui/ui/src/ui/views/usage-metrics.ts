// Token/cost 紧凑格式化，供会话用量 tab 与消息级 usage footer 使用。

export function formatTokens(n: number | undefined): string {
  const value = n ?? 0;
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return String(value);
}

export function formatCost(n: number | undefined, decimals = 2): string {
  return `$${(n ?? 0).toFixed(decimals)}`;
}
