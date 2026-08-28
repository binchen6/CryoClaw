// 守护回归（源码审计，同 git-ui.test.ts / worktrees-ui.test.ts 模式）：
// R41 Task 5「后台会话终态及时刷新侧边栏 + lastActiveSessionKey 守卫」。
// app-gateway.ts 为重模块（依赖 gateway 客户端/大量 UI 控制器），在 node 下
// 不可导入，只能钉源码。本文件钉住 chat 事件分支的两条语义：
//
// 钉住的不变量：
// - 后台会话（cron/渠道/sub-agent）的 final/error/aborted 终态，在
//   `payload.sessionKey !== host.sessionKey` 过滤后调用模块内既有的
//   scheduleTerminalSessionsRefresh（per-sessionKey 去重 + in-flight 合并），
//   侧边栏排序/标题/未读及时更新，不落到 30s ticker 兜底
// - setLastActiveSessionKey 仅在 `payload.sessionKey === host.sessionKey`
//   （当前会话事件）时调用；后台会话事件不得覆写「上次活跃会话」，
//   否则重启后会恢复到后台会话而非用户上次所看的会话
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 编译产物位于 chat-ui/ui/.test-dist/ui/src/ui/，源文件位于 chat-ui/ui/src/ui/
function src(rel: string): string {
  return readFileSync(new URL(`../../../../src/ui/${rel}`, import.meta.url), "utf8");
}

// 截取 chat 事件分支（自 `if (evt.event === "chat")` 到下一个事件分支边界）
function chatBranch(s: string): string {
  const start = s.indexOf('if (evt.event === "chat")');
  assert.notEqual(start, -1, "app-gateway.ts 缺少 chat 事件分支");
  const end = s.indexOf('if (evt.event === "exec.approval.requested")', start);
  assert.notEqual(end, -1, "无法定位 chat 事件分支边界");
  return s.slice(start, end);
}

test("app-gateway.ts：后台会话终态（final/error/aborted）触发侧边栏刷新", () => {
  const s = chatBranch(src("app-gateway.ts"));
  // 后台会话判定（sessionKey 不等）+ 终态判定 → 复用既有去重刷新，而非新写拉取逻辑
  assert.match(
    s,
    /payload\.sessionKey !== host\.sessionKey[\s\S]*?payload\.state === "final"[\s\S]*?payload\.state === "error"[\s\S]*?payload\.state === "aborted"[\s\S]*?scheduleTerminalSessionsRefresh\(host as unknown as OpenClawApp, payload\.sessionKey\);/,
    "后台会话终态应在 payload.sessionKey !== host.sessionKey 过滤后调用 scheduleTerminalSessionsRefresh(host, payload.sessionKey)",
  );
  // 补刷新后提前 return：不进 handleChatEvent（其首行按 sessionKey 过滤），
  // 也不触碰仅服务当前会话的 consumePendingSessionReset / loadChatHistory
  assert.match(
    s,
    /scheduleTerminalSessionsRefresh\(host as unknown as OpenClawApp, payload\.sessionKey\);\s*\n\s*return;/,
    "后台会话终态补刷新后应提前 return",
  );
});

test("app-gateway.ts：setLastActiveSessionKey 仅对当前会话事件调用（守卫）", () => {
  const s = chatBranch(src("app-gateway.ts"));
  assert.match(
    s,
    /payload\.sessionKey === host\.sessionKey[\s\S]*?setLastActiveSessionKey\(/,
    "setLastActiveSessionKey 调用应被 payload.sessionKey === host.sessionKey 条件包裹",
  );
  // 回归钉点：禁止此前「只要有 payload.sessionKey 就无条件调用」的写法
  assert.doesNotMatch(
    s,
    /if \(payload\?\.sessionKey\) \{\s*\n\s*setLastActiveSessionKey\(/,
    "setLastActiveSessionKey 不得在仅判断 payload.sessionKey 存在时无条件调用",
  );
});
