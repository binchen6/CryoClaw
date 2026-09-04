// 守护回归（源码审计，同 app-update-notify.test.ts 模式）：
// 「内核版本低于最低支持版本时启动后自动升级」的接线不变量。
// 重 UI 模块（app.ts / views）在 node 下不可导入（顶层 new CSSStyleSheet() 等），只能钉源码。
//
// 钉住的不变量：
// - 主进程：kernel-updater.ts 的 isKernelBelowMinSupported 门槛与 kernel-channel.json
//   minSupported 一致（2026.7）；orchestrate 所有 push 带 source，成功/失败补终态事件；
//   main.ts 的 scheduleAutoKernelUpgradeIfNeeded 仅打包环境生效、防重复调度、
//   25s 延迟 unref、导入进行中放弃、cryoclaw/legacy-cryoclaw 两分支调用
// - 渲染层：app.ts 全局订阅 onKernelUpdateProgress，仅 source==="auto" 更新横幅，
//   done 态 setTimeout 自动清除，disconnectedCallback 清理订阅与计时器
// - kernel-auto-upgrade-banner.ts：进度条 pct 驱动宽度 + msg + i18n 标题 +
//   error 态关闭按钮；app-render.ts 挂载横幅
// - 桥接：preload/window/ipc-bridge 的进度载荷带 source 字段
// - i18n：kernelAutoUpgrade.* 键 zh/en 双区齐全
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 编译产物位于 chat-ui/ui/.test-dist/ui/src/ui/，源文件位于 chat-ui/ui/src/ui/
function src(rel: string): string {
  return readFileSync(new URL(`../../../../src/ui/${rel}`, import.meta.url), "utf8");
}

// 主进程源码（仓库根 src/；编译产物上 6 级到仓库根）
function mainSrc(rel: string): string {
  return readFileSync(new URL(`../../../../../../src/${rel}`, import.meta.url), "utf8");
}

test("主进程 kernel-updater.ts：最低支持版本判定与 kernel-channel.json minSupported 一致", () => {
  const s = mainSrc("kernel-updater.ts");
  assert.match(s, /export function isKernelBelowMinSupported\(\): boolean/, "应导出 isKernelBelowMinSupported");
  assert.match(s, /readKernelVersionParts\(\)/, "应复用 readKernelVersionParts 读 gateway 包版本");
  assert.match(s, /versionAtLeast\(parts, MIN_SUPPORTED_KERNEL_VERSION\)/, "应复用 versionAtLeast 比较");
  assert.match(s, /MIN_SUPPORTED_KERNEL_VERSION = \{ year: 2026, month: 7 \}/, "门槛应为 2026.7");
  assert.match(s, /if \(!parts\) return false/, "读不到版本应保守返回 false");
  // 文件头/常量注释须说明与 kernel-channel.json minSupported 的同步关系
  assert.match(s, /kernel-channel\.json 的 minSupported/, "注释应说明与 kernel-channel.json minSupported 保持一致");
  const channel = JSON.parse(readFileSync(new URL("../../../../../../kernel-channel.json", import.meta.url), "utf8"));
  assert.equal(channel.minSupported, "2026.7.0", "kernel-channel.json minSupported 应与代码门槛一致");
});

test("主进程 kernel-updater.ts：progress 带 source，成功/失败补终态事件", () => {
  const s = mainSrc("kernel-updater.ts");
  assert.match(s, /source\?: "auto" \| "manual"/, "KernelUpdateProgress 应有 source 字段");
  assert.match(s, /orchestrate\(args: string\[\], source: "auto" \| "manual" = "manual"\)/, "orchestrate 应接收 source 参数");
  // 终态：成功 done / 失败 error，均带 source
  assert.match(s, /step: "done",\s*pct: 100,[\s\S]*?内核已升级到 \$\{done\.to\}[\s\S]*?source/, "成功应推 done 终态");
  assert.match(s, /step: "error", pct: 100, msg: error, source/, "失败应推 error 终态");
  // 自动回滚路径的最终结论也要推终态（error 事件出现次数 ≥3：健康检查回滚、回退失败、catch）
  const errorEvents = s.match(/step: "error", pct: 100/g) ?? [];
  assert.ok(errorEvents.length >= 3, "自动回滚/catch 等所有失败结论都应推 error 终态");
  assert.match(s, /runKernelUpdate\(tag\?: string, source: "auto" \| "manual" = "manual"\)/, "runKernelUpdate 应透传 source");
});

