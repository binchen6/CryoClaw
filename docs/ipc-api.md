# CryoClaw IPC API Reference

> Preload (`src/preload.ts`) 通过 `contextBridge.exposeInMainWorld("cryoclaw", {...})` 暴露的完整 IPC 接口清单。
> Electron 43 默认 sandbox 模式，所有渲染进程与主进程的交互必须经过此桥接层。

## OpenAI / Codex 独立代理

| 方法 | IPC 通道 | 说明 |
|---|---|---|
| `openaiProxyGet()` | `settings:openai-proxy-get` | 读取壳层代理配置 |
| `openaiProxySave(config)` | `settings:openai-proxy-save` | 校验并保存 `{mode: system/direct/custom, url}`，请求网关重启 |
| `openaiProxyTest(config)` | `settings:openai-proxy-test` | 最长 8 秒测试 HTTP(S) CONNECT；不携带账户凭据 |

三个通道均校验可信发送方；自定义地址拒绝 SOCKS、URL 用户密码、路径、查询及 fragment。

## Gateway 控制方法

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `restartGateway()` | `gateway:restart` | send |
| `startGateway()` | `gateway:start` | send |
| `stopGateway()` | `gateway:stop` | send |
| `getGatewayState()` | `gateway:state` | invoke，返回 `{ state, progress }`（`progress` 为最近一次 `GatewayProgressInfo`，无则 null） |

## 自动更新

> R20 起由 `src/app-updater.ts` 重新引入（electron-updater，generic provider 走 GitHub Releases）：
> 仅 packaged 环境启用（dev 下 `supported=false`）；启动后 ~15s 检查一次（无周期复查）。
> **v2026.906.0 起改为「弹窗决策」模式**：`autoDownload=false`，发现新版本仅弹窗
> （更新日志 + 更新/暂缓，渲染层 `views/update-available-dialog.ts`），用户点「更新」
> 才经 `app-update:download` 开始下载；下载进度与「重启安装」在同一弹窗完成。
> 暂缓持久化在 `src/update-snooze.ts`（`userData/app-update-snooze.json`，
> 7 天/1 月/3 月/永久/自定义 1–3650 天），期内跳过启动自动检查，手动检查不受影响；
> `AppUpdateState` 带 `snoozedUntil` 字段。安装为**真静默**：自实现 spawn 带 `/S` 的 NSIS 安装器
> （见 gotchas #67），`quitAndInstall()` 仅作文件缺失时的回退。状态机纯逻辑在 `src/app-updater-state.ts`，
> IPC handlers 注册在 `src/settings/about.ts`（全部过 `assertTrustedIpcSender`）。

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `appUpdateGetState()` | `app-update:get-state` | invoke，返回 `{success, data: AppUpdateState}` |
| `appUpdateCheck()` | `app-update:check` | invoke，触发一次检查并返回当前 state |
| `appUpdateDownload()` | `app-update:download` | invoke，available 态开始下载（唯一下载入口，906.0 新增） |
| `appUpdateSnooze(opts)` | `app-update:snooze` | invoke，`{days: 1–3650}` 或 `{forever: true}`（906.0 新增） |
| `appUpdateClearSnooze()` | `app-update:clear-snooze` | invoke，清除暂缓恢复自动检查（906.0 新增） |
| `appUpdateQuitAndInstall()` | `app-update:quit-and-install` | invoke，spawn 带 `/S` 的真静默安装器（gotcha #67）后 `app.quit()` |
| `onAppUpdateState(cb)` | `app:update-state` | 推送（状态快照，返回 unsubscribe 函数） |

## 内核升级/回退

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `kernelGetUpdateState()` | `kernel:get-update-state` | invoke |
| `kernelCheckUpdate()` | `kernel:check` | invoke |
| `kernelUpdate(params?)` | `kernel:update` | invoke（tag 可选） |
| `kernelRollback()` | `kernel:rollback` | invoke |

## Setup

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `verifyKey(params)` | `setup:verify-key` | invoke |
| `saveConfig(params)` | `setup:save-config` | invoke |

> R4 起 `setup:save-config` 只接收 `{providerKey, providerConfig, primaryModel, kimiCode?, ...埋点字段}`：
> provider/模型凭据由 setup step2 前端直接写入（fragment 形式，复用
> `views/settings/tab-provider.lib.ts` 的 add 流程构造函数；setup 期间 gateway 未运行，
> 不走 `config.patch`），主进程仅写 baseline 默认值与 primary model。

