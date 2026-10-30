; CryoClaw NSIS 自定义钩子
; 功能：安装前杀进程、更新时跳过多余页面（只显示进度条）、卸载时提供 CLI 清理和用户数据删除选项
;
; 品牌位图不走本文件（命令行 -D 已定义同名宏，!define 会冲突）：
; Welcome 侧图 / 页头图由 electron-builder.yml 的 nsis.installerSidebar / installerHeader 指定，
; 位图由 scripts/gen-installer-bitmaps.ps1 生成（沉稳蓝渐变 + 图标，与应用品牌色一致）。

; ============================================================
; 自定义 Welcome 页：更新时自动跳过，首次安装正常显示
; 标题带品牌与版本号（语言中性，避免单语正文覆盖 MUI 本地化文案）
; ============================================================

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "CryoClaw ${VERSION} Setup"
  !define MUI_WELCOMEPAGE_TITLE_3LINES
  !define MUI_PAGE_CUSTOMFUNCTION_PRE onWelcomePagePre
  !insertmacro MUI_PAGE_WELCOME
!macroend

; ============================================================
; 自定义安装模式：更新时沿用已有安装模式，跳过选择页
; ============================================================

!macro customInstallMode
  ${if} ${isUpdated}
    ${if} $hasPerMachineInstallation == "1"
      StrCpy $isForceMachineInstall "1"
    ${else}
      StrCpy $isForceCurrentInstall "1"
    ${endif}
  ${endif}
!macroend

; ============================================================
; 自定义 Finish 页：更新时自动跳过并启动 app，首次安装显示"运行"勾选框
; ============================================================

!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  ; Finish 页左下角发布页链接（装完看更新日志/新版本说明）
  !define MUI_FINISHPAGE_LINK "更新日志 · Release Notes"
  !define MUI_FINISHPAGE_LINK_LOCATION "https://github.com/binchen6/CryoClaw/releases"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE onFinishPagePre
  !insertmacro MUI_PAGE_FINISH
!macroend

; ============================================================
; 自定义卸载 Welcome 页：品牌标题（侧图由 MUI_UNWELCOMEFINISHPAGE_BITMAP
; 自动继承 installerSidebar）
; ============================================================

!macro customUnWelcomePage
  !define MUI_UNWELCOMEPAGE_TITLE "CryoClaw Uninstall"
  !define MUI_UNWELCOMEPAGE_TITLE_3LINES
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

; ============================================================
; customHeader：品牌文字、页面 Pre 回调、卸载选项双语文案
; （函数定义可后置，NSIS 编译期统一解析；本宏在 installer 和
; uninstaller 两个 pass 都会展开，故 LangString 不加 BUILD_UNINSTALLER 门控）
; ============================================================

!macro customHeader
  ; 底部品牌文字（默认是 "Nullsoft Install System vX.XX"）
  BrandingText " CryoClaw Setup"

  ; 卸载组件页选项文案（electron-builder installerLanguages 只有 en/zh_CN，
  ; 其他系统语言回退 English——避免英文系统看到中文 section 名）
  LangString un.removeCli ${LANG_ENGLISH} "Remove command-line tools (openclaw CLI)"
  LangString un.removeCli ${LANG_SIMPCHINESE} "删除命令行工具 (openclaw CLI)"
  LangString un.removeWebbridge ${LANG_ENGLISH} "Delete WebBridge binaries and cache (~/.kimi-webbridge)"
  LangString un.removeWebbridge ${LANG_SIMPCHINESE} "删除 WebBridge 二进制和缓存 (~/.kimi-webbridge)"
  LangString un.removeUserData ${LANG_ENGLISH} "Delete ALL user data and settings (~/.openclaw)"
  LangString un.removeUserData ${LANG_SIMPCHINESE} "删除所有用户数据和配置 (~/.openclaw)"

  ; customHeader 在 installer 和 uninstaller 两个 pass 都会展开，
  ; 但这些函数和 $launchLink 变量只在 installer pass 中存在
  !ifndef BUILD_UNINSTALLER
    ; 更新时跳过 Welcome 页
    Function onWelcomePagePre
      ${if} ${isUpdated}
        Abort
      ${endif}
    FunctionEnd

    ; 更新时跳过 Finish 页，直接启动 app
    ; （首次安装走 customFinishPage 中的 StartApp 函数，由 Finish 页 "Run" 勾选框触发）
    Function onFinishPagePre
      ${if} ${isUpdated}
        ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
        Abort
      ${endif}
    FunctionEnd
  !endif
