// webbridge.ts — daemon 下载缓存 / setup 编排 / 状态聚合 / precheck
// 合并自原 webbridge-installer.ts + webbridge-setup-task.ts + webbridge-status.ts
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as https from "https";
import { execFile } from "child_process";
import { promisify } from "util";
import { URL } from "url";
import {
  readWebbridgeCrxMetadata,
  resolveWebbridgeCrxPath,
  resolveWebbridgeDataDir,
} from "./constants";
import { loadRemotePins } from "./webbridge-pins";
import type {
  BrowserInstallSummary,
  BrowserMode,
  BrowserState,
  ExtensionSpec,
} from "./browser";
import type { WriteUserConfigOptions } from "./provider-config";

// ═══════════════════════════════════════════════════════════════════
// installer（CDN 下载 / ETag 缓存 / 进度 / 重试）
// ═══════════════════════════════════════════════════════════════════

export const CDN_BASE_URL = "https://kimi-web-img.moonshot.cn/webbridge";

// ═══════════════════════════════════════════════════════════════════
// 供应链钉定（R65，对齐 kimi-search tgz sha256 钉定模型）：
// CDN 只暴露 latest 别名（版本化 URL 是 NoSuchKey），latest 内容由上游随时
// 可变——下载后立即执行的二进制必须有内容完整性校验。下表钉定当前 latest
// 各平台产物的 sha256；上游换新内容后哈希不匹配 → 拒装（fail closed），
// setup 流程按既有设计降级 openclaw 模式，应用不受阻。升级 webbridge =
// 重新取哈希更新本表。KIMI_WEBBRIDGE_SKIP_PIN=1 为排障逃生门（勿日常使用）。
// ═══════════════════════════════════════════════════════════════════
export const WEBBRIDGE_BINARY_SHA256_PINS: Record<string, string> = {
  // 2026-09-10 两次换新（同日）：上游对 latest 产物反复重建，字节数不变、仅 Go
  // build ID 等约 177B 元数据变化。嵌入表只是**兜底快照**，权威值在同仓库
  // resources/webbridge-pins.json（App 修复时自动拉取，见 webbridge-pins.ts）——
  // 这样上游再换新时无需发版即可修复（R68 永久修复）。
  "kimi-webbridge-windows-amd64.exe":
    "eec1976d5da3338a94ed9981796f7284570b8100cc62706a6de89f3d25a433c6",
  "kimi-webbridge-darwin-arm64":
    "04532d772d3c7789f6ab61e1e055c56bf73724757596ff0ab64ea29abef0a261",
  "kimi-webbridge-darwin-amd64":
    "931769e94f5b84cca8f130e94e7151bcdeee9e70bcddaf1f513ac194c3b8cc0c",
};

export function resolveWebbridgeBinaryPin(filename: string): string | null {
  return WEBBRIDGE_BINARY_SHA256_PINS[filename] ?? null;
}

/** 当前平台二进制文件名（不支持的平台返回 null，调用方跳过校验）。 */
function safeResolveWebbridgePinFilename(): string | null {
  try {
    return resolvePlatformBinaryName(process.platform, process.arch);
  } catch {
    return null;
  }
}

export function sha256FileSync(filePath: string): string {
  const { createHash } = require("crypto") as typeof import("crypto");
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

// ── Windows 文件锁重试（R79）──
// daemon 进程运行时，对二进制的 rename / unlink 会间歇性 EPERM/EBUSY
// （Defender 扫描 + Go 进程自身句柄）。固定 3 次退避重试（500ms/1s/2s）。
const FILE_LOCK_RETRY_DELAYS_MS = [500, 1000, 2000];

function isFileLockError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "ENOTEMPTY";
}

/** rename 带文件锁退避重试（daemon 持锁换装二进制的统一入口）。 */
export async function renameWithRetry(src: string, dest: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err) {
      if (attempt >= FILE_LOCK_RETRY_DELAYS_MS.length || !isFileLockError(err)) {
        throw err;
      }
      await sleep(FILE_LOCK_RETRY_DELAYS_MS[attempt]);
    }
  }
}

// 同步 sleep：verifyWebbridgeBinarySha256 是同步 fail-closed 路径（测试直接
// assert.throws），删除被锁产物时的短暂阻塞可接受；Node 主线程允许 Atomics.wait。
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 强删文件带文件锁退避重试；非锁错误或重试耗尽时抛出（由调用方决断）。 */
function rmForceWithLockRetry(filePath: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(filePath, { force: true });
      return;
    } catch (err) {
      if (attempt >= FILE_LOCK_RETRY_DELAYS_MS.length || !isFileLockError(err)) {
        throw err;
      }
      sleepSync(FILE_LOCK_RETRY_DELAYS_MS[attempt]);
    }
  }
}

// fail-closed 删除产物；删除本身被文件锁挡住时把清理失败信息附在校验错误上
// （不能吞掉校验错误——那是拒绝执行未校验产物的核心语义）。
function failClosedDelete(binaryPath: string, err: Error): never {
  try {
    rmForceWithLockRetry(binaryPath);
  } catch (cleanupErr) {
    err.message += `\n（且清理落盘产物失败: ${
      cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
    }——可能 daemon 正在运行，请先停止后重试）`;
  }
  throw err;
}

/**
 * 校验已下载的 webbridge 二进制与钉定哈希一致。
 * - expected 未给：按二进制文件名取内置 pin 表（生产路径）。
 * - expected === ""：显式跳过（测试 fixture 注入口，两条路径语义一致）。
 * - expected 非空：以调用方为准。
 * - extraPins：远端可更新清单（webbridge-pins.ts）；与内置表任一命中即通过——
 *   上游反复重建 latest 时无需发版即可修复（R68），仍是精确 sha256 比对。
 * - KIMI_WEBBRIDGE_SKIP_PIN=1：排障逃生门，直接放行。
 * 失败抛错并删除落盘文件（fail closed，不留可执行物）。
 */
