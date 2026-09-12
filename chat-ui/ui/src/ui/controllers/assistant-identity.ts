import type { GatewayBrowserClient } from "../gateway.ts";
import { normalizeAssistantIdentity } from "../assistant-identity.ts";

export type AssistantIdentityState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string | null;
};

export async function loadAssistantIdentity(
  state: AssistantIdentityState,
  opts?: { sessionKey?: string },
) {
  if (!state.client || !state.connected) {
    return;
  }
  const requestSessionKey = opts?.sessionKey?.trim() || state.sessionKey.trim();
  const params = requestSessionKey ? { sessionKey: requestSessionKey } : {};
  try {
    const res = await state.client.request("agent.identity.get", params);
    if (!res) {
      return;
    }
    // 会话切换竞态守卫：请求在途时用户可能已切到别的会话（切换方总会重新发起
    // 加载），迟到的旧会话身份不能覆盖当前会话——否则头部/头像显示上一个 agent
    if (state.sessionKey.trim() !== requestSessionKey) {
      return;
    }
    const normalized = normalizeAssistantIdentity(res);
    state.assistantName = normalized.name;
    state.assistantAvatar = normalized.avatar;
    state.assistantAgentId = normalized.agentId ?? null;
  } catch {
    // Ignore errors; keep last known identity.
  }
}
