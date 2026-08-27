/**
 * 显式跳转到侧边栏不可见会话时的 reconcile 容忍记录。
 *
 * 背景：任务页「打开会话」/ Cron「跳转会话」可能指向已归档（或被
 * activeMinutes/limit 过滤）的会话——sessions.list 默认只返回未归档会话
 * （gotchas #50），而 30s tick 的 reconcile 会把不在可见列表里的当前会话
 * 强制弹回 main。用户显式跳转到的会话应被豁免，直到其显式切走或该会话被删除。
 *
 * 仅显式切换（applySessionKey 路径）会写入容忍；启动/URL 恢复等直接赋值
 * host.sessionKey 的路径不受影响，保持原有 reconcile 行为。
 */
let toleratedKey: string | null = null;

/** 记录最近一次显式切换的会话 key（每次显式切换都覆盖） */
export function tolerateHiddenSession(key: string | null | undefined) {
  const trimmed = key?.trim();
  toleratedKey = trimmed || null;
}

/** 会话被删除时清除容忍，让 reconcile 正常接管切换 */
export function clearToleratedHiddenSession(key: string) {
  if (toleratedKey === key.trim()) {
    toleratedKey = null;
  }
}

/** 当前会话是否为「显式跳转到但不在可见列表」的豁免对象 */
export function isToleratedHiddenSession(key: string | null | undefined): boolean {
  const trimmed = key?.trim();
  return Boolean(trimmed) && trimmed === toleratedKey;
}