export function verifyWebbridgeBinarySha256(
  binaryPath: string,
  filename: string,
  expected?: string,
  extraPins?: Record<string, string> | null,
): void {
  if (process.env.KIMI_WEBBRIDGE_SKIP_PIN === "1") return;
  if (expected === "") return;
  const embedded = expected ?? resolveWebbridgeBinaryPin(filename);
  const remote = extraPins?.[filename] ?? null;
  const pin = embedded ?? remote;
  if (!pin) {
    failClosedDelete(
      binaryPath,
      new Error(
        `webbridge 二进制缺少 sha256 钉定（${filename}）——拒绝执行未校验的下载产物；` +
          `请更新 WEBBRIDGE_BINARY_SHA256_PINS 或设置 KIMI_WEBBRIDGE_SKIP_PIN=1 排障`,
      ),
    );
  }
  const actual = sha256FileSync(binaryPath);
  const okEmbedded = actual.toLowerCase() === pin.toLowerCase();
  const okRemote =
    !okEmbedded && remote !== null && actual.toLowerCase() === remote.toLowerCase();
  if (!okEmbedded && !okRemote) {
    failClosedDelete(
      binaryPath,
      new Error(
        `webbridge 二进制 sha256 校验失败: ${filename}\n  expected ${pin}` +
          `${remote && remote !== pin ? `\n  remote   ${remote}` : ""}\n  actual   ${actual}` +
          `\n（上游 latest 内容已变化或传输被污染；升级需更新钉定表）`,
      ),
    );
  }
}

// 版本串白名单（R79）：版本会直接拼进 CDN URL path——KIMI_WEBBRIDGE_VERSION
// 来自环境变量，未校验时 "../.." / "a/b?x=" 之类能构造 path traversal 或注入
// query。只允许字母数字开头的 [A-Za-z0-9._-]，长度 ≤64。
const WEBBRIDGE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 版本串是否合法（"latest" / 语义化版本 / 构建 tag 形态）。 */
export function isValidWebbridgeVersion(version: string): boolean {
  return WEBBRIDGE_VERSION_PATTERN.test(version.trim());
}

export function resolveWebbridgeVersion(override?: string): string {
  const candidate = (override ?? process.env.KIMI_WEBBRIDGE_VERSION ?? "").trim();
  if (candidate && isValidWebbridgeVersion(candidate)) return candidate;
  // 非法值（含未设置）静默回退 latest：环境变量是排障用途，不该有能力让
  // 下载 URL 指向任意路径。
  return "latest";
}

export interface CacheManifest {
  version: string;
  etag: string | null;
  lastModified: string | null;
  contentLength: number | null;
  /** 本地落盘二进制的 sha256（R79 本地复用 / 离线 skip 判定）；旧 manifest 无此字段为 null。 */
  sha256?: string | null;
  /** true = 沿用了用户自行安装的二进制（版本探测采纳），不是 CryoClaw 下载的产物。 */
  adopted?: boolean;
}

const CACHE_FILE_NAME = ".download-cache.json";

export function readCacheManifest(dataDir: string): CacheManifest | null {
  try {
    const raw = fs.readFileSync(path.join(dataDir, CACHE_FILE_NAME), "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return {
      version: String(parsed.version ?? ""),
      etag: parsed.etag ?? null,
      lastModified: parsed.lastModified ?? null,
      contentLength:
        typeof parsed.contentLength === "number" ? parsed.contentLength : null,
      sha256: typeof parsed.sha256 === "string" ? parsed.sha256 : null,
      adopted: parsed.adopted === true,
    };
  } catch {
    return null;
  }
}

export function writeCacheManifest(
  dataDir: string,
  manifest: CacheManifest,
): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, CACHE_FILE_NAME),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
}

export interface HeadResult {
  etag: string | null;
  lastModified: string | null;
  contentLength: number | null;
}

const MAX_REDIRECTS = 5;
const HEAD_TIMEOUT_MS = 15_000;

function chooseTransport(url: string): typeof https | typeof http {
  return new URL(url).protocol === "http:" ? http : https;
}

// 重定向与非 200 状态码前置检查（httpHead / downloadToFile 共用）。
// 返回 true = 已处理（跟随了重定向或已 fail），调用方直接 return；
// 返回 false = 200 响应，调用方继续后续逻辑。
function guardRedirectAndStatus(
  res: http.IncomingMessage,
  url: string,
  ctx: {
    bumpRedirect: () => boolean; // false → 超过上限
    follow: (nextUrl: string) => void;
    fail: (err: Error) => void;
  },
): boolean {
  const status = res.statusCode ?? 0;
  if (status >= 300 && status < 400 && res.headers.location) {
    if (ctx.bumpRedirect()) {
      const next = new URL(res.headers.location, url).toString();
      // 只允许 https 目标：防止 https→http 降级把可执行文件下载拖回明文通道
      if (new URL(url).protocol === "https:" && new URL(next).protocol !== "https:") {
        ctx.fail(new Error(`拒绝降级到非 https 下载地址: ${next}`));
      } else {
        ctx.follow(next);
      }
    } else {
      ctx.fail(new Error(`Too many redirects (>${MAX_REDIRECTS})`));
    }
    res.resume();
    return true;
  }
  if (status !== 200) {
    ctx.fail(new Error(`HTTP ${status} — ${url}`));
    res.resume();
    return true;
  }
  return false;
}

