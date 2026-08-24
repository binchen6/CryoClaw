/**
 * gateway-control-server.ts — Gateway 本地控制服务
 *
 * 背景：内核原生 CLI 的 `openclaw gateway restart/stop/start` 按自带 daemon
 * 模型操作，在 asar 内嵌 + Electron 托管部署下必然失败。本模块在主进程内
 * 起一个仅绑 127.0.0.1 的 HTTP 服务，CLI wrapper 拦截 gateway 子命令后
 * 经 scripts/updater/gateway-ctl.mjs 转发到这里，由托管的 GatewayProcess
 * 执行真正的停启（世代守卫/崩溃冷却逻辑不变）。
 *
 * 安全模型：随机 token（首启生成 32 位 hex 并持久化到 cryoclaw.config.json
 * 的 gatewayControl.token）+ Authorization: Bearer 校验；实际监听端口写入
 * gatewayControl.port 供 ctl 脚本读取。端口/token 不落日志明文。
 */

import * as http from "http";
import * as crypto from "crypto";
import { GATEWAY_CONTROL_BASE_PORT, GATEWAY_CONTROL_MAX_PORT_ATTEMPTS } from "./constants";
import { readCryoclawConfig, writeCryoclawConfig } from "./cryoclaw-config";
import * as log from "./logger";

// 托管状态快照：running/pid/port/uptime 由 main.ts 从 GatewayProcess 读取
export interface GatewayControlStatus {
  running: boolean;
  pid: number | null;
  port: number;
  uptimeMs: number | null;
}

export interface GatewayControlDeps {
  getStatus: () => GatewayControlStatus;
  /** 托管重启：停 gateway → ensureGatewayRunning（失败应抛错） */
  restart: () => Promise<void>;
}

interface ActiveServer {
  server: http.Server;
  port: number;
}

let active: ActiveServer | null = null;

// ── token / 端口持久化 ──

// 读取或首次生成控制 token（32 位 hex），持久化到 cryoclaw.config.json。
export function ensureGatewayControlToken(): string {
  const config = readCryoclawConfig() ?? {};
  const existing = config.gatewayControl?.token;
  if (typeof existing === "string" && existing.trim()) return existing;
  const token = crypto.randomBytes(16).toString("hex");
  config.gatewayControl = { ...config.gatewayControl, token };
  writeCryoclawConfig(config);
  return token;
}

// 实际监听端口写回配置，供 gateway-ctl.mjs 读取（token 字段原样保留）。
// 内部吞错：persist 抛错时 server 已在监听，若向上抛会走 catch 返回 null
// 但泄漏一个未纳入 active 管理的孤立 server（端口占用直至进程退出）。
function persistGatewayControlPort(port: number): void {
  try {
    const config = readCryoclawConfig() ?? {};
    config.gatewayControl = { ...config.gatewayControl, port };
    writeCryoclawConfig(config);
  } catch (err: any) {
    log.error(`[gateway-control] 端口写回配置失败: ${err?.message ?? err}`);
  }
}

// ── 请求处理 ──

// Bearer token 校验（长度一致时走 timingSafeEqual，避免时序侧信道）
function isAuthorized(req: http.IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const expected = `Bearer ${token}`;
  if (header.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

// 串行化 restart：并发请求共享同一个在途 promise，避免双重停启
let inflightRestart: Promise<void> | null = null;

function runSerializedRestart(deps: GatewayControlDeps): Promise<void> {
  if (!inflightRestart) {
    inflightRestart = deps.restart().finally(() => {
      inflightRestart = null;
    });
  }
  return inflightRestart;
}

// 请求处理器（与 listen 解耦，便于单测直接注入 mock deps）
export function createGatewayControlRequestHandler(
  deps: GatewayControlDeps,
  token: string,
): http.RequestListener {
  return async (req, res) => {
    try {
      if (!isAuthorized(req, token)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      const url = (req.url ?? "").split("?")[0];
      if (req.method === "GET" && url === "/gateway/status") {
        sendJson(res, 200, { ok: true, ...deps.getStatus() });
        return;
      }
      if (req.method === "POST" && url === "/gateway/restart") {
        req.resume(); // 排空请求体，保持连接状态机干净
        await runSerializedRestart(deps);
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 404, { ok: false, error: "not found" });
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
    }
  };
}

// ── 端口绑定 ──

// 绑定 127.0.0.1，从 basePort 起 EADDRINUSE 递增重试，返回实际监听端口。
// 注意：不能用 server.listen(port, host, cb) 的回调判定成功——cb 是注册一次性
// "listening" 监听，失败尝试的 cb 不会在 error 时摘除，重试成功后旧 cb 会以
// 旧端口先触发（Windows 实测）。改为持久监听 + 核对实际绑定端口。
export function listenWithPortRetry(
  server: http.Server,
  basePort: number,
  maxAttempts: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const cleanup = () => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
    };
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && attempt + 1 < maxAttempts) {
        attempt += 1;
        server.listen(basePort + attempt, "127.0.0.1");
      } else {
        cleanup();
        reject(err);
      }
    };
    const onListening = () => {
      const addr = server.address();
      if (addr && typeof addr === "object" && addr.port === basePort + attempt) {
        cleanup();
        resolve(addr.port);
      }
    };
    server.on("error", onError);
    server.on("listening", onListening);
    server.listen(basePort, "127.0.0.1");
  });
}

// ── 生命周期 ──

// 启动控制服务：ensure token → listen → 回写实际端口。
// 失败只记日志返回 null，不阻塞应用启动。
export async function startGatewayControlServer(
  deps: GatewayControlDeps,
  opts?: { basePort?: number; maxAttempts?: number },
): Promise<number | null> {
  if (active) return active.port;
  try {
    const token = ensureGatewayControlToken();
    const server = http.createServer(createGatewayControlRequestHandler(deps, token));
    const port = await listenWithPortRetry(
      server,
      opts?.basePort ?? GATEWAY_CONTROL_BASE_PORT,
      opts?.maxAttempts ?? GATEWAY_CONTROL_MAX_PORT_ATTEMPTS,
    );
    // listen 成功后的运行期错误只记日志（retry 监听器已摘除，避免 error 事件无人接收）
    server.on("error", (err) => {
      log.error(`[gateway-control] 服务运行错误: ${err?.message ?? err}`);
    });
    persistGatewayControlPort(port);
    active = { server, port };
    log.info(`[gateway-control] 本地控制服务已启动 (127.0.0.1:${port})`);
    return port;
  } catch (err: any) {
    log.error(`[gateway-control] 启动失败（不影响应用）: ${err?.message ?? err}`);
    return null;
  }
}

// 关闭控制服务（app 退出时调用）
export async function stopGatewayControlServer(): Promise<void> {
  const current = active;
  active = null;
  if (!current) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    current.server.close(finish);
    // 兜底：close 等待存量连接，超时强解
    setTimeout(finish, 1000).unref?.();
  });
}
