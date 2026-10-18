"use strict";
const fs = require("node:fs");
const path = require("node:path");

const MARKER = "; cryoclaw: delegate failed legacy uninstall to custom recovery";
function patchUninstallTemplate(source) {
  if (source.includes(MARKER)) return source;
  const needle = "    Sleep 1000\n    Goto UninstallLoop";
  const normalized = source.replace(/\r\n/g, "\n");
  if (normalized.split(needle).length !== 2) throw new Error("Unsupported electron-builder uninstall template; recovery patch was not applied");
  return normalized.replace(needle, `${MARKER}\n    !ifmacrodef customUnInstallCheck\n      Return\n    !endif\n${needle}`);
}

function prepareNsis(context) {
  if (context.electronPlatformName !== "win32") return;
  const root = path.dirname(require.resolve("app-builder-lib/package.json"));
  const file = path.join(root, "templates", "nsis", "include", "installUtil.nsh");
  const source = fs.readFileSync(file, "utf8");
  const patched = patchUninstallTemplate(source);
  if (patched !== source) fs.writeFileSync(file, patched);
}
module.exports = prepareNsis;
module.exports.patchUninstallTemplate = patchUninstallTemplate;