export function httpHead(initialUrl: string): Promise<HeadResult> {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const ok = (r: HeadResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const request = (url: string) => {
      const req = chooseTransport(url).request(
        url,
        { method: "HEAD" },
        (res) => {
          if (
            guardRedirectAndStatus(res, url, {
              bumpRedirect: () => ++redirects <= MAX_REDIRECTS,
              follow: request,
              fail,
            })
          ) return;
          const lenRaw = res.headers["content-length"];
          // Number.isFinite 而非 `|| null`：后者会把合法的 0 误当未知长度
          const len =
            typeof lenRaw === "string" ? Number.parseInt(lenRaw, 10) : NaN;
          ok({
            etag: (res.headers.etag as string | undefined) ?? null,
            lastModified:
              (res.headers["last-modified"] as string | undefined) ?? null,
            contentLength: Number.isFinite(len) ? len : null,
          });
          res.resume();
        },
      );
      // socket-level inactivity timeout：每次重定向递归都会创建新 req，每个 req
      // 各自计时，整体最坏 = (MAX_REDIRECTS+1) * HEAD_TIMEOUT_MS。GFW / IPv6-only
      // 卡死场景下的兜底——没这条 setup-task 会永远不返回。
      req.setTimeout(HEAD_TIMEOUT_MS, () => {
        req.destroy(new Error(`HEAD timeout after ${HEAD_TIMEOUT_MS}ms — ${url}`));
      });
      req.on("error", fail);
      req.end();
    };
    request(initialUrl);
  });
}

export interface ProgressEvent {
  downloaded: number;
  total: number | null;
  pct: number | null;
}

export type ProgressHandler = (event: ProgressEvent) => void;

const DOWNLOAD_TIMEOUT_MS = 60_000;
const PROGRESS_INTERVAL_MS = 200;
const PROGRESS_BYTES_THRESHOLD = 64 * 1024;

