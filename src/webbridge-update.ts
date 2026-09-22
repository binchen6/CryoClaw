/**
 * webbridge-update.ts — WebBridge 版本状态 / 检查更新 / 自动更新管线（R79）
 *
 * 数据源优先级：
 *   - daemon `GET /status`（默认 127.0.0.1:10086，1.5s 超时）——daemon 自己会查
 *     最新版，`update_available {current, latest}` 是最可信来源；
 *   - manifest（~/.kimi-webbridge/.download-cache.json）的 version / sha256 / adopted；
 *   - CDN HEAD latest 的 ETag（daemon 没跑时的更新信号：与 manifest etag 不同
 *     = 可能有更新）。
 * 检查结果持久化到 ~/.kimi-webbridge/.update-check.json（含 checkedAt 与
 * autoUpdate 开关，默认 true = 静默检查发现新版本后自动换装）。
 *
 * 并发护栏（F4）：repair-and-enable / pill-repair / setup:complete 后台任务 /
 * applyWebbridgeUpdate 共用 runWebbridgeExclusive 单例锁；锁忙抛
 * WebbridgeBusyError（IPC 层转 code=WEBBRIDGE_BUSY）。
 *
 * 换装管线（F3）：下载到独立 tmp → sha256 校验（fail-closed：未命中钉定
 * 保留旧版本不替换）→ 停 daemon → rename（文件锁退避重试）→ 写 manifest →
 * 按需重启 daemon → install-skill -y 刷新 skill → 广播 webbridge:state-changed。
 */
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import { resolveWebbridgeDataDir, resolveWebbridgeBinaryPath } from "./constants";
import {
  CDN_BASE_URL,
  downloadToFileWithRetry,
  httpHeadWithRetry,
  installWebbridgeSkill,
  readCacheManifest,
  renameWithRetry,
  resolvePlatformBinaryName,
  resolveWebbridgeVersion,
  sha256FileSync,
  verifyWebbridgeBinarySha256,
  writeCacheManifest,
  type CacheManifest,
  type ProgressHandler,
} from "./webbridge";
import { loadRemotePins } from "./webbridge-pins";
import * as log from "./logger";

// ═══════════════════════════════════════════════════════════════════
// 并发护栏（F4）：模块级单例锁
// ═══════════════════════════════════════════════════════════════════

export class WebbridgeBusyError extends Error {
  readonly code = "WEBBRIDGE_BUSY";
  constructor() {
    super("Another WebBridge operation is in progress");
    this.name = "WebbridgeBusyError";
  }
}

let exclusiveBusy = false;

/** 是否有 WebBridge 独占操作（修复 / setup 任务 / 换装）在跑。 */
export function isWebbridgeExclusiveBusy(): boolean {
  return exclusiveBusy;
}

/**
 * 独占执行 fn：busy 标志在首个 await 前同步置位（Node 单线程，check-then-set
 * 原子），锁忙直接抛 WebbridgeBusyError，不排队——调用方（IPC 层）把它转成
 * 明确的 WEBBRIDGE_BUSY 错误码让 UI 提示「正在进行另一项 WebBridge 操作」。
 */