| `setupGetLaunchAtLogin()` | `setup:get-launch-at-login` | invoke |
| `detectEnvKeys()` | `setup:detect-env-keys` | invoke，返回 `{success, data: [{providerKey, envVar, maskedKey}]}` |
| `adoptEnvKey(params)` | `setup:adopt-env-key` | invoke，入参 `{providerKey, envVar}`，返回 `{ok, providerKey, model?}` 或 `{ok:false, error}` |
| `completeSetup(params?)` | `setup:complete` | invoke |
| `detectInstallation()` | `setup:detect-installation` | invoke |
| `resolveConflict(params)` | `setup:resolve-conflict` | invoke |

> v2026.907.0 起 Setup「快速通道」：`setup:detect-env-keys` 扫描环境变量（OPENAI /
> ANTHROPIC / MOONSHOT / GOOGLE·GEMINI / DEEPSEEK_API_KEY，映射表见
> `src/setup-env-detect.ts` 的 `ENV_KEY_CANDIDATES`）返回**掩码列表**；`setup:adopt-env-key`
> 只收 `{providerKey, envVar}`（必须是映射表内组合，防渲染层任意指定变量名偷值），明文
> key 由主进程自读 `process.env`、走与手动配置相同的 `verifyProvider` 真实验证后落盘。
> **设计红线：明文 key 不出主进程**，渲染层只接触掩码。

## Kimi OAuth

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `kimiOAuthLogin()` | `kimi-oauth:login` | invoke |
| `kimiOAuthCancel()` | `kimi-oauth:cancel` | invoke |
| `kimiOAuthLogout()` | `kimi-oauth:logout` | invoke |
| `kimiOAuthStatus()` | `kimi-oauth:status` | invoke |
| `kimiGetUsage()` | `kimi:get-usage` | invoke |

## Settings — Provider

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `settingsVerifyKey(params)` | `settings:verify-key` | invoke |
| `settingsFetchProviderModels(params)` | `settings:fetch-provider-models` | invoke（R58，/models 实时列表） |
| `settingsGetProviderUsage(params)` | `settings:get-provider-usage` | invoke（R58，套餐用量/余额） |
| `settingsWriteKimiApiKey(params)` | `settings:write-kimi-api-key` | invoke |

> R4 起 provider/模型配置的读取与写入改走内核原生 `config.get` / `config.patch` RPC
> （chat-ui controllers/config.ts），原 `settings:get-config` / `settings:save-provider` /
> `settings:get-configured-models` / `settings:delete-model` / `settings:set-default-model` /
> `settings:update-model-alias` 已退役。

## Settings — Channels（通用）

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `settingsGetChannelRuntimeState()` | `settings:get-channel-runtime-state` | invoke |
| `settingsEnsureWeixinPlugin()` | `settings:ensure-weixin-plugin` | invoke |

> R4 起渠道/搜索/记忆/高级配置的读取与写入改走内核原生 `config.get` / `config.patch` RPC
> （chat-ui `views/settings/tab-channels.lib.ts` 纯函数在 draft 上落变更），原
> `settings:get-channel-config` / `settings:save-channel` / `settings:get-wecom-config` /
> `settings:save-wecom-config` / `settings:get-qqbot-config` / `settings:save-qqbot-config` /
> `settings:get-dingtalk-config` / `settings:save-dingtalk-config` / `settings:get-weixin-config` /
> `settings:save-weixin-config` / `settings:get-kimi-search-config` / `settings:save-kimi-search-config` /
> `settings:get-memory-config` / `settings:save-memory-config` / `settings:add-feishu-group-allow-from`
> 已退役；pairing 配对与已批准名单管理仍走主进程（配对 store 属主进程职责）。

## Settings — Channels (Feishu)

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `settingsListFeishuPairing()` | `settings:list-feishu-pairing` | invoke |
| `settingsApproveFeishuPairing(params)` | `settings:approve-feishu-pairing` | invoke |
| `settingsRejectFeishuPairing(params)` | `settings:reject-feishu-pairing` | invoke |
| `settingsListFeishuApproved()` | `settings:list-feishu-approved` | invoke |
| `settingsRemoveFeishuApproved(params)` | `settings:remove-feishu-approved` | invoke |