export function downloadToFile(
  initialUrl: string,
  dest: string,
  onProgress?: ProgressHandler,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmpPath = `${dest}.tmp-${process.pid}-${Date.now()}`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    let redirects = 0;
    let settled = false;
    let lastProgressAt = 0;
    let lastProgressBytes = 0;
    // 当前尝试的写流句柄（redirect 重入 request 会换新流）：失败清理前必须
    // destroy——Windows 下仍打开的句柄会让 unlink EBUSY，重试场景每次失败
    // 都泄漏一个 fd + 一个 *.tmp-* 孤儿文件（R76 修复）
    let currentFile: fs.WriteStream | null = null;

    const cleanupTmp = () => {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {}
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      if (currentFile && !currentFile.destroyed) currentFile.destroy();
      cleanupTmp();
      reject(err);
    };

    const request = (url: string) => {
      const req = chooseTransport(url).get(url, (res) => {
        if (
          guardRedirectAndStatus(res, url, {
            bumpRedirect: () => ++redirects <= MAX_REDIRECTS,
            follow: request,
            fail,
          })
        ) return;

        const lenRaw = res.headers["content-length"];
        const lenParsed =
          typeof lenRaw === "string" ? Number.parseInt(lenRaw, 10) : NaN;
        const total = Number.isFinite(lenParsed) ? lenParsed : null;

        const file = fs.createWriteStream(tmpPath);
        currentFile = file;
        let downloaded = 0;

        res.on("data", (chunk: Buffer) => {
          downloaded += chunk.length;
          if (!onProgress) return;
          const now = Date.now();
          if (
            now - lastProgressAt >= PROGRESS_INTERVAL_MS ||
            downloaded - lastProgressBytes >= PROGRESS_BYTES_THRESHOLD
          ) {
            lastProgressAt = now;
            lastProgressBytes = downloaded;
            onProgress({
              downloaded,
              total,
              pct: total ? (downloaded / total) * 100 : null,
            });
          }
        });

        res.on("error", fail);
        file.on("error", fail);

        file.on("finish", () => {
          file.close((closeErr) => {
            if (settled) return;
            if (closeErr) {
              fail(closeErr);
              return;
            }
            // R79：rename 带文件锁退避重试——目标二进制被运行中的 daemon 持有
            // （Windows EPERM/EBUSY）时不再一次定生死。
            renameWithRetry(tmpPath, dest).then(
              () => {
                if (settled) return;
                onProgress?.({
                  downloaded,
                  total,
                  pct: total ? 100 : null,
                });
                settled = true;
                resolve();
              },
              (err: Error) => fail(err),
            );
          });
        });

        res.pipe(file);
      });

      req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
        req.destroy(new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`));
      });
      req.on("error", fail);
    };

    request(initialUrl);
  });
}

export function resolvePlatformBinaryName(
  platform: NodeJS.Platform | string,
  arch: string,
): string {
  const key = `${platform}-${arch}`;
  switch (key) {
    case "darwin-arm64":
      return "kimi-webbridge-darwin-arm64";
    case "darwin-x64":
      return "kimi-webbridge-darwin-amd64";
    case "win32-x64":
    case "win32-arm64":
      return "kimi-webbridge-windows-amd64.exe";
    default:
      throw new Error(`Unsupported platform: ${key}`);
  }
}

export interface InstallOptions {
  dataDir?: string;
  binaryPath?: string;
  version?: string;
  platform?: NodeJS.Platform | string;
  arch?: string;
  cdnBaseUrl?: string;
  onProgress?: ProgressHandler;
  force?: boolean;
  maxRetries?: number;
  /** 期望的 sha256（hex）。缺省 = 按文件名取内置钉定表；空串 = 跳过（测试 fixture）。 */
  expectedSha256?: string;
  /**
   * 远端钉定清单（R79 去重）：调用方已经 loadRemotePins 过时注入，命中即不再
   * 重复拉取（修复路径原先会拉两次）。undefined = 按生产逻辑自行加载。
   */
  remotePins?: Record<string, string> | null;
  /** 本地二进制版本探测注入（测试 fixture；生产用 probeWebbridgeBinaryVersion）。 */
  versionProbe?: (binaryPath: string) => Promise<string | null>;
}

export interface InstallResult {
  installed: boolean;
  skipped: boolean;
  version: string;
  binaryPath: string;
  etag: string | null;
  /** skipped=true 且沿用用户自装二进制（版本探测采纳）。 */
  adopted?: boolean;
  /** skipped=true 且因离线（HEAD 失败）复用本地可信二进制。 */
  offline?: boolean;
}

const DEFAULT_MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;

function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|timed out|socket hang up/i.test(
    msg,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// 解析默认路径——统一收敛到 constants.resolveWebbridgeDataDir（R79）：
// 此前本模块自带的 homedir 解析与 constants 顺序不一致（多一层 || HOME 兜底），
// 从 Git Bash / MSYS 启动时 skill 探测根与二进制落盘根可能分裂。
function resolveDefaultBinaryPath(dataDir: string): string {
  const exe = process.platform === "win32" ? "kimi-webbridge.exe" : "kimi-webbridge";
  return path.join(dataDir, "bin", exe);
}

// HEAD 也走 transient 重试 —— 没有这个的话，install 路径在网络抖一下就直接
// 降级到 openclaw，而下载阶段的重试根本没机会触发。同样的指数退避策略。
export async function httpHeadWithRetry(
  url: string,
  maxRetries: number,
): Promise<HeadResult> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await httpHead(url);
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries || !isTransientError(err)) {
        throw err;
      }
      await sleep(RETRY_BASE_DELAY_MS * Math.pow(3, attempt));
    }
  }
  throw lastErr;
}

// 下载 + transient 重试（installWebbridge 与 webbridge-update 的换装管线共用）。
export async function downloadToFileWithRetry(
  url: string,
  dest: string,
  maxRetries: number,
  onProgress?: ProgressHandler,
): Promise<void> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await downloadToFile(url, dest, onProgress);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries || !isTransientError(err)) {
        throw err;
      }
      await sleep(RETRY_BASE_DELAY_MS * Math.pow(3, attempt));
    }
  }
  throw lastErr;
}

/**
 * 探测本地二进制版本（F1 采纳判定的健康检查，只跑只读子命令）：
 *   1. `<binary> --version`（Go CLI 惯例；SKILL.md 未 documenting 但常见）
 *   2. `<binary> status` → daemon 在跑时 /status JSON 里有 version 字段
 * 两者都拿不到版本号 → 返回 null（调用方按"二进制可疑"走下载替换）。
 */
export async function probeWebbridgeBinaryVersion(
  binaryPath: string,
  deps: { execFileAsync?: ExecFileAsync } = {},
): Promise<string | null> {
  const execFileAsync = deps.execFileAsync ?? DEFAULT_EXEC_FILE;
  const VERSION_RE = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/;
  try {
    const { stdout } = await execFileAsync(binaryPath, ["--version"], {
      timeout: 10_000,
      windowsHide: true,
    });
    const m = String(stdout).match(VERSION_RE);
    if (m) return m[0];
  } catch {
    // --version 不被支持（老版本二进制）→ 试 status
  }
  try {
    const { stdout } = await execFileAsync(binaryPath, ["status"], {
      timeout: 10_000,
      windowsHide: true,
    });
    const parsed = JSON.parse(String(stdout)) as { version?: unknown; running?: unknown };
    if (parsed?.running === true && typeof parsed.version === "string" && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    // daemon 没跑 / 输出不可解析 → null
  }
  return null;
}

export async function installWebbridge(
  options: InstallOptions = {},
): Promise<InstallResult> {
  const dataDir = options.dataDir ?? resolveWebbridgeDataDir();
  const binaryPath = options.binaryPath ?? resolveDefaultBinaryPath(dataDir);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const version = resolveWebbridgeVersion(options.version);
  const filename = resolvePlatformBinaryName(platform, arch);
  const base = options.cdnBaseUrl ?? CDN_BASE_URL;
  const url = `${base}/${version}/releases/${filename}`;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  // 远端可更新钉定清单（R68）：调用方注入优先（修复路径已拉过，R79 去重）；
  // 只在生产路径（未显式传入 fixture 期望值）自动加载，保证测试不触网；
  // 拉取失败返回 null，回退内置表。
  const remotePins =
    options.remotePins !== undefined
      ? options.remotePins
      : options.expectedSha256 === undefined
        ? (await loadRemotePins({ dataDir }).catch(() => ({ pins: null, source: null }))).pins
        : null;

  // 当前文件名的有效钉定（embedded + remote；fixture 语义与下载路径一致：
  // 未给 = 内置 pin；空串 = 显式跳过）
  const pinsForFilename = (): { embedded: string | null; remote: string | null } => ({
    embedded:
      options.expectedSha256 === undefined
        ? resolveWebbridgeBinaryPin(filename)
        : options.expectedSha256 || null,
    remote:
      options.expectedSha256 === undefined
        ? remotePins?.[filename] ?? null
        : null,
  });

  const shaOfBinary = (p: string): string | null => {
    try {
      return sha256FileSync(p).toLowerCase();
    } catch {
      return null;
    }
  };

  // ── F1 本地复用（R79）：目标二进制已存在时优先复用，不再无条件打网络 ──
  // 覆盖三类场景：① 用户自行安装（同路径有二进制但无 CryoClaw manifest）——
  // 命中钉定或版本探测健康 → 采纳，省 10MB 下载；② 上游重建 latest 后本地
  // 产物仍与（远端）钉定一致 → 免 HEAD 直接复用；③ 离线（HEAD 失败）→ 本地
  // 可信即继续流程，setup 不再因断网降级 openclaw。
  if (!options.force && fs.existsSync(binaryPath)) {
    const prevManifest = readCacheManifest(dataDir);
    const actual = shaOfBinary(binaryPath);
    const { embedded, remote } = pinsForFilename();
    const pinHit =
      actual !== null &&
      ((embedded !== null && actual === embedded.toLowerCase()) ||
        (remote !== null && actual === remote.toLowerCase()));
    if (pinHit) {
      // 磁盘产物与当前钉定一致 = 已是已知安全版本（ETag 命中路径之外的
      // 第三条 skip 路径）；保留旧 manifest 的 etag 供更新检查比对。
      writeCacheManifest(dataDir, {
        version: prevManifest?.version || version,
        etag: prevManifest?.etag ?? null,
        lastModified: prevManifest?.lastModified ?? null,
        contentLength: prevManifest?.contentLength ?? null,
        sha256: actual,
        adopted: false,
      });
      return {
        installed: false,
        skipped: true,
        version,
        binaryPath,
        etag: prevManifest?.etag ?? null,
      };
    }
    // sha 未命中任何钉定（用户自装了更新版本？）→ 只读版本探测：
    // 能输出版本号 = 可执行且健康 → 采纳本机安装，跳过下载；
    // 探测失败（二进制损坏/不可执行）→ 落到正常下载替换路径。
    if (actual !== null) {
      const probed = await (options.versionProbe ?? probeWebbridgeBinaryVersion)(binaryPath);
      if (probed) {
        writeCacheManifest(dataDir, {
          version: probed,
          etag: null,
          lastModified: null,
          contentLength: null,
          sha256: actual,
          adopted: true,
        });
        return {
          installed: false,
          skipped: true,
          adopted: true,
          version: probed,
          binaryPath,
          etag: null,
        };
      }
    }
  }

  // HEAD 拿 ETag（同时作为版本探测；404/403 会在这里直接抛出，transient 错误自动重试）。
  // 离线兜底（F1）：HEAD 彻底失败但本地二进制可信（钉定命中，或上次 manifest
  // 记录的 sha256 与当前一致）→ skip 下载继续流程；本地完全无二进制 → 维持
  // 现状抛错（setup 降级 openclaw）。
  let head: HeadResult;
  try {
    head = await httpHeadWithRetry(url, maxRetries);
  } catch (err) {
    if (fs.existsSync(binaryPath)) {
      const actual = shaOfBinary(binaryPath);
      const { embedded, remote } = pinsForFilename();
      const manifest = readCacheManifest(dataDir);
      const trusted =
        actual !== null &&
        ((embedded !== null && actual === embedded.toLowerCase()) ||
          (remote !== null && actual === remote.toLowerCase()) ||
          (manifest?.sha256 && actual === manifest.sha256.toLowerCase()));
      if (trusted) {
        return {
          installed: false,
          skipped: true,
          offline: true,
          version,
          binaryPath,
          etag: manifest?.etag ?? null,
        };
      }
    }
    throw err;
  }

  if (!options.force) {
    const cache = readCacheManifest(dataDir);
    if (
      cache &&
      head.etag &&
      cache.etag === head.etag &&
      fs.existsSync(binaryPath)
    ) {
      // 缓存命中也复验钉定（R65）：缓存可能由旧版本 App（无钉定校验时期）落盘，
      // 或磁盘二进制被篡改；不匹配不作废整条缓存路径而是删除产物走重下，
      // 由下载后的正式校验决断（重下仍不匹配才 fail closed 抛错）。
      // expectedSha256 语义与下载路径一致：未给 = 内置 pin；空串 = 显式跳过。
      const pin = options.expectedSha256 === undefined
        ? resolveWebbridgeBinaryPin(filename)
        : (options.expectedSha256 || null);
      const remotePin = options.expectedSha256 === undefined ? remotePins?.[filename] ?? null : null;
      const cacheOk = (() => {
        if (!pin && !remotePin) return true; // 无钉定条目：按下载后校验的策略处理，此处放行
        let actual: string;
        try {
          actual = sha256FileSync(binaryPath).toLowerCase();
        } catch {
          return false;
        }
        return (!!pin && actual === pin.toLowerCase()) || (!!remotePin && actual === remotePin.toLowerCase());
      })();
      if (cacheOk) {
        return {
          installed: false,
          skipped: true,
          version,
          binaryPath,
          etag: head.etag,
        };
      }
      // 缓存产物与钉定不符：作废缓存记录，继续走下载路径。
      // 注意不预先删除磁盘上的二进制——downloadToFile 本身是「独立 tmp + rename
      // 覆盖」，删除并非下载的前置条件；预先删除会让下载重试耗尽后用户机器上
      // 原本可运行的 daemon 二进制凭空消失（update 场景的 fail-closed 语义是
      // 「校验不过保留旧版本继续可用」，见 webbridge-update.ts 的换装管线）。
      writeCacheManifest(dataDir, { version: "", etag: null, lastModified: null, contentLength: null });
    }
  }

  // 下载（重试 transient 错误；rename 阶段的文件锁错误在 downloadToFile 内重试）
  await downloadToFileWithRetry(url, binaryPath, maxRetries, options.onProgress);

  // 供应链钉定：下载产物过 sha256 校验才允许落盘执行（fail closed，详见
  // verifyWebbridgeBinarySha256 注释）。CDN 只暴露 latest，必须内容级校验；
  // 远端清单（R68）让上游反复重建时无需发版即可修复。
  verifyWebbridgeBinarySha256(binaryPath, filename, options.expectedSha256, remotePins);

  if (process.platform !== "win32") {
    fs.chmodSync(binaryPath, 0o755);
  }

  writeCacheManifest(dataDir, {
    version,
    etag: head.etag,
    lastModified: head.lastModified,
    contentLength: head.contentLength,
    sha256: sha256FileSync(binaryPath),
    adopted: false,
  });

  return {
    installed: true,
    skipped: false,
    version,
    binaryPath,
    etag: head.etag,
  };
}

// ═══════════════════════════════════════════════════════════════════
// setup task（一键启用 webbridge：下载 / skill / 扩展 / 失败降级）
// ═══════════════════════════════════════════════════════════════════

export interface WebbridgeSetupTaskLogger {
  info: (msg: string) => void;
  error: (msg: string) => void;
}

export interface WebbridgeSetupTaskDeps {
  // Phase 1：下载 webbridge 二进制。语义同 installWebbridge()。
  installer: () => Promise<InstallResult>;
  // Phase 3：批量装浏览器扩展。语义同 installForAllDetectedBrowsers(extId)。
  installExtensions: (extId: string) => Promise<BrowserInstallSummary[]>;
  // openclaw.json 读写；DI 供测试替换
  readConfig: () => any;
  // opts.baseSnapshot：降级改写时把 readConfig 拿到的对象传回，写前比对磁盘
  writeConfig: (config: any, opts?: WriteUserConfigOptions) => void;
  // Phase 2：applyBrowserModeConfig 的直接注入
  applyMode: (config: any, mode: BrowserMode) => any;
  // build-config.json 里的 ext ID；空字符串 → 严格判失败（走降级）
  extensionId: string;
  // 降级到 openclaw 模式重写 config 后，通知调用方（生产：gateway restart）
  onConfigRewritten?: () => void;
  // binary 就绪后安装 skill 到各 AI runtime
  installSkill?: (
    binaryPath: string,
  ) => Promise<{ success: boolean; output: string; error?: string }>;
  logger?: WebbridgeSetupTaskLogger;
  /**
   * true（默认）= 任何步骤失败时自动改写 config 到 openclaw 模式 + onConfigRewritten 通知。
   *               适合 Setup 完成后的 fire-and-forget 路径。
   * false = 失败只返回 outcome=fell-back-to-openclaw + error，不动 config 不通知。
   *         适合 Settings repair-and-enable 路径，由调用方决定是否写 config。
   */
  fallbackOnFailure?: boolean;
  /**
   * 选择性修复：跳过对应步骤（precheck 已确认在位时）。
   * Setup 路径默认全 false（跑完整流程）；Settings repair 路径按 precheck 缺啥跑啥。
   */
  skipBinaryInstall?: boolean;
  skipSkillInstall?: boolean;
  skipExtensionInstall?: boolean;
  /**
   * 当 skipBinaryInstall=true 时，跳过 installer() 调用，
   * 由调用方提供已存在的 binary 路径填入 summary。
   */
  existingBinaryPath?: string;
  /**
   * 远端可更新钉定清单（R68；由调用方 loadRemotePins 后注入）。
   * 缺省 null = 只用内置表（测试路径不触网）。
   */
  remotePins?: Record<string, string> | null;
}

export type SetupTaskOutcome =
  | "webbridge-ready"
  | "fell-back-to-openclaw"
  | "extension-skipped";

export interface SetupTaskSummary {
  outcome: SetupTaskOutcome;
  webbridgeInstalled: boolean;
  binaryPath: string | null;
  extensionSummary: BrowserInstallSummary[] | null;
  error?: string;
}

const NOOP_LOGGER: WebbridgeSetupTaskLogger = {
  info: () => {},
  error: () => {},
};

export async function runWebbridgeSetupTask(
  deps: WebbridgeSetupTaskDeps,
): Promise<SetupTaskSummary> {
  const log = deps.logger ?? NOOP_LOGGER;
  const shouldFallback = deps.fallbackOnFailure !== false;

  const fail = (
    reason: string,
    error: string,
    binaryPath: string | null,
  ): SetupTaskSummary => {
    log.error(`[webbridge-setup] ${reason}: ${error}`);
    if (shouldFallback) {
      try {
        const current = deps.readConfig();
        const next = deps.applyMode(current, "openclaw");
        // applyMode 返回新对象、current 未被改动，可直接作读时刻快照：窗口期内
        // gateway 落盘的 config.patch 不会被这次降级改写用旧快照覆盖
        deps.writeConfig(next, { baseSnapshot: current });
        deps.onConfigRewritten?.();
      } catch (rewriteErr) {
        const m =
          rewriteErr instanceof Error ? rewriteErr.message : String(rewriteErr);
        log.error(`[webbridge-setup] 降级改写 config 失败: ${m}`);
      }
    }
    return {
      outcome: "fell-back-to-openclaw",
      webbridgeInstalled: false,
      binaryPath,
      extensionSummary: null,
      error,
    };
  };

  // Step 1：下载 webbridge 二进制（precheck 已就绪时跳过）
  let binaryPath: string | null = null;
  let needDownload = !deps.skipBinaryInstall;
  if (deps.skipBinaryInstall) {
    binaryPath = deps.existingBinaryPath ?? null;
    log.info(`[webbridge-setup] 跳过 binary 下载（已就绪）: path=${binaryPath ?? "(unknown)"}`);
    // repair 路径的既有二进制也过钉定校验（R65 复核 P2）：磁盘上的产物可能由
    // 旧版本 App（无钉定时期）落盘或被篡改，执行前必须验哈希。不匹配不作 fail——
    // 上游换新后钉定表更新、而磁盘仍是旧产物是正常场景（R66 实测），此时作废产物
    // 转重下，由下载后校验决断；一次修复动作内收敛，避免用户点两次才成功。
    if (binaryPath && fs.existsSync(binaryPath)) {
      const pinFilename = safeResolveWebbridgePinFilename();
      if (pinFilename) {
        try {
          verifyWebbridgeBinarySha256(binaryPath, pinFilename, undefined, deps.remotePins ?? null);
        } catch (err) {
          log.info(
            `[webbridge-setup] 既有二进制校验失败，转为重新下载: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          binaryPath = null;
          needDownload = true;
        }
      }
    }
  }
  if (needDownload) {
    try {
      const installResult = await deps.installer();
      binaryPath = installResult.binaryPath;
      log.info(
        `[webbridge-setup] 二进制就绪: version=${installResult.version} skipped=${installResult.skipped} path=${installResult.binaryPath}`,
      );
    } catch (err) {
      return fail(
        "二进制下载失败",
        err instanceof Error ? err.message : String(err),
        null,
      );
    }
  }

  // Step 1.5：安装 skill（严格：失败/抛错都降级；precheck 已就绪时跳过）
  if (!deps.skipSkillInstall && deps.installSkill) {
    try {
      const skillResult = await deps.installSkill(binaryPath ?? "");
      if (!skillResult.success) {
        return fail(
          "skill 安装失败",
          skillResult.error ?? "(unknown)",
          binaryPath,
        );
      }
      log.info(
        `[webbridge-setup] skill 安装完成${
          skillResult.output ? `\n${skillResult.output.trimEnd()}` : ""
        }`,
      );
    } catch (err) {
      return fail(
        "skill 安装异常",
        err instanceof Error ? err.message : String(err),
        binaryPath,
      );
    }
  } else if (deps.skipSkillInstall) {
    log.info("[webbridge-setup] 跳过 skill 安装（已就绪）");
  }

  // Step 2 + 3：浏览器扩展（precheck 已就绪时整段跳过——extId 也不再校验）
  let extensionSummary: BrowserInstallSummary[] | null = null;
  if (!deps.skipExtensionInstall) {
    if (!deps.extensionId) {
      return fail(
        "未读到 WebBridge 扩展 ID（resources/webbridge/kimi-webbridge.json 缺失或损坏，严格判失败）",
        "no extension id",
        binaryPath,
      );
    }
    try {
      extensionSummary = await deps.installExtensions(deps.extensionId);
      log.info(
        `[webbridge-setup] 浏览器扩展安装完成: ${extensionSummary
          .map((r) => `${r.browserId}=${r.result}`)
          .join(" ")}`,
      );
    } catch (err) {
      return fail(
        "浏览器扩展批量安装失败",
        err instanceof Error ? err.message : String(err),
        binaryPath,
      );
    }
    // 严格校验：installExtensions 不抛异常但返回不可用结果时同样判失败。
    //   - 空数组：默认浏览器不是 Chrome/Edge（installForDefaultBrowser 路径）
    //   - 全部 result 为 browser-not-installed / 带 error：扩展实际没装上
    // 任何一种情况下都不应让 outcome=webbridge-ready，否则 setup-ipc 不会触发
    // 降级 + 用户进入 webbridge 模式但浏览器接管能力不存在。
    if (extensionSummary.length === 0) {
      return fail(
        "浏览器扩展未安装：默认浏览器不是 Chrome/Edge",
        "no extension target",
        binaryPath,
      );
    }
    const acceptableResults = new Set(["installed", "updated", "skipped"]);
    const anyOk = extensionSummary.some(
      (r) => acceptableResults.has(r.result) && !r.error,
    );
    if (!anyOk) {
      const detail = extensionSummary
        .map((r) => `${r.browserId}=${r.result}${r.error ? `(${r.error})` : ""}`)
        .join(" ");
      return fail(
        "浏览器扩展未安装：所有目标浏览器都失败",
        detail,
        binaryPath,
      );
    }
  } else {
    log.info("[webbridge-setup] 跳过浏览器扩展安装（已就绪）");
  }

  return {
    outcome: "webbridge-ready",
    webbridgeInstalled: true,
    binaryPath,
    extensionSummary,
  };
}

