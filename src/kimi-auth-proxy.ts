/**
 * Kimi Auth Proxy — localhost 反向代理
 *
 * 在 Main 进程内启动一个 127.0.0.1 HTTP 代理，按路径路由到 Kimi API 上游，
 * 每次请求注入内存中最新的 OAuth access_token，解决 embedded agent 持有过期
 * config 快照导致 401 的问题。
 *
 * 回环鉴权（path secret）已于 R49 移除：secret 写在 openclaw.json 的 baseUrl 里，
 * 应用重启换 secret 后任何同步缺口都会让主模型静默 401 落入 fallback（R40 事故），
 * 维护 16 条消费路径的成本远超"本机进程白嫖 token"这一低威胁场景的收益。
 * 代理只监听 127.0.0.1，按路由表白名单转发到固定上游。
 */

import * as http from "http";
import * as https from "https";
import * as net from "net";
import * as log from "./logger";

// ────────────────────────────── 状态 ──────────────────────────────

let server: http.Server | null = null;
let currentPort = -1;
let currentAccessToken = "";
let kimiSearchDedicatedKey = "";

// 上游基地址
const UPSTREAM_HOST = "api.kimi.com";

// ────────────────────────────── 路由表 ──────────────────────────────

interface Route {
  /** 上游路径（保持与客户端请求一致） */
  upstream: (path: string) => string;
  /** 是否使用 search 专用 key */
  useSearchKey: boolean;
}

// 路由匹配：返回 Route 或 null（404）
// kimi-search 端点在 /coding/v1/search 和 /coding/v1/fetch 下，统一走 /coding/* 路由
function matchRoute(path: string): Route | null {
  if (path.startsWith("/coding/") || path === "/coding") {
    // search/fetch 子路径使用专属 key（如有）
    const isSearchPath = path.includes("/v1/search") || path.includes("/v1/fetch");
    return { upstream: (p) => p, useSearchKey: isSearchPath };
  }
  return null;
}

// ────────────────────────────── Token 选择 ──────────────────────────────

// 根据路由决定使用哪个 token
function resolveToken(route: Route): string {
  if (route.useSearchKey && kimiSearchDedicatedKey) {
    return kimiSearchDedicatedKey;
  }
  return currentAccessToken;
}

// ────────────────────────────── 请求处理 ──────────────────────────────

// 处理单个代理请求：路由 → 鉴权 → 转发 → 透传响应
function handleRequest(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
): void {
  const url = clientReq.url ?? "/";

  // 解析路径（去掉 query 部分用于路由匹配）
  const pathOnly = url.split("?")[0];

  const route = matchRoute(pathOnly);

  if (!route) {
    clientRes.writeHead(404, { "Content-Type": "text/plain" });
    clientRes.end("Not Found");
    return;
  }

  const token = resolveToken(route);
  if (!token) {
    clientRes.writeHead(401, { "Content-Type": "text/plain" });
    clientRes.end("No access token available");
    return;
  }

  // 复制原始请求头，替换鉴权相关字段
  const headers: http.OutgoingHttpHeaders = { ...clientReq.headers };
  headers["host"] = UPSTREAM_HOST;
  headers["x-api-key"] = token;
  headers["authorization"] = `Bearer ${token}`;

  // 删除可能干扰上游的 hop-by-hop 头
  delete headers["connection"];

  const upstreamPath = route.upstream(pathOnly + (url.includes("?") ? url.slice(url.indexOf("?")) : ""));

  const proxyReq = https.request(
    {
      hostname: UPSTREAM_HOST,
      port: 443,
      path: upstreamPath,
      method: clientReq.method,
      headers,
    },
    (proxyRes) => {
      // 透传上游响应（包括 SSE streaming）
      clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(clientRes);
    },
  );

  proxyReq.on("error", (err) => {
    log.error(`[auth-proxy] 上游请求失败: ${err.message}`);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "Content-Type": "text/plain" });
    }
    clientRes.end("Bad Gateway");
  });

  // 客户端中断（断连/中止）时同步终止上游请求：SSE 流式生成场景下若不销毁
  // proxyReq，上游 LLM 会继续生成计费到自然结束（客户端 socket 已断，写入静默失败）；
  // streaming POST 场景下 proxyReq 也会永挂直到对端超时。destroy 不触发已处理的
  // error 路径，仅截断 pipe。
  const abortUpstream = () => proxyReq.destroy();
  clientReq.on("aborted", abortUpstream);
  clientRes.on("close", () => {
    if (!clientRes.writableEnded) {
      abortUpstream();
    }
  });

  // 透传请求体（支持 streaming POST）
  clientReq.pipe(proxyReq);
}

