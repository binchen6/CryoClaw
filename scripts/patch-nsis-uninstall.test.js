const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { patchUninstallTemplate,patchExtractionTemplate,patchInstallSection } = require("./patch-nsis-uninstall");

test('payload extraction runs before the installer populates its empty destination',()=>{
  const file=path.join(path.dirname(require.resolve('app-builder-lib/package.json')),'templates/nsis/installSection.nsh');
  const result=patchInstallSection(fs.readFileSync(file,'utf8'));
  assert.ok(result.indexOf('!insertmacro installApplicationFiles')<result.indexOf('File /oname=uninstallerIcon.ico'));
  assert.ok(result.indexOf('File /oname=uninstallerIcon.ico')<result.indexOf('!insertmacro registryAddInstallInfo'));
  assert.equal(result.split('File /oname=uninstallerIcon.ico').length,2);
  assert.equal(patchInstallSection(result),result);
  assert.throws(()=>patchInstallSection('unknown upstream'),/Unsupported/);
});

test('same-volume payload move precedes copy and preserves upstream fallback',()=>{
  const file=path.join(path.dirname(require.resolve('app-builder-lib/package.json')),'templates/nsis/include/extractAppPackage.nsh');
  const source=fs.readFileSync(file,'utf8'),result=patchExtractionTemplate(source);
  assert.ok(result.indexOf('!insertmacro customMoveExtractedPayload')<result.indexOf('CopyFiles /SILENT'));
  assert.ok(result.includes('Nsis7z::Extract'));assert.ok(result.includes('DoneExtract7za:'));
  assert.equal(patchExtractionTemplate(result),result);
  assert.throws(()=>patchExtractionTemplate('unknown upstream'),/Unsupported/);
});

test('new payload destinations can rename without requiring a removable directory',()=>{
  const script=fs.readFileSync(path.join(__dirname,'installer.nsh'),'utf8');
  assert.ok(script.includes('IfFileExists "$cryoclawPayloadDestination\\*.*" 0 cryoclaw_payload_rename'));
  assert.match(script,/RMDir "\$cryoclawPayloadDestination"\s+IfErrors cryoclaw_payload_retry\s+cryoclaw_payload_rename:/);
  assert.match(script,/Rename "\$\{SOURCE\}" "\$cryoclawPayloadDestination"/);
  assert.match(script,/cryoclaw_payload_copy:[\s\S]*?DetailPrint "Directory rename unavailable; using safe copy fallback"/);
  assert.match(script,/IntCmp \$cryoclawPayloadAttempt 6 cryoclaw_payload_entries cryoclaw_payload_wait cryoclaw_payload_entries/);
  assert.match(script,/cryoclaw_payload_wait:\s+Sleep 100\s+Goto cryoclaw_payload_attempt/);
  assert.ok(script.includes('StrCpy $cryoclawPayloadMode "entry-rename"'));
  assert.ok(script.includes('Rename "$cryoclawPayloadDestination\\$cryoclawPayloadEntry" "${SOURCE}\\$cryoclawPayloadEntry"'));
});

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
test("installer phase timing covers initialization, old removal and CLI completion",()=>{
  const script=fs.readFileSync(path.join(__dirname,'installer.nsh'),'utf8');
  for(const field of ['initCompletedMs','oldUninstallCompletedMs','payloadReadyMs','installMs','completionMs'])assert.ok(script.includes(field),field);
  assert.match(script,/!macro customUnInstallCheck\s+System::Call 'kernel32::GetTickCount\(\) i.r0'/);
  const start=script.search(/!macro customInstall\r?\n/),end=script.search(/; customRemoveFiles/);assert.ok(start>=0&&end>start);
  const install=script.slice(start,end);
  assert.ok(install.indexOf('cryoclaw_cli_done:')<install.indexOf('FileOpen $1 "$INSTDIR\\resources\\install-performance.json" w'));
});