## Settings — Channels (WeCom)

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `settingsListWecomPairing()` | `settings:list-wecom-pairing` | invoke |
| `settingsApproveWecomPairing(params)` | `settings:approve-wecom-pairing` | invoke |
| `settingsRejectWecomPairing(params)` | `settings:reject-wecom-pairing` | invoke |
| `settingsListWecomApproved()` | `settings:list-wecom-approved` | invoke |
| `settingsRemoveWecomApproved(params)` | `settings:remove-wecom-approved` | invoke |

## Settings — Channels (WeChat 微信)

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `settingsWeixinLoginStart()` | `settings:weixin-login-start` | invoke |
| `settingsWeixinLoginWait(params)` | `settings:weixin-login-wait` | invoke |
| `settingsWeixinClearAccounts()` | `settings:weixin-clear-accounts` | invoke |

## Settings — Kimi

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `settingsGetKimiSearchKey()` | `settings:get-kimi-search-key` | invoke |
| `settingsWriteKimiSearchKey(params)` | `settings:write-kimi-search-key` | invoke |
| `settingsEnsureKimiProxy()` | `settings:ensure-kimi-proxy` | invoke |
| `settingsGetAboutInfo()` | `settings:get-about-info` | invoke |

## Settings — Memory

> Memory 工作区数据 + memory CLI 桥（`src/settings/memory.ts`）：记忆/梦境分页 +
> 召回测试 / 索引重建 / 插件修复。全部通道 `assertTrustedIpcSender` 校验。

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `memoryListWorkspace()` | `memory:list` | invoke（记忆条目分页列表） |
| `memoryReadEntry(params)` | `memory:read` | invoke |
| `memoryAppendEntry(params)` | `memory:append` | invoke |
| `memoryListDreams()` | `memory:list-dreams` | invoke（梦境分页） |
| `memoryReadDream(params)` | `memory:read-dream` | invoke |
| `memoryDeleteDream(params)` | `memory:delete-dream` | invoke |
| `memoryRecallTest(params)` | `memory:recall-test` | invoke（召回测试） |
| `memoryReindex()` | `memory:reindex` | invoke（索引重建） |
| `memoryRepairPlugin()` | `memory:repair-plugin` | invoke（修复 memory 插件） |

## Settings — Advanced / CLI

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `settingsGetAdvanced()` | `settings:get-advanced` | invoke |
| `settingsGetEnvInfo()` | `settings:get-env-info` | invoke |
| `settingsWebbridgePrecheck()` | `settings:webbridge-precheck` | invoke |
| `settingsWebbridgeRepairAndEnable()` | `settings:webbridge-repair-and-enable` | invoke |
| `settingsGetDefaultBrowserName()` | `settings:get-default-browser-name` | invoke |
| `settingsWebbridgeNeedsRepair()` | `settings:webbridge-needs-repair` | invoke（左侧栏 pill） |
| `settingsWebbridgePillRepair()` | `settings:webbridge-pill-repair` | invoke（pill 点击修复） |
| `settingsWebbridgeVersionStatus()` | `settings:webbridge-version-status` | invoke（版本状态：安装版本/来源/daemon 运行态/更新信号，R79） |
| `settingsWebbridgeUpdateCheck(params?)` | `settings:webbridge-update-check` | invoke（检查更新；`params.autoUpdate` 传 boolean 时只写自动更新开关，R79） |
| `settingsWebbridgeUpdateApply()` | `settings:webbridge-update-apply` | invoke（下载新二进制 → 钉定校验 → 换装 → 按需重启 daemon，R79） |
| `settingsWebbridgeRefreshPins()` | `settings:webbridge-refresh-pins` | invoke（绕过 24h 缓存强制拉取远端 WebBridge 钉定清单） |
| `settingsWebbridgeExtensionCheck()` | `settings:webbridge-extension-check` | invoke（浏览器扩展检查更新，清单 extension 块驱动） |
| `settingsWebbridgeExtensionUpdate()` | `settings:webbridge-extension-update` | invoke（浏览器扩展立即更新） |
| `settingsExportDiagnostics()` | `settings:export-diagnostics` | invoke（脱敏诊断包导出） |
| `settingsSaveAdvanced(params)` | `settings:save-advanced` | invoke |
| `settingsGetCliStatus()` | `settings:get-cli-status` | invoke |
| `settingsInstallCli()` | `settings:install-cli` | invoke |
| `settingsUninstallCli()` | `settings:uninstall-cli` | invoke |

> R4 起 `settings:get-advanced` / `settings:save-advanced` 只保留主进程职责字段
> （browserMode / browserProfile / launchAtLogin / clawHubRegistry / dockerAvailable）；
> openclaw.json 内的高级字段（gateway.reload、tools.exec、agents.defaults.sandbox、
> channels.imessage）改走 `config.get` / `config.patch`。