export async function runWebbridgeExclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (exclusiveBusy) throw new WebbridgeBusyError();
  exclusiveBusy = true;
  try {
    return await fn();
  } finally {
    exclusiveBusy = false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// daemon /status 探测
// ═══════════════════════════════════════════════════════════════════

export const DEFAULT_DAEMON_STATUS_URL = "http://127.0.0.1:10086/status";
const DAEMON_STATUS_TIMEOUT_MS = 1_500;

export interface WebbridgeDaemonStatus {
  running: boolean;
  /** daemon 二进制版本（/status.version） */
  version: string | null;
  /** 已连接的浏览器扩展版本（未连接为 null） */
  extensionVersion: string | null;
  updateAvailable: { current: string | null; latest: string | null } | null;
  versionMismatch: boolean;
}

// daemon 监听地址解析：daemon.addr（运行时实际绑定）> config.json addr > 默认。
// 两者的形态都可能是 "host:port"；防御性解析，坏文件直接走默认。
function parseAddrRaw(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t.replace(/\/+$/, "");
  if (/^\d+$/.test(t)) return `http://127.0.0.1:${t}`;
  const m = t.match(/^([\w.-]+):(\d+)$/);
  if (m) return `http://${m[1]}:${m[2]}`;
  return null;
}

export function resolveDaemonStatusUrl(dataDir: string): string {
  for (const rel of ["daemon.addr", "config.json"]) {
    try {
      const raw = fs.readFileSync(path.join(dataDir, rel), "utf-8");
      const candidate = rel === "config.json"
        ? String((JSON.parse(raw) as { addr?: unknown })?.addr ?? "")
        : raw;
      const base = parseAddrRaw(candidate);
      if (base) return `${base}/status`;
    } catch {
      // 文件不存在 / 损坏 → 下一个来源
    }
  }
  return DEFAULT_DAEMON_STATUS_URL;
}

/**
 * GET /status（1.5s 超时）。任何失败（连接拒绝 / 超时 / 非 daemon JSON）都返回
 * null = daemon 未运行；永不抛错。
 */
export function fetchWebbridgeDaemonStatus(opts: {
  dataDir?: string;
  url?: string;
  timeoutMs?: number;
} = {}): Promise<WebbridgeDaemonStatus | null> {
  const url = opts.url ?? resolveDaemonStatusUrl(opts.dataDir ?? resolveWebbridgeDataDir());
  const timeoutMs = opts.timeoutMs ?? DAEMON_STATUS_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: WebbridgeDaemonStatus | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const req = http.get(url, (res) => {
      const status = res.statusCode ?? 0;
      if (status !== 200) {
        res.resume();
        return done(null);
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
          // 非 daemon 程序应答（缺 running 布尔）按未运行处理
          if (typeof parsed?.running !== "boolean") return done(null);
          const ua = parsed.update_available as { current?: unknown; latest?: unknown } | undefined;
          done({
            running: parsed.running === true,
            version: typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : null,
            extensionVersion:
              typeof parsed.extension_version === "string" && parsed.extension_version.trim()
                ? parsed.extension_version.trim()
                : null,
            updateAvailable: ua
              ? {
                  current: typeof ua.current === "string" ? ua.current : null,
                  latest: typeof ua.latest === "string" ? ua.latest : null,
                }
              : null,
            // daemon /status 契约：version_mismatch 是布尔字段（缺失 = 无错配），
            // 因此严格 === true。旧写法 `!= null` 把 daemon 明确返回的 false 也
            // 判成错配（缺字段与 false 必须区分）。
            versionMismatch: parsed.version_mismatch === true,
          });
        } catch {
          done(null);
        }
      });
      res.on("error", () => done(null));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`daemon status timeout ${timeoutMs}ms`));
    });
    req.on("error", () => done(null));
  });
}

// ═══════════════════════════════════════════════════════════════════
// .update-check.json（检查结果 + autoUpdate 开关）
// ═══════════════════════════════════════════════════════════════════

const UPDATE_CHECK_FILE_NAME = ".update-check.json";

export interface WebbridgeUpdateCheckState {
  checkedAt: string | null;
  /** 自动更新开关（默认 true：静默检查发现新版本后自动换装）。 */
  autoUpdate: boolean;
  updateAvailable: { current: string | null; latest: string | null } | null;
  etag: string | null;
  source: "daemon" | "etag" | "cache" | "offline" | null;
}

export function readUpdateCheckState(dataDir: string): WebbridgeUpdateCheckState {
  const fallback: WebbridgeUpdateCheckState = {
    checkedAt: null,
    autoUpdate: true,
    updateAvailable: null,
    etag: null,
    source: null,
  };
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dataDir, UPDATE_CHECK_FILE_NAME), "utf-8"),
    ) as Partial<WebbridgeUpdateCheckState>;
    if (typeof parsed !== "object" || parsed === null) return fallback;
    return {
      checkedAt: typeof parsed.checkedAt === "string" ? parsed.checkedAt : null,
      autoUpdate: parsed.autoUpdate !== false,
      updateAvailable:
        parsed.updateAvailable && typeof parsed.updateAvailable === "object"
          ? {
              current: parsed.updateAvailable.current ?? null,
              latest: parsed.updateAvailable.latest ?? null,
            }
          : null,
      etag: typeof parsed.etag === "string" ? parsed.etag : null,
      source:
        parsed.source === "daemon" || parsed.source === "etag" || parsed.source === "cache" || parsed.source === "offline"
          ? parsed.source
          : null,
    };
  } catch {
    return fallback;
  }
}

