import type { GatewayBrowserClient } from "../gateway.ts";

export type WorkspaceGatewayState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
};

// 从 gateway 动态获取 agent 的 workspace 路径（agents.files.list 响应里的 workspace 字段）。
// 未连接时返回 null；RPC 失败向上抛，由调用方统一降级为错误提示。
export async function resolveAgentWorkspacePath(
  state: WorkspaceGatewayState,
  agentId: string,
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const res = await state.client.request<{ workspace?: string } | undefined>(
    "agents.files.list",
    { agentId },
  );
  return res?.workspace ?? null;
}
