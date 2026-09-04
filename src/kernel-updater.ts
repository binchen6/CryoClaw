/**
 * kernel-updater.ts — 内核（openclaw）运行时升级/回退的主进程编排
 *
 * 实际的换装逻辑在安装产物的 updater/kernel-update.mjs（差分式 asar 换装，
 * 见 docs/OPTIMIZATION-PROGRESS.md 阶段 1 设计）。本模块负责：
 *   - 查询当前/最新内核版本与回退可用性（--check）
 *   - 升级/回退编排：停 gateway → 跑 updater 脚本（JSONL 进度转发渲染层）
 *     → 重启 gateway → 健康检查失败时自动回滚
 *   - 单任务并发护栏
 *   - 最低支持版本判定（isKernelBelowMinSupported）：门槛与根目录
 *     kernel-channel.json 的 minSupported 字段保持一致（运行时暂不远程读取，
 *     调整 minSupported 时需同步修改本文件的 MIN_SUPPORTED_KERNEL_VERSION）
 */

import { spawn } from "child_process";
import { StringDecoder } from "string_decoder";
import * as fs from "fs";
import * as path from "path";
import { resolveResourcesPath, resolveNodeBin, resolveNodeExtraEnv, resolveCliExe } from "./constants";
import { migrateOpenclawConfigForKernelUpgrade, readKernelVersionParts, versionAtLeast } from "./openclaw-config-migration";
import * as log from "./logger";

// ── 类型 ──

export type KernelUpdateState = {
  /** updater 资源是否存在（dev 环境未跑 package:resources 时为 false） */
  available: boolean;
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  rollbackAvailable: boolean;
  /** 有升级/回退任务进行中 */
  running: boolean;
  /** 最近一次 registry 查询失败原因 */
  checkError?: string | null;
};

export type KernelUpdateProgress = {
  step: string;
  pct: number;
  msg: string;
  /** 触发来源：auto = 启动后自动升级（渲染层全局横幅），manual = 设置页手动触发 */
  source?: "auto" | "manual";
};

export type KernelUpdateResult =
  | { ok: true; action: "update" | "rollback"; from: string; to: string; rolledBack?: boolean }
  | { ok: false; error: string };

export type Deps = {
  stopGateway: () => Promise<unknown>;
  /** 重启 gateway 并等待健康；返回是否成功 */
  startGateway: () => Promise<boolean>;
  /** 查询 gateway 当前状态（"running" 等），用于编排结束后决定是否恢复启动 */
  getGatewayState: () => string;
  push: (payload: KernelUpdateProgress) => void;
};

// ── 内部状态 ──

let deps: Deps | null = null;
let running = false;
let lastCheck: Partial<KernelUpdateState> = {};

function resolveUpdaterScript(): string {
  return path.join(resolveResourcesPath(), "updater", "kernel-update.mjs");
}

export function isKernelUpdaterAvailable(): boolean {
  return fs.existsSync(resolveUpdaterScript());
}

// 最低支持内核版本：与根目录 kernel-channel.json 的 minSupported 字段保持一致
// （运行时暂不远程读取该文件，策展方推进 minSupported 时需同步修改此处）。
const MIN_SUPPORTED_KERNEL_VERSION = { year: 2026, month: 7 };

/** 当前内核版本是否低于最低支持版本；读不到版本时保守返回 false（不触发自动升级）。 */
export function isKernelBelowMinSupported(): boolean {
  const parts = readKernelVersionParts();
  if (!parts) return false;
  return !versionAtLeast(parts, MIN_SUPPORTED_KERNEL_VERSION);
}

export function getKernelUpdateState(): KernelUpdateState {
  return {
    available: isKernelUpdaterAvailable(),
    current: lastCheck.current ?? null,
    latest: lastCheck.latest ?? null,
    updateAvailable: lastCheck.updateAvailable ?? false,
    rollbackAvailable: lastCheck.rollbackAvailable ?? false,
    running,
    checkError: lastCheck.checkError ?? null,
  };
}

// ── updater 子进程 ──

type UpdaterEvent =
  | { type: "progress"; step: string; pct: number; msg: string }
  | { type: "state"; current: string; latest: string | null; updateAvailable: boolean; rollbackAvailable?: boolean; checkError?: string }
  | { type: "done"; action: "update" | "rollback"; from: string; to: string }
  | { type: "error"; message: string };

