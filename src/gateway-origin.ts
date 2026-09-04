/**
 * gateway-origin.ts — 本地 gateway WebSocket 握手的 Origin 头改写
 *
 * openclaw 2026.8 起对 webchat/control-ui 客户端强制浏览器 Origin 校验
 * （checkBrowserOrigin）：file:// 加载的 Electron 渲染进程发出的
 * `Origin: file://` 无法通过内核 parseOrigin（协议后无 host），握手被
 * 1008 origin not allowed 拒绝。这里把指向本地环回 gateway 的 ws(s) 握手
 * Origin 改写为同 host 的 http origin，走 private-same-origin 通道
 * （host 一致 + 本地客户端）。只作用于环回地址的 ws 连接，远程 gateway
 * 的 Origin 不动（远程需在 gateway.controlUi.allowedOrigins 显式放行）。
 */
import { session } from "electron";

const LOOPBACK_WS_FILTER = {
  urls: [
    "ws://127.0.0.1:*/*",
    "ws://localhost:*/*",
    "ws://[::1]:*/*",
    "wss://127.0.0.1:*/*",
    "wss://localhost:*/*",
  ],
};

/** 把环回 ws(s) URL 的 Origin 改写为同 host 的 http(s) origin；其他请求原样返回。 */
export function rewriteLoopbackWsOrigin(
  url: string,
  headers: Record<string, string>,
): Record<string, string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return headers;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return headers;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") return headers;
  const out = { ...headers };
  for (const key of Object.keys(out)) {
    if (key.toLowerCase() === "origin") delete out[key];
  }
  const httpProtocol = parsed.protocol === "wss:" ? "https" : "http";
  out.Origin = `${httpProtocol}://${parsed.host}`;
  return out;
}

/** 在默认 session 上安装环回 ws 握手 Origin 改写（app ready 后调用一次）。 */
export function installGatewayOriginRewrite(): void {
  session.defaultSession.webRequest.onBeforeSendHeaders(LOOPBACK_WS_FILTER, (details, callback) => {
    callback({ requestHeaders: rewriteLoopbackWsOrigin(details.url, details.requestHeaders) });
  });
}
