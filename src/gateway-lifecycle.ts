/**
 * gateway-lifecycle.ts — GatewayProcess 生命周期状态转移判定（纯逻辑便于测试）。
 *
 * 背景：gateway-process.ts 的状态机审计（P0-1 doStart 预启动与 stop() 竞态、
 * P0-2 崩溃自动重启与监督式启动重试双链并发、L2 isPlausiblyOwnGateway fail-open）
 * 涉及的转移判定全部抽到这里——不依赖实例状态、不 import electron/constants/logger，
 * 保证 node 与 vitest 双泳道可测（对齐 gateway-crash-restart.ts 的纯函数模式）。
 */

export type GatewayStateLiteral = "stopped" | "starting" | "running" | "stopping";

/**
 * P0-1：doStart 预启动步骤（端口冲突路径含 10 轮 ×500ms 等待，窗口可达 20s+）
 * 完成后、spawn 之前，是否需要因 stop() 竞态而中止启动。
 * 预启动期间 stop() 可能已把状态复位 stopped（调用方已认为 gateway 停妥，退出/
 * 导入路径会继续清空状态目录）——此时再 spawn 会留下孤儿进程。只有仍处于
 * starting 才允许继续；任何其他状态都意味着有人在我们不在时动过状态机。
 */
export function shouldAbortStartAfterPrestart(state: GatewayStateLiteral): boolean {
  return state !== "starting";
}

/**
 * P0-1：stop() 遇到「starting + 无 proc」半死态时，是否可直接强制复位 stopped。
 * 仅当无子进程句柄且无在途 doStart（预启动窗口，proc 尚未赋值）时才允许——
 * 有在途启动时强转 stopped 会让 doStart 在 stop() 返回后继续 spawn 出孤儿，
 * 必须改为等待其落定（等待分支的判定即本函数的取反）。
 */
export function shouldForceResetHalfDead(
  state: GatewayStateLiteral,
  hasProc: boolean,
  hasInflightStart: boolean,
): boolean {
  return state === "starting" && !hasProc && !hasInflightStart;
}

/**
 * P0-2：子进程退出是否应触发 onCrash（由 main 决定是否排程崩溃自动重启）。
 * - stopping/stopped：主动停止路径，exit handler 另有分支，绝不触发；
 * - running：运行中崩溃，无论是否有监督式启动在途都必须触发——restart 链
 *   （requestGatewayRestart）没有重试监督，全靠 onCrash 恢复；
 * - starting：监督式启动（ensureGatewayRunning 的重试链）在途时不触发——监督链
 *   自己带 3 次重试与失败上报，再排一条崩溃重启链会双倍消耗崩溃预算、双恢复
 *   入口；非监督启动（restart 链的 start）仍触发，标记刻意不覆盖该场景。
 */
export function shouldFireCrashOnStartingExit(
  state: GatewayStateLiteral,
  supervisedStartInFlight: boolean,
): boolean {
  if (state === "stopping" || state === "stopped") return false;
  if (state === "running") return true;
  return !supervisedStartInFlight;
}

/**
 * L2：解析 tasklist /FO CSV /NH 输出首行的镜像名列（去引号、小写）。
 * 无匹配进程时 tasklist 输出为空/全空白行，返回空串（调用方据此拒绝）。
 */
export function parseTasklistImageName(stdout: string): string {
  const firstLine = stdout.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  return firstLine.split(",")[0]?.replace(/^"|"$/g, "")?.toLowerCase() ?? "";
}

/** 镜像名是否属于本应用 gateway 的可能形态（Electron 复用二进制 / CLI 二进制 / 系统 node）。 */
export function isPlausibleGatewayImage(image: string): boolean {
  return /(?:cryoclaw|electron|node)/.test(image);
}

/**
 * L2：tasklist CSV 输出 → 是否可判定为自家 gateway。解析失败（空输出）即拒绝——
 * 身份校验 fail-closed，调用方据此跳过硬杀，交由启动失败提示引导用户。
 */
export function isPlausiblyOwnGatewayFromTasklist(stdout: string): boolean {
  return isPlausibleGatewayImage(parseTasklistImageName(stdout));
}