// ────────────────────────────── 端口选择 ──────────────────────────────

// 尝试在候选端口列表上绑定，全部失败则由 OS 分配
function tryListen(
  srv: http.Server,
  preferredPort?: number,
  excludePort?: number,
): Promise<number> {
  // 构建去重的候选列表，排除 gateway 端口避免冲突
  const candidates: number[] = [];
  if (preferredPort != null && preferredPort > 0 && preferredPort !== excludePort) {
    candidates.push(preferredPort);
  }
  if (!candidates.includes(18790) && 18790 !== excludePort) {
    candidates.push(18790);
  }

  return new Promise((resolve, reject) => {
    let idx = 0;

    const attempt = (): void => {
      if (idx >= candidates.length) {
        // 所有候选端口耗尽，让 OS 动态分配
        srv.once("error", reject);
        srv.listen(0, "127.0.0.1", () => {
          const addr = srv.address() as net.AddressInfo;
          resolve(addr.port);
        });
        return;
      }

      const port = candidates[idx++];

      // 先移除上一轮残留的一次性监听
      srv.removeAllListeners("error");

      srv.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          log.warn(`[auth-proxy] 端口 ${port} 被占用，尝试下一个`);
          attempt();
        } else {
          reject(err);
        }
      });

      srv.listen(port, "127.0.0.1", () => {
        srv.removeAllListeners("error");
        // listen 成功后的运行期错误只记日志（对齐 gateway-control-server 模式：
        // retry 监听器已摘除，不补挂的话 error 事件无监听器会直接抛崩主进程）
        srv.on("error", (err) => {
          log.error(`[auth-proxy] 服务运行错误: ${err?.message ?? err}`);
        });
        const addr = srv.address() as net.AddressInfo;
        resolve(addr.port);
      });
    };

    attempt();
  });
}

// ────────────────────────────── 公开接口 ──────────────────────────────

// 启动代理，返回实际监听端口（excludePort 用于避让 gateway 端口）
export async function startAuthProxy(preferredPort?: number, excludePort?: number): Promise<number> {
  if (server) {
    log.warn("[auth-proxy] 代理已在运行，先停止旧实例");
    await stopAuthProxy();
  }

  const srv = http.createServer(handleRequest);

  const port = await tryListen(srv, preferredPort, excludePort);
  server = srv;
  currentPort = port;

  log.info(`[auth-proxy] 已启动，监听 127.0.0.1:${port}`);
  return port;
}

// 停止代理
export async function stopAuthProxy(): Promise<void> {
  if (!server) return;

  const srv = server;
  server = null;
  currentPort = -1;

  return new Promise((resolve) => {
    // close() 会等活动连接（如 SSE 长连接）结束才回调，先强制断开所有连接，
    // 避免 quit() await stopAuthProxy() 被活动连接无限挂起（Node ≥ 18.2）
    srv.closeAllConnections();
    srv.close(() => {
      log.info("[auth-proxy] 已停止");
      resolve();
    });
  });
}

// 更新内存中的 OAuth access_token
export function setProxyAccessToken(token: string): void {
  currentAccessToken = token;
}

// 更新 Kimi Search 专属 key（优先级高于 OAuth token）
export function setProxySearchDedicatedKey(key: string): void {
  kimiSearchDedicatedKey = key;
}

// 获取当前代理端口（-1 表示未启动）
export function getProxyPort(): number {
  return currentPort;
}
