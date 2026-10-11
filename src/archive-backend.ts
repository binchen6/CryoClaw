// archive-backend.ts — .openclaw 归档工具 Rust sidecar 的探测与会话封装。
//
// 设计契约：
//   - sidecar 只做字节级 zip 读写 + CRC32；路径白名单/条目注册表/大小上限等
//     安全校验留在 JS 侧（openclaw-state-archive-zip.ts），sidecar 解压时另做
//     目标路径前缀约束作为防御纵深。
//   - 任何失败（二进制缺失/握手失败/spawn 失败/协议错误/校验拒绝）都抛错给
//     调用方，由调用方落回纯 JS fflate 实现——用户可见行为永远等价于
//     「sidecar 不存在」，错误文案由 JS 权威产生，双实现不漂移。
//   - 探测结果带缓存（含负结果）；测试用 resetArchiveToolProbeForTests 重置。
//   - 本模块不 import electron：归档链路在无 electron 的测试环境也要可加载。
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

const TOOL_EXE = process.platform === "win32" ? "cryoclaw-archive.exe" : "cryoclaw-archive";
const VERSION_PREFIX = "cryoclaw-archive ";
const HANDSHAKE_TIMEOUT_MS = 10_000;
// 会话级 stdout 空闲看门狗：合法最慢路径是 sidecar 解析超大 stdin command JSON 或
// 单条目 deflate，均在秒级；AV 扫描锁文件/协议死锁类挂起 2 分钟足够判死
const SESSION_IDLE_TIMEOUT_MS = 120_000;
const MAX_STDOUT_LINE_BYTES = 64 * 1024 * 1024;

// sidecar 版本与 package.json pin（cryoclaw.archiveTool）比对：不符视为探测失败
// （fail closed 回退 JS）——stale 的 dev 本地产物可能协议已漂移，「静默兼容」形态
// 的漂移会产出错数据而非错误。读取失败（无 pin）时跳过比对。
function readPinnedArchiveToolVersion(): string | null {
  for (const root of [path.resolve(__dirname, ".."), path.resolve(__dirname, "..", "..")]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
        cryoclaw?: { archiveTool?: unknown };
      };
      const version = pkg.cryoclaw?.archiveTool;
      return typeof version === "string" && version.trim() ? version.trim() : null;
    } catch {
      // 尝试下一个深度（src/、dist/、.test-dist/ 的 __dirname 深度不同）
    }
  }
  return null;
}

// 回退可观测性：双 backend 的「任何失败静默回退」契约保持不变（用户可见行为
// 等价于 sidecar 不存在），但性能优化失效必须留痕——每进程仅告警一次，防止
// 探测/校验类周期性失败刷屏。
let warnedFallbackOnce = false;
export function warnArchiveToolFallbackOnce(err: unknown): void {
  if (warnedFallbackOnce) return;
  warnedFallbackOnce = true;
  console.warn(
    "[archive-backend] Rust sidecar 归档失败，回退纯 JS 实现（每进程仅告警一次）:",
    err instanceof Error ? err.message : String(err),
  );
}

export type ArchiveToolHandle = {
  binPath: string;
  version: string;
};

export type RustManifestEntry = {
  name: string;
  kind: "file" | "dir";
  compression: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  versionMadeBy: number;
  externalAttrs: number;
};

export type RustCreateEntry = {
  path: string;
  relPath: string;
  kind: "file" | "dir";
  mode: number;
  dosDate: number;
  dosTime: number;
  compression: "store" | "deflate";
  contentBase64: string | null;
};

export type RustExtractEntry = {
  name: string;
  kind: "file" | "dir";
  segments: string[];
};

export type RustCapturedEntry = {
  name: string;
  contentBase64: string;
};

type ToolEvent =
  | { type: "progress"; done: number; total: number; entry: string }
  | {
      type: "result";
      ok: boolean;
      entries?: RustManifestEntry[];
      entryNames?: string[];
      capture?: RustCapturedEntry[];
      error?: { code: string; message: string };
    };

let probeCache: ArchiveToolHandle | null | undefined;

/** 测试注入口：清空探测缓存（负缓存会让后续用例跳过握手）。 */
export function resetArchiveToolProbeForTests(): void {
  probeCache = undefined;
}

