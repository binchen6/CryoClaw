/**
 * 全局 toast（轻量通知条）—— 从 skillStoreState 解耦出来的独立模块状态。
 * 同一时间只保留一条；普通 toast 自动消失（error 8s / warning 6s / 其余 4s），
 * 展示期间同一条（同文案/类型/action）再次出现时重置自动消失计时，避免连续
 * 报错被旧时限过早收起。
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
export type ToastKind="info"|"success"|"warning"|"error";
let toastKind:ToastKind="info";
export function getToastKind():ToastKind{return toastKind;}

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

// 普通 toast 的自动消失时长：error 8s、warning 6s、其余 4s
function autoDismissDelay(kind: ToastKind): number {
  return kind==="error"?8000:kind==="warning"?6000:4000;
}

function scheduleAutoDismiss(state: AppViewState, kind: ToastKind) {
  toastTimer = setTimeout(() => {
    toastTimer = null;
    dismissWithExit(state);
  }, autoDismissDelay(kind));
}

export function showToast(state: AppViewState, message: string, action?: ToastAction,kind:ToastKind="info") {
  if(!message.trim())return;
  if(toastMessage===message && toastKind===kind && toastAction===(action??null) && !toastLeaving){
    // 同一条提示在展示期间再次出现：普通 toast 重置自动消失计时，避免连续报错被旧时限过早收起；
    // 带 action 的常驻 toast 没有计时器，直接复用
    if(!action){
      if(toastTimer)clearTimeout(toastTimer);
      scheduleAutoDismiss(state,kind);
    }
    return;
  }
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  // 上一条若正在退场：取消移除计时并复位——同一 DOM 节点复用，内容直接换新
  clearRemoveTimer();
  toastLeaving = false;
  toastMessage = message;
  toastKind=kind;
  toastAction = action ?? null;
  state.requestUpdate();
  // 带 action 的 toast 常驻（如「重启更新」需等用户决策），普通 toast 自动消失
  if (!action) {
    scheduleAutoDismiss(state,kind);
  }
}

// DOM 层（事件委托等无 state 上下文处）触发 toast 的桥：查找应用根元素并复用 showToast。
export function showToastGlobal(message: string,kind:ToastKind="info"): void {
  const app = document.querySelector("openclaw-app") as (Element & { requestUpdate?: () => void }) | null;
  if (!app || typeof app.requestUpdate !== "function") {
    return;
  }
  showToast(app as unknown as AppViewState, message,undefined,kind);
}