## Settings — Backup

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `settingsListConfigBackups()` | `settings:list-config-backups` | invoke |
| `settingsExportOpenclawState()` | `settings:export-openclaw-state` | invoke |
| `settingsSelectOpenclawStateArchive()` | `settings:select-openclaw-state-archive` | invoke |
| `settingsImportOpenclawState(params)` | `settings:import-openclaw-state` | invoke |
| `settingsRestoreConfigBackup(params)` | `settings:restore-config-backup` | invoke |
| `settingsRestoreLastKnownGood()` | `settings:restore-last-known-good` | invoke |
| `settingsResetConfigAndRelaunch()` | `settings:reset-config-and-relaunch` | invoke |

> 恢复语义（2026.912.0 起）：两个 restore 通道在写配置前会先静默 gateway（对齐恢复出厂路径，防内核 config observer 写回复活），恢复落盘后按当前内核版本跑存量迁移（dingtalk 废弃字段 / browser profile / 内核版本门控迁移），返回成功后再由渲染层重启 gateway。旧备份恢复后不再出现 gateway 被 strict 校验拒起的问题。

## Settings — Share

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `settingsGetShareCopy()` | `settings:get-share-copy` | invoke |

## 技能商店

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `skillStoreList(params?)` | `skill-store:list` | invoke |
| `skillStoreSearch(params?)` | `skill-store:search` | invoke |
| `skillStoreInstall(params?)` | `skill-store:install` | invoke |
| `skillStoreUninstall(params?)` | `skill-store:uninstall` | invoke |
| `skillStoreListInstalled()` | `skill-store:list-installed` | invoke |
| `skillStoreCheckUpdates({slug?})` | `skill-store:check-updates` | invoke（支持单技能检查；排除本地目录） |
| `skillStoreImportLocal()` | `skill-store:import-local` | invoke（系统目录选择；校验并复制 SKILL.md 目录，不覆盖已安装技能） |
| `pluginStoreImportLocal()` | `plugin-store:import-local` | invoke（系统目录选择；校验插件清单和目录内入口，再交内核安装） |
| `skillStoreUpdate(params?)` | `skill-store:update` | invoke（升级；slugs 缺省 = 全部可更新项） |
| `skillStoreDetail(params?)` | `skill-store:detail` | invoke |

## 插件管理页（extensions 视图）

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `pluginStoreList()` | `plugin-store:list` | invoke |
| `pluginStoreSearch(params?)` | `plugin-store:search` | invoke |
| `pluginStoreInstall(params?)` | `plugin-store:install` | invoke |
| `pluginStoreUninstall(params?)` | `plugin-store:uninstall` | invoke |
| `pluginStoreSetEnabled(params?)` | `plugin-store:set-enabled` | invoke（启用/禁用统一写入：entries.enabled + plugins.allow 同步，主进程原子写） |
| `pluginStoreCheckUpdates({id?})` | `plugin-store:check-updates` | invoke（直接检查 ClawHub / npm 元数据；排除本地和内置项，`data.failed` 为检查失败的 id 清单） |
| `pluginStoreUpdate(params?)` | `plugin-store:update` | invoke |
| `pluginStoreDetail(params?)` | `plugin-store:detail` | invoke |
| `pluginStoreMarketBrowse(params?)` | `plugin-store:market-browse` | invoke |
| `pluginStoreMarketDetail(params?)` | `plugin-store:market-detail` | invoke（市场条目详情） |

## Chat UI

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `openWebUI()` | `app:open-webui` | send |
| `quit()` | `app:quit` | send |
| `reportSetupViewState(active)` | `app:setup-view-state` | send |
| `getGatewayPort()` | `gateway:port` | invoke |
| `getReleaseNotes(opts?)` | `app:get-release-notes` | invoke |
| `dismissReleaseNotes(version)` | `app:dismiss-release-notes` | invoke |

> `openWebUI()` 打开外部浏览器时不再把 gateway token 交给 OS/浏览器：改为打开控制服务的一次性
> handoff URL（`GET /webui-handoff/<code>`，60s TTL、用后作废），由 302 的 Location 头把
> `#token=` 送到真实 WebUI；控制服务未就绪时降级为不带 token 的直连 URL。
> 注意：浏览器会提交「重定向后」的 URL（即落地 URL 仍带 token），真正把它从历史记录里清掉的是
> Control UI 启动时的 `history.replaceState`（见 gotchas #21 实测残留面）。

