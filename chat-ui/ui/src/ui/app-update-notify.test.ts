// 守护回归（源码审计，同 i18n.test.ts / app-session-actions.test.ts 模式）：
// P1「软件更新策略与进度提示」的 UI 接线。重 UI 模块（app.ts /
// components/cc-sidebar.ts / tab-about.ts）在 node 下不可导入（顶层 new CSSStyleSheet() 等），只能钉源码。
//
// 钉住的不变量：
// - app.ts 全局订阅 app:update-state（onAppUpdateState），断开时清理；
//   downloaded 态弹带 action 的 toast（appUpdateQuitAndInstall 重启），角标驱动 appUpdateBadge
// - app-render.ts 把 appUpdateBadge 传给 sidebar，并渲染 toast action 按钮
// - components/cc-sidebar.ts 设置入口渲染更新角标（sidebar.updateBadge，R41 Task 12 自 sidebar.ts 迁入）
// - tab-about.ts 渲染 releaseNotes / error 详情 / 重试按钮 / 查看更新日志入口
// - app-toast.ts 支持 action（getToastAction）且带 action 时不自动消失
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 编译产物位于 chat-ui/ui/.test-dist/ui/src/ui/，源文件位于 chat-ui/ui/src/ui/
function src(rel: string): string {
  return readFileSync(new URL(`../../../../src/ui/${rel}`, import.meta.url), "utf8");
}

test("app.ts：全局订阅 app:update-state 并在断开时清理", () => {
  const s = src("app.ts");
  assert.match(s, /onAppUpdateState\(/, "app.ts 应订阅 onAppUpdateState");
  assert.match(s, /appUpdateGetState\?\.\(\)/, "app.ts 首屏应拉一次更新状态快照");
  assert.match(s, /this\.appUpdateStateCleanup = null/, "disconnectedCallback 应清理订阅");
});

test("app.ts：downloaded 态 toast 带「重启更新」action，走 appUpdateQuitAndInstall", () => {
  const s = src("app.ts");
  assert.match(s, /t\("appUpdate\.toastDownloaded"\)/, "缺少 downloaded toast 文案");
  assert.match(s, /t\("appUpdate\.toastRestart"\)/, "缺少 action 按钮文案");
  assert.match(s, /appUpdateQuitAndInstall\?\.\(\)/, "action 应调 appUpdateQuitAndInstall");
  // 角标：available/downloading/downloaded 时常驻
  assert.match(s, /appUpdateBadge\s*=\s*[\s\S]*?"downloaded"/, "appUpdateBadge 应覆盖 downloaded 态");
});

test("app-render.ts：sidebar 收到 settingsUpdateBadge，toast 渲染 action 按钮", () => {
  const s = src("app-render.ts");
  assert.match(s, /settingsUpdateBadge: state\.appUpdateBadge/, "应向 sidebar 传 settingsUpdateBadge");
  assert.match(s, /global-toast__action/, "应渲染 toast action 按钮");
  assert.match(s, /getToastAction\(\)/, "应读取 toast action");
});

test("cc-sidebar：设置入口渲染更新角标", () => {
  const s = src("components/cc-sidebar.ts");
  assert.match(s, /props\.settingsUpdateBadge/, "sidebar 应接收 settingsUpdateBadge");
  assert.match(s, /t\("sidebar\.updateBadge"\)/, "角标应使用 sidebar.updateBadge 文案");
});

test("tab-about.ts：releaseNotes / error 详情 / 重试 / 查看更新日志", () => {
  const s = src("views/settings/tab-about.ts");
  assert.match(s, /oc-settings-release-notes/, "available/downloaded 态应渲染 releaseNotes 卡片");
  assert.match(s, /localizedNotes/, "releaseNotes 应按 locale 取值");
  assert.match(s, /tWithDetail\("settings\.about\.appUpdateError", us\.error\)/, "error 态应展示具体错误");
  assert.match(s, /settings\.about\.appUpdateRetry/, "error 态按钮应为「重试」");
  assert.match(s, /getReleaseNotes\(\{ all: true \}\)/, "查看更新日志应拉全量条目");
  assert.match(s, /oc-settings-progress__bar/, "下载进度条应使用 CSS class（token 化）");
});

test("app-toast.ts：支持 action 且带 action 时不自动消失", () => {
  const s = src("app-toast.ts");
  assert.match(s, /export function getToastAction\(\)/, "应导出 getToastAction");
  assert.match(s, /export function hideToast/, "应导出 hideToast");
  assert.match(s, /if \(!action\)/, "仅无 action 的 toast 走 4s 自动消失");
});
