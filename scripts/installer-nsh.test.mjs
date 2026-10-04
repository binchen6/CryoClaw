/**
 * installer-nsh.test.mjs — NSIS 安装脚本不变量守卫（R94）。
 *
 * 背景：更新换装中断会留下「安装目录已空 + 卸载注册表项残留」状态，此后每次安装
 * 都在模板 uninstallOldVersion 里执行缺失的卸载器 → appCannotBeClosed 重试死循环
 * （实测：用户点「重试」永远无效，只能点「取消」绕过）。customInit 的 R94 自愈块
 * 负责清除该残留状态。此测试钉住这些不变量，防止后续维护中误删：
 *   1. R94 自愈块存在且删除陈旧卸载注册表项；
 *   2. taskkill 行绝不含 /T（树杀会级联杀掉安装器自身——R20 实测回归）；
 *   3. customInit 仍清理三个镜像名（主进程 / Helper / CLI）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nsh = fs.readFileSync(path.join(repoRoot, "scripts", "installer.nsh"), "utf8");

function macroBody(name) {
  const start = nsh.indexOf(`!macro ${name}`);
  assert.notEqual(start, -1, `未找到 !macro ${name}`);
  const end = nsh.indexOf("!macroend", start);
  assert.notEqual(end, -1, `!macro ${name} 未闭合`);
  return nsh.slice(start, end);
}

test("R94 自愈：customInit 命中残留时删除陈旧卸载注册表项", () => {
  const body = macroBody("customInit");
  assert.match(body, /R94 自愈/, "应保留 R94 自愈说明块");
  assert.match(body, /DeleteRegKey SHELL_CONTEXT "\$\{UNINSTALL_REGISTRY_KEY\}"/, "应删除陈旧卸载项");

  // 判定条件：卸载项存在 + （主 exe 缺失 或 卸载器缺失）才动作——正常升级不受影响
  assert.match(body, /ReadRegStr \$R8 SHELL_CONTEXT "\$\{UNINSTALL_REGISTRY_KEY\}" UninstallString/);
  assert.match(body, /\$\{ifNot\} \$\{FileExists\} "\$R7\\\$\{APP_EXECUTABLE_FILENAME\}"/);
  assert.match(body, /\$\{ifNot\} \$\{FileExists\} "\$R7\\Uninstall \$\{APP_FILENAME\}\.exe"/);
});

test("taskkill 行绝不含 /T（树杀会级联杀掉安装器自身）", () => {
  for (const line of nsh.split(/\r?\n/)) {
    if (!/taskkill/.test(line) || /^\s*;/.test(line)) continue;
    assert.ok(!/\s\/T\b/.test(line), `taskkill 不得带 /T: ${line.trim()}`);
  }
});

test("customInit 仍清理三个镜像名（主进程 / Helper / CLI）", () => {
  const body = macroBody("customInit");
  for (const image of ['taskkill /IM "CryoClaw.exe" /F', 'taskkill /IM "CryoClaw Helper.exe" /F', 'taskkill /IM "CryoClaw-CLI.exe" /F']) {
    assert.ok(body.includes(image), `customInit 应包含 ${image}`);
  }
});