test("主进程 main.ts：自动升级调度的护栏与触发", () => {
  const s = mainSrc("main.ts");
  assert.match(s, /function scheduleAutoKernelUpgradeIfNeeded\(\): void/, "应定义 scheduleAutoKernelUpgradeIfNeeded");
  assert.match(s, /if \(!app\.isPackaged\) return/, "仅打包环境生效");
  assert.match(s, /if \(autoKernelUpgradeScheduled\) return/, "模块级布尔防重复调度");
  assert.match(s, /if \(!isKernelBelowMinSupported\(\)\) return/, "仅低于最低支持版本时调度");
  assert.match(s, /25 \* 1000[\s\S]*?unref/, "应 25s 延迟且 unref");
  assert.match(s, /openclawStateImportLifecycle\.isImportActive\(\)[\s\S]*?log\.warn/, "导入进行中应记 warn 放弃");
  assert.match(s, /runKernelUpdate\(undefined, "auto"\)/, "应以 source=auto 触发升级");
  // cryoclaw / legacy-cryoclaw 两分支各调用一次（fresh/external 分支不调用）
  const calls = s.match(/scheduleAutoKernelUpgradeIfNeeded\(\);/g) ?? [];
  assert.equal(calls.length, 2, "启动序列两个分支各调用一次");
});

test("app.ts：订阅 onKernelUpdateProgress，仅 auto 更新横幅，断开时清理", () => {
  const s = src("app.ts");
  assert.match(s, /onKernelUpdateProgress\(/, "app.ts 应订阅 onKernelUpdateProgress");
  assert.match(s, /p\.source !== "auto"\) return/, "应仅处理 source===\"auto\" 的进度（manual 由 tab-about 自理）");
  assert.match(s, /this\.kernelUpdateProgressCleanup = null/, "disconnectedCallback 应清理订阅");
  assert.match(s, /kernelAutoUpgradeDoneTimer = setTimeout/, "done 态应 setTimeout 自动清除横幅");
  assert.match(s, /clearTimeout\(this\.kernelAutoUpgradeDoneTimer\)/, "断开/新事件/dismiss 应清计时器");
  assert.match(s, /dismissKernelAutoUpgrade\(\)/, "应提供 error 态关闭入口");
});

test("app-render.ts：挂载内核自动升级横幅", () => {
  const s = src("app-render.ts");
  assert.match(s, /renderKernelAutoUpgradeBanner\(state\.kernelAutoUpgrade/, "app-render 应渲染横幅并传进度");
  assert.match(s, /state\.dismissKernelAutoUpgrade\(\)/, "应接关闭回调");
});

test("kernel-auto-upgrade-banner.ts：进度条 + msg + i18n 标题 + error 关闭按钮", () => {
  const s = src("views/kernel-auto-upgrade-banner.ts");
  assert.match(s, /if \(!progress\) return nothing/, "null 应不渲染");
  assert.match(s, /kernel-auto-banner__bar" style="width:\$\{pct\}%/, "进度条宽度应由 pct 驱动");
  assert.match(s, /kernel-auto-banner__msg">\$\{progress\.msg\}/, "应渲染 msg 文本");
  assert.match(s, /t\("kernelAutoUpgrade\.title"\)/, "应有进行中标题");
  assert.match(s, /t\("kernelAutoUpgrade\.done"\)/, "应有完成标题");
  assert.match(s, /t\("kernelAutoUpgrade\.error"\)/, "应有失败标题");
  assert.match(s, /kernel-auto-banner--done/, "done 态应有成功样式修饰");
  assert.match(s, /kernel-auto-banner--error[\s\S]*?kernel-auto-banner__close/, "error 态应有警告样式 + 关闭按钮");
});

test("shell.css：横幅样式走 token（indigo 主色 / done 成功色 / error 警告色）", () => {
  const s = readFileSync(new URL("../../../../src/styles/shell.css", import.meta.url), "utf8");
  assert.match(s, /\.kernel-auto-banner \{[\s\S]*?var\(--bg-elevated\)/, "横幅应为浮出卡片");
  assert.match(s, /\.kernel-auto-banner__bar \{[\s\S]*?var\(--accent\)/, "进度条应为 indigo 主色");
  assert.match(s, /\.kernel-auto-banner--done[\s\S]*?var\(--ok\)/, "done 态应为成功色");
  assert.match(s, /\.kernel-auto-banner--error[\s\S]*?var\(--warn\)/, "error 态应为警告色");
});

test("桥接：preload / window / ipc-bridge 的进度载荷带 source 字段", () => {
  assert.match(mainSrc("preload.ts"), /onKernelUpdateProgress: \(cb: \(payload: \{[^}]*source\?: "auto" \| "manual"/, "preload 回调类型应带 source");
  assert.match(mainSrc("window.ts"), /pushKernelUpdateProgress\(payload: \{[^}]*source\?: "auto" \| "manual"/, "window 推送类型应带 source");
  const bridge = src("data/ipc-bridge.ts");
  assert.match(bridge, /interface KernelUpdateProgress \{[\s\S]*?source\?: "auto" \| "manual"/, "ipc-bridge KernelUpdateProgress 应带 source");
});

test("i18n：kernelAutoUpgrade.* 键 zh/en 双区齐全（全集一致性由 i18n.test.ts 保证）", () => {
  const zh = src("i18n/zh.ts");
  const en = src("i18n/en.ts");
  for (const key of ["kernelAutoUpgrade.title", "kernelAutoUpgrade.done", "kernelAutoUpgrade.error"]) {
    assert.ok(zh.includes(`"${key}"`), `zh 缺 ${key}`);
    assert.ok(en.includes(`"${key}"`), `en 缺 ${key}`);
  }
});