!macroend

; ============================================================
; 安装钩子
; ============================================================
!ifndef BUILD_UNINSTALLER
Var /GLOBAL cryoclawInstallStarted
Var /GLOBAL cryoclawInitCompletedMs
Var /GLOBAL cryoclawOldUninstallCompletedMs
Var /GLOBAL cryoclawPostPayloadMs
Var /GLOBAL cryoclawCompletionMs
Var /GLOBAL cryoclawPayloadDestination
Var /GLOBAL cryoclawPayloadMode
Var /GLOBAL cryoclawPayloadReadyMs
Var /GLOBAL cryoclawPayloadFallback
Var /GLOBAL cryoclawPayloadError
Var /GLOBAL cryoclawPayloadAttempt
Var /GLOBAL cryoclawPayloadFind
Var /GLOBAL cryoclawPayloadEntry
Var /GLOBAL cryoclawPayloadMoved
Var /GLOBAL cryoclawPayloadPassMoved
Var /GLOBAL cryoclawPayloadSourceVolume
Var /GLOBAL cryoclawPayloadFindData
Var /GLOBAL cryoclawPayloadFindError

; Capture the native error together with FindNextFileW. The NSIS FindNext
; instruction exposes only a generic error flag, so it cannot prove EOF.
Function CryoClawNextPayloadEntry
  System::Call 'kernel32::FindNextFileW(p $cryoclawPayloadFind, p $cryoclawPayloadFindData) i.r0 ?e'
  Pop $cryoclawPayloadFindError
  StrCmp $0 0 cryoclaw_payload_find_end
  ; WIN32_FIND_DATAW has a fixed 44-byte header before cFileName[260].
  IntOp $0 $cryoclawPayloadFindData + 44
  System::Call '*$0(&w260 .r1)'
  StrCpy $cryoclawPayloadEntry $1
  StrCpy $cryoclawPayloadFindError 0
  Return
  cryoclaw_payload_find_end:
  StrCpy $cryoclawPayloadEntry ""
FunctionEnd
!endif



