"use strict";
const fs = require("node:fs");
const path = require("node:path");

const MARKER = "; cryoclaw: delegate failed legacy uninstall to custom recovery";
const PAYLOAD_MARKER = '; cryoclaw: move extracted payload before recursive copy';
const SECTION_MARKER = '; cryoclaw: write installer icon after payload adoption';
function patchInstallSection(source) {
  if (source.includes(SECTION_MARKER)) return source;
  const normalized = source.replace(/\r\n/g, '\n');
  const icon = '!ifdef UNINSTALLER_ICON\n  File /oname=uninstallerIcon.ico "${UNINSTALLER_ICON}"\n!endif';
  const needle = `${icon}\n\n!insertmacro installApplicationFiles`;
  if (normalized.split(needle).length !== 2) throw new Error('Unsupported electron-builder install section');
  // An installer-owned icon made the otherwise empty target fail non-recursive RMDir.
  return normalized.replace(needle, `${SECTION_MARKER}\n!insertmacro installApplicationFiles\n\n${icon}`);
}
function patchExtractionTemplate(source) {
  if(source.includes(PAYLOAD_MARKER))return source;
  const normalized=source.replace(/\r\n/g,'\n');
  const needle='  # Retry counter\n  StrCpy $R1 0';
  if(normalized.split(needle).length!==2)throw new Error('Unsupported electron-builder extraction template');
  return normalized.replace(needle,`${PAYLOAD_MARKER}\n  !ifmacrodef customMoveExtractedPayload\n    !insertmacro customMoveExtractedPayload "$PLUGINSDIR\\7z-out" "$OUTDIR"\n  !endif\n\n${needle}`);
}
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
  const extraction=path.join(root,'templates/nsis/include/extractAppPackage.nsh');
  const before=fs.readFileSync(extraction,'utf8'),after=patchExtractionTemplate(before);
  if(before!==after)fs.writeFileSync(extraction,after);
  const section=path.join(root,'templates/nsis/installSection.nsh');
  const original=fs.readFileSync(section,'utf8'),updated=patchInstallSection(original);
  if(original!==updated)fs.writeFileSync(section,updated);
}
module.exports = prepareNsis;
module.exports.patchUninstallTemplate = patchUninstallTemplate;
module.exports.patchExtractionTemplate = patchExtractionTemplate;
module.exports.patchInstallSection = patchInstallSection;
