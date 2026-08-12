import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildPosixWrapperForPaths,
  buildWinWrapperForPaths,
  buildWinPathEnvScript,
  hasManagedWrapper,
  inferCliEnabledPreference,
  resolvePosixRcPathsForHome,
  resolveWinCliBinDirsForPaths,
  stripManagedRcBlock,
} from "./cli-integration";

test("POSIX wrapper 应使用真实 Node.js（无 ELECTRON_RUN_AS_NODE）并注入 OPENCLAW_NO_RESPAWN", () => {
  const script = buildPosixWrapperForPaths("/Applications/CryoClaw/node", "/Applications/CryoClaw/openclaw.mjs");

  assert.ok(!script.includes("ELECTRON_RUN_AS_NODE"), "不应包含 ELECTRON_RUN_AS_NODE（CLI 用真实 Node.js）");
  assert.ok(script.includes("OPENCLAW_NO_RESPAWN=1"));
  assert.ok(script.includes('exec "$APP_NODE" "$APP_ENTRY" "$@"'));
});

test("Windows wrapper 应使用真实 Node.js（无 ELECTRON_RUN_AS_NODE）并注入 OPENCLAW_NO_RESPAWN", () => {
  const script = buildWinWrapperForPaths("C:\\CryoClaw\\node.exe", "C:\\CryoClaw\\openclaw.mjs");

  assert.ok(!script.includes("ELECTRON_RUN_AS_NODE"), "不应包含 ELECTRON_RUN_AS_NODE（CLI 用真实 Node.js）");
  assert.ok(script.includes('set "OPENCLAW_NO_RESPAWN=1"'));
  assert.ok(script.includes('"%APP_NODE%" "%APP_ENTRY%" %*'));
});