; The payload is already fully extracted and the old app removed. On the same
; volume, rename the whole directory instead of Shell CopyFiles for 34k files.
; RMDir is deliberately NON-recursive. An empty pinned target can adopt top-level
; entries on the same volume; nonempty targets retain the copy/retry path.
!macro customMoveExtractedPayload SOURCE DESTINATION
  StrCpy $cryoclawPayloadDestination "${DESTINATION}"
  StrCpy $cryoclawPayloadMode "copy"
  StrCpy $cryoclawPayloadFallback "destination-not-empty-or-locked"
  StrCpy $cryoclawPayloadError 0
  StrCpy $cryoclawPayloadFindData 0
  System::Call 'kernel32::GetTickCount() i.r0'
  IntOp $cryoclawPayloadReadyMs $0 - $cryoclawInstallStarted
  SetOutPath "$TEMP"
  StrCpy $cryoclawPayloadAttempt 0
  cryoclaw_payload_attempt:
  IntOp $cryoclawPayloadAttempt $cryoclawPayloadAttempt + 1
  StrCpy $cryoclawPayloadFallback "destination-not-empty-or-locked"
  IfFileExists "$cryoclawPayloadDestination\*.*" 0 cryoclaw_payload_rename
  ClearErrors
  RMDir "$cryoclawPayloadDestination"
  IfErrors cryoclaw_payload_retry
  cryoclaw_payload_rename:
  StrCpy $cryoclawPayloadFallback "rename-failed"
  ClearErrors
  Rename "${SOURCE}" "$cryoclawPayloadDestination"
  IfErrors cryoclaw_payload_retry
  StrCpy $cryoclawPayloadMode "rename"
  StrCpy $cryoclawPayloadFallback "none"
  StrCpy $cryoclawPayloadError 0
  SetOutPath "$cryoclawPayloadDestination"
  DetailPrint "Payload installed by directory rename"
  Goto DoneExtract7za
  cryoclaw_payload_retry:
  System::Call 'kernel32::GetLastError() i.r0'
  StrCpy $cryoclawPayloadError $0
  ; Indexers and antivirus can briefly hold an otherwise empty destination.
  ; Only retry nonrecursive removal/rename; nonempty targets keep the fallback.
  IntCmp $cryoclawPayloadAttempt 6 cryoclaw_payload_entries cryoclaw_payload_wait cryoclaw_payload_entries
  cryoclaw_payload_wait:
  Sleep 100
  Goto cryoclaw_payload_attempt
  cryoclaw_payload_entries:
  ; Cross-volume directory moves must retain the original single copy path.
  System::Call 'kernel32::GetVolumePathNameW(w "${SOURCE}", w .r1, i ${NSIS_MAX_STRLEN}) i.r0'
  IntCmp $0 0 cryoclaw_payload_copy cryoclaw_payload_copy +1
  StrCpy $cryoclawPayloadSourceVolume $1
  System::Call 'kernel32::GetVolumePathNameW(w "$cryoclawPayloadDestination", w .r1, i ${NSIS_MAX_STRLEN}) i.r0'
  IntCmp $0 0 cryoclaw_payload_copy cryoclaw_payload_copy +1
  StrCmp $cryoclawPayloadSourceVolume $1 +1 cryoclaw_payload_copy
  System::Alloc 592
  Pop $cryoclawPayloadFindData
  StrCmp $cryoclawPayloadFindData 0 cryoclaw_payload_copy
  ; An open handle can pin an empty destination itself while allowing children
  ; to move. Never merge entries through this path: any existing entry falls
  ; back to the original copier, including directories and reparse points.
  ClearErrors
  FindFirst $cryoclawPayloadFind $cryoclawPayloadEntry "$cryoclawPayloadDestination\*.*"
  IfErrors cryoclaw_payload_copy
  cryoclaw_payload_target_next:
  StrCmp $cryoclawPayloadEntry "" cryoclaw_payload_target_empty
  StrCmp $cryoclawPayloadEntry "." cryoclaw_payload_target_skip
  StrCmp $cryoclawPayloadEntry ".." cryoclaw_payload_target_skip
  FindClose $cryoclawPayloadFind
  Goto cryoclaw_payload_copy
  cryoclaw_payload_target_skip:
  Call CryoClawNextPayloadEntry
  StrCmp $cryoclawPayloadFindError 0 cryoclaw_payload_target_next
  StrCmp $cryoclawPayloadFindError 18 cryoclaw_payload_target_empty
  FindClose $cryoclawPayloadFind
  Goto cryoclaw_payload_copy
  cryoclaw_payload_target_empty:
  FindClose $cryoclawPayloadFind
  System::Call 'kernel32::GetFileAttributesW(w "$cryoclawPayloadDestination") i.r0'
  IntOp $0 $0 & 0x400
  IntCmp $0 0 cryoclaw_payload_entries_empty cryoclaw_payload_copy cryoclaw_payload_copy
  cryoclaw_payload_entries_empty:
  StrCpy $cryoclawPayloadMoved 0
  cryoclaw_payload_entries_scan:
  StrCpy $cryoclawPayloadPassMoved 0
  ClearErrors
  FindFirst $cryoclawPayloadFind $cryoclawPayloadEntry "${SOURCE}\*.*"
  IfErrors cryoclaw_payload_entry_scan_failed
  cryoclaw_payload_entry_next:
  StrCmp $cryoclawPayloadEntry "" cryoclaw_payload_entries_scanned
  StrCmp $cryoclawPayloadEntry "." cryoclaw_payload_entry_skip
  StrCmp $cryoclawPayloadEntry ".." cryoclaw_payload_entry_skip
  ClearErrors
  Rename "${SOURCE}\$cryoclawPayloadEntry" "$cryoclawPayloadDestination\$cryoclawPayloadEntry"
  IfErrors cryoclaw_payload_entry_failed
  Push $cryoclawPayloadEntry
  IntOp $cryoclawPayloadMoved $cryoclawPayloadMoved + 1
  IntOp $cryoclawPayloadPassMoved $cryoclawPayloadPassMoved + 1
  cryoclaw_payload_entry_skip:
  Call CryoClawNextPayloadEntry
  StrCmp $cryoclawPayloadFindError 0 cryoclaw_payload_entry_next
  StrCmp $cryoclawPayloadFindError 18 cryoclaw_payload_entries_scanned
  StrCpy $cryoclawPayloadError $cryoclawPayloadFindError
  StrCpy $cryoclawPayloadFallback "entry-enumeration-failed"
  FindClose $cryoclawPayloadFind
  Goto cryoclaw_payload_entry_rollback
  cryoclaw_payload_entries_scanned:
  FindClose $cryoclawPayloadFind
  ; Re-enumerate after moves so directory enumeration cannot skip a member.
  IntCmp $cryoclawPayloadPassMoved 0 cryoclaw_payload_entries_finished cryoclaw_payload_entries_finished cryoclaw_payload_entries_scan
  cryoclaw_payload_entries_finished:
  IntCmp $cryoclawPayloadMoved 0 cryoclaw_payload_copy cryoclaw_payload_copy cryoclaw_payload_entries_validate
  cryoclaw_payload_entries_validate:
  ClearErrors
  RMDir "${SOURCE}"
  IfErrors cryoclaw_payload_entry_scan_failed
  cryoclaw_payload_entries_commit:
  Pop $cryoclawPayloadEntry
  IntOp $cryoclawPayloadMoved $cryoclawPayloadMoved - 1
  IntCmp $cryoclawPayloadMoved 0 cryoclaw_payload_entries_done cryoclaw_payload_entries_done cryoclaw_payload_entries_commit
  cryoclaw_payload_entries_done:
  System::Free $cryoclawPayloadFindData
  StrCpy $cryoclawPayloadFindData 0
  StrCpy $cryoclawPayloadMode "entry-rename"
  StrCpy $cryoclawPayloadFallback "none"
  StrCpy $cryoclawPayloadError 0
  SetOutPath "$cryoclawPayloadDestination"
  DetailPrint "Payload installed by top-level entry rename"
  Goto DoneExtract7za
  cryoclaw_payload_entry_failed:
  System::Call 'kernel32::GetLastError() i.r0'
  StrCpy $cryoclawPayloadError $0
  StrCpy $cryoclawPayloadFallback "entry-rename-failed"
  FindClose $cryoclawPayloadFind
  Goto cryoclaw_payload_entry_rollback
  cryoclaw_payload_entry_scan_failed:
  System::Call 'kernel32::GetLastError() i.r0'
  StrCpy $cryoclawPayloadError $0
  StrCpy $cryoclawPayloadFallback "entry-enumeration-failed"
  cryoclaw_payload_entry_rollback:
  IntCmp $cryoclawPayloadMoved 0 cryoclaw_payload_copy cryoclaw_payload_copy cryoclaw_payload_entry_restore
  cryoclaw_payload_entry_restore:
  Pop $cryoclawPayloadEntry
  ; If a restore is also blocked, its bytes stay at the intended destination;
  ; the original copier fills the remaining entries without deleting anything.
  Rename "$cryoclawPayloadDestination\$cryoclawPayloadEntry" "${SOURCE}\$cryoclawPayloadEntry"
  IntOp $cryoclawPayloadMoved $cryoclawPayloadMoved - 1
  Goto cryoclaw_payload_entry_rollback
  cryoclaw_payload_copy:
  StrCmp $cryoclawPayloadFindData 0 cryoclaw_payload_copy_ready
  System::Free $cryoclawPayloadFindData
  StrCpy $cryoclawPayloadFindData 0
  cryoclaw_payload_copy_ready:
  DetailPrint "Directory rename unavailable; using safe copy fallback"
  SetOutPath "$cryoclawPayloadDestination"
  ClearErrors
