/**
 * webbridge-extension-update.ts — 浏览器扩展（CRX）运行时更新管线（schema v3）
 *
 * 背景：浏览器扩展历史上是随 App 打包的静态 CRX（resources/webbridge/kimi-webbridge.crx），
 * 经 external_crx 离线协议安装，永不在客户端自我更新——上游扩展修 bug 必须等 CryoClaw
 * 发版。本模块让扩展跟 WebBridge 钉定清单（resources/webbridge-pins.json v3 的
 * extension 块）同步更新，无需 App 发版：
 *
 *   CI（refresh-webbridge-pins.mjs）查询 Chrome Web Store update2 端点 → 发现新版
 *   → 下载 CRX、sha256、镜像进仓库 resources/webbridge/extension/ → 更新清单。
 *   客户端从 jsDelivr/raw 拉清单（24h 缓存）→ 比对当前生效版本 → 下载镜像 CRX
 *   → sha256 钉定校验 → 解析 CRX 内 manifest.json 复核 version → 落盘
 *   ~/.kimi-webbridge/extension/ → 把已配置该扩展的浏览器重指到新 CRX
 *   （external_crx 协议：浏览器下次启动时生效）。
 *
 * 安全边界：CRX 的 extId 必须等于内置 sidecar 的 id（Chrome 公钥 fingerprint
 * 决定，伪造 CRX 无法复用该 id）；sha256 精确命中清单数组；CRX 内嵌 version
 * 必须等于清单宣告值。任一不过 → 拒装，旧扩展不动（fail closed）。
 *
 * 与 daemon 换装共用 runWebbridgeExclusive 单例锁（F4），永不抛错到调用方
 * 以外的任何地方——失败只进返回值与日志。
 */
import * as fs from "fs";
import * as path from "path";
import * as log from "./logger";
import { resolveWebbridgeDataDir, readWebbridgeCrxMetadata } from "./constants";
import {
  downloadToFileWithRetry,
  sha256FileSync,
} from "./webbridge";
import {
  compareExtensionVersions,
  extensionCrxUrls,
  loadRemoteExtensionPin,
  resolvePinsUrls,
  type RemoteExtensionPin,
} from "./webbridge-pins";
import {
  broadcastWebbridgeStateChanged,
  runWebbridgeExclusive,
  WebbridgeBusyError,
  isWebbridgeExclusiveBusy,
} from "./webbridge-update";
import type { ExtensionSpec } from "./browser";

// ═══════════════════════════════════════════════════════════════════
// 运行时扩展存储（~/.kimi-webbridge/extension/）
// ═══════════════════════════════════════════════════════════════════

const EXTENSION_DIR_NAME = "extension";
const EXTENSION_POINTER_NAME = "current.json";

export function resolveRuntimeExtensionDir(dataDir: string): string {
  return path.join(dataDir, EXTENSION_DIR_NAME);
}

interface RuntimeExtensionPointer {
  extensionId: string;
  version: string;
  file: string; // 目录内文件名（kimi-webbridge-<v>.crx）
}

function readRuntimePointer(dataDir: string): RuntimeExtensionPointer | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(resolveRuntimeExtensionDir(dataDir), EXTENSION_POINTER_NAME), "utf-8"),
    );
    const extensionId = typeof parsed?.extensionId === "string" ? parsed.extensionId.trim() : "";
    const version = typeof parsed?.version === "string" ? parsed.version.trim() : "";
    const file = typeof parsed?.file === "string" ? parsed.file.trim() : "";
    if (!extensionId || !version || !file) return null;
    // 防目录穿越：file 必须是裸文件名
    if (file !== path.basename(file)) return null;
    return { extensionId, version, file };
  } catch {
    return null;
  }
}

/**
 * 运行时扩展 spec（指针 + CRX 存在 + id 与内置 sidecar 一致才采纳）。
 * id 不一致说明指针被伪造/串台——Chrome 会用 fingerprint 拒绝，我们也拒绝。
 * expectedId 为测试注入口（缺省 = 内置 sidecar 的 extensionId）。
 */
export function readRuntimeExtensionSpec(dataDir: string, expectedId?: string): ExtensionSpec | null {
  const ptr = readRuntimePointer(dataDir);
  if (!ptr) return null;
  const bundledId = expectedId ?? readWebbridgeCrxMetadata()?.extensionId;
  if (!bundledId || bundledId !== ptr.extensionId) return null;
  const crxPath = path.join(resolveRuntimeExtensionDir(dataDir), ptr.file);
  if (!fs.existsSync(crxPath)) return null;
  return { extId: ptr.extensionId, crxPath, crxVersion: ptr.version };
}

