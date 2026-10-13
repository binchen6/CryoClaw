/**
 * 全局 toast（轻量通知条）—— 从 skillStoreState 解耦出来的独立模块状态。
 * 显示 4 秒后自动消失；同一时间只保留一条。
 * 带 action 按钮的 toast（如「重启更新」）不自动消失，等用户点击或被下一条覆盖。
 * 消失走「退场动画 → 延迟移除」两段式：先置 leaving 挂 .global-toast--leaving
 * 播退场动画，TOAST_EXIT_MS 后才清消息移除 DOM（时长须与 components.css 的
 * global-toast-out 一致；reduced-motion 下动画瞬时，延迟仅 200ms 可接受）。
 */

import type { AppViewState } from "./app-view-state.ts";

export type ToastAction = {
  label: string;
  onClick: () => void;
};

// 退场时长 = components.css global-toast-out 的 var(--duration-normal)（0.2s）
const TOAST_EXIT_MS = 200;

let toastMessage: string | null = null;
let toastAction: ToastAction | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let toastLeaving = false;
let toastRemoveTimer: ReturnType<typeof setTimeout> | null = null;

export function getToastMessage(): string | null {
  return toastMessage;
}

export function getToastAction(): ToastAction | null {
  return toastAction;
}

export function isToastLeaving(): boolean {
  return toastLeaving;
}

function clearRemoveTimer() {
  if (toastRemoveTimer) {
    clearTimeout(toastRemoveTimer);
    toastRemoveTimer = null;
  }
}

/** 触发退场：挂 leaving 类播退场动画，结束后移除。已在退场中则幂等。 */
function dismissWithExit(state?: AppViewState) {
  if (toastLeaving) return;
  toastLeaving = true;
  state?.requestUpdate();
  toastRemoveTimer = setTimeout(() => {
    toastRemoveTimer = null;
    toastLeaving = false;
    toastMessage = null;
    toastAction = null;
    state?.requestUpdate();
  }, TOAST_EXIT_MS);
}

/** 关闭当前 toast（action 点击后或状态变化时调用）：走退场动画后移除。 */
export function hideToast(state?: AppViewState) {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  if (toastMessage === null && toastAction === null) return;
  dismissWithExit(state);
}

export function showToast(state: AppViewState, message: string, action?: ToastAction) {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  // 上一条若正在退场：取消移除计时并复位——同一 DOM 节点复用，内容直接换新
  clearRemoveTimer();
  toastLeaving = false;
  toastMessage = message;
  toastAction = action ?? null;
  state.requestUpdate();
  // 带 action 的 toast 常驻（如「重启更新」需等用户决策），普通 toast 4s 自动消失
  if (!action) {
    toastTimer = setTimeout(() => {
      toastTimer = null;
      dismissWithExit(state);
    }, 4000);
  }
}

// DOM 层（事件委托等无 state 上下文处）触发 toast 的桥：查找应用根元素并复用 showToast。
export function showToastGlobal(message: string): void {
  const app = document.querySelector("openclaw-app") as (Element & { requestUpdate?: () => void }) | null;
  if (!app || typeof app.requestUpdate !== "function") {
    return;
  }
  showToast(app as unknown as AppViewState, message);
}
