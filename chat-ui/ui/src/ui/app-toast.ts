/**
 * 全局 toast（轻量通知条）—— 从 skillStoreState 解耦出来的独立模块状态。
 * 显示 4 秒后自动消失；同一时间只保留一条。
 */

import type { AppViewState } from "./app-view-state.ts";

let toastMessage: string | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function getToastMessage(): string | null {
  return toastMessage;
}

export function showToast(state: AppViewState, message: string) {
  if (toastTimer) clearTimeout(toastTimer);
  toastMessage = message;
  state.requestUpdate();
  toastTimer = setTimeout(() => {
    toastMessage = null;
    toastTimer = null;
    state.requestUpdate();
  }, 4000);
}

// DOM 层（事件委托等无 state 上下文处）触发 toast 的桥：查找应用根元素并复用 showToast。
export function showToastGlobal(message: string): void {
  const app = document.querySelector("openclaw-app") as (Element & { requestUpdate?: () => void }) | null;
  if (!app || typeof app.requestUpdate !== "function") {
    return;
  }
  showToast(app as unknown as AppViewState, message);
}