test("Windows PATH 脚本中的 try/catch 不能被分号打断", () => {
  const script = buildWinPathEnvScript("add", "C:\\Users\\admin\\AppData\\Local\\CryoClaw\\bin");
  assert.equal(/}\s*;\s*catch\s*{/.test(script), false);
  assert.ok(/try\s*{[\s\S]*catch\s*{/.test(script));
});

test("Windows CLI 目录解析应同时返回当前路径与旧版迁移路径", () => {
  const dirs = resolveWinCliBinDirsForPaths(
    "C:\\Users\\admin\\AppData\\Local",
    "C:\\Users\\admin\\.openclaw",
  );

  assert.equal(dirs.currentBinDir, "C:\\Users\\admin\\AppData\\Local\\CryoClaw\\bin");
  assert.deepEqual(dirs.legacyBinDirs, [
    "C:\\Users\\admin\\.openclaw\\bin",
    // 上一代（OneClaw 时代）安装目录，一次性清掉 PATH 残留
    "C:\\Users\\admin\\AppData\\Local\\OneClaw\\bin",
  ]);
});

// POSIX rc 路径仅在 mac/linux 生效；Windows 上 path.join 产生反斜杠，断言无意义，平台门控跳过
test("POSIX CLI PATH 注入应覆盖 login 与 interactive shell 配置", { skip: process.platform === "win32" }, () => {
  const paths = resolvePosixRcPathsForHome("/Users/admin");

  assert.deepEqual(paths, [
    "/Users/admin/.zprofile",
    "/Users/admin/.zshrc",
    "/Users/admin/.bash_profile",
    "/Users/admin/.bashrc",
  ]);
});

test("CLI 启用偏好应兼容未持久化的老用户状态", () => {
  assert.equal(inferCliEnabledPreference(undefined, false, false), undefined);
  assert.equal(inferCliEnabledPreference(undefined, true, false), true);
  assert.equal(inferCliEnabledPreference(undefined, false, true), true);
  assert.equal(inferCliEnabledPreference(false, true, true), false);
  assert.equal(inferCliEnabledPreference(true, false, false), true);
});

test("生成的 wrapper 带新 marker（CryoClaw CLI）", () => {
  const posix = buildPosixWrapperForPaths("/node", "/openclaw.mjs");
  const win = buildWinWrapperForPaths("C:\\node.exe", "C:\\openclaw.mjs");
  assert.ok(posix.includes("CryoClaw CLI"));
  assert.ok(win.includes("CryoClaw CLI"));
});

test("hasManagedWrapper 新旧 marker 双识别", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-cli-test-"));
  try {
    const newWrapper = path.join(tmpDir, "new.cmd");
    const oldWrapper = path.join(tmpDir, "old.cmd");
    const foreign = path.join(tmpDir, "foreign.cmd");
    fs.writeFileSync(newWrapper, "REM CryoClaw CLI - auto-generated, do not edit\n", "utf-8");
    fs.writeFileSync(oldWrapper, "REM OneClaw CLI - auto-generated, do not edit\n", "utf-8");
    fs.writeFileSync(foreign, "REM user custom script\n", "utf-8");

    assert.equal(hasManagedWrapper(newWrapper), true, "新 marker 应识别为托管");
    assert.equal(hasManagedWrapper(oldWrapper), true, "旧 marker（OneClaw CLI）也应识别为托管");
    assert.equal(hasManagedWrapper(foreign), false, "无标记脚本不应误认");
    assert.equal(hasManagedWrapper(path.join(tmpDir, "missing.cmd")), false, "不存在文件返回 false");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("stripManagedRcBlock 新旧标记块都能精确移除", () => {
  const body = 'case ":$PATH:" in\n  *:"/x/bin":*) ;;\nesac';
  for (const tag of ["cryoclaw-cli", "oneclaw-cli"]) {
    const content = `export A=1\n# >>> ${tag} >>>\n${body}\n# <<< ${tag} <<<\nexport B=2\n`;
    const { text, removed } = stripManagedRcBlock(content);
    assert.equal(removed, true, `${tag} 块应被移除`);
    assert.ok(!text.includes(tag), `${tag} 标记不应残留`);
    assert.ok(text.includes("export A=1") && text.includes("export B=2"), "用户行必须保留");
  }
  // 损坏块（缺结束标记）保留原文
  const broken = "export A=1\n# >>> cryoclaw-cli >>>\nsomething\n";
  assert.deepEqual(stripManagedRcBlock(broken), { text: broken, removed: false });
});

test("POSIX wrapper 应拦截 gateway 子命令并原样透传参数", () => {
  const script = buildPosixWrapperForPaths("/node", "/openclaw.mjs", {
    gatewayCtlEntry: "/res/updater/gateway-ctl.mjs",
  });

  assert.ok(script.includes('APP_GATEWAY_CTL="/res/updater/gateway-ctl.mjs"'));
  assert.ok(script.includes('if [ "$1" = "gateway" ]; then'));
  assert.ok(script.includes('exec "$APP_NODE" "$APP_GATEWAY_CTL" "$@"'));
  // 与 update 拦截共存
  const both = buildPosixWrapperForPaths("/node", "/openclaw.mjs", {
    updaterEntry: "/res/updater/kernel-update.mjs",
    gatewayCtlEntry: "/res/updater/gateway-ctl.mjs",
  });
  assert.ok(both.includes('if [ "$1" = "update" ]; then'));
  assert.ok(both.includes('if [ "$1" = "gateway" ]; then'));
});

test("POSIX wrapper 缺少 ctl 脚本时退回原生命令", () => {
  const script = buildPosixWrapperForPaths("/node", "/openclaw.mjs");
  assert.ok(!script.includes("APP_GATEWAY_CTL"));
  assert.ok(script.includes("OPENCLAW_NO_RESPAWN=1"));
  assert.ok(script.includes('exec "$APP_NODE" "$APP_ENTRY" "$@"'));
});

test("Windows wrapper 应拦截 gateway 子命令并共用块外统一 exit", () => {
  const script = buildWinWrapperForPaths("C:\\node.exe", "C:\\openclaw.mjs", {
    updaterEntry: "C:\\res\\updater\\kernel-update.mjs",
    gatewayCtlEntry: "C:\\res\\updater\\gateway-ctl.mjs",
  });

  assert.ok(script.includes('set "APP_GATEWAY_CTL=C:\\res\\updater\\gateway-ctl.mjs"'));
  assert.ok(script.includes('if /i "%~1"=="gateway" ('));
  assert.ok(script.includes(') else if /i "%~1"=="update" ('));
  assert.ok(script.includes('"%APP_NODE%" "%APP_GATEWAY_CTL%" %*'));
  // 括号块内不允许出现 %errorlevel%（解析阶段提前展开陷阱），统一出口在块外
  const dispatchBlock = script.slice(script.indexOf('if /i'), script.indexOf("exit /b %errorlevel%"));
  assert.ok(!dispatchBlock.includes("%errorlevel%"));
});

test("Windows wrapper 缺少 ctl 脚本时退回原生命令", () => {
  const script = buildWinWrapperForPaths("C:\\node.exe", "C:\\openclaw.mjs");
  assert.ok(!script.includes("APP_GATEWAY_CTL"));
  assert.ok(!script.includes('if /i "%~1"'));
  assert.ok(script.includes('set "OPENCLAW_NO_RESPAWN=1"'));
  assert.ok(script.includes('"%APP_NODE%" "%APP_ENTRY%" %*'));
});
