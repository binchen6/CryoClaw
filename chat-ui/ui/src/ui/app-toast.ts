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
