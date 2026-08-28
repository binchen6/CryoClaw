import type { GatewaySessionRow, SessionsListResult } from "../types.ts";

// sessions.changed 事件本地 patch（对齐官方 control-ui 的事件驱动刷新）：
// 内核在会话变更时广播行快照子集字段（来自 buildGatewaySessionEventFields），
// 命中缓存行就地浅合并即可免一次全量 sessions.list。
//
// 保守原则（任何不确定都返回 null 让调用方回落全量重拉，正确性优先于省一次请求）：
//  1) 不新增行——新会话/排序/分组/字段完整性交给全量重拉，避免缺字段的新行进列表；
//  2) 不引入事件元字段（ts/phase/messageId/messageSeq/sessionKey/agentId）；
//  3) 不新增行上原本没有的字段——防事件特有字段污染行结构。
//
// 已知边界（有意不处理，等下一次全量重拉收敛）：
//  ① 被删除的会话不会因事件从列表消失；
//  ② 新会话不进列表；
//  ③ 归档会话的事件可能 patch 到被过滤的行——无害。
//
// 事件元字段：这些是广播点附加的定位/相位信息，不属于行快照，不写进行。
const META_FIELDS: ReadonlySet<string> = new Set([
  "ts",
  "phase",
  "messageId",
  "messageSeq",
  "sessionKey",
  "agentId",
]);

export function applySessionsChangedPatch(
  current: SessionsListResult | null | undefined,
  payload: unknown,
): SessionsListResult | null {
  // 1) payload 必须是非空对象且带非空字符串 sessionKey，否则无法定位 → 全量重拉。
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const sessionKey = (payload as Record<string, unknown>).sessionKey;
  if (typeof sessionKey !== "string" || sessionKey === "") {
    return null;
  }

  // 2) current?.sessions 必须是非空数组，否则没有可 patch 的缓存行。
  const sessions = current?.sessions;
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return null;
  }

  // 3) 定位命中行；未命中 → 不追加，返回 null 交给全量重拉保证列表完整性。
  const index = sessions.findIndex((row) => row.key === sessionKey);
  if (index < 0) {
    return null;
  }

  // 4) 合并：遍历事件自有字段，跳过元字段与行上不存在的字段（白名单 = 行已有字段集合），
  //    命中字段浅覆盖。行身份不靠事件改，故 key 也在元字段集合里被排除。
  const row = sessions[index];
  const merged: GatewaySessionRow = { ...row };
  const event = payload as Record<string, unknown>;
  for (const field of Object.keys(event)) {
    if (META_FIELDS.has(field)) {
      continue;
    }
    if (!(field in row)) {
      continue;
    }
    merged[field] = event[field];
  }

  // 5) 不可变返回：顶层对象与 sessions 数组都是新的，仅命中行替换为新对象，
  //    未命中行保持原引用，避免误伤其他行的引用相等判断。
  const nextSessions = sessions.slice();
  nextSessions[index] = merged;
  return { ...current, sessions: nextSessions };
}
