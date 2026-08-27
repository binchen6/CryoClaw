// 守护回归（源码审计，同 i18n.test.ts 模式）：任务页「打开会话」/ Cron 运行记录
// 「跳转会话」曾直接 applySettings({ sessionKey }) —— 只写持久化设置，不切换活跃会话
// （state.sessionKey 不变、不重置流态、不拉历史），点击后仍停留在旧对话。
// fix：统一走 handleSessionChange（与侧边栏点击同一条完整切换路径）。
// 注：handleSessionChange 的完整切换语义由 session-transition.test.ts 钉住；
// 本测试钉住的是接线——两个面板入口不得再绕开完整切换路径直写 settings。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 编译产物位于 chat-ui/ui/.test-dist/ui/src/ui/，源文件位于 chat-ui/ui/src/ui/
const panelEntries = ["app-tasks.ts", "app-cron.ts"];

// 直写 settings.sessionKey 的旧模式（applySettings 载荷里携带 sessionKey）
const DIRECT_SETTINGS_SESSION_RE = /applySettings\(\s*\{[^}]*\bsessionKey\b/s;

for (const name of panelEntries) {
  test(`${name}：跳转会话走 handleSessionChange 完整切换路径`, () => {
    const src = readFileSync(new URL(`../../../../src/ui/${name}`, import.meta.url), "utf8");
    assert.match(
      src,
      /handleSessionChange\(state, sessionKey\)/,
      `${name} 应调用 handleSessionChange(state, sessionKey)`,
    );
    assert.ok(
      !DIRECT_SETTINGS_SESSION_RE.test(src),
      `${name} 不得再直接 applySettings 写 sessionKey（只写设置不切会话的回归）`,
    );
  });
}

// reconcile 双调用点（tick 路径 / 删除路径）都必须带隐藏会话豁免，
// 否则显式跳转到归档会话会被 30s tick 弹回 main。
const reconcileEntries: Array<[string, string]> = [
  ["app-gateway.ts", "reconcileSessionSelection"],
  ["app-session-actions.ts", "reconcileVisibleSession"],
];

for (const [name, fn] of reconcileEntries) {
  test(`${name}：${fn} 带 isToleratedHiddenSession 豁免`, () => {
    const src = readFileSync(new URL(`../../../../src/ui/${name}`, import.meta.url), "utf8");
    assert.match(src, /isToleratedHiddenSession\(/, `${name} 的 reconcile 缺少隐藏会话豁免`);
  });
}
