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
 *
 * 唯一不要求 Bearer 的路由是 /webui-handoff/<code>（F5）：外部浏览器直接导航
 * 无法携带 Authorization 头，该路径改用一次性 code 承担凭证语义，见
 * issueWebuiHandoffCode / redeemWebuiHandoff。
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
  /**
   * F5：webui handoff 的落地目标（当前 gateway 端口 + token，每次兑换实时取值）。
   * 未提供或返回 null 时 handoff 返回 503（例如 gateway 尚未分配端口）。
   */
  getWebuiHandoffTarget?: () => { token: string; port: number } | null;
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

// ── webui 一次性 handoff（F5）──

// 背景：app:open-webui 原先把 gateway token 直接拼进外部浏览器 URL 的 fragment 交给
// OS/浏览器打开。fragment 不会发给服务器，但完整 URL 会进入浏览器历史（开启历史同步
// 即上传云端），而该 token 是本机 gateway 的全量控制凭据。
//
// 改为 302 跳板后，shell 交给 OS/浏览器的只是「一次性 code」URL：code 16 字节随机、
// 60s TTL、兑换即作废，即使泄露也只是短命的一次性凭据，不再是长期全量控制令牌。
//
// 实测残留面（Chromium 实测 + 内核 2026.9.3 代码核对，见 docs/gotchas #21）：浏览器
// 提交的是**重定向后**的 URL，因此最终进入历史的仍是带 `#token=` 的落地 URL，重定向
// 前的 code URL 不会作为独立历史条目留存。真正把 token 从历史记录里抹掉的是 Control UI
// 启动时的 history.replaceState（清 hash）；页面若始终没启动（gateway 未起、加载失败、
// 提前关标签），带 token 的 URL 会留在历史里。该残留与改动前同源，本端点不消除它——
// 要彻底消除需要内核侧支持非 URL 渠道注入 token（如 __OPENCLAW_NATIVE_CONTROL_AUTH__）。
export const WEBUI_HANDOFF_PATH = "/webui-handoff/";
export const WEBUI_HANDOFF_TTL_MS = 60_000;

interface HandoffEntry {
  expiresAt: number;
  /** 已兑换（含兑换时目标不可用的情况）：重放一律 410，不再二次生效 */
  used: boolean;
}

// code → 条目。纯进程内内存态，应用退出即失效；条目在过期清理时删除。
const handoffCodes = new Map<string, HandoffEntry>();

// 清理过期条目：签发/兑换时顺带清理，避免长期运行下 Map 无界增长
function pruneExpiredHandoffCodes(now: number): void {
  for (const [code, entry] of handoffCodes) {
    if (entry.expiresAt <= now) handoffCodes.delete(code);
  }
}

/**
 * 签发一次性 handoff code（16 字节随机 hex，默认 TTL 60s，兑换后作废）。
 * ttlMs 仅供测试注入过期态；生产路径一律使用默认值。
 */
export function issueWebuiHandoffCode(ttlMs: number = WEBUI_HANDOFF_TTL_MS): string {
  const now = Date.now();
  pruneExpiredHandoffCodes(now);
  const code = crypto.randomBytes(16).toString("hex");
  handoffCodes.set(code, { expiresAt: now + ttlMs, used: false });
  return code;
}

/**
 * F5：生成供外部浏览器打开 WebUI 的一次性 handoff URL。
 * 控制服务未启动（端口绑定失败）时返回 null，调用方须回退为「不带 token」的
 * 直连 URL——绝不回退到把 token 拼进 URL 的老行为。
 */
export function buildWebuiHandoffUrl(): string | null {
  if (!active) return null;
  return `http://127.0.0.1:${active.port}${WEBUI_HANDOFF_PATH}${issueWebuiHandoffCode()}`;
}

// 落地 URL：token 仍走 fragment（不发往服务器），与旧行为保持一致
function buildWebuiHandoffLocation(port: number, token: string): string {
  return `http://127.0.0.1:${port}/#token=${encodeURIComponent(token)}`;
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

/**
 * 兑换一次性 handoff code 并 302 到 WebUI 落地 URL。
 *
 * 这是本服务唯一的无 Bearer 路由：浏览器地址栏导航无法携带 Authorization 头，
 * 安全性全部由 code 自身承担——16 字节随机、TTL 60s、兑换即作废、服务仅绑
 * 127.0.0.1。因此 401/403 语义在此路径不适用，未知 code 统一 404（不区分
 * 「不存在」与「格式非法」，避免给攻击者提供存在性信号）。
 */
function redeemWebuiHandoff(
  res: http.ServerResponse,
  path: string,
  deps: GatewayControlDeps,
): void {
  const code = path.slice(WEBUI_HANDOFF_PATH.length);
  const entry = handoffCodes.get(code);
  if (!entry) {
    sendJson(res, 404, { ok: false, error: "not found" });
    return;
  }
  if (entry.used) {
    sendJson(res, 410, { ok: false, error: "handoff already used" });
    return;
  }
  if (entry.expiresAt <= Date.now()) {
    handoffCodes.delete(code);
    sendJson(res, 410, { ok: false, error: "handoff expired" });
    return;
  }
  // 先作废再取落地目标：目标查询抛错/返回 null 时 code 也不能保持可兑换
  entry.used = true;
  const target = deps.getWebuiHandoffTarget?.() ?? null;
  if (!target || !target.token) {
    sendJson(res, 503, { ok: false, error: "handoff unavailable" });
    return;
  }
  // cache-control: no-store —— 跳转响应不可被缓存，否则同一个 code 可能被重复消费
  res.writeHead(302, {
    location: buildWebuiHandoffLocation(target.port, target.token),
    "cache-control": "no-store",
  });
  res.end();
}

// 请求处理器（与 listen 解耦，便于单测直接注入 mock deps）
export function createGatewayControlRequestHandler(
  deps: GatewayControlDeps,
  token: string,
): http.RequestListener {
  return async (req, res) => {
    try {
      const url = (req.url ?? "").split("?")[0];
      // handoff 先于 Bearer 校验（见 redeemWebuiHandoff 注释）；非 GET 一律 404
      if (url.startsWith(WEBUI_HANDOFF_PATH)) {
        if (req.method === "GET") {
          redeemWebuiHandoff(res, url, deps);
        } else {
          sendJson(res, 404, { ok: false, error: "not found" });
        }
        return;
      }
      if (!isAuthorized(req, token)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
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
