// F8：gatewayUrl 的 scheme 白名单校验（纯函数，供 storage / URL 参数消费）。
// 历史漏洞面：localStorage 脏数据或 ?gatewayUrl= 参数注入（javascript:、http:、
// 畸形串）曾原样流入 settings.gatewayUrl → new WebSocket 同步抛异常打断启动初始化。
// WebSocket 构造器本身只接受 ws/wss，这里在配置入口提前拦截，非法输入回退默认/
// 拒绝进入确认流程，让用户看到明确的默认地址而非启动崩溃。
export function isAcceptableGatewayUrl(raw: string | null | undefined): boolean {
  const value = raw?.trim();
  if (!value) {
    return false;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      return false;
    }
    return Boolean(url.host);
  } catch {
    return false;
  }
}