// updater 整体看门狗：内部各步骤（npm/HTTP/冒烟）各自带超时，但脚本外原因（管道阻塞/
// 磁盘 I/O 挂起）导致整体挂住时，无兜底则编排永久挂起——此时 gateway 已停、
// running 恒为 true（finally 永不执行），用户侧“升级中”永久卡死。取远大于内部各步超时的宽松值。
const UPDATOR_OVERALL_TIMEOUT_MS = 15 * 60_000;

/** 运行 updater 脚本，逐行解析 JSONL 协议；onEvent 抛错不影响子进程。 */
function runUpdater(args: string[], onEvent: (e: UpdaterEvent) => void): Promise<UpdaterEvent[]> {
  return new Promise((resolve, reject) => {
    const script = resolveUpdaterScript();
    const child = spawn(resolveNodeBin(), [script, ...args], {
      env: {
        ...process.env,
        ...resolveNodeExtraEnv(),
        CRYOCLAW_KERNEL_RESOURCES_DIR: resolveResourcesPath(),
        ...(resolveCliExe() ? { CRYOCLAW_CLI_EXE: resolveCliExe()! } : {}),
      },
      windowsHide: true,
    });

    const events: UpdaterEvent[] = [];
    let stdoutBuf = "";
    let stderrTail = "";
    // UTF-8 多字节字符可能跨 chunk 截断，用 StringDecoder 累积解码，避免乱码毁行丢事件
    const stdoutDecoder = new StringDecoder("utf-8");

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += stdoutDecoder.write(chunk);
      let idx: number;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line) as UpdaterEvent;
          events.push(event);
          onEvent(event);
        } catch {
          log.warn(`[kernel-updater] 非协议输出: ${line.slice(0, 200)}`);
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf-8")).slice(-2000);
    });
    // 整体看门狗：超时杀子进程，让 close 事件带非 0 退出码走 reject 路径，
    // 由上层编排（sawSwap 回滚 + 恢复启动）接管。
    const watchdog = setTimeout(() => {
      child.kill();
    }, UPDATOR_OVERALL_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(watchdog);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(watchdog);
      // 冲刷 decoder 中可能残留的半字符，再尝试解析收尾行（正常协议每行以 \n 结尾）
      stdoutBuf += stdoutDecoder.end();
      const tail = stdoutBuf.trim();
      if (tail) {
        try {
          const event = JSON.parse(tail) as UpdaterEvent;
          events.push(event);
          onEvent(event);
        } catch {
          log.warn(`[kernel-updater] 非协议输出: ${tail.slice(0, 200)}`);
        }
      }
      if (code === 0) {
        resolve(events);
      } else {
        const protoErr = events.find((e) => e.type === "error");
        reject(new Error(protoErr && protoErr.type === "error" ? protoErr.message : `updater 退出码 ${code}: ${stderrTail.slice(-500)}`));
      }
    });
  });
}

// ── IPC 操作 ──

export async function checkKernelUpdate(): Promise<KernelUpdateState> {
  if (!isKernelUpdaterAvailable()) return getKernelUpdateState();
  const events = await runUpdater(["--check"], () => {});
  const state = events.find((e) => e.type === "state");
  if (state && state.type === "state") {
    lastCheck = {
      current: state.current,
      latest: state.latest,
      updateAvailable: state.updateAvailable,
      rollbackAvailable: state.rollbackAvailable ?? false,
      checkError: state.checkError ?? null,
    };
  }
  return getKernelUpdateState();
}

