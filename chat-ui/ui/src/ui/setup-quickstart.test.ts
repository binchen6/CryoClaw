// 守护回归（源码审计，同 i18n.test.ts / app-update-notify.test.ts 模式）：
// Setup 快速通道「检测本机已有 API 访问 → 一键采用」的接线。step2 视图模块
// 依赖 Lit/gateway client，node 下不可导入，只能钉源码。
//
// 钉住的不变量：
// - 主进程 setup-ipc.ts 注册 setup:detect-env-keys / setup:adopt-env-key，均校验 sender；
//   adopt 走 ENV_KEY_CANDIDATES 白名单（resolveEnvCandidate）+ verifyProvider 真实验证
//   + persistSetupProviderConfig 共享落盘（与 setup:save-config 同一份逻辑）
// - setup-env-detect.ts 映射表覆盖 6 个环境变量，对外只暴露掩码（maskedKey）
// - preload 暴露 detectEnvKeys / adoptEnvKey；ipc-bridge 有封装与 window 类型声明
// - step2 进入时调 detectEnvKeys，有结果渲染 oc-setup-quickstart 卡片，成功 goToStep(3)
// - i18n setup.quickstart.* zh/en 双区齐备；样式 token 化
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

test("setup-ipc.ts：注册 detect-env-keys / adopt-env-key 且均校验 sender", () => {
  const s = mainSrc("setup-ipc.ts");
  for (const ch of ["setup:detect-env-keys", "setup:adopt-env-key"]) {
    const esc = ch.replace(":", "\\:");
    assert.match(s, new RegExp(`ipcMain\\.handle\\("${esc}"`), `缺少 ${ch} handler`);
    assert.match(s, new RegExp(`assertTrustedIpcSender\\(\\w+, "${esc}"\\)`), `${ch} 应校验 sender`);
  }
});

test("setup-ipc.ts：adopt 走映射表白名单 + verifyProvider 验证 + 共享落盘", () => {
  const s = mainSrc("setup-ipc.ts");
  assert.match(s, /resolveEnvCandidate\(providerKey, envVar\)/, "adopt 应校验 (providerKey, envVar) 白名单组合");
  assert.match(s, /process\.env\[envVar\]/, "明文 key 应由主进程从 process.env 读取");
  assert.match(s, /verifyProvider\(\{/, "adopt 应走 verifyProvider 真实验证");
  // 落盘逻辑抽成共享函数，save-config 与 adopt 都复用
  assert.match(s, /function persistSetupProviderConfig\(/, "应抽出 persistSetupProviderConfig 共享落盘函数");
  assert.ok(
    (s.match(/persistSetupProviderConfig\(\{/g) ?? []).length >= 2,
    "setup:save-config 与 setup:adopt-env-key 都应复用 persistSetupProviderConfig",
  );
});

test("setup-env-detect.ts：映射表覆盖 6 个环境变量，对外只暴露掩码", () => {
  const s = mainSrc("setup-env-detect.ts");
  for (const v of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "MOONSHOT_API_KEY",
    "DEEPSEEK_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
  ]) {
    assert.ok(s.includes(`"${v}"`), `映射表缺 ${v}`);
  }
  assert.match(s, /maskedKey/, "检测输出应为掩码 maskedKey");
  assert.match(s, /export function maskApiKey/, "应导出 maskApiKey");
});

test("preload：暴露 detectEnvKeys / adoptEnvKey", () => {
  const s = mainSrc("preload.ts");
  assert.match(s, /detectEnvKeys:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("setup:detect-env-keys"\)/);
  assert.match(s, /adoptEnvKey:[\s\S]*?ipcRenderer\.invoke\("setup:adopt-env-key"/);
});

test("ipc-bridge.ts：detectEnvKeys / adoptEnvKey 封装 + window 类型声明", () => {
  const s = src("data/ipc-bridge.ts");
  assert.match(s, /export interface EnvKeyCandidate/, "缺 EnvKeyCandidate 类型");
  assert.match(s, /export interface AdoptEnvKeyResult/, "缺 AdoptEnvKeyResult 类型");
  assert.match(s, /export async function detectEnvKeys\(\): Promise<EnvKeyCandidate\[\]>/);
  assert.match(s, /export async function adoptEnvKey\(/);
  assert.match(s, /detectEnvKeys\?: \(\) => Promise<any>/, "window 声明缺 detectEnvKeys");
  assert.match(s, /adoptEnvKey\?: \(params: Record<string, unknown>\) => Promise<any>/, "window 声明缺 adoptEnvKey");
});

test("step2：进入时检测、有结果渲染快速采用卡片、成功跳 step3", () => {
  const s = src("views/setup/setup-step2-provider.ts");
  assert.match(s, /maybeLoadEnvKeys\(state\)/, "renderStep2 应触发环境变量检测");
  assert.match(s, /ipc\.detectEnvKeys\(\)/, "应调 detectEnvKeys");
  assert.match(s, /qs\.candidates\.length/, "无检测结果时不渲染（零干扰）");
  assert.match(s, /oc-setup-quickstart/, "应渲染快速采用卡片");
  assert.match(s, /ipc\.adoptEnvKey\(\{ providerKey: candidate\.providerKey, envVar: candidate\.envVar \}\)/);
  assert.match(s, /result\.ok[\s\S]{0,120}?goToStep\(3\)/, "采用成功应 goToStep(3)（与手动保存同路径）");
  assert.match(s, /qs\.errors\[candidate\.envVar\]/, "失败应在卡片下方显示错误");
});

test("i18n：setup.quickstart.* zh/en 双区齐备", () => {
  const keys = [
    "setup.quickstart.title",
    "setup.quickstart.subtitle",
    "setup.quickstart.adopt",
    "setup.quickstart.verifying",
    "setup.quickstart.failed",
  ];
  for (const f of ["i18n/zh.ts", "i18n/en.ts"]) {
    const s = src(f);
    for (const k of keys) {
      assert.ok(s.includes(`"${k}"`), `${f} 缺 ${k}`);
    }
  }
});

test("setup.css：quickstart 卡片样式存在且 token 化", () => {
  const s = readFileSync(new URL("../../../../src/styles/setup.css", import.meta.url), "utf8");
  assert.match(s, /\.oc-setup-quickstart\s*\{/);
  assert.match(s, /\.oc-setup-quickstart__item/);
  // 不应出现硬编码颜色（走 design token）
  const block = s.match(/\.oc-setup-quickstart[\s\S]*?(?=\n\/\* |$)/)![0];
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, "quickstart 样式不应硬编码颜色");
});
