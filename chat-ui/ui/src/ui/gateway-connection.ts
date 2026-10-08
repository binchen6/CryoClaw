/**
 * gateway-connection.ts — Gateway 连接状态模型（纯逻辑，node:test 可直接导入）。
 *
 * 三态模型替代裸 `disconnected (code): reason` 文案：
 * - starting：    内核正在启动（主进程推送 gateway:progress 步骤），信息态（蓝）
 * - reconnecting：连接丢失，客户端按指数退避自动重连，信息/过渡态
 * - failed：      持续重连失败后才落错误态（用户可手动重试）
 *
 * 阶段推导只看两类输入：WS 关闭码（mapCloseCodeToPhase）与「是否曾连接过」
 * （connectGateway 时 hello 是否为空）——保持纯函数便于测试。
 */

/** 连接状态三态（connected 由 host.connected 表达，不在这里） */
export type GatewayConnPhase = "starting" | "reconnecting" | "failed";

/** 主进程 gateway:progress 推送的载荷（src/gateway-process.ts GatewayProgressInfo） */
export type GatewayProgressInfo = {
  step: string;
  attempt: number;
  elapsedMs?: number;
};

/** 内核启动步骤（按启动顺序排列；health 步可能重复多次直到服务就绪） */
export const GATEWAY_PROGRESS_STEPS = [
  "cleanup",
  "database",
  "port",
  "spawn",
  "health",
  "ready",
] as const;

/** 步骤序号（未知步骤返回 -1；进度条按 序号/(总长-1) 近似定位） */
export function gatewayStepIndex(step: string): number {
  return (GATEWAY_PROGRESS_STEPS as readonly string[]).indexOf(step);
}

/**
 * WS 关闭码 → 连接阶段。
 * 1012 Service Restart / 1013 (Try Again Later，内核健康检查重启窗口) 是内核
 * 启动/重启过程的正常信号 → starting（信息态）；其余（1006 异常断开、1001、
 * connect 失败 4000 等）→ reconnecting（客户端会自动退避重连）。
 */
export function mapCloseCodeToPhase(code: number): GatewayConnPhase {
  if (code === 1012 || code === 1013) {
    return "starting";
  }
  return "reconnecting";
}

/** 步骤文案的 i18n key（渲染层 t() 取值；未知步骤兜底 ready 之外的通用 key） */
export function gatewayStepKey(step: string): string {
  return (GATEWAY_PROGRESS_STEPS as readonly string[]).includes(step)
    ? `gateway.starting.step.${step}`
    : "gateway.starting.step.unknown";
}