!macroend

; 杀进程后仅在确有进程被杀时等待句柄释放：
; taskkill 退出码 128 = 没有匹配进程（全新安装场景），跳过固定 Sleep 省 2s；
; 其他退出码（0=成功、1=部分失败/拒绝访问）一律等待，宁可慢不可踩文件锁。
!macro customInit
  System::Call 'kernel32::GetTickCount() i.r0'
  StrCpy $cryoclawInstallStarted $0
  StrCpy $cryoclawOldUninstallCompletedMs -1
  ; 安装前强制终止正在运行的 CryoClaw 进程（/IM 按镜像名匹配所有同名进程：
  ; 主进程/渲染/GPU/utility 全部同名 CryoClaw.exe，无需 /T）。
  ; ⚠ 绝不能加 /T（树杀）：electron-updater quitAndInstall 会把本安装器 spawn 为
  ; CryoClaw.exe 的子进程，/T 会把安装器自己级联杀掉（R20 实测复现：更新换装静默失败）。
  ; CryoClaw Helper.exe 是 Electron 复用二进制跑 Node.js 的 gateway 子进程，
  ; CryoClaw-CLI.exe 是 CLI 入口，镜像名不同需显式清理。
  StrCpy $0 0
  nsExec::ExecToLog 'taskkill /IM "CryoClaw.exe" /F'
  Pop $1
  ${if} $1 != 128
    StrCpy $0 1
  ${endif}
  nsExec::ExecToLog 'taskkill /IM "CryoClaw Helper.exe" /F'
  Pop $1
  ${if} $1 != 128
    StrCpy $0 1
  ${endif}
  nsExec::ExecToLog 'taskkill /IM "CryoClaw-CLI.exe" /F'
  Pop $1
  ${if} $1 != 128
    StrCpy $0 1
  ${endif}
  ${if} $0 == 1
    Sleep 2000
  ${endif}

  IfFileExists "$INSTDIR\resources\stop-bundled-runtime.ps1" 0 cryoclaw_runtime_stopped
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\stop-bundled-runtime.ps1"'
  Pop $1
  cryoclaw_runtime_stopped:

  ; ── R94 自愈：更新换装中断残留 ────────────────────────────────────────
  ; 场景（实测）：上次换装把旧版卸载了但新版未落地 → 安装目录已无主 exe，而
  ; Windows 卸载注册表项仍在（UninstallString 指向已不存在的卸载器）。此后每次
  ; 安装都会在模板 uninstallOldVersion 里复制/执行缺失的卸载器，失败 5 次后弹出
  ; appCannotBeClosed（「重试」永远无效，只能点「取消」绕过）——用户被卡在
  ; 「目录已空 + 注册表残留」的死循环里。
  ; 处理：命中残留时删除陈旧卸载项，让安装器走全新安装路径（用户数据在
  ; ~/.openclaw，不受影响）；INSTALL_REGISTRY_KEY 保留 → $INSTDIR 与快捷方式
  ; 语义不变、安装模式判定（customInstallMode）不受影响。
  ; 判定基准与模板 uninstallOldVersion 同源：目录先取 $INSTDIR（已由
  ; initMultiUser 解析），回落 InstallLocation，再回落默认目录；仅当卸载项存在
  ; 且（主 exe 缺失 或 卸载器缺失）才动作——正常升级路径 exe/卸载器均在，不受影响。
  StrCpy $R7 "$INSTDIR"
  ${if} $R7 == ""
    ReadRegStr $R7 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${endif}
  ${if} $R7 == ""
    StrCpy $R7 "$LOCALAPPDATA\Programs\${APP_FILENAME}"
  ${endif}
  ReadRegStr $R8 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${if} $R8 != ""
    StrCpy $R6 0
    ${ifNot} ${FileExists} "$R7\${APP_EXECUTABLE_FILENAME}"
      StrCpy $R6 1
    ${endif}
    ${if} $R6 == 0
      ${ifNot} ${FileExists} "$R7\Uninstall ${APP_FILENAME}.exe"
        StrCpy $R6 1
      ${endif}
    ${endif}
    ${if} $R6 == 1
      DetailPrint "检测到上次更新中断残留（旧版目录不可用），已按全新安装处理"
      DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
      !ifdef UNINSTALL_REGISTRY_KEY_2
        DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}"
      !endif
    ${endif}
  ${endif}
  System::Call 'kernel32::GetTickCount() i.r0'
  IntOp $cryoclawInitCompletedMs $0 - $cryoclawInstallStarted
