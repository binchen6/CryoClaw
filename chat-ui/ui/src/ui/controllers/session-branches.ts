import type { GatewayBrowserClient } from "../gateway.ts";

// 会话分支（内核 2026.9.7 session branch tree）RPC 封装。
// 对应内核 RPC：sessions.branches.{list,switch} / sessions.rewind / sessions.fork
// （旧版 sessions.compaction.{list,restore,branch} 已被内核移除）。
// 模型：会话 transcript 是一棵树，可见历史 = active path——
//   rewind：把所选用户消息及其之后移出 active path（保留为可切换分支，非破坏），
//           该消息文本/图片附件经 editorText/editorAttachments 回填输入框（编辑重发）；
//   fork：从所选用户消息分叉一个全新会话（prefix 截止到该消息之前），返回新 sessionKey；
//   switch：把 active path 切到指定分支 tip（leafEntryId），原分支同样保留。

export type SessionBranch = {
  leafEntryId: string;
  headline: string;
  messageCount: number;
  updatedAt?: string;
  active: boolean;
};

// 内核 SessionsBranchesListResultSchema = { branches }（closedObject，无 ok 字段）
export type SessionBranchListResult = {
  branches?: SessionBranch[];
};

// rewind/fork 成功后回填输入框的内容（该用户消息的文本与内联图片）
export type SessionEditorRestore = {
  editorText?: string;
  editorAttachments?: Array<{ mimeType: string; data: string }>;
};

export type SessionForkResult = SessionEditorRestore & {
  sessionKey?: string;
};

export type SessionBranchState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionBranches: SessionBranch[];
  // 本次 branches 加载时对应的 sessionKey（异步返回可能晚于会话切换）
  sessionBranchesKey: string | null;
  sessionBranchesLoading: boolean;
  sessionBranchesError: string | null;
  // 正在执行的分支操作（switch:<leafEntryId> / rewind:<entryId> / fork:<entryId>），同一时刻一个
  branchBusyAction: string | null;
};

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// 拉取当前会话的分支列表（含 active 标记；外部 agent 接管的会话返回空）
export async function loadSessionBranches(state: SessionBranchState, key: string) {
  if (!state.client || !state.connected) {
    return;
  }
  state.sessionBranchesLoading = true;
  state.sessionBranchesError = null;
  try {
    const res = await state.client.request<SessionBranchListResult | undefined>(
      "sessions.branches.list",
      { sessionKey: key },
    );
    state.sessionBranches = Array.isArray(res?.branches) ? res.branches : [];
    // 结果归属到加载时的 key（跨会话误用防护，与旧 checkpoints 同语义）
    state.sessionBranchesKey = key;
  } catch (err) {
    state.sessionBranches = [];
    state.sessionBranchesKey = key;
    state.sessionBranchesError = errMessage(err);
  } finally {
    state.sessionBranchesLoading = false;
  }
}

// 切换到指定分支 tip（leafEntryId 必须是树上的 tip，当前 active 会报 already-active）
export async function switchSessionBranchTo(
  state: SessionBranchState,
  key: string,
  leafEntryId: string,
): Promise<boolean> {
  if (!state.client || !state.connected || state.branchBusyAction) {
    return false;
  }
  state.branchBusyAction = `switch:${leafEntryId}`;
  state.sessionBranchesError = null;
  try {
    await state.client.request("sessions.branches.switch", { sessionKey: key, leafEntryId });
    return true;
  } catch (err) {
    state.sessionBranchesError = errMessage(err);
    return false;
  } finally {
    state.branchBusyAction = null;
  }
}

// 回退（编辑重发）：把 active path 收回到所选用户消息之前，消息内容回填输入框
export async function rewindSessionToEntry(
  state: SessionBranchState,
  key: string,
  entryId: string,
): Promise<SessionEditorRestore | null> {
  if (!state.client || !state.connected || state.branchBusyAction) {
    return null;
  }
  state.branchBusyAction = `rewind:${entryId}`;
  state.sessionBranchesError = null;
  try {
    const res = await state.client.request<SessionEditorRestore | undefined>(
      "sessions.rewind",
      { sessionKey: key, entryId },
    );
    return res ?? {};
  } catch (err) {
    state.sessionBranchesError = errMessage(err);
    return null;
  } finally {
    state.branchBusyAction = null;
  }
}

// 分叉：从所选用户消息创建新会话，成功返回新 sessionKey
export async function forkSessionFromEntry(
  state: SessionBranchState,
  key: string,
  entryId: string,
): Promise<SessionForkResult | null> {
  if (!state.client || !state.connected || state.branchBusyAction) {
    return null;
  }
  state.branchBusyAction = `fork:${entryId}`;
  state.sessionBranchesError = null;
  try {
    const res = await state.client.request<SessionForkResult | undefined>(
      "sessions.fork",
      { sessionKey: key, entryId },
    );
    const nextKey = typeof res?.sessionKey === "string" ? res.sessionKey.trim() : "";
    if (!nextKey) {
      throw new Error("missing fork session key");
    }
    return { ...res, sessionKey: nextKey };
  } catch (err) {
    state.sessionBranchesError = errMessage(err);
    return null;
  } finally {
    state.branchBusyAction = null;
  }
}