// ═══════════════════════════════════════════════════════════════════
// status（installState / extensionSpec / skill 安装 / precheck）
// ═══════════════════════════════════════════════════════════════════

// ───────────────────────── 状态聚合 ─────────────────────────

export interface WebbridgeInstallState {
  installed: boolean;
  version: string | null;
  binaryPath: string;
  etag: string | null;
  extensionId: string;
  browsers: BrowserState[];
}

export interface GetStateDeps {
  binaryPath: string;
  dataDir: string;
  fileExists: (p: string) => boolean;
  readManifest: (dataDir: string) => CacheManifest | null;
  readExtensionStates: (extId: string) => Promise<BrowserState[]>;
  extensionId: string;
}

export async function getWebbridgeInstallState(
  deps: GetStateDeps,
): Promise<WebbridgeInstallState> {
  const installed = deps.fileExists(deps.binaryPath);

  let version: string | null = null;
  let etag: string | null = null;
  if (installed) {
    try {
      const manifest = deps.readManifest(deps.dataDir);
      if (manifest) {
        version = manifest.version || null;
        etag = manifest.etag || null;
      }
    } catch {
      // disk IO 异常不传导
    }
  }

  let browsers: BrowserState[] = [];
  try {
    browsers = await deps.readExtensionStates(deps.extensionId);
  } catch {
    // reg/fs 异常不传导
  }

  return {
    installed,
    version,
    binaryPath: deps.binaryPath,
    etag,
    extensionId: deps.extensionId,
    browsers,
  };
}