!macroend

; ============================================================
; 安装后钩子：生成 CLI 专用二进制（SUBSYSTEM:CONSOLE）
; 复制主 exe 并补丁 PE header，支持交互式 stdin
; ============================================================

!macro customInstall
  System::Call 'kernel32::GetTickCount() i.r0'
  IntOp $cryoclawPostPayloadMs $0 - $cryoclawInstallStarted
  ; 生成 CLI 专用二进制（SUBSYSTEM:CONSOLE）：复制主 exe 并补丁 PE header。
  ; -File 直跑（R64 审查 P3）：脚本自定位安装目录（$PSScriptRoot 上级），
  ; 旧版把 $INSTDIR 内插进 -Command 双引号串，自选安装目录含 $、反引号等
  ; PS 元字符时会被展开/转义导致 CLI 生成失败。
  IfFileExists "$INSTDIR\resources\create-cli-binary.ps1" 0 cryoclaw_cli_done
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\create-cli-binary.ps1"'
  ; 检查退出码：CLI 二进制生成失败不阻断安装，但写醒目日志便于排查
  Pop $0
  ${if} $0 != 0
    DetailPrint "WARNING: create-cli-binary.ps1 failed (exit=$0) - openclaw CLI binary was not created. Reinstall or run resources\create-cli-binary.ps1 manually to restore it."
  ${endif}
  cryoclaw_cli_done:
  System::Call 'kernel32::GetTickCount() i.r0'
  IntOp $cryoclawCompletionMs $0 - $cryoclawInstallStarted
  FileOpen $1 "$INSTDIR\resources\install-performance.json" w
  FileWrite $1 '{$\"payloadMode$\":$\"$cryoclawPayloadMode$\",$\"fallback$\":$\"$cryoclawPayloadFallback$\",$\"win32Error$\":$cryoclawPayloadError,$\"initCompletedMs$\":$cryoclawInitCompletedMs,$\"oldUninstallCompletedMs$\":$cryoclawOldUninstallCompletedMs,$\"payloadReadyMs$\":$cryoclawPayloadReadyMs,$\"installMs$\":$cryoclawPostPayloadMs,$\"completionMs$\":$cryoclawCompletionMs}'
  FileClose $1