/**
 * 生效扩展 spec：运行时 CRX 优先，内置打包 CRX 兜底。
 * 这是安装/修复路径应使用的唯一入口（webbridge.ts 的 resolveWebbridgeExtensionSpec
 * 只看内置包，保留给对比/兜底判断）。
 */
export function resolveEffectiveExtensionSpec(dataDir?: string): ExtensionSpec | null {
  const dir = dataDir ?? resolveWebbridgeDataDir();
  const runtime = readRuntimeExtensionSpec(dir);
  if (runtime) return runtime;
  // lazy require 避免与 webbridge.ts 形成模块环（webbridge.ts 被本模块导入）
  const { resolveWebbridgeExtensionSpec } = require("./webbridge") as typeof import("./webbridge");
  return resolveWebbridgeExtensionSpec();
}

/** 当前生效扩展版本（状态展示用；未安装返回 null）。 */
export function currentEffectiveExtensionVersion(dataDir?: string): string | null {
  return resolveEffectiveExtensionSpec(dataDir)?.crxVersion ?? null;
}

// ═══════════════════════════════════════════════════════════════════
// CRX 解析（Cr24 头 + zip 内 manifest.json）
// ═══════════════════════════════════════════════════════════════════

export interface CrxInfo {
  version: string;
}

/**
 * 解析 CRX（v2/v3）内嵌 manifest.json 的 version。
 * CRX3 头：magic(4) "Cr24" + version u32(=3) + headerLen u32 + header(protobuf) + zip。
 * CRX2 头：magic + version u32(=2) + pubkeyLen u32 + sigLen u32 + pubkey + sig + zip。
 * 不解 protobuf——信任锚是 sha256 钉定 + extId 等值（见模块头注释），
 * 这里只需要 zip 里 manifest.json 的 version（external_crx 协议要求它与
 * 注册表宣告值一致）。
 */