// ───────────────────── ExtensionSpec 组装（sidecar） ─────────────────────

/**
 * 用 sidecar JSON（resources/webbridge/kimi-webbridge.json）+ CRX 文件组装完整 ExtensionSpec。
 * sidecar 是 extId / version 的唯一来源。
 * 任意一段缺失（CRX 没打包进来 / metadata JSON 损坏）→ 返回 null，
 * 调用方决定是降级 openclaw 还是保留现状。
 */
export function resolveWebbridgeExtensionSpec(): ExtensionSpec | null {
  const meta = readWebbridgeCrxMetadata();
  if (!meta) return null;

  const crxPath = resolveWebbridgeCrxPath();
  if (!fs.existsSync(crxPath)) return null;

  return { extId: meta.extensionId, crxPath, crxVersion: meta.version };
}

// ───────────────────────── Skill 安装 ─────────────────────────

export interface SkillInstallResult {
  success: boolean;
  output: string;
  error?: string;
}

export type ExecFileAsync = (
  cmd: string,
  args: string[],
  opts: { timeout: number; windowsHide: boolean },
) => Promise<{ stdout: string; stderr: string }>;

export interface SkillInstallerDeps {
  execFileAsync?: ExecFileAsync;
}

const DEFAULT_SKILL_TIMEOUT_MS = 30_000;