/** 解析探测候选路径（按序）：env 覆盖 → dev 本地产物 → resources 注入路径。 */
export function resolveArchiveToolCandidates(): string[] {
  const candidates: string[] = [];
  const envOverride = (process.env.CRYOCLAW_ARCHIVE_TOOL_BIN || "").trim();
  if (envOverride) candidates.push(path.resolve(envOverride));

  // dev：仓库内 cargo 本地产物。__dirname 可能是 dist/（Electron dev）、
  // src/（vitest 源码）或 .test-dist/（node:test 编译产物）——两种深度都试。
  for (const root of [path.resolve(__dirname, ".."), path.resolve(__dirname, "..", "..")]) {
    candidates.push(path.join(root, "native", "cryoclaw-archive", "target", "release", TOOL_EXE));
  }

  // resources 注入路径：packaged 走 process.resourcesPath，dev 走 targets 目录。
  // process.resourcesPath 仅 Electron 存在（TS 类型无此字段，运行时探测）。
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, "resources", "archive-tool", TOOL_EXE));
  }
  for (const root of [path.resolve(__dirname, ".."), path.resolve(__dirname, "..", "..")]) {
    candidates.push(
      path.join(root, "resources", "targets", `${process.platform}-${process.arch}`, "archive-tool", TOOL_EXE),
    );
  }
  return [...new Set(candidates)];
}

/** `--version` 握手：输出行首必须是 "cryoclaw-archive <semver>"。 */
function handshake(binPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (version: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(version);
    };
    const timer = setTimeout(() => finish(null), HANDSHAKE_TIMEOUT_MS);
    let stdout = "";
    const child = spawn(binPath, ["--version"], { windowsHide: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const firstLine = stdout.split(/\r?\n/, 1)[0] ?? "";
      const match = /^cryoclaw-archive (\d+\.\d+\.\d+.*)$/.exec(firstLine.trim());
      if (match) finish(match[1]);
    });
    child.on("error", () => finish(null));
    child.on("exit", (code) => {
      if (code === 0) {
        const match = /^cryoclaw-archive (\d+\.\d+\.\d+.*)$/.exec(stdout.trim());
        finish(match ? match[1] : null);
      } else {
        finish(null);
      }
    });
  });
}

/** 探测 sidecar（带缓存，含负缓存）：返回可用手柄或 null。
 *  CRYOCLAW_ARCHIVE_TOOL=off（或 0/false）显式禁用 sidecar——运维回退与
 *  双 backend 测试强制走纯 JS 路径的开关。 */
export async function probeArchiveTool(): Promise<ArchiveToolHandle | null> {
  const flag = (process.env.CRYOCLAW_ARCHIVE_TOOL || "").trim().toLowerCase();
  if (flag === "off" || flag === "0" || flag === "false") {
    probeCache = null;
    return null;
  }
  if (probeCache !== undefined) return probeCache;
  const pinnedVersion = readPinnedArchiveToolVersion();
  for (const candidate of resolveArchiveToolCandidates()) {
    if (!fs.existsSync(candidate)) continue;
    const version = await handshake(candidate);
    if (version && pinnedVersion && version !== pinnedVersion) {
      continue;
    }
    if (version) {
      probeCache = { binPath: candidate, version };
      return probeCache;
    }
  }
  probeCache = null;
  return null;
}

/** 单次 sidecar 会话：写一行 command JSON 到 stdin，收集 stdout 事件流，
 *  返回最终 result 事件。进度事件被解析但不外抛（调用方暂不需要进度）。 */