## 文件操作

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `selectFiles(options?)` | `dialog:select-files` | invoke |
| `selectDirectory()` | `dialog:select-directory` | invoke（目录选择；取消返回 null） |
| `readFileBase64(path)` | `file:read-base64` | invoke |
| `readClipboardFilePaths()` | `clipboard:read-file-paths` | invoke（剪贴板文件路径） |
| `fileThumbnail(path)` | `file:thumbnail` | invoke（图片附件缩略图：png/jpg/webp/gif/bmp，≤192px data URL；非法输入或失败返回 null 不抛错） |

## 工作空间（workspace 视图）

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `setWorkspaceRoot(root)` | `workspace:set-root` | invoke |
| `workspaceGetContext()` | `workspace:get-context` | invoke（只读默认/当前根路径，sender 校验，不返回配置或凭据） |
| `openWorkspaceFolder(filePath)` | `workspace:open-folder` | invoke |
| `listWorkspaceDir(dirPath)` | `workspace:list-dir` | invoke |
| `readWorkspaceFile(filePath)` | `workspace:read-file` | invoke |
| `workspaceWriteFile(params)` | `workspace:write-file` | invoke（`{path, content, baseHash}`：版本 hash 校验 + 原子替换） |
| `workspaceSaveDraft(params)` | `workspace:save-draft` | invoke（`{path, draft, baseHash}`：草稿暂存，`draft=null` 清除） |
| `workspaceFindFiles(params)` | `workspace:find-files` | invoke（`{root, query, showHidden?}`：根内文件名搜索） |

> 全部通道 `assertTrustedIpcSender` 校验；路径必须落在 workspace 根内
> （`workspace-ipc.ts` 的根内包含校验 + realpath 复核防 symlink 逃逸）。
> `workspace:set-root` 写 `agents.defaults.workspace` 时用正斜杠（见 gotcha #84）。

## Git 面板（P4，文件级 v1）

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `gitDetect()` | `git:detect` | invoke |
| `gitStatus(cwd)` | `git:status` | invoke |
| `gitDiff(cwd, opts?)` | `git:diff` | invoke |
| `gitStage(cwd, paths)` | `git:stage` | invoke |
| `gitUnstage(cwd, paths)` | `git:unstage` | invoke |
| `gitCommit(cwd, message)` | `git:commit` | invoke |
| `gitBranchList(cwd)` | `git:branch-list` | invoke（R58） |
| `gitCheckout(cwd, branch)` | `git:checkout` | invoke（R58） |
| `gitLog(cwd, limit?)` | `git:log` | invoke（R58） |
| `gitPush(cwd, opts?)` | `git:push` | invoke（R58） |
| `gitPull(cwd)` | `git:pull` | invoke（R58） |
| `gitDiscard(cwd, paths)` | `git:discard` | invoke（R58，destructive） |
| `gitClean(cwd, paths)` | `git:clean` | invoke（R58，destructive） |
| `gitChangeStats(cwd, paths)` | `git:change-stats` | invoke（只读；本轮改动胶囊与消息底部「已编辑」卡片的行数统计） |

