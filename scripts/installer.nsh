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

; 杀进程后仅在确有进程被杀时等待句柄释放：
; taskkill 退出码 128 = 没有匹配进程（全新安装场景），跳过固定 Sleep 省 2s；
; 其他退出码（0=成功、1=部分失败/拒绝访问）一律等待，宁可慢不可踩文件锁。
!macro customInit
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
!macroend

; ============================================================
; 安装后钩子：生成 CLI 专用二进制（SUBSYSTEM:CONSOLE）
; 复制主 exe 并补丁 PE header，支持交互式 stdin
; ============================================================

!macro customInstall
  ; 生成 CLI 专用二进制（SUBSYSTEM:CONSOLE）：复制主 exe 并补丁 PE header。
  ; -File 直跑（R64 审查 P3）：脚本自定位安装目录（$PSScriptRoot 上级），
  ; 旧版把 $INSTDIR 内插进 -Command 双引号串，自选安装目录含 $、反引号等
  ; PS 元字符时会被展开/转义导致 CLI 生成失败。
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\create-cli-binary.ps1"'
  ; 检查退出码：CLI 二进制生成失败不阻断安装，但写醒目日志便于排查
  Pop $0
  ${if} $0 != 0
    DetailPrint "WARNING: create-cli-binary.ps1 failed (exit=$0) - openclaw CLI binary was not created. Reinstall or run resources\create-cli-binary.ps1 manually to restore it."
  ${endif}
!macroend

; ============================================================
; customRemoveFiles：接管旧版文件移除，绕开官方 atomicRMDir 稳定失败
; （electron-builder 26.7.0 模板在"更新模式卸载"上逐项 rename 到
;  %TEMP%\ns*.tmp\old-install 报 Can't rename $INSTDIR → Abort(exit 2)
;  → 新安装器 5 轮重试 → uninstallFailed 弹窗（silent 下也弹），更新链路
;  整体卡死。v2026.909.6 全旧代码同样复现，非本仓库回归，属上游缺陷。）
; 对策：更新场景旧文件本就要丢弃，无需 rename 暂存/还原语义——直接
; RMDir /r 删除；残留（文件确被锁）时 retry 一轮，仍非空才 Abort 交回
; 官方重试循环。非更新（真卸载）同样直接删（官方删法等价，少一跳）。
; ============================================================

!macro customRemoveFiles
  SetOutPath "$TEMP"
  RMDir /r "$INSTDIR"
  ${if} ${FileExists} "$INSTDIR\*.*"
    Sleep 1000
    RMDir /r "$INSTDIR"
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
  ${if} $R0 != 0
    DetailPrint "old uninstaller failed (exit=$R0), falling back to direct removal"
    SetOutPath "$TEMP"
    RMDir /r "$INSTDIR"
    ${if} ${FileExists} "$INSTDIR\*.*"
      Sleep 1500
      RMDir /r "$INSTDIR"
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
!macro customUnInit
  StrCpy $0 0
  nsExec::ExecToLog 'taskkill /IM "CryoClaw.exe" /T /F'
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

    ; 写入临时 PowerShell 脚本，从用户级 PATH 移除 bin 目录
    ; 逻辑与 cli-integration.ts buildWinPathEnvScript("remove") 保持一致
    FileOpen $0 "$TEMP\cryoclaw-uninstall-path.ps1" w
    FileWrite $0 "function Remove-FromPath([string]$$target) {$\r$\n"
    FileWrite $0 "  $$current = [Environment]::GetEnvironmentVariable('Path', 'User')$\r$\n"
    FileWrite $0 "  if (-not $$current) { return }$\r$\n"
    FileWrite $0 "  $$parts = $$current -split ';' | ForEach-Object { $$_.Trim() } | Where-Object { $$_ -ne '' }$\r$\n"
    FileWrite $0 "  try { $$tn = ([System.IO.Path]::GetFullPath($$target)).TrimEnd('\').ToLowerInvariant() } catch { $$tn = $$target.Trim().TrimEnd('\').ToLowerInvariant() }$\r$\n"
    FileWrite $0 "  $$filtered = @()$\r$\n"
    FileWrite $0 "  foreach ($$p in $$parts) {$\r$\n"
    FileWrite $0 "    try { $$n = ([System.IO.Path]::GetFullPath($$p)).TrimEnd('\').ToLowerInvariant() } catch { $$n = $$p.Trim().TrimEnd('\').ToLowerInvariant() }$\r$\n"
    FileWrite $0 "    if ($$n -ne $$tn) { $$filtered += $$p }$\r$\n"
    FileWrite $0 "  }$\r$\n"
    FileWrite $0 "  [Environment]::SetEnvironmentVariable('Path', ($$filtered -join ';'), 'User')$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "Remove-FromPath $$env:LOCALAPPDATA\CryoClaw\bin$\r$\n"
    FileWrite $0 "Remove-FromPath $$env:USERPROFILE\.openclaw\bin$\r$\n"
    FileClose $0

    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$TEMP\cryoclaw-uninstall-path.ps1"'
    Delete "$TEMP\cryoclaw-uninstall-path.ps1"
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
