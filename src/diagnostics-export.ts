// 诊断包导出（R20）：打包日志 + 环境信息 + 脱敏配置摘要为 zip，供用户外发求助。
//
// 安全红线：openclaw.json 含 apiKey/token 等敏感字段，导出前递归脱敏
// （key/token/secret/password/credential 命名的值一律替换为 "***"）。
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { app } from "electron";
import { zip } from "fflate";
import { resolveLogsDir, resolveUserConfigPath, resolveUserStateDir } from "./constants";

// 单个日志文件最多纳入的字节数（取尾部，最近的日志最有诊断价值）
const MAX_LOG_BYTES_PER_FILE = 2 * 1024 * 1024;
// 日志目录总纳入上限
const MAX_LOG_BYTES_TOTAL = 8 * 1024 * 1024;

const SENSITIVE_KEY_PATTERN = /(apikey|api_key|token|secret|password|credential|auth)/i;

// 回环代理 URL 里的 path secret（kimi-auth-proxy）：http://127.0.0.1:<port>/<secret>/...
// secret 嵌在 baseUrl 值里、键名不敏感，需按值定向打码（诊断包是用户外发件）
const LOOPBACK_SECRET_PATTERN = /(127\.0\.0\.1:\d+\/)[A-Za-z0-9_-]{8,}(?=\/|$)/g;

function redactStringValue(value: string): string {
  return value.replace(LOOPBACK_SECRET_PATTERN, "$1***");
}

// 递归脱敏：敏感键的值替换为 "***"；数组/对象递归处理
export function redactSensitiveValues(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map(redactSensitiveValues);
  }
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key) && typeof value === "string" && value) {
        out[key] = "***";
      } else {
        out[key] = redactSensitiveValues(value);
      }
    }
    return out;
  }
  if (typeof input === "string") {
    return redactStringValue(input);
  }
  return input;
}

async function readLogEntries(logsDir: string): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  let total = 0;
  let files: string[] = [];
  try {
    files = (await fs.promises.readdir(logsDir, { withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  } catch {
    return out;
  }
  for (const name of files) {
    if (total >= MAX_LOG_BYTES_TOTAL) break;
    try {
      const full = path.join(logsDir, name);
      const buf = await fs.promises.readFile(full);
      const budget = Math.min(MAX_LOG_BYTES_PER_FILE, MAX_LOG_BYTES_TOTAL - total);
      const slice = buf.length > budget ? buf.subarray(buf.length - budget) : buf;
      out[`logs/${name}`] = new Uint8Array(slice);
      total += slice.length;
    } catch {
      // 单个文件读取失败跳过
    }
  }
  return out;
}

function buildEnvironmentInfo(): string {
  return JSON.stringify(
    {
      appVersion: app.getVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      locale: app.getLocale(),
      exportedAt: new Date().toISOString(),
    },
    null,
    2,
  );
}

async function buildSanitizedConfigSummary(): Promise<string> {
  try {
    const raw = await fs.promises.readFile(resolveUserConfigPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return JSON.stringify(redactSensitiveValues(parsed), null, 2);
  } catch (err) {
    return JSON.stringify({ error: `配置读取/解析失败: ${err instanceof Error ? err.message : String(err)}` });
  }
}

export function buildDiagnosticsDefaultFileName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `cryoclaw-diagnostics-${app.getVersion()}-${stamp}.zip`;
}

export async function exportDiagnosticsBundle(targetZipPath: string): Promise<void> {
  const stateDir = resolveUserStateDir();
  const files: Record<string, Uint8Array> = {
    "environment.json": new Uint8Array(Buffer.from(buildEnvironmentInfo(), "utf-8")),
    "openclaw-config.redacted.json": new Uint8Array(Buffer.from(await buildSanitizedConfigSummary(), "utf-8")),
    ...(await readLogEntries(resolveLogsDir())),
  };
  // 兼容期：旧根路径日志若仍存在（未迁移/迁移后遗留），一并纳入
  for (const legacy of ["app.log", "gateway.log"]) {
    try {
      const p = path.join(stateDir, legacy);
      if (!files[`logs/${legacy}`]) {
        const buf = await fs.promises.readFile(p);
        files[`logs/legacy-${legacy}`] = new Uint8Array(
          buf.length > MAX_LOG_BYTES_PER_FILE ? buf.subarray(buf.length - MAX_LOG_BYTES_PER_FILE) : buf,
        );
      }
    } catch {}
  }
  await fs.promises.mkdir(path.dirname(targetZipPath), { recursive: true });
  // 异步压缩 + 异步写盘：最坏 ~10MB 的同步 zip 会冻结主进程数秒，所有 IPC 停摆
  const zipped = await new Promise<Uint8Array>((resolve, reject) => {
    zip(files, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data)));
  });
  await fs.promises.writeFile(targetZipPath, zipped);
}