> 全部通道 `assertTrustedIpcSender` 校验 + `cwd` 必须 ∈ workspace 白名单根
> （`workspace-ipc.ts resolveAllowedDir`：path 校验 + realpath 复核防 symlink）。
> 实现为 execFile git CLI 数组传参（无 shell 注入面）+ 超时 + windowsHide。
> `git:status` 返回 `status --porcelain=v2 -z -b` 解析后的 `{branch, entries, truncated}`；
> `git:diff`（`opts.cached` 拉 staged 区、`opts.path` 限定单文件懒拉）返回解析后的
> `{files: DiffFile[], truncated}`；porcelain/diff 解析器在 `src/git-parse.ts`（纯函数），
> 底层 runner 在 `src/git-run.ts`（截断检测含 Node ≥22 的 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`）。
> 结构化错误协议：git 未安装 `{error:"no-git"}`、cwd 白名单外 `{error:"denied"}`、
> cwd 不存在/非目录 `{error:"not-found"}`（避免与 git 二进制缺失的 ENOENT 混淆）、
> 非 git 仓库 `{error:"not-a-repo"}`、其余 git 失败 `{error:"git-error", message: stderr}`。
> 文件路径入参只接受仓库相对路径（`sanitizeGitRelPaths` 拒绝绝对路径与 `..` 逃逸）。
> `git:unstage` 用 `restore --staged`（要求 git ≥ 2.23）；空仓库（unborn HEAD）自动回退
> `rm --cached`。
>
> `git:change-stats`（只读，本轮改动胶囊用）：入参 `paths[]` 是渲染层工具参数里的路径
> （绝对 / 仓库相对 / Windows 反斜杠均可），主进程先 `git rev-parse --show-toplevel` 找
> 仓库根、`git status --porcelain=v2 -z` 列改动（含未跟踪 / 重命名），把路径按
> 「绝对路径归一 / 最长后缀」匹配到改动项，再一次性 `git diff HEAD --numstat -z`
> 取 tracked 文件增删行数。未跟踪文件按读文件行数计新增（单文件 ≤1MiB、前 8000 字节
> NUL 嗅探二进制、单次总读取预算 8MiB）；二进制文件标记 `binary: true` 且行数为 0。
> 返回 `{success:true, data:{stats:[{path, additions, deletions, binary?}], truncated?}}`，
> `stats[].path` 原样回传入参路径（渲染层据此与列表对应）；行数不可用的路径不出现在
> stats 里。上限：单次 ≤200 个路径、每路径 ≤1024 字符、diff argv 总长 ≤24000 字符
> （超限置 `truncated: true`，渲染层整体退回「新增/删除文件数」）。
> 错误协议沿用上方 git 通道，另加 `invalid-input`（paths 非法/超限）。

> `file:read-base64`：读取本地文件为 base64，供聊天文件附件走内核 apiAttachments。
> 仅接受已存在的绝对路径普通文件，大小 ≤16MB（stat 预判 + 读后复核双道）；超限返回 `{ error: "too-large", size }`
> （不抛错，chat-ui 据此降级为路径文本前缀），成功返回 `{ base64, size, mimeType }`；
> 其余非法入参（非绝对路径/不存在/非普通文件）reject。
> 安全决策：这是向渲染层暴露的任意绝对路径读取原语，`assertTrustedIpcSender` 只放行
> file:// 主界面 frame；渲染层 XSS 可借此读本地文件，属已接受风险（用户自选文件场景需要）。

## 工具

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `openExternal(url)` | `app:open-external` | invoke |
| `openPath(path)` | `app:open-path` | invoke（扩展名白名单） |
| `revealPath(path)` | `app:reveal-path` | invoke（文件管理器定位） |

> `openExternal` 存在的原因：sandbox 模式下 `shell.openExternal` 不可用，必须走 IPC 到主进程。

## 事件监听器

| 方法 | IPC 通道 | 说明 |
|---|---|---|
| `onSettingsNavigate(cb)` | `settings:navigate` | Settings tab 导航（含 notice） |
| `onNavigate(cb)` | `app:navigate` | Chat UI 视图切换（返回 unsubscribe 函数） |
| `onKernelUpdateProgress(cb)` | `kernel:update-progress` | 内核升级进度推送（返回 unsubscribe 函数） |
| `onGatewayReady(cb)` | `gateway:ready` | 网关就绪推送（token/gatewayUrl；返回 unsubscribe 函数） |
| `onGatewayProgress(cb)` | `gateway:progress` | 网关启动进度推送（`GatewayProgressInfo {step, attempt, elapsedMs?}`，step: cleanup/database/port/spawn/health/ready；返回 unsubscribe 函数） |
| `onWebbridgeStateChanged(cb)` | `webbridge:state-changed` | webbridge 状态变化（setup 装完扩展/修复完成；返回 unsubscribe 函数） |
| `onThemeRequest(cb)` | `theme:request` | 主题预览桥请求（主进程 → 渲染层；返回 unsubscribe 函数） |
| `themeResult(response)` | `theme:result` | 主题预览桥回包（渲染层 → 主进程 send，配对 `theme:request`） |
| `onArchiveProgress(cb)` | `settings:archive-progress` | 备份/恢复归档进度推送（返回 unsubscribe 函数） |

> `kernel:update-progress` 载荷为 `{step, pct, msg, source?}`；v2026.907.0 起新增
> `source: "auto" | "manual"` 字段，区分手动升级与「内核低于 minSupported 的兜底自动
> 升级」（`main.ts scheduleAutoKernelUpgradeIfNeeded`），渲染层全局横幅
> （`views/kernel-auto-upgrade-banner.ts`）据此呈现并靠 `step:"done"` 终态收敛。
