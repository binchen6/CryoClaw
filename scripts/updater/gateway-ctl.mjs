#!/usr/bin/env node
/**
 * gateway-ctl.mjs — CryoClaw 托管 Gateway 的 CLI 控制脚本（零依赖，Node ≥18）
 *
 * 内核原生 `openclaw gateway *` 按自带 daemon 模型操作，在 asar 内嵌 +
 * Electron 托管部署下必然失败。CLI wrapper 拦截 gateway 子命令后 exec
 * 本脚本，由本脚本通过主进程的本地控制服务（127.0.0.1 HTTP + Bearer
 * token）执行真正的托管停启。
 *
 * 连接信息（端口/token）由主进程写入 ~/.openclaw/cryoclaw.config.json 的
 * gatewayControl 字段；本脚本只读不写。控制服务不可达 = CryoClaw 未运行，
 * 直接报错，绝不回退原生命令（原生必坏）。
 *
 * 用法（wrapper 原样透传参数，首个参数可能是 "gateway"）：
 *   gateway-ctl.mjs gateway restart   重启托管 Gateway（退出码 0/1）
 *   gateway-ctl.mjs gateway status    查看运行状态（JSON 输出）
 *   其他子命令：打印托管说明，退出码 2（避免 agent 误判成功）
 *
 * 安装位置：<install>/resources/resources/updater/gateway-ctl.mjs
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";

const STATUS_TIMEOUT_MS = 10_000;
// Windows 冷启动健康检查最长 180s，restart 留足余量
const RESTART_TIMEOUT_MS = 240_000;

const MANAGED_HINT =
  "gateway 由 CryoClaw 托管，请在应用内操作；可用命令：openclaw gateway restart / status";
const NOT_RUNNING_HINT =
  "CryoClaw 未运行，无法执行 gateway 命令；请先启动 CryoClaw 应用";

// ── 子命令路由（可测纯函数）──

// wrapper 透传时首个参数是 "gateway"，剥离后取子命令
export function parseGatewayCommand(argv) {
  const args = argv[0] === "gateway" ? argv.slice(1) : argv;
  const sub = (args[0] ?? "").toLowerCase();
  if (sub === "restart") {
    return { kind: "call", sub, method: "POST", path: "/gateway/restart", timeoutMs: RESTART_TIMEOUT_MS };
  }
  if (sub === "status") {
    return { kind: "call", sub, method: "GET", path: "/gateway/status", timeoutMs: STATUS_TIMEOUT_MS };
  }
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    return { kind: "help" };
  }
  return { kind: "unsupported", sub };
}

// ── 配置读取 ──

function resolveStateDir(env) {
  if (env.OPENCLAW_STATE_DIR) return env.OPENCLAW_STATE_DIR;
  // HOME/USERPROFILE 在 CI/sandbox 下可能没设置，兜底 os.homedir()
  const home = (process.platform === "win32" ? env.USERPROFILE : env.HOME) || os.homedir();
  return path.join(home, ".openclaw");
}

// 读取 gatewayControl 连接信息（新文件优先，fallback 上一代 oneclaw.config.json）
export function readGatewayControlConfig(env = process.env) {
  const stateDir = resolveStateDir(env);
  for (const name of ["cryoclaw.config.json", "oneclaw.config.json"]) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(stateDir, name), "utf-8"));
      const ctl = raw?.gatewayControl;
      if (ctl && typeof ctl.port === "number" && ctl.port > 0 &&
          typeof ctl.token === "string" && ctl.token) {
        return { port: ctl.port, token: ctl.token };
      }
    } catch {
      // 文件不存在/非法 JSON：尝试下一个
    }
  }
  return null;
}

// ── 控制服务调用 ──

function callControlServer({ port, token, method, path: reqPath, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: reqPath,
        method,
        headers: { authorization: `Bearer ${token}` },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let body = null;
          try {
            body = JSON.parse(text);
          } catch {
            // 非 JSON 响应：body 留 null，走 HTTP 状态码分支
          }
          resolve({ statusCode: res.statusCode, body });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
    req.end();
  });
}

// 连接级错误（服务不可达/超时）：一律视为 CryoClaw 未运行
function isUnreachableError(err) {
  const code = err?.code;
  return (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ECONNABORTED" ||
    code === "ETIMEDOUT" ||
    code === "EHOSTUNREACH" ||
    code === "EPERM" ||
    err?.message === "请求超时"
  );
}

// ── 主流程（可测：返回退出码，输出经 io 注入）──

export async function runGatewayCtl(argv, io = {}) {
  const stdout = io.stdout ?? ((line) => process.stdout.write(line + "\n"));
  const stderr = io.stderr ?? ((line) => process.stderr.write(line + "\n"));
  const env = io.env ?? process.env;

  const cmd = parseGatewayCommand(argv);
  if (cmd.kind === "help") {
    stdout(`用法: openclaw gateway <restart|status>\n${MANAGED_HINT}`);
    return 0;
  }
  if (cmd.kind === "unsupported") {
    stderr(`不支持的 gateway 子命令 "${cmd.sub}"。${MANAGED_HINT}`);
    return 2;
  }

  const ctl = readGatewayControlConfig(env);
  if (!ctl) {
    stderr("未找到 gateway 控制配置（端口/token），CryoClaw 应用版本过旧或尚未初始化；请先启动一次 CryoClaw 应用");
    return 1;
  }

  let res;
  try {
    res = await callControlServer({
      port: ctl.port,
      token: ctl.token,
      method: cmd.method,
      path: cmd.path,
      timeoutMs: cmd.timeoutMs,
    });
  } catch (err) {
    if (isUnreachableError(err)) {
      stderr(NOT_RUNNING_HINT);
      return 1;
    }
    stderr(`gateway ${cmd.sub} 失败: ${err?.message ?? err}`);
    return 1;
  }

  if (res.statusCode === 401) {
    stderr("控制服务鉴权失败（token 不匹配），请重启 CryoClaw 应用后重试");
    return 1;
  }
  if (res.statusCode === 200 && res.body?.ok) {
    if (cmd.sub === "status") {
      // agent 可读的简洁 JSON
      stdout(JSON.stringify(res.body));
    } else {
      stdout("gateway 已重启");
    }
    return 0;
  }
  stderr(`gateway ${cmd.sub} 失败: ${res.body?.error ?? `HTTP ${res.statusCode}`}`);
  return 1;
}

// ── 入口（被 import 时不执行）──

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const selfPath = fileURLToPath(import.meta.url);
const isMain =
  invokedPath &&
  (process.platform === "win32"
    ? invokedPath.toLowerCase() === selfPath.toLowerCase()
    : invokedPath === selfPath);

if (isMain) {
  runGatewayCtl(process.argv.slice(2)).then((code) => process.exit(code));
}
