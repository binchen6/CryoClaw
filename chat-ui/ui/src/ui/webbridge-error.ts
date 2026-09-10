/**
 * webbridge-error.ts — 主进程 webbridge 修复错误 → 用户可操作判定的纯逻辑。
 *
 * 背景（R66）：webbridge 产物走 sha256 钉定（fail closed）。上游 CDN 换新后，
 * 旧版 App 的钉定表与之不符，修复失败时主进程抛出的消息包含内部哈希值与
 * `KIMI_WEBBRIDGE_SKIP_PIN` 开发逃生门说明——对终端用户不可操作。UI 命中该特征时
 * 改显示「请升级 CryoClaw 后重试」，把技术细节留在日志里。
 */

const PIN_STALE_MARKERS = ["sha256 校验失败", "缺少 sha256 钉定"];

/** 主进程错误消息是否为 webbridge 钉定校验失败（需升级应用才能解决）。 */
export function isWebbridgePinStaleError(message: unknown): boolean {
  if (typeof message !== "string") return false;
  return PIN_STALE_MARKERS.some((marker) => message.includes(marker));
}