/** 升级（tag 为空 = latest）或回退的公共编排。 */
async function orchestrate(args: string[], source: "auto" | "manual" = "manual"): Promise<KernelUpdateResult> {
  if (!deps) return { ok: false, error: "kernel-updater 未初始化" };
  if (running) return { ok: false, error: "已有内核升级任务进行中" };
  if (!isKernelUpdaterAvailable()) return { ok: false, error: "当前环境缺少内核升级器资源" };

  running = true;
  const d = deps;
  // 记录 gateway 原状态：仅当原本在跑，编排结束后才恢复启动（L9）
  const wasRunning = d.getGatewayState() === "running";
  // 追踪是否走到过 swap 阶段：走到过说明 asar 可能已被换装，失败时需先自动回滚
  let sawSwap = false;
  try {
    d.push({ step: "gateway-stop", pct: 0, msg: "停止 Gateway", source });
    await d.stopGateway();

    const events = await runUpdater(args, (e) => {
      if (e.type === "progress") {
        if (e.step === "swap") sawSwap = true;
        d.push({ step: e.step, pct: e.pct, msg: e.msg, source });
      }
    });
    const done = events.find((e) => e.type === "done");
    if (!done || done.type !== "done") {
      throw new Error("updater 未返回完成事件");
    }

    // 换装成功后、启动 gateway 前同步跑一次配置迁移（如移除已废弃字段），
    // 避免旧配置残留让新内核校验报错、起不来
    migrateOpenclawConfigForKernelUpgrade();

    d.push({ step: "gateway-start", pct: 97, msg: "重启 Gateway 并健康检查", source });
    const healthy = await d.startGateway();
    if (healthy) {
      lastCheck = { current: done.to, latest: lastCheck.latest ?? null, updateAvailable: false, rollbackAvailable: true };
      // 终态事件：自动升级的全局横幅靠它收敛（done 几秒后自动消失）
      d.push({
        step: "done",
        pct: 100,
        msg: done.action === "rollback" ? `内核已回退到 ${done.to}` : `内核已升级到 ${done.to}`,
        source,
      });
      return { ok: true, action: done.action, from: done.from, to: done.to };
    }

    // 升级后 gateway 起不来：update 场景自动回滚
    if (done.action === "update") {
      log.warn("[kernel-updater] 新内核健康检查失败，自动回滚");
      d.push({ step: "auto-rollback", pct: 98, msg: "新内核启动失败，自动回滚", source });
      await d.stopGateway();
      await runUpdater(["--rollback"], (e) => {
        if (e.type === "progress") d.push({ step: e.step, pct: e.pct, msg: e.msg, source });
      });
      // 回滚换装完成、重启 gateway 前重跑配置迁移：双向规则会把
      // tools.updatePlan 等 2026.8 新落位搬回旧内核位置，保证旧内核校验通过
      migrateOpenclawConfigForKernelUpgrade();
      const restored = await d.startGateway();
      const error = restored
        ? `新内核 ${done.to} 启动失败，已自动回滚到 ${done.from}`
        : `新内核 ${done.to} 启动失败，自动回滚后仍无法启动，请手动检查`;
      d.push({ step: "error", pct: 100, msg: error, source });
      return { ok: false, error };
    }
    const error = `回退到 ${done.to} 后 Gateway 启动失败，请查看日志`;
    d.push({ step: "error", pct: 100, msg: error, source });
    return { ok: false, error };
  } catch (err: any) {
    log.error(`[kernel-updater] ${err?.message ?? err}`);
    // 脚本在 swap 之后失败：asar 可能已被换装，先尽力回滚（best-effort，失败吞掉）
    if (sawSwap) {
      try {
        await runUpdater(["--rollback"], (e) => {
          if (e.type === "progress") d.push({ step: e.step, pct: e.pct, msg: e.msg, source });
        });
        // best-effort 回滚成功：恢复启动前同样把配置迁回旧内核落位
        migrateOpenclawConfigForKernelUpgrade();
      } catch (rollbackErr: any) {
        log.error(`[kernel-updater] 失败后自动回滚未成功: ${rollbackErr?.message ?? rollbackErr}`);
      }
    }
    // 仅当 gateway 原本在运行时才恢复启动；恢复失败必须在错误文案中透出，
    // 否则用户只看到“升级失败”，不知道 gateway 已停摆。
    let restored = true;
    if (wasRunning) {
      try {
        restored = Boolean(await d.startGateway());
      } catch {
        restored = false;
      }
    }
    const baseError = String(err?.message ?? err);
    const error = restored ? baseError : `${baseError}；且 Gateway 恢复启动失败，请手动检查或重启应用`;
    d.push({ step: "error", pct: 100, msg: error, source });
    return { ok: false, error };
  } finally {
    running = false;
  }
}

export async function runKernelUpdate(tag?: string, source: "auto" | "manual" = "manual"): Promise<KernelUpdateResult> {
  return orchestrate(tag ? ["--tag", tag] : [], source);
}

export async function runKernelRollback(): Promise<KernelUpdateResult> {
  return orchestrate(["--rollback"]);
}

// ── IPC 注册 ──

export function initKernelUpdater(d: Deps): void {
  deps = d;
}