function runToolSession(tool: ArchiveToolHandle, subcommand: string, command: unknown): Promise<ToolEvent & { type: "result" }> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool.binPath, [subcommand], { windowsHide: true });
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const settle = (err: Error | null, result?: ToolEvent & { type: "result" }) => {
      if (settled) return;
      settled = true;
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (err) reject(err);
      else resolve(result!);
    };
    // stdout 空闲看门狗：sidecar 活着但不输出（AV 锁文件/协议死锁等）会让会话
    // 永不 settle——import 生命周期是 stop gateway → import → start，挂死等于
    // gateway 无限期停摆。超时 kill + reject，调用方走既有静默回退 JS 路径。
    const armIdleWatchdog = () => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        settle(new Error(`sidecar 会话空闲超时（${SESSION_IDLE_TIMEOUT_MS / 1000}s 无输出）`));
        child.kill();
      }, SESSION_IDLE_TIMEOUT_MS);
    };
    armIdleWatchdog();

    let pendingLine = Buffer.alloc(0);
    let lastEvent: ToolEvent | null = null;
    let stderrText = "";
    child.stdout.on("data", (chunk: Buffer) => {
      armIdleWatchdog();
      pendingLine = Buffer.concat([pendingLine, chunk]);
      if (pendingLine.length > MAX_STDOUT_LINE_BYTES) {
        settle(new Error("sidecar stdout 超过单行上限"));
        child.kill();
        return;
      }
      for (;;) {
        const newlineIndex = pendingLine.indexOf(0x0a);
        if (newlineIndex < 0) break;
        const line = pendingLine.subarray(0, newlineIndex).toString("utf8");
        pendingLine = pendingLine.subarray(newlineIndex + 1);
        if (!line.trim()) continue;
        let event: ToolEvent;
        try {
          event = JSON.parse(line) as ToolEvent;
        } catch {
          settle(new Error(`sidecar 输出非 JSON 行: ${line.slice(0, 200)}`));
          child.kill();
          return;
        }
        lastEvent = event;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
      if (stderrText.length > 64 * 1024) stderrText = stderrText.slice(-64 * 1024);
    });
    child.on("error", (err) => settle(err));
    child.on("exit", (code, signal) => {
      if (lastEvent?.type === "result") {
        settle(null, lastEvent);
        return;
      }
      settle(new Error(`sidecar 异常退出 code=${code} signal=${signal}: ${stderrText.trim().slice(0, 500)}`));
    });

    // 异步写 command 行并关流；child 提前退出时的 EPIPE 由 exit 事件兜底
    const line = `${JSON.stringify(command)}\n`;
    child.stdin.on("error", () => {});
    child.stdin.write(line, "utf8", () => {
      child.stdin.end();
    });
  });
}

function toArchiveError(error: { code: string; message: string }): Error {
  const err = new Error(error.message);
  (err as Error & { archiveToolCode?: string }).archiveToolCode = error.code;
  return err;
}

/** manifest 子命令：只解析 central directory + local header 一致性（不解压）。 */
export async function rustReadManifest(tool: ArchiveToolHandle, zipPath: string): Promise<RustManifestEntry[]> {
  const result = await runToolSession(tool, "manifest", { cmd: "manifest", zip: zipPath });
  if (!result.ok) throw toArchiveError(result.error!);
  return result.entries ?? [];
}

/** extract 子命令：白名单条目单遍流式解压 + 校验；outputDir 为 null 时
 *  只校验不落盘（validate 形态）。返回条目名（central 顺序）与 capture 内容。 */
export async function rustExtractArchive(
  tool: ArchiveToolHandle,
  params: {
    zipPath: string;
    outputDir: string | null;
    entries: RustExtractEntry[];
    capture: string[];
  },
): Promise<{ entryNames: string[]; capture: RustCapturedEntry[] }> {
  const result = await runToolSession(tool, "extract", {
    cmd: "extract",
    zip: params.zipPath,
    outputDir: params.outputDir,
    entries: params.entries,
    capture: params.capture,
    utcOffsetMinutes: new Date().getTimezoneOffset(),
  });
  if (!result.ok) throw toArchiveError(result.error!);
  return { entryNames: result.entryNames ?? [], capture: result.capture ?? [] };
}

/** create 子命令：按 JS 收集的条目清单流式写 zip。 */
export async function rustCreateArchive(
  tool: ArchiveToolHandle,
  params: { outputPath: string; entries: RustCreateEntry[] },
): Promise<void> {
  const result = await runToolSession(tool, "create", {
    cmd: "create",
    output: params.outputPath,
    entries: params.entries,
  });
  if (!result.ok) throw toArchiveError(result.error!);
}

/** JS Date → DOS 日期/时间（本地墙钟，与 fflate 写入器同公式；sidecar 不依赖
 *  本地时区库，换算放在已有时区语义的 JS 侧）。 */
export function dateToDosDateTime(date: Date): { dosDate: number; dosTime: number } {
  const year = Math.max(date.getFullYear(), 1980);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  return { dosDate, dosTime };
}
