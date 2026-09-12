import * as fs from "fs";
import * as path from "path";
import { resolveLogsDir, resolveUserStateDir } from "./constants";

// 应用日志（R20 起统一写入 ~/.openclaw/logs/app.log；旧路径 ~/.openclaw/app.log 一次性迁移）
const LOG_PATH = path.join(resolveLogsDir(), "app.log");

// 日志上限 5MB，启动时截断
const MAX_LOG_SIZE = 5 * 1024 * 1024;

// 日志级别：CRYOCLAW_LOG_LEVEL=error|warn|info|debug（默认 info）。低于级别的日志
// 文件与 console 镜像都不写。
const LOG_LEVELS: Record<string, number> = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const configuredLevel = (process.env.CRYOCLAW_LOG_LEVEL || "info").toUpperCase();
const MAX_LEVEL = LOG_LEVELS[configuredLevel] ?? LOG_LEVELS.INFO;

try {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  // 一次性迁移旧路径日志（新文件已存在则保留旧文件不动，避免覆盖）
  const legacyPath = path.join(resolveUserStateDir(), "app.log");
  if (fs.existsSync(legacyPath) && !fs.existsSync(LOG_PATH)) {
    fs.renameSync(legacyPath, LOG_PATH);
  }
  if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > MAX_LOG_SIZE) {
    fs.writeFileSync(LOG_PATH, "[truncated]\n");
  }
} catch {}

// 使用 WriteStream 异步缓冲写入，避免高频 appendFileSync 阻塞主进程
let logStream: fs.WriteStream | null = null;
let writeCount = 0;
let fileWritesPaused = false;
// 轮转窗口：end+close 异步完成后才截断，期间 write() 不再重建流追加（否则截断
// 会把窗口内已落盘的行一起抹掉）
let rotationInProgress = false;
const ROTATION_CHECK_INTERVAL = 1000;

function getLogStream(): fs.WriteStream {
  if (!logStream) {
    logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });
    logStream.on("error", () => { logStream = null; });
  }
  return logStream;
}

// 流关闭通用工具：end 后等 close，1s 超时兜底（退出路径不阻塞）。
// logger 与 gateway-process 的诊断日志流关闭共用。
export function endStreamWithTimeout(stream: {
  once(event: string, listener: () => void): unknown;
  end(): unknown;
}): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    stream.once("close", finish);
    stream.once("error", finish);
    stream.end();
    setTimeout(finish, 1000).unref?.();
  });
}

async function closeLogStream(): Promise<void> {
  const stream = logStream;
  if (!stream) return;
  logStream = null;
  await endStreamWithTimeout(stream);
}

export async function withFileLoggingPaused<T>(fn: () => Promise<T>): Promise<T> {
  // .openclaw import deletes app.log on Windows; close the stream first so
  // fs.rm can remove that file without an open-handle failure.
  fileWritesPaused = true;
  await closeLogStream();
  try {
    return await fn();
  } finally {
    fileWritesPaused = false;
  }
}

function checkRotation(): void {
  if (++writeCount < ROTATION_CHECK_INTERVAL) return;
  // 计数器先重置：statSync/truncate 失败（目录被删/磁盘满）也不能卡在高位，
  // 否则之后每条日志都同步 stat 一次（对齐 gateway-process.ts diagLog 模式）
  writeCount = 0;
  try {
    if (fs.statSync(LOG_PATH).size > MAX_LOG_SIZE) {
      const stream = logStream;
      logStream = null;
      if (!stream) {
        fs.writeFileSync(LOG_PATH, "[truncated]\n");
        return;
      }
      // destroy() 的 fd 关闭在 Windows 上是异步的：紧随的同步截断会 EBUSY 且被
      // 吞掉（本轮轮转静默丢失）。改为 end+close（缓冲行落盘）完成后再截断，
      // 1s 超时兜底；仍失败则下个计数周期重试。窗口内置 rotationInProgress，
      // write() 不重建流——否则截断会把窗口内新写入的行一并抹掉。
      rotationInProgress = true;
      void endStreamWithTimeout(stream).then(() => {
        rotationInProgress = false;
        try { fs.writeFileSync(LOG_PATH, "[truncated]\n"); } catch {}
      });
    }
  } catch {}
}

// 写一行日志到文件 + console 镜像
function write(level: string, msg: string): void {
  const levelValue = LOG_LEVELS[level] ?? LOG_LEVELS.INFO;
  if (levelValue > MAX_LEVEL) return; // 低于配置级别：文件与 console 都不写
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  if (!fileWritesPaused && !rotationInProgress) {
    try {
      getLogStream().write(line);
      checkRotation();
    } catch {}
  }

  try {
    if (level === "ERROR") {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  } catch {}
}

export function info(msg: string): void { write("INFO", msg); }
export function warn(msg: string): void { write("WARN", msg); }
export function error(msg: string): void { write("ERROR", msg); }
export function debug(msg: string): void { write("DEBUG", msg); }

// URL 日志脱敏：剥离 query 与 hash（入口 URL 携带 gateway token，app.log 可能被
// 用户外发分享）。与 sanitizeLogText（main.ts）的职责互补：这里用于「要整条 URL
// 的日志」，那边用于「自由文本里内嵌 URL」的场景。
export function sanitizeUrlForLog(url: string): string {
  return url.split(/[?#]/, 1)[0];
}
