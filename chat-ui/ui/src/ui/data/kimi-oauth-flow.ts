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
const attempts=new WeakMap<KimiOAuthFlowState,object>();

// Kimi OAuth 登录公共流程：重置状态 → 调登录 → 失败写错误；成功走回调。
// 连接异常统一归为 setup.error.connection；oauthLoading 保证复位。
export async function runKimiOAuthLogin(
  state: AppViewState,
  st: KimiOAuthFlowState,
  onLoggedIn: (accessToken: string | null,isCurrent:()=>boolean) => Promise<void> | void,
): Promise<void> {
  if (st.oauthLoading) return;
  const attempt={};attempts.set(st,attempt);
  const owns=()=>attempts.get(st)===attempt;
  const current=()=>owns() && st.oauthLoading;
  st.oauthLoading = true;
  st.oauthSuccess = false;
  st.oauthNoMembership = false;
  st.error = null;
  state.requestUpdate();
  // onLoggedIn 调用移出 try：catch 只归 IPC 连接/调用错误为 connection，
  // 回调自身的抛错不应被误报为连接错误
  let accessToken: string | null = null;
  try {
    const result = await ipc.kimiOAuthLogin();
    if(!current())return;
    if (!result.success) {
      st.error = result.message ?? t("setup.error.verifyFailed");
      st.oauthLoading = false;
      state.requestUpdate();
      return;
    }
    accessToken = result.accessToken ?? null;
  } catch (e: any) {
    if(!current())return;
    st.error = t("setup.error.connection") + (e?.message ?? "");
    st.oauthLoading = false;
    state.requestUpdate();
    return;
  }
  try {if(current())await onLoggedIn(accessToken,current);}
  catch(error:any){if(current())st.error=error?.message??t("setup.error.verifyFailed");}
  finally{if(owns()){st.oauthLoading=false;state.requestUpdate();}}
}