!macroend

; ============================================================
; customRemoveFiles：接管旧版文件移除，绕开官方 atomicRMDir 稳定失败
; （electron-builder 26.7.0 模板在"更新模式卸载"上逐项 rename 到
;  %TEMP%\ns*.tmp\old-install 报 Can't rename $INSTDIR → Abort(exit 2)
;  → 新安装器 5 轮重试 → uninstallFailed 弹窗（silent 下也弹），更新链路
;  整体卡死。v2026.909.6 全旧代码同样复现，非本仓库回归，属上游缺陷。）
; 对策：沿用已验证的直接删除和有界重试。卸载器与新安装器属于独立进程，
; 不能以 NSIS 全局变量传递暂存目录；未验证的跨进程回收方案不进入发行。
; ============================================================

; Native Node removes long SDK paths that NSIS 3 cannot enumerate. Its own
; executable is retained until it exits; the existing NSIS fallback finishes.
!define CRYOCLAW_REMOVE_HELPER "${__FILEDIR__}\remove-installed-files.cjs"
!macro cryoclawRemoveInstallDirectory
  Push $0
  StrCpy $0 2
  ${if} ${FileExists} "$INSTDIR\resources\resources\runtime\node.exe"
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File /oname=cryoclaw-remove-install.cjs "${CRYOCLAW_REMOVE_HELPER}"
    nsExec::ExecToLog '"$INSTDIR\resources\resources\runtime\node.exe" --no-warnings "$PLUGINSDIR\cryoclaw-remove-install.cjs" "$INSTDIR"'
    Pop $0
    ${if} $0 != 0
      DetailPrint "Native file removal unavailable (exit=$0); using NSIS fallback"
    ${endif}
  ${endif}
  SetOutPath "$TEMP"
  ; A locked long file needs the native runtime and ownership markers for the
  ; outer bounded retry. Remove them only after native cleanup succeeds, or
  ; when native cleanup was unavailable and the legacy fallback owns the work.
  ${if} $0 != 1
    RMDir /r "$INSTDIR"
  ${endif}
  Pop $0
