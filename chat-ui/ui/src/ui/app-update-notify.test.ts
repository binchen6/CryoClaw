// 守护回归（源码审计，同 i18n.test.ts / app-session-actions.test.ts 模式）：
// P1「软件更新策略与进度提示」的 UI 接线。重 UI 模块（app.ts /
// components/cc-sidebar.ts / tab-about.ts）在 node 下不可导入（顶层 new CSSStyleSheet() 等），只能钉源码。
//
// 钉住的不变量：
// - app.ts 全局订阅 app:update-state（onAppUpdateState），断开时清理；
//   downloaded 态弹带 action 的 toast（appUpdateQuitAndInstall 重启），角标驱动 appUpdateBadge
// - app-render.ts 把 appUpdateBadge 传给 sidebar，并渲染 toast action 按钮
// - components/cc-sidebar.ts 设置入口渲染更新角标（rail-dot 圆点，R42 第二期图标轨化）
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

test("cc-rail：设置入口渲染更新角标", () => {
  const s = src("components/cc-rail.ts");
  // 关联断言：徽标（微信/更新）必须驱动 rail-dot 圆点渲染，防止退化为各自独立的存在性检查
  assert.match(s, /props\.settingsBadge \|\| props\.settingsUpdateBadge[\s\S]{0,100}?cc-rail__dot/, "更新/微信徽标应驱动 rail-dot 圆点");
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

// ── v2026.906.0：更新弹窗 + 暂缓 + 非静默换装 守护 ──

// 主进程源码（仓库根 src/；编译产物上 6 级到仓库根）
function mainSrc(rel: string): string {
  return readFileSync(new URL(`../../../../../../src/${rel}`, import.meta.url), "utf8");
}

test("主进程 app-updater.ts：autoDownload=false + 启动检查受暂缓门控", () => {
  const s = mainSrc("app-updater.ts");
  assert.match(s, /autoUpdater\.autoDownload = false/, "应关闭自动下载（用户点「更新」才下载）");
  assert.match(s, /isUpdateSnoozed\(\)/, "启动自动检查应查暂缓状态");
  assert.match(s, /downloadAppUpdate\(\)[\s\S]*?autoUpdater\.downloadUpdate\(\)/, "downloadAppUpdate 应调 downloadUpdate");
  assert.match(s, /snoozeAppUpdate[\s\S]*?writeSnooze/, "snoozeAppUpdate 应持久化暂缓");
});

test("主进程 app-updater.ts：换装非静默（无 /S，安装器带进度条）", () => {
  const s = mainSrc("app-updater.ts");
  assert.match(s, /spawn\(installerPath, \["--updated", "--force-run"\]/, "spawn 安装器不应带 /S");
  assert.match(s, /quitAndInstall\(false, true\)/, "回退路径应 isSilent=false");
  assert.doesNotMatch(s, /\["--updated", "\/S"/, "不应再出现静默换装参数");
});

test("主进程 about.ts：download/snooze/clear-snooze 通道均校验 sender", () => {
  const s = mainSrc("settings/about.ts");
  for (const ch of ["app-update:download", "app-update:snooze", "app-update:clear-snooze"]) {
    assert.match(s, new RegExp(`assertTrustedIpcSender\\(event, "${ch.replace(":", "\\:")}"\\)`), `${ch} 应校验 sender`);
  }
  // snooze 天数上限守卫（防超大时间戳）
  assert.match(s, /days > 3650/, "snooze 应限制天数上限");
});

test("preload：app-update 新通道齐备", () => {
  const s = mainSrc("preload.ts");
  assert.match(s, /app-update:download/, "缺少 appUpdateDownload");
  assert.match(s, /app-update:snooze/, "缺少 appUpdateSnooze");
  assert.match(s, /app-update:clear-snooze/, "缺少 appUpdateClearSnooze");
});

test("app.ts：available 自动弹窗 + 同版本关闭后不重复弹 + snooze/download 动作", () => {
  const s = src("app.ts");
  assert.match(s, /showUpdateDialog = true/, "进入 available 应自动弹出更新弹窗");
  assert.match(s, /updateDialogDismissedFor/, "应记住本会话已关闭弹窗的版本");
  assert.match(s, /appUpdateDownload\?\.\(\)/, "startUpdateDownload 应调 appUpdateDownload");
  assert.match(s, /appUpdateSnooze\?\.\(opts\)/, "snoozeUpdate 应调 appUpdateSnooze");
  assert.match(s, /snoozeUpdateCustom\(\)[\s\S]*?days > 3650/, "自定义暂缓应校验天数范围");
});

test("update-available-dialog.ts：更新/暂缓按钮 + 四预设 + 自定义 + 进度条 + 重启安装", () => {
  const s = src("views/update-available-dialog.ts");
  assert.match(s, /appUpdate\.updateNow/, "应有「更新」按钮");
  assert.match(s, /appUpdate\.snooze"/, "应有「暂缓」按钮");
  for (const opt of ["days: 7", "days: 30", "days: 90", "forever: true"]) {
    assert.ok(s.includes(opt), `暂缓预设缺 ${opt}`);
  }
  assert.match(s, /updateSnoozeDays/, "应有自定义天数输入");
  assert.match(s, /oc-settings-progress__bar/, "下载中应渲染进度条");
  assert.match(s, /appUpdate\.restartInstall/, "downloaded 态应有「重启安装」");
  assert.match(s, /releaseNotes\[lang/, "更新日志应按 locale 取值");
});

test("app-render.ts 挂载更新弹窗", () => {
  const s = src("app-render.ts");
  assert.match(s, /renderUpdateAvailableDialog\(state\)/, "app-render 应渲染更新弹窗");
});

test("tab-about.ts：available 态「更新」按钮 + 暂缓状态行与恢复入口", () => {
  const s = src("views/settings/tab-about.ts");
  assert.match(s, /handleAppUpdateDownload/, "available 态应有下载按钮（autoDownload=false）");
  assert.match(s, /appUpdateClearSnooze/, "应有恢复自动检查入口");
  assert.match(s, /snoozedUntil/, "应展示暂缓状态");
});

test("tab-about.ts：「查看更新详情」重开更新弹窗（弹窗关闭后的重开入口）", () => {
  const s = src("views/settings/tab-about.ts");
  assert.match(s, /settings\.about\.appUpdateViewDetails/, "应有「查看更新详情」按钮文案");
  assert.match(s, /function handleViewUpdateDetails[\s\S]{0,200}?state\.showUpdateDialog = true/, "点击应重开 update-available-dialog");
});

test("update-available-dialog.ts：「立即更新」点击后到 downloading 推送之间禁用按钮（防双击）", () => {
  const s = src("views/update-available-dialog.ts");
  assert.match(s, /let updateDownloadInFlight = false/, "应有本地 in-flight 标志");
  assert.match(s, /us\.status !== "available"\) updateDownloadInFlight = false/, "状态迁移时应复位 in-flight");
  assert.match(s, /\?disabled=\$\{updateNowDisabled\}/, "按钮应随 in-flight 禁用");
});

test("i18n：更新弹窗 key 双区齐全（抽样；全集一致性由 i18n.test.ts 保证）", () => {
  const zh = src("i18n/zh.ts");
  const en = src("i18n/en.ts");
  for (const key of ["appUpdate.dialogTitle", "appUpdate.snoozeForever", "appUpdate.downloadedHint", "appUpdate.restartInstall", "appUpdate.resumeCheck"]) {
    assert.ok(zh.includes(`"${key}"`), `zh 缺 ${key}`);
    assert.ok(en.includes(`"${key}"`), `en 缺 ${key}`);
  }
});
