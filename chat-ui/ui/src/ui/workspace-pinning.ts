/**
 * 固定工作区（UI 侧组织能力，纯函数模块，独立可测）：
 * 工作区 = 路径 + 名称 + 图标，持久化在 UiSettings；会话可一对一绑定工作区，
 * 会话列表把绑定会话按工作区分组，未绑定会话保持原有置顶/时间分组。
 * 内核会话行不投影 cwd（2026.10.3 sessions.list 无 cwd 字段），故不做内核侧路由。
 */
import type { PinnedWorkspace } from "./storage.ts";
import type { SessionPanelSessionOption } from "./components/oc-session-panel.ts";

export type WorkspaceDraft = {
  name: string;
  icon?: string;
  path: string;
};

export type WorkspaceSection = {
  workspace: PinnedWorkspace;
  items: SessionPanelSessionOption[];
};

export function createWorkspaceId(): string {
  return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 追加工作区；name/path 必填（空串返回原列表），icon 缺省 📁 */
export function addWorkspace(
  list: readonly PinnedWorkspace[],
  draft: WorkspaceDraft,
): PinnedWorkspace[] {
  const name = draft.name.trim();
  const path = draft.path.trim();
  if (!name || !path) {
    return [...list];
  }
  const icon = draft.icon?.trim() || "📁";
  return [...list, { id: createWorkspaceId(), name, icon, path }];
}

/** 删除工作区并丢弃其全部会话绑定（绑定表同步清理，避免悬挂 id） */
export function removeWorkspace(
  list: readonly PinnedWorkspace[],
  map: Record<string, string>,
  workspaceId: string,
): { workspaces: PinnedWorkspace[]; map: Record<string, string> } {
  const workspaces = list.filter((w) => w.id !== workspaceId);
  const nextMap: Record<string, string> = {};
  for (const [sessionKey, wsId] of Object.entries(map)) {
    if (wsId !== workspaceId) {
      nextMap[sessionKey] = wsId;
    }
  }
  return { workspaces, map: nextMap };
}

/** 绑定/解绑会话到工作区；workspaceId 为 null 表示解绑 */
export function bindSessionToWorkspace(
  map: Record<string, string>,
  sessionKey: string,
  workspaceId: string | null,
): Record<string, string> {
  const next = { ...map };
  if (workspaceId) {
    next[sessionKey] = workspaceId;
  } else {
    delete next[sessionKey];
  }
  return next;
}

/** 读取会话绑定的工作区 id（无绑定/绑定到已删除工作区时返回 null 由调用方判空） */
export function sessionWorkspaceId(
  map: Record<string, string>,
  sessionKey: string,
): string | null {
  return map[sessionKey] ?? null;
}

/**
 * 把会话列表按工作区切分：每个工作区恒有一个 section（section 顺序 =
 * 工作区列表顺序，组内保持输入顺序；空工作区 items 为空数组，渲染层只画
 * 分组头 + 快速新建按钮），未绑定会话归入 unbound。
 * 绑定到不存在的工作区 id（脏数据/已删除残留）视为未绑定，保证会话可达。
 */
export function splitSessionsByWorkspace(
  sessions: readonly SessionPanelSessionOption[],
  workspaces: readonly PinnedWorkspace[],
  map: Record<string, string>,
): { sections: WorkspaceSection[]; unbound: SessionPanelSessionOption[] } {
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  const bucketed = new Map<string, SessionPanelSessionOption[]>();
  const unbound: SessionPanelSessionOption[] = [];
  for (const s of sessions) {
    const wsId = map[s.key];
    const ws = wsId ? byId.get(wsId) : undefined;
    if (ws) {
      const arr = bucketed.get(ws.id) ?? [];
      arr.push(s);
      bucketed.set(ws.id, arr);
    } else {
      unbound.push(s);
    }
  }
  const sections: WorkspaceSection[] = workspaces.map((w) => ({
    workspace: w,
    items: bucketed.get(w.id) ?? [],
  }));
  return { sections, unbound };
}