export function parseCrxManifestVersion(buf: Buffer): string | null {
  try {
    if (buf.length < 16 || buf.toString("latin1", 0, 4) !== "Cr24") return null;
    const format = buf.readUInt32LE(4);
    let zipStart: number;
    if (format === 3) {
      const headerLen = buf.readUInt32LE(8);
      zipStart = 12 + headerLen;
    } else if (format === 2) {
      const pubLen = buf.readUInt32LE(8);
      const sigLen = buf.readUInt32LE(12);
      zipStart = 16 + pubLen + sigLen;
    } else {
      return null;
    }
    if (zipStart >= buf.length) return null;
    // lazy require：fflate 是 dependencies 一员；测试环境同样可用
    const { unzipSync } = require("fflate") as typeof import("fflate");
    const files = unzipSync(new Uint8Array(buf.subarray(zipStart)));
    const manifestBytes = files["manifest.json"];
    if (!manifestBytes) return null;
    const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf-8"));
    const version = typeof manifest?.version === "string" ? manifest.version.trim() : "";
    return version || null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// 检查 + 应用
// ═══════════════════════════════════════════════════════════════════

export { compareExtensionVersions };

export interface ExtensionUpdateCheck {
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  source: string | null;
}

export async function checkWebbridgeExtensionUpdate(opts: {
  dataDir?: string;
  forceRefresh?: boolean;
} = {}): Promise<ExtensionUpdateCheck> {
  const dataDir = opts.dataDir ?? resolveWebbridgeDataDir();
  const current = currentEffectiveExtensionVersion(dataDir);
  const result = await loadRemoteExtensionPin({
    dataDir,
    forceRefresh: opts.forceRefresh === true,
    logger: { info: (m) => log.info(m) },
  });
  const latest = result.extension?.version ?? null;
  return {
    current,
    latest,
    updateAvailable:
      !!latest && !!current ? compareExtensionVersions(latest, current) > 0 : false,
    source: result.source,
  };
}

export type WebbridgeExtensionUpdateResult =
  | { ok: true; from: string | null; to: string; browsersRepointed: string[] }
  | {
      ok: false;
      reason: "busy" | "no-update" | "manifest-unavailable" | "download-failed" | "pin-stale" | "crx-invalid" | "write-failed";
      message?: string;
    };

export interface ApplyExtensionUpdateOptions {
  dataDir?: string;
  /** 清单提供器（测试注入；缺省 = loadRemoteExtensionPin 强制刷新）。 */
  extensionPinProvider?: () => Promise<{ extension: RemoteExtensionPin | null; source: string | null }>;
  /** 当前生效 spec 提供器（测试注入；缺省 = resolveEffectiveExtensionSpec）。 */
  currentSpecProvider?: () => ExtensionSpec | null;
  /** CRX 下载器（测试注入；缺省 = 经镜像 URL 列表下载）。 */
  downloadCrx?: (urls: string[], dest: string) => Promise<void>;
  /** 浏览器重指（测试注入；缺省 = 真实注册表/JSON 写入）。 */
  repointBrowsers?: (oldSpec: ExtensionSpec | null, newSpec: ExtensionSpec) => Promise<string[]>;
  logger?: { info: (m: string) => void; error: (m: string) => void };
}

export async function applyWebbridgeExtensionUpdate(
  options: ApplyExtensionUpdateOptions = {},
): Promise<WebbridgeExtensionUpdateResult> {
  if (isWebbridgeExclusiveBusy()) return { ok: false, reason: "busy" };
  try {
    return await runWebbridgeExclusive(() => applyWebbridgeExtensionUpdateLocked(options));
  } catch (err) {
    if (err instanceof WebbridgeBusyError) return { ok: false, reason: "busy" };
    throw err;
  }
}

async function applyWebbridgeExtensionUpdateLocked(
  options: ApplyExtensionUpdateOptions,
): Promise<WebbridgeExtensionUpdateResult> {
  const dataDir = options.dataDir ?? resolveWebbridgeDataDir();
  const logger = options.logger ?? { info: (m: string) => log.info(m), error: (m: string) => log.error(m) };

  // 1. 清单（强制刷新：用户点按钮/自动检查都要最新结果）
  const provider =
    options.extensionPinProvider ??
    (() => loadRemoteExtensionPin({ dataDir, forceRefresh: true, logger: { info: logger.info } }));
  const { extension, source } = await provider().catch(() => ({ extension: null, source: null }));
  if (!extension) {
    return {
      ok: false,
      reason: "manifest-unavailable",
      message: `远端清单无扩展信息（source=${source ?? "none"}）`,
    };
  }

  // 2. 版本判定
  const oldSpec = (options.currentSpecProvider ?? (() => resolveEffectiveExtensionSpec(dataDir)))();
  const current = oldSpec?.crxVersion ?? null;
  if (current && compareExtensionVersions(extension.version, current) <= 0) {
    return { ok: false, reason: "no-update", message: `当前 ${current} 已不旧于清单 ${extension.version}` };
  }

  // 3. 下载镜像 CRX 到 tmp（jsDelivr/raw 与清单同基址；失败换下一个）
  const tmpPath = path.join(
    resolveRuntimeExtensionDir(dataDir),
    `.download-${process.pid}-${Date.now()}.crx`,
  );
  fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
  const urls = resolvePinsUrls().map((u) => extensionCrxUrls(u, extension.file));
  const download =
    options.downloadCrx ??
    (async (list: string[], dest: string) => {
      let lastErr: Error | null = null;
      for (const url of list) {
        try {
          await downloadToFileWithRetry(url, dest, 1);
          return;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
          logger.info(`[webbridge-ext-update] CRX 下载失败（${url}）: ${lastErr.message}`);
        }
      }
      throw lastErr ?? new Error("无可用镜像");
    });
  try {
    await download(urls, tmpPath);
  } catch (err) {
    return {
      ok: false,
      reason: "download-failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // 4. sha256 钉定校验（fail closed：不命中即拒装，旧扩展不动）
  const actualSha = sha256FileSync(tmpPath);
  if (!extension.sha256.includes(actualSha.toLowerCase())) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {}
    return {
      ok: false,
      reason: "pin-stale",
      message: `CRX sha256 ${actualSha.slice(0, 16)}… 未命中清单钉定`,
    };
  }

  // 5. CRX 结构复核：内嵌 manifest.json 的 version 必须等于清单宣告值
  //   （external_crx 协议要求注册表宣告 version == CRX 内 version，写错就是死扩展）
  const crxVersion = parseCrxManifestVersion(fs.readFileSync(tmpPath));
  if (!crxVersion || crxVersion !== extension.version) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {}
    return {
      ok: false,
      reason: "crx-invalid",
      message: `CRX 内嵌 version=${crxVersion ?? "(解析失败)"} ≠ 清单 ${extension.version}`,
    };
  }

  // 6. 原子落盘 + 指针更新（先写 CRX 再换指针——指针永远是最后一个动作）
  const extDir = resolveRuntimeExtensionDir(dataDir);
  const finalName = path.basename(extension.file); // 清单 file 已过白名单正则，再剥一层防御
  const finalPath = path.join(extDir, finalName);
  const newSpec: ExtensionSpec = { extId: extension.id, crxPath: finalPath, crxVersion: extension.version };
  try {
    fs.copyFileSync(tmpPath, `${finalPath}.tmp`);
    fs.rmSync(tmpPath, { force: true });
    fs.renameSync(`${finalPath}.tmp`, finalPath);
    const pointer: RuntimeExtensionPointer = {
      extensionId: extension.id,
      version: extension.version,
      file: finalName,
    };
    const ptrTmp = path.join(extDir, `${EXTENSION_POINTER_NAME}.tmp`);
    fs.writeFileSync(ptrTmp, JSON.stringify(pointer, null, 2), "utf-8");
    fs.renameSync(ptrTmp, path.join(extDir, EXTENSION_POINTER_NAME));
  } catch (err) {
    return {
      ok: false,
      reason: "write-failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  logger.info(
    `[webbridge-ext-update] 扩展已更新: ${current ?? "(无)"} → ${extension.version}（${finalPath}）`,
  );

  // 7. 浏览器重指：把已配置旧 spec 的浏览器指到新 CRX（下次浏览器启动生效）
  const repoint = options.repointBrowsers ?? repointConfiguredBrowsers;
  let repointed: string[] = [];
  try {
    repointed = await repoint(oldSpec, newSpec);
  } catch (err) {
    // 重指失败不回滚 CRX 落盘——下次修复路径会按新 spec 补齐
    logger.error(
      `[webbridge-ext-update] 浏览器重指失败（扩展文件已更新，浏览器重启后修复路径可补齐）: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  broadcastWebbridgeStateChanged();
  return { ok: true, from: current, to: extension.version, browsersRepointed: repointed };
}

/**
 * 缺省重指实现：对每个已知浏览器目标，若其注册表/JSON 当前指向旧 spec
 * （或任何 kimi-webbridge CRX——覆盖历史漂移），改写为新 spec。
 */
async function repointConfiguredBrowsers(
  oldSpec: ExtensionSpec | null,
  newSpec: ExtensionSpec,
): Promise<string[]> {
  const {
    BROWSER_TARGETS,
    isExtensionConfigured,
    installExtension,
  } = require("./browser") as typeof import("./browser");
  const repointed: string[] = [];
  // 漂移候选：浏览器可能指着内置打包的旧 CRX（早期安装、从未运行时更新过）
  const { resolveWebbridgeExtensionSpec } = require("./webbridge") as typeof import("./webbridge");
  const bundledSpec = resolveWebbridgeExtensionSpec();
  for (const target of BROWSER_TARGETS) {
    try {
      let configured = oldSpec ? await isExtensionConfigured(target, oldSpec) : false;
      if (!configured && bundledSpec && bundledSpec.crxPath !== oldSpec?.crxPath) {
        configured = await isExtensionConfigured(target, bundledSpec);
      }
      if (!configured) continue;
      const result = await installExtension(target, newSpec);
      if (result === "installed" || result === "updated") {
        repointed.push(target.id);
      }
    } catch {
      // 单浏览器失败不影响其它
    }
  }
  return repointed;
}

/**
 * 自动检查接线：maybeAutoCheckWebbridgeUpdate 的同袍——daemon 报 version_mismatch
 * 或清单里有更新版本时，走上面的管线。autoUpdate 关闭时只广播状态。
 * 永不抛错。
 */
export async function maybeAutoUpdateWebbridgeExtension(opts: {
  dataDir?: string;
  versionMismatch?: boolean;
  autoUpdate?: boolean;
} = {}): Promise<void> {
  const dataDir = opts.dataDir ?? resolveWebbridgeDataDir();
  try {
    const check = await checkWebbridgeExtensionUpdate({ dataDir });
    const shouldUpdate = check.updateAvailable || opts.versionMismatch === true;
    if (!shouldUpdate) return;
    if (opts.autoUpdate === false) {
      log.info(
        `[webbridge-ext-update] 发现扩展更新（current=${check.current ?? "?"} latest=${check.latest ?? "?"} mismatch=${opts.versionMismatch === true}），autoUpdate 关闭仅广播`,
      );
      broadcastWebbridgeStateChanged();
      return;
    }
    const applied = await applyWebbridgeExtensionUpdate({ dataDir });
    log.info(
      applied.ok
        ? `[webbridge-ext-update] 自动更新完成: ${applied.from ?? "?"} → ${applied.to}，重指浏览器=${applied.browsersRepointed.join(",") || "无"}`
        : `[webbridge-ext-update] 自动更新跳过: reason=${applied.reason}`,
    );
  } catch (err) {
    log.info(
      `[webbridge-ext-update] 自动检查失败（忽略）: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