!macroend

!macro customRemoveFiles
  SetOutPath "$TEMP"
  !insertmacro cryoclawRemoveInstallDirectory
  ${if} ${FileExists} "$INSTDIR\*.*"
    Sleep 1000
    !insertmacro cryoclawRemoveInstallDirectory
  ${endif}
  ${if} ${FileExists} "$INSTDIR\*.*"
    DetailPrint "removeFiles: $INSTDIR 仍有残留（文件被占用），交回重试"
    Abort
  ${endif}
!macroend

; ============================================================
; customUnInstallCheck：接管"旧版卸载器运行结果"的处理
; （背景同上——旧版卸载器的 atomicRMDir 在本机稳定失败 exit 2，官方
;  handleUninstallResult 的 uninstallFailed MessageBox 无 /SD 旗标，
;  静默更新链路会永远卡在该弹窗上。定义本宏后 electron-builder 模板会
;  在检查点直接插入本宏并 Return，弹窗永不出现。）
; 失败补救：旧卸载器失败时 $INSTDIR 通常完整（其内部 restoreFiles 已把
; 挪走的文件还原回来）——直接 RMDir /r 清场后放行安装继续；残留文件
; 会被新安装器的解包覆盖，不阻断更新。
; ============================================================

!macro customUnInstallCheck
  System::Call 'kernel32::GetTickCount() i.r0'
  IntOp $cryoclawOldUninstallCompletedMs $0 - $cryoclawInstallStarted
  ${if} $R0 != 0
    DetailPrint "old uninstaller failed (exit=$R0), falling back to direct removal"
    SetOutPath "$TEMP"
    !insertmacro cryoclawRemoveInstallDirectory
    ${if} ${FileExists} "$INSTDIR\*.*"
      Sleep 1500
      !insertmacro cryoclawRemoveInstallDirectory
    ${endif}
    ${if} ${FileExists} "$INSTDIR\*.*"
      DetailPrint "fallback removal left residue in $INSTDIR (locked files will be overwritten)"
    ${endif}
  ${endif}
!macroend

; ============================================================
; 卸载钩子
; ============================================================

