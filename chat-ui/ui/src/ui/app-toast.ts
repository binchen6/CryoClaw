/**
 * 全局 toast（轻量通知条）—— 从 skillStoreState 解耦出来的独立模块状态。
 * 显示 4 秒后自动消失；同一时间只保留一条。
 * 带 action 按钮的 toast（如「重启更新」）不自动消失，等用户点击或被下一条覆盖。
 */

import type { AppViewState } from "./app-view-state.ts";

export type ToastAction = {
  label: string;
  onClick: () => void;
};

let toastMessage: string | null = null;
let toastAction: ToastAction | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function getToastMessage(): string | null {
  return toastMessage;
}

export function getToastAction(): ToastAction | null {
  return toastAction;
}

/** 立即关闭当前 toast（action 点击后或状态变化时调用）。 */
export function hideToast(state?: AppViewState) {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  if (toastMessage === null && toastAction === null) return;
  toastMessage = null;
  toastAction = null;
  state?.requestUpdate();
}

export function showToast(state: AppViewState, message: string, action?: ToastAction) {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  toastMessage = message;
  toastAction = action ?? null;
  state.requestUpdate();
  // 带 action 的 toast 常驻（如「重启更新」需等用户决策），普通 toast 4s 自动消失
  if (!action) {
    toastTimer = setTimeout(() => {
      toastMessage = null;
      toastTimer = null;
      state.requestUpdate();
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