const DEFAULT_EXEC_FILE: ExecFileAsync = (() => {
  const p = promisify(execFile);
  return async (cmd, args, opts) => {
    const res = await p(cmd, args, opts);
    return {
      stdout: String(res.stdout ?? ""),
      stderr: String(res.stderr ?? ""),
    };
  };
})();

export async function installWebbridgeSkill(
  binaryPath: string,
  deps: SkillInstallerDeps = {},
): Promise<SkillInstallResult> {
  const execFileAsync = deps.execFileAsync ?? DEFAULT_EXEC_FILE;
  try {
    const { stdout, stderr } = await execFileAsync(
      binaryPath,
      ["install-skill", "-y"],
      { timeout: DEFAULT_SKILL_TIMEOUT_MS, windowsHide: true },
    );
    const output = (stdout || "") + (stderr ? "\n" + stderr : "");
    return { success: true, output };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: "", error: msg };
  }
}

// ───────────────────────── Precheck ─────────────────────────

// skill 探测根（~/.agents/skills/kimi-webbridge）：与二进制落盘根
// （constants.resolveWebbridgeDataDir = ~/.kimi-webbridge）同源推导（R79）。
// 此前本模块自带的 home() 比 constants 多一层 `|| process.env.HOME` 兜底，
// 从 Git Bash / MSYS（设了 POSIX 形态 HOME）启动时两套解析会分裂——
// skill 探测指错根，precheck 恒报 missing.skill。
function skillPathsRoot(): string {
  return path.dirname(resolveWebbridgeDataDir());
}

