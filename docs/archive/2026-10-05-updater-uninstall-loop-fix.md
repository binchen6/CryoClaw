# 更新换装「无法关闭」死循环修复（2026-10-05）

现象与根因诊断（真机实测，用户报告）：应用内点「更新」→ 安装器弹出
「CryoClaw 无法关闭。请手动关闭它，然后单击重试以继续。」，点「重试」永远无效；
用户点「取消」后安装反而成功。

## 根因链（证据）

1. **不是进程检查**：直读机器状态——无任何 CryoClaw 相关进程（安装器自身的
   路径检查命令返回「未找到」）、磁盘剩余 111GB、安装目录 ACL 正常且可写。
2. **安装目录已被清空**：`%LOCALAPPDATA%\Programs\CryoClaw` 为空（旧版 exe/
   app.asar/卸载器全无），而 HKCU 卸载注册表项仍在：
   `UninstallString → …\Programs\CryoClaw\Uninstall CryoClaw.exe`（文件已不存在）。
3. **模板 `uninstallOldVersion` 死循环**（electron-builder 26.7.0
   `templates/nsis/include/installUtil.nsh`）：更新换装先复制并执行**旧版卸载器**
   （`$INSTDIR\Uninstall <App>.exe`，路径取自 UninstallString）；卸载器缺失或
   执行返回非 0 时循环重试，超过 5 次即弹 `appCannotBeClosed`（标题文案为
   「无法关闭」）；「重试」重入同一必败循环 → 永远卡住；「取消」从宏返回，
   安装段落继续执行 → 全新安装成功（与用户观察一致）。
4. **中断成因**：上一次换装把旧版卸载了但复制阶段未完成（应用/子进程占文件、
   AV 扫描、或用户中途取消），留下「目录已空 + 注册表残留」的中间态。

## 修复（两处，均为防御性加固）

1. **安装器自愈（`scripts/installer.nsh` customInit，主修复）**
   `initMultiUser`（模板 .onInit 内先于 customInit 执行）已解析 `$INSTDIR` 与
   `SHELL_CONTEXT`。customInit 新增：当卸载注册表项存在、且（`$INSTDIR` 下主
   exe 缺失 **或** 卸载器缺失）时，删除陈旧卸载项 → 模板 `uninstallOldVersion`
   读到空 UninstallString 直接 `Return` → 走全新安装路径。
   - `INSTALL_REGISTRY_KEY`（`Software\<APP_GUID>`，含 InstallLocation/
     ShortcutName）**保留** → `$INSTDIR`、快捷方式与安装模式判定不受影响；
   - 用户数据在 `~/.openclaw`，不受影响；
   - 正常升级路径（exe 与卸载器均在）不触发，行为完全不变。
2. **应用侧交接清理（`src/main.ts` beforeQuitAndInstall + `src/plugin-store.ts`
   + `src/preload-warmup.ts`）**
   换装交接前 `cancelCacheWarmup()` + `killTrackedKernelCliChildren()`：
   `execKernelCli` 现在跟踪在途子进程（均为 `CryoClaw Helper.exe`、路径在安装
   目录内——包括 R94 批次新增的启动预热），交接前一并终止，避免其占住安装目录
   文件、干扰旧版卸载（即第 4 条中断成因的直接来源之一）。

## 守卫与验证

- 新增 `scripts/installer-nsh.test.mjs`（test:scripts）：钉住 R94 自愈块存在、
  `taskkill` 行绝不含 `/T`（级联自杀回归）、customInit 仍清理三个镜像名。
- `npm test` 四段全绿；类型检查通过。
- 真机复现路径：构造「目录已空 + 卸载项残留」后用新版安装器验证不再弹窗、
  直接全新安装成功（发版前验证项）。
