/**
 * gateway-crash-restart.ts — 网关崩溃自动重启策略（R71，纯逻辑便于测试）。
 *
 * 背景：网关子进程非预期退出后，主进程此前不做任何重启，用户会一直停在
 * 「无法连接到 Gateway」直到手动重启应用（渲染层只重连 WebSocket，而进程已死）。
 *
 * 策略：非预期退出后延迟重试，但在滑动时间窗内有界（默认 5 分钟 3 次）——
 * 既能让偶发崩溃自动恢复，又不会陷入崩溃循环把 CPU/磁盘打满；达上限后转人工恢复入口。
 */

export const CRASH_RESTART_MAX = 3;
export const CRASH_RESTART_WINDOW_MS = 5 * 60_000;
export const CRASH_RESTART_DELAY_MS = 3_000;

export interface CrashRestartDecision {
  allow: boolean;
  /** 窗口内（含本次）的重启时间戳 */
  times: number[];
  /** 本次是窗口内第几次 */
  attempt: number;
}

/** 判定是否允许再自动重启一次；返回更新后的时间戳列表供调用方保存。 */
export function decideCrashRestart(
  times: number[],
  now: number,
  opts: { max?: number; windowMs?: number } = {},
): CrashRestartDecision {
  const max = opts.max ?? CRASH_RESTART_MAX;
  const windowMs = opts.windowMs ?? CRASH_RESTART_WINDOW_MS;
  const recent = times.filter((t) => now - t < windowMs);
  if (recent.length >= max) return { allow: false, times: recent, attempt: recent.length };
  const next = [...recent, now];
  return { allow: true, times: next, attempt: next.length };
}
