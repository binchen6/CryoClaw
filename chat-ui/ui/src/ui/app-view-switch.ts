/**
 * 视图切换 —— cryoclawView 状态机。
 *
 * 独立成模块是为了打破循环依赖：各视图控制器（反馈/技能等）需要切换视图，
 * 而视图切换又要通知控制器做进入/离开清理。控制器通过
 * registerViewLeaveHook / registerViewEnterHook 注册钩子，本模块不反向依赖它们。
 */

import type { AppViewState } from "./app-view-state.ts";
import { cleanupSettingsView } from "./views/settings/settings-view.ts";
import type { CryoClawViewId } from "./views/registry.ts";

type ViewHook = (state: AppViewState) => void;

const enterHooks = new Map<CryoClawViewId, ViewHook>();
const leaveHooks = new Map<CryoClawViewId, ViewHook>();

export function registerViewEnterHook(view: CryoClawViewId, hook: ViewHook) {
  enterHooks.set(view, hook);
}

export function registerViewLeaveHook(view: CryoClawViewId, hook: ViewHook) {
  leaveHooks.set(view, hook);
}

export function setCryoClawView(state: AppViewState, next: CryoClawViewId) {
  const prev = state.settings.cryoclawView ?? "chat";
  if (prev === next) {
    return;
  }
  leaveHooks.get(prev)?.(state);
  if (prev === "settings") {
    cleanupSettingsView();
  }
  enterHooks.get(next)?.(state);
  state.applySettings({
    ...state.settings,
    cryoclawView: next,
  });
}