; 卸载初始化：杀进程（与安装前逻辑相同，条件等待）
; ⚠ 同样绝不能加 /T（树杀）：静默更新链路中旧卸载器是新安装器 spawn 的
; 子进程（镜像名同为 CryoClaw.exe），customInit 的 taskkill 失败而
; CryoClaw.exe 存活时，/T 会把 CryoClaw.exe 整棵子树（含新安装器与
; 卸载器自身）级联杀掉，更新静默死亡且无日志。/IM 按镜像名已覆盖
; 主进程/渲染/GPU/utility（理由同 customInit）。
!macro customUnInit
  StrCpy $0 0
  nsExec::ExecToLog 'taskkill /IM "CryoClaw.exe" /F'
  Pop $1
  ${if} $1 != 128
    StrCpy $0 1
  ${endif}
  nsExec::ExecToLog 'taskkill /IM "CryoClaw Helper.exe" /F'
  Pop $1
  ${if} $1 != 128
    StrCpy $0 1
  ${endif}
  nsExec::ExecToLog 'taskkill /IM "CryoClaw-CLI.exe" /F'
  Pop $1
  ${if} $1 != 128
    StrCpy $0 1
  ${endif}
  ${if} $0 == 1
    Sleep 2000
  ${endif}
  ${if} ${FileExists} "$INSTDIR\resources\stop-bundled-runtime.ps1"
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\stop-bundled-runtime.ps1"'
    Pop $1
  ${endif}
!macroend

; 卸载组件选择页：NSIS 自动渲染为勾选框列表
; 注意：customUnInstallSection 在 electron-builder 的 customUnInstall 之后执行
!macro customUnInstallSection
  ; 默认勾选：删除 CLI wrapper 和 PATH 注入
  Section "$(un.removeCli)"
    ; electron-builder 更新安装会静默（/S）运行旧版卸载器，默认勾选的 section 会被执行；
    ; 更新场景绝不能删 CLI wrapper/PATH——新版启动时 reconcileCliOnAppLaunch 会自愈重建。
    ${ifNot} ${isUpdated}
    ; 删除当前版本 wrapper（%LOCALAPPDATA%\CryoClaw\bin\）
    Delete "$LOCALAPPDATA\CryoClaw\bin\openclaw.cmd"
    Delete "$LOCALAPPDATA\CryoClaw\bin\clawhub.cmd"
    RMDir "$LOCALAPPDATA\CryoClaw\bin"
    RMDir "$LOCALAPPDATA\CryoClaw"

    ; 删除旧版 wrapper（%USERPROFILE%\.openclaw\bin\）
    Delete "$PROFILE\.openclaw\bin\openclaw.cmd"
    Delete "$PROFILE\.openclaw\bin\clawhub.cmd"
    RMDir "$PROFILE\.openclaw\bin"

    ; 常量命令直接清理用户 PATH：不执行可被同用户低权限进程替换的临时脚本。
    ; 环境路径只作为 Join-Path 的数据，不插入 PowerShell 源代码。
    nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$ErrorActionPreference='Stop'; $$targets=@((Join-Path $$env:LOCALAPPDATA 'CryoClaw\bin'),(Join-Path $$env:USERPROFILE '.openclaw\bin')) | ForEach-Object { $$_.TrimEnd('\') }; $$current=[Environment]::GetEnvironmentVariable('Path','User'); if ($$null -ne $$current) { $$next=($$current -split ';' | Where-Object { $$targets -notcontains $$_.Trim().TrimEnd('\') }) -join ';'; [Environment]::SetEnvironmentVariable('Path',$$next,'User') }"`
    Pop $0
    ${if} $0 != 0
      DetailPrint "WARNING: user PATH cleanup failed (exit=$0); command wrappers were removed"
    ${endif}
    ${endif}
  SectionEnd

  ; 默认不勾选：删除 WebBridge 二进制、缓存、日志
  Section /o "$(un.removeWebbridge)"
    RMDir /r "$PROFILE\.kimi-webbridge"
  SectionEnd

  ; 默认不勾选（/o）：删除用户数据和配置，防止误删
  Section /o "$(un.removeUserData)"
    ; 整个 ~/.openclaw/ 目录：配置、日志、凭据、备份、技能、对话历史
    RMDir /r "$PROFILE\.openclaw"
  SectionEnd
!macroend
