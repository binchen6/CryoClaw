const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { patchUninstallTemplate } = require("./patch-nsis-uninstall");

test("legacy uninstall failure reaches custom recovery before retry dialog", () => {
  const template = fs.readFileSync(path.join(path.dirname(require.resolve("app-builder-lib/package.json")), "templates/nsis/include/installUtil.nsh"), "utf8");
  const result = patchUninstallTemplate(template);
  assert.match(result, /!ifmacrodef customUnInstallCheck\s+Return\s+!endif\s+Sleep 1000\s+Goto UninstallLoop/);
  assert.equal(patchUninstallTemplate(result), result);
  assert.ok(result.includes('MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)"'));
  assert.ok(result.includes('ExecWait'));
});
test("unexpected template structure fails closed", () => {
  assert.throws(() => patchUninstallTemplate("changed upstream template"), /Unsupported/);
  assert.throws(() => patchUninstallTemplate("    Sleep 1000\n    Goto UninstallLoop\n    Sleep 1000\n    Goto UninstallLoop"), /Unsupported/);
});