export function writeUpdateCheckState(
  dataDir: string,
  patch: Partial<WebbridgeUpdateCheckState>,
): WebbridgeUpdateCheckState {
  const next = { ...readUpdateCheckState(dataDir), ...patch };
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, UPDATE_CHECK_FILE_NAME), JSON.stringify(next, null, 2), "utf-8");
  } catch (err) {
    log.info(`[webbridge-update] 写 .update-check.json 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  return next;
}

// ═══════════════════════════════════════════════════════════════════
// F2：版本状态 + 检查更新
// ═══════════════════════════════════════════════════════════════════

export interface WebbridgeVersionStatus {
  installed: boolean;
  installedVersion: string | null;
  installSource: "cryoclaw" | "adopted" | null;
  daemonRunning: boolean;
  daemonVersion: string | null;
  extensionVersion: string | null;
  updateAvailable: { current: string | null; latest: string | null } | null;
  autoUpdate: boolean;
  lastCheckedAt: string | null;
  checkedAt: string;
}

export async function getWebbridgeVersionStatus(opts: {
  dataDir?: string;
  binaryPath?: string;
  /** 预取的 daemon 状态（测试 / 复用场景注入；undefined = 现查） */
  daemonStatus?: WebbridgeDaemonStatus | null;
} = {}): Promise<WebbridgeVersionStatus> {
  const dataDir = opts.dataDir ?? resolveWebbridgeDataDir();
  const binaryPath = opts.binaryPath ?? resolveWebbridgeBinaryPath();
  const installed = fs.existsSync(binaryPath);
  const manifest: CacheManifest | null = installed ? readCacheManifest(dataDir) : null;
  const daemon =
    opts.daemonStatus !== undefined ? opts.daemonStatus : await fetchWebbridgeDaemonStatus({ dataDir });
  const checkState = readUpdateCheckState(dataDir);

  // manifest.version 生产路径是 "latest" 别名（无信息量）→ 优先具体版本：
  // 采纳时记录的探测版本 > daemon 上报版本 > null。
  const manifestVersion = manifest?.version?.trim();
  const installedVersion =
    manifestVersion && manifestVersion !== "latest"
      ? manifestVersion
      : daemon?.version ?? null;

  return {
    installed,
    installedVersion,
    installSource: !installed ? null : manifest?.adopted === true ? "adopted" : manifest ? "cryoclaw" : null,
    daemonRunning: daemon?.running === true,
    daemonVersion: daemon?.version ?? null,
    extensionVersion: daemon?.extensionVersion ?? null,
    updateAvailable: daemon?.updateAvailable ?? checkState.updateAvailable ?? null,
    autoUpdate: checkState.autoUpdate,
    lastCheckedAt: checkState.checkedAt,
    checkedAt: new Date().toISOString(),
  };
}

export interface WebbridgeUpdateCheckResult {
  checkedAt: string;
  source: "daemon" | "etag" | "cache" | "offline";
  updateAvailable: { current: string | null; latest: string | null } | null;
  etag: string | null;
  error?: string;
}

const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 检查更新（daemon 权威：在跑就用 /status 的 update_available；没跑则 HEAD CDN
 * latest 拿 ETag 与 manifest 比对，不同 = 可能有更新）。结果持久化到
 * .update-check.json；24h 内的重复调用直接回缓存（force=true 除外）。
 */
export async function checkWebbridgeUpdate(opts: {
  dataDir?: string;
  force?: boolean;
  daemonStatus?: WebbridgeDaemonStatus | null;
  cdnBaseUrl?: string;
} = {}): Promise<WebbridgeUpdateCheckResult> {
  const dataDir = opts.dataDir ?? resolveWebbridgeDataDir();
  const cached = readUpdateCheckState(dataDir);
  if (
    !opts.force &&
    cached.checkedAt &&
    Number.isFinite(Date.parse(cached.checkedAt)) &&
    Date.now() - Date.parse(cached.checkedAt) < AUTO_CHECK_INTERVAL_MS
  ) {
    return {
      checkedAt: cached.checkedAt,
      source: "cache",
      updateAvailable: cached.updateAvailable,
      etag: cached.etag,
    };
  }

  const checkedAt = new Date().toISOString();
  const daemon =
    opts.daemonStatus !== undefined ? opts.daemonStatus : await fetchWebbridgeDaemonStatus({ dataDir });

  // daemon 在跑：/status 的 update_available 是最可信来源（daemon 自己查最新版）
  if (daemon?.running) {
    const next = writeUpdateCheckState(dataDir, {
      checkedAt,
      source: "daemon",
      updateAvailable: daemon.updateAvailable,
      etag: cached.etag,
    });
    return {
      checkedAt,
      source: "daemon",
      updateAvailable: next.updateAvailable,
      etag: next.etag,
    };
  }

  // daemon 没跑：HEAD CDN latest，ETag 与 manifest 不同 = 可能有更新
  const manifest = readCacheManifest(dataDir);
  const filename = resolvePlatformBinaryName(process.platform, process.arch);
  const url = `${opts.cdnBaseUrl ?? CDN_BASE_URL}/${resolveWebbridgeVersion()}/releases/${filename}`;
  try {
    const head = await httpHeadWithRetry(url, 1);
    const etagChanged = head.etag !== null && manifest?.etag !== head.etag;
    const updateAvailable = etagChanged
      ? { current: manifest?.version && manifest.version !== "latest" ? manifest.version : null, latest: null }
      : null;
    writeUpdateCheckState(dataDir, { checkedAt, source: "etag", updateAvailable, etag: head.etag });
    return { checkedAt, source: "etag", updateAvailable, etag: head.etag };
  } catch (err) {
    // 离线 / CDN 不可达：保留上次的 updateAvailable 判断，只刷新 checkedAt
    const message = err instanceof Error ? err.message : String(err);
    writeUpdateCheckState(dataDir, { checkedAt, source: "offline" });
    return {
      checkedAt,
      source: "offline",
      updateAvailable: cached.updateAvailable,
      etag: cached.etag,
      error: message,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
// F3：自动更新管线
// ═══════════════════════════════════════════════════════════════════

export type WebbridgeUpdateResult =
  | { ok: true; from: string | null; to: string | null; etag: string | null; daemonRestarted: boolean }
  | {
      ok: false;
      reason: "busy" | "not-installed" | "head-failed" | "download-failed" | "pin-stale";
      message?: string;
    };

export interface ApplyWebbridgeUpdateOptions {
  dataDir?: string;
  binaryPath?: string;
  platform?: NodeJS.Platform | string;
  arch?: string;
  cdnBaseUrl?: string;
  onProgress?: ProgressHandler;
  maxRetries?: number;
  /** 远端钉定清单提供者（测试注入；缺省 = loadRemotePins 强制刷新）。 */
  remotePinsProvider?: () => Promise<Record<string, string> | null>;
  /** daemon 状态提供者（测试注入；缺省 = fetchWebbridgeDaemonStatus）。 */
  fetchDaemonStatus?: () => Promise<WebbridgeDaemonStatus | null>;
  /** skill 刷新注入（测试注入；缺省 = installWebbridgeSkill）。 */
  installSkill?: (binaryPath: string) => Promise<{ success: boolean; output: string; error?: string }>;
}

const DAEMON_STOP_TIMEOUT_MS = 5_000;
const UPDATE_MAX_RETRIES = 2;

/** 公共入口：与修复 / setup 任务共用同一把独占锁（F4）。 */
export async function applyWebbridgeUpdate(
  options: ApplyWebbridgeUpdateOptions = {},
): Promise<WebbridgeUpdateResult> {
  if (isWebbridgeExclusiveBusy()) return { ok: false, reason: "busy" };
  try {
    return await runWebbridgeExclusive(() => applyWebbridgeUpdateLocked(options));
  } catch (err) {
    if (err instanceof WebbridgeBusyError) return { ok: false, reason: "busy" };
    throw err;
  }
}

async function applyWebbridgeUpdateLocked(
  options: ApplyWebbridgeUpdateOptions,
): Promise<WebbridgeUpdateResult> {
  const dataDir = options.dataDir ?? resolveWebbridgeDataDir();
  const binaryPath = options.binaryPath ?? resolveWebbridgeBinaryPath();
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const maxRetries = options.maxRetries ?? UPDATE_MAX_RETRIES;

  if (!fs.existsSync(binaryPath)) {
    return { ok: false, reason: "not-installed" };
  }

  const oldManifest = readCacheManifest(dataDir);
  const filename = resolvePlatformBinaryName(platform, arch);
  const base = options.cdnBaseUrl ?? CDN_BASE_URL;
  const url = `${base}/${resolveWebbridgeVersion()}/releases/${filename}`;

  // 1. HEAD 拿 ETag（manifest 记录 + 更新判定）
  let head;
  try {
    head = await httpHeadWithRetry(url, maxRetries);
  } catch (err) {
    return {
      ok: false,
      reason: "head-failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (head.etag && oldManifest?.etag === head.etag) {
    // ETag 一致 = CDN 内容没变，无需换装（幂等成功）
    return { ok: true, from: oldManifest.version || null, to: oldManifest.version || null, etag: head.etag, daemonRestarted: false };
  }

  const fetchDaemon =
    options.fetchDaemonStatus ?? (() => fetchWebbridgeDaemonStatus({ dataDir }));
  const daemonBefore = await fetchDaemon();
  const daemonWasRunning = daemonBefore?.running === true;

  // 2. 下载到独立 tmp（绝不清写旧产物——校验不过时保留旧版本继续可用）
  const tmpPath = `${binaryPath}.update-tmp-${process.pid}-${Date.now()}`;
  try {
    await downloadToFileWithRetry(url, tmpPath, maxRetries, options.onProgress);
  } catch (err) {
    return {
      ok: false,
      reason: "download-failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // 3. sha256 校验（fail-closed 保守保留）：命中远端/内置钉定才允许换装；
  //    KIMI_WEBBRIDGE_SKIP_PIN=1 逃生门仍生效（verifyWebbridgeBinarySha256 内）。
  //    更新场景比安装更保守——绝不裸装未钉定的新产物替换能用的旧版本。
  const loadPins =
    options.remotePinsProvider ??
    (async () => (await loadRemotePins({ dataDir, forceRefresh: true }).catch(() => ({ pins: null }))).pins);
  let remotePins: Record<string, string> | null = null;
  try {
    remotePins = await loadPins();
  } catch {
    remotePins = null;
  }
  try {
    verifyWebbridgeBinarySha256(tmpPath, filename, undefined, remotePins);
  } catch (err) {
    // verify 已删 tmp；旧二进制原封不动
    return {
      ok: false,
      reason: "pin-stale",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // 3.5 内容级幂等：CDN HEAD 不回 ETag（或 ETag 变化但内容未变）时，上方 ETag
  // 短路不会命中；下载后比对 sha256，内容未变则丢弃 tmp 直接幂等返回——
  // 避免每 24h 自动检查都白白停/启 daemon（打断浏览器扩展连接）。
  if (oldManifest?.sha256) {
    const tmpSha = sha256FileSync(tmpPath);
    if (tmpSha === oldManifest.sha256 && oldManifest.sha256 === sha256FileSync(binaryPath)) {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {}
      return {
        ok: true,
        from: oldManifest.version || null,
        to: oldManifest.version || null,
        etag: head.etag ?? null,
        daemonRestarted: false,
      };
    }
  }

  // 4. 换文件前处理文件锁：daemon 在跑先 stop（等 5s）
  if (daemonWasRunning) {
    await stopDaemonAndWait(binaryPath, dataDir);
  }

  // 5. rename（EPERM/EBUSY 退避重试）+ chmod + 写新 manifest。
  //    daemon 已 stop：这一段里任何失败都必须先尽力恢复 daemon 再返回——否则
  //    浏览器桥静默死亡直到下次 App 启动。binaryPath 处的二进制始终可启动：
  //    rename 失败时是旧版仍在原位，rename 成功后是已过 pin 校验的新版，
  //    两种情形都直接从 binaryPath 拉起。
  let newSha: string;
  try {
    await renameWithRetry(tmpPath, binaryPath);
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(binaryPath, 0o755);
      } catch {}
    }
    newSha = sha256FileSync(binaryPath);
    writeCacheManifest(dataDir, {
      version: resolveWebbridgeVersion(),
      etag: head.etag,
      lastModified: head.lastModified,
      contentLength: head.contentLength,
      sha256: newSha,
      adopted: false,
    });
    writeUpdateCheckState(dataDir, { updateAvailable: null, etag: head.etag });
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {}
    const message = `swap failed: ${err instanceof Error ? err.message : String(err)}`;
    restoreDaemonAfterFailedSwap(binaryPath, daemonWasRunning);
    log.error(`[webbridge-update] 换装失败（daemon 已尽力恢复）: ${message}`);
    return {
      ok: false,
      reason: "download-failed",
      message,
    };
  }
  log.info(
    `[webbridge-update] 二进制已换装: etag=${head.etag ?? "(none)"} sha256=${newSha.slice(0, 12)}…`,
  );

  // 6. 更新前 daemon 在跑 → 重启；再刷新 skill（skill 与二进制版本配对）
  if (daemonWasRunning) {
    startDaemonDetached(binaryPath);
  }
  const installSkill = options.installSkill ?? ((bp: string) => installWebbridgeSkill(bp));
  const skill = await installSkill(binaryPath);
  if (!skill.success) {
    // 更新本身已成功；skill 刷新失败只记日志（下次修复路径会补）
    log.error(`[webbridge-update] install-skill 刷新失败: ${skill.error ?? "unknown"}`);
  }

  broadcastWebbridgeStateChanged();
  return {
    ok: true,
    from: oldManifest?.version || null,
    to: resolveWebbridgeVersion(),
    etag: head.etag,
    daemonRestarted: daemonWasRunning,
  };
}

// spawn 子进程等待退出（daemon stop 语义：返回即已停止）
function spawnAndWait(
  binaryPath: string,
  args: string[],
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    try {
      const child = require("child_process").spawn(binaryPath, args, {
        stdio: "ignore",
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        resolve();
      }, timeoutMs);
      child.on("error", () => {
        clearTimeout(timer);
        resolve();
      });
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

async function stopDaemonAndWait(binaryPath: string, dataDir: string): Promise<void> {
  await spawnAndWait(binaryPath, ["stop"], 8_000);
  const deadline = Date.now() + DAEMON_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const st = await fetchWebbridgeDaemonStatus({ dataDir });
    if (!st?.running) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

// 换装失败后恢复 daemon：本身再包一层 try/catch——恢复启动失败必须醒目落日志，
// 否则又是一种静默（daemon 停着，浏览器扩展连不上，用户无感知）。
function restoreDaemonAfterFailedSwap(binaryPath: string, daemonWasRunning: boolean): void {
  if (!daemonWasRunning) return;
  try {
    startDaemonDetached(binaryPath);
  } catch (err) {
    log.error(
      `[webbridge-update] 换装失败且恢复 daemon 启动异常（浏览器桥将保持停止直到 App 重启）: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function startDaemonDetached(binaryPath: string): void {
  try {
    const child = require("child_process").spawn(binaryPath, ["start"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch (err) {
    log.error(`[webbridge-update] daemon 重启失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 自动检查接线（gateway ready + webbridge 模式 + >24h → 静默 check）
// ═══════════════════════════════════════════════════════════════════

// 广播 webbridge:state-changed（默认实现 lazy require electron——本模块会被
// node --test 导入，顶层 import electron 会拖垮测试运行器）
let broadcastOverride: (() => void) | null = null;

/** 测试注入口：替换默认的窗口广播。 */
export function setWebbridgeStateChangedBroadcastForTests(fn: (() => void) | null): void {
  broadcastOverride = fn;
}

export function broadcastWebbridgeStateChanged(): void {
  if (broadcastOverride) {
    broadcastOverride();
    return;
  }
  try {
    const { BrowserWindow } = require("electron") as typeof import("electron");
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("webbridge:state-changed");
    }
  } catch {
    // 非 Electron 环境（node --test）忽略
  }
}

/**
 * gateway ready 后调用：浏览器模式为 webbridge 且距上次检查 >24h 时静默 check
 * 一次（不弹 UI，只更新 .update-check.json + 广播 state-changed）；
 * autoUpdate 开着且发现新版本 → 直接走换装管线。永不抛错、不阻塞调用方。
 */
export async function maybeAutoCheckWebbridgeUpdate(): Promise<void> {
  try {
    // 模式判定 lazy require：保持本模块导入图对 node --test 友好
    const { readUserConfig } = require("./provider-config") as typeof import("./provider-config");
    const { detectBrowserMode } = require("./browser") as typeof import("./browser");
    if (detectBrowserMode(readUserConfig()) !== "webbridge") return;
  } catch {
    return;
  }
  const dataDir = resolveWebbridgeDataDir();
  if (!fs.existsSync(resolveWebbridgeBinaryPath())) return;
  const state = readUpdateCheckState(dataDir);
  if (
    state.checkedAt &&
    Number.isFinite(Date.parse(state.checkedAt)) &&
    Date.now() - Date.parse(state.checkedAt) < AUTO_CHECK_INTERVAL_MS
  ) {
    return;
  }
  try {
    const result = await checkWebbridgeUpdate({ dataDir });
    log.info(
      `[webbridge-update] 自动检查完成: source=${result.source} update=${result.updateAvailable ? "yes" : "no"}${
        result.error ? ` error=${result.error}` : ""
      }`,
    );
    if (result.updateAvailable && readUpdateCheckState(dataDir).autoUpdate) {
      const applied = await applyWebbridgeUpdate({ dataDir });
      log.info(
        applied.ok
          ? `[webbridge-update] 自动更新完成: from=${applied.from ?? "?"} daemonRestarted=${applied.daemonRestarted}`
          : `[webbridge-update] 自动更新跳过: reason=${applied.reason}`,
      );
    } else if (result.updateAvailable) {
      // autoUpdate 关闭：只广播状态（设置页 / pill 侧自行刷新）
      broadcastWebbridgeStateChanged();
    }
  } catch (err) {
    log.info(`[webbridge-update] 自动检查失败（忽略）: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// daemon 保活（R86）
// ═══════════════════════════════════════════════════════════════════

/**
 * gateway ready 后调用：webbridge 模式下确保 daemon 在运行。
 * 背景：daemon 平时由 AI 技能按需启动，应用侧从不拉起——重启电脑 / daemon 崩溃 /
 * 换装中断后，浏览器扩展一直连不上（用户看到「无法连接到已安装插件的浏览器」），
 * 直到某次技能调用把它救活。此处启动时探测一次 /status，未运行则 detached 拉起。
 * 幂等：已在运行不重复启动。永不抛错。
 * 返回 true = 本次确实拉起了 daemon（调用方可延迟广播 state-changed 让 pill 重判）。
 */
export async function ensureWebbridgeDaemonRunning(): Promise<boolean> {
  try {
    const { readUserConfig } = require("./provider-config") as typeof import("./provider-config");
    const { detectBrowserMode } = require("./browser") as typeof import("./browser");
    if (detectBrowserMode(readUserConfig()) !== "webbridge") return false;
  } catch {
    return false;
  }
  const binaryPath = resolveWebbridgeBinaryPath();
  if (!fs.existsSync(binaryPath)) return false;
  const dataDir = resolveWebbridgeDataDir();
  const status = await fetchWebbridgeDaemonStatus({ dataDir });
  if (status?.running) return false;
  log.info("[webbridge-update] daemon 未运行，启动时拉起（webbridge 模式保活）");
  startDaemonDetached(binaryPath);
  return true;
}