// CryoClaw 只关心自己的 OpenClaw runtime（~/.agents/skills/kimi-webbridge）。
// install-skill -y 会顺手装到检测到的其它 AI runtime（Claude / Codex / Kimi CLI），
// 但那些不属于 CryoClaw 必须保证的能力，所以 precheck 只看这一处。
// 注意：延迟到首次访问再求值（模块加载时 HOME 可能尚未由主流程修正）。
export const KIMI_WEBBRIDGE_SKILL_PATHS: string[] = [];
function skillPaths(): string[] {
  if (KIMI_WEBBRIDGE_SKILL_PATHS.length === 0) {
    KIMI_WEBBRIDGE_SKILL_PATHS.push(path.join(skillPathsRoot(), ".agents", "skills", "kimi-webbridge"));
  }
  return KIMI_WEBBRIDGE_SKILL_PATHS;
}

export interface WebbridgePrecheckResult {
  ok: boolean;
  missing: {
    binary: boolean;
    skill: boolean;
    extension: boolean;
  };
  defaultBrowser: { id: string; name: string } | null;
  defaultUnsupported: boolean;
}

export interface WebbridgePrecheckDeps {
  binaryPath: string;
  extensionId: string;
  fileExists: (p: string) => boolean;
  readExtensionStates: (extId: string) => Promise<BrowserState[]>;
  getDefaultBrowser: () => Promise<{ target: { id: string; name: string } } | null>;
  /**
   * 读 openclaw.json 里 `skills.entries["kimi-webbridge"].enabled`：
   * - undefined → 视为已启用（缺省即启用）
   * - true → 已启用
   * - false → 配合 currentBrowserMode 一起判断是漂移还是正常状态
   * 不注入 → 默认 true（向后兼容旧调用方）。
   */
  readSkillEnabled?: () => boolean | undefined;
  /**
   * 用户当前实际所处的浏览器模式（来自 detectBrowserMode(config)）。
   * 用来区分 enabled=false 是"漂移"还是"当前模式的预期值"：
   *   - "webbridge" + enabled=false → 漂移（用户从 chat-ui 关掉了），算 missing.skill
   *   - 其他模式 + enabled=false   → 当前模式的预期（applyBrowserModeConfig 写的就是 false），
   *                                  切换到 webbridge 时会被翻回 true，不算 missing
   * 不注入 → 当 webbridge 处理（保留旧行为，向后兼容）。
   */
  currentBrowserMode?: "webbridge" | "openclaw" | "user";
  skillPaths?: string[];
}

export async function getWebbridgePrecheck(
  deps: WebbridgePrecheckDeps,
): Promise<WebbridgePrecheckResult> {
  const resolvedSkillPaths = deps.skillPaths ?? skillPaths();

  const binaryMissing = !deps.fileExists(deps.binaryPath);
  const fileMissing = !resolvedSkillPaths.some((p) => deps.fileExists(p));
  // 文件在但被 disable 才算 missing 的前提：用户当前已处于 webbridge 模式
  // （否则 enabled=false 是 openclaw/chrome 模式的正常配置，模式切换会自动翻回 true）。
  const skillEnabled = deps.readSkillEnabled?.() ?? true;
  const currentMode = deps.currentBrowserMode ?? "webbridge";
  const skillDisabledDrift =
    currentMode === "webbridge" && skillEnabled === false;
  const skillMissing = fileMissing || skillDisabledDrift;

  const def = await deps.getDefaultBrowser();
  const defaultUnsupported = !def;
  const defaultBrowser = def
    ? { id: def.target.id, name: def.target.name }
    : null;

  let extMissing: boolean;
  if (!deps.extensionId || defaultUnsupported) {
    extMissing = true;
  } else {
    try {
      const browsers = await deps.readExtensionStates(deps.extensionId);
      const targetState = browsers.find((b) => b.browserId === def!.target.id);
      // settings 高级页面只关心"CryoClaw 这套组件是否真的坏了 / 缺了 / 被黑名单挡了"。
      // 不再判 presentInChrome：用户在 Chrome 里有没有点"启用"是用户行为，
      // 不是 CryoClaw 能修的状态——左侧栏 pill 单独负责催用户去启用。
      extMissing = !(
        targetState?.installed &&
        targetState.configured &&
        !targetState.blocklisted
      );
    } catch {
      extMissing = true;
    }
  }

  return {
    ok: !binaryMissing && !skillMissing && !extMissing,
    missing: {
      binary: binaryMissing,
      skill: skillMissing,
      extension: extMissing,
    },
    defaultBrowser,
    defaultUnsupported,
  };
}
