import type { AppViewState } from "../app-view-state.ts";
import { t } from "../i18n.ts";
import * as ipc from "./ipc-bridge.ts";

// Kimi OAuth 登录相关 UI 状态公共字段（tab-provider / setup-step2-provider 共用）。
export interface KimiOAuthFlowState {
  oauthLoading: boolean;
  oauthSuccess: boolean;
  oauthNoMembership: boolean;
  error: string | null;
}

// Kimi OAuth 登录公共流程：重置状态 → 调登录 → 失败写错误；成功走回调。
// 连接异常统一归为 setup.error.connection；oauthLoading 保证复位。
export async function runKimiOAuthLogin(
  state: AppViewState,
  st: KimiOAuthFlowState,
  onLoggedIn: (accessToken: string | null) => Promise<void> | void,
): Promise<void> {
  if (st.oauthLoading) return;
  st.oauthLoading = true;
  st.oauthSuccess = false;
  st.oauthNoMembership = false;
  st.error = null;
  state.requestUpdate();
  try {
    const result = await ipc.kimiOAuthLogin();
    if (!result.success) {
      st.error = result.message ?? t("setup.error.verifyFailed");
      st.oauthLoading = false;
      state.requestUpdate();
      return;
    }
    await onLoggedIn(result.accessToken ?? null);
  } catch (e: any) {
    st.error = t("setup.error.connection") + (e?.message ?? "");
    st.oauthLoading = false;
    state.requestUpdate();
  }
}
