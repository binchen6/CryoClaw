# CryoClaw IPC API Reference

> Preload (`src/preload.ts`) 通过 `contextBridge.exposeInMainWorld("cryoclaw", {...})` 暴露的完整 IPC 接口清单。
> Electron 43 默认 sandbox 模式，所有渲染进程与主进程的交互必须经过此桥接层。

## Gateway 控制

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `restartGateway()` | `gateway:restart` | send |
| `startGateway()` | `gateway:start` | send |
| `stopGateway()` | `gateway:stop` | send |
| `getGatewayState()` | `gateway:state` | invoke |

## 自动更新

> R20 起由 `src/app-updater.ts` 重新引入（electron-updater，generic provider 走 GitHub Releases）：
> 仅 packaged 环境启用（dev 下 `supported=false`）；启动后 ~15s 静默检查一次（无周期复查），
> 自动下载，downloaded 后由用户确认重启安装。换装为自实现 spawn（见 gotchas #67），
> `quitAndInstall()` 仅作文件缺失时的回退。状态机纯逻辑在 `src/app-updater-state.ts`，
> IPC handlers 注册在 `src/settings/about.ts`（全部过 `assertTrustedIpcSender`）。

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `appUpdateGetState()` | `app-update:get-state` | invoke，返回 `{success, data: AppUpdateState}` |
| `appUpdateCheck()` | `app-update:check` | invoke，触发一次检查并返回当前 state |
| `appUpdateQuitAndInstall()` | `app-update:quit-and-install` | invoke，启动 pending 安装器后 `app.quit()` |
| `onAppUpdateState(cb)` | `app:update-state` | 推送（状态快照，返回 unsubscribe 函数） |

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
| `completeSetup(params?)` | `setup:complete` | invoke |
| `retryRandomPort()` | `setup:retry-random-port` | invoke |
| `detectInstallation()` | `setup:detect-installation` | invoke |
| `resolveConflict(params)` | `setup:resolve-conflict` | invoke |

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
| `settingsAddFeishuUserAllowFrom(params)` | `settings:add-feishu-user-allow-from` | invoke |
| `settingsRemoveFeishuApproved(params)` | `settings:remove-feishu-approved` | invoke |

## Settings — Channels (WeCom)

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `settingsListWecomPairing()` | `settings:list-wecom-pairing` | invoke |
| `settingsApproveWecomPairing(params)` | `settings:approve-wecom-pairing` | invoke |
| `settingsRejectWecomPairing(params)` | `settings:reject-wecom-pairing` | invoke |
| `settingsListWecomApproved()` | `settings:list-wecom-approved` | invoke |
| `settingsAddWecomUserAllowFrom(params)` | `settings:add-wecom-user-allow-from` | invoke |
| `settingsAddWecomGroupAllowFrom(params)` | `settings:add-wecom-group-allow-from` | invoke |
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

## Settings — Advanced / CLI

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `settingsGetAdvanced()` | `settings:get-advanced` | invoke |
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

## Settings — Share

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `settingsGetShareCopy()` | `settings:get-share-copy` | invoke |

## 技能商店

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `skillStoreList(params?)` | `skill-store:list` | invoke |
| `skillStoreSearch(params?)` | `skill-store:search` | invoke |
| `skillStoreDetail(params?)` | `skill-store:detail` | invoke |
| `skillStoreInstall(params?)` | `skill-store:install` | invoke |
| `skillStoreUninstall(params?)` | `skill-store:uninstall` | invoke |
| `skillStoreListInstalled()` | `skill-store:list-installed` | invoke |

## Chat UI

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `openSettings()` | `app:open-settings` | send |
| `openWebUI()` | `app:open-webui` | send |
| `getGatewayPort()` | `gateway:port` | invoke |

## 文件操作

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `selectFiles(options?)` | `dialog:select-files` | invoke |
| `readFileBase64(path)` | `file:read-base64` | invoke |

## Git 面板（P4，文件级 v1）

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `gitDetect()` | `git:detect` | invoke |
| `gitStatus(cwd)` | `git:status` | invoke |
| `gitDiff(cwd, opts?)` | `git:diff` | invoke |
| `gitStage(cwd, paths)` | `git:stage` | invoke |
| `gitUnstage(cwd, paths)` | `git:unstage` | invoke |
| `gitCommit(cwd, message)` | `git:commit` | invoke |

> 全部通道 `assertTrustedIpcSender` 校验 + `cwd` 必须 ∈ workspace 白名单根
> （`workspace-ipc.ts resolveAllowedDir`：path 校验 + realpath 复核防 symlink）。
> 实现为 execFile git CLI 数组传参（无 shell 注入面）+ 超时 + windowsHide。
> `git:status` 返回 `status --porcelain=v2 -z -b` 解析后的 `{branch, entries, truncated}`；
> `git:diff`（`opts.cached` 拉 staged 区、`opts.path` 限定单文件懒拉）返回解析后的
> `{files: DiffFile[], truncated}`；porcelain/diff 解析器在 `src/git-parse.ts`（纯函数），
> 底层 runner 在 `src/git-run.ts`（截断检测含 Node ≥22 的 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`）。
> 结构化错误协议：git 未安装 `{error:"no-git"}`、cwd 白名单外 `{error:"denied"}`、
> 非 git 仓库 `{error:"not-a-repo"}`、其余 git 失败 `{error:"git-error", message: stderr}`。
> 文件路径入参只接受仓库相对路径（`sanitizeGitRelPaths` 拒绝绝对路径与 `..` 逃逸）。
> `git:unstage` 用 `restore --staged`（要求 git ≥ 2.23）；空仓库（unborn HEAD）自动回退
> `rm --cached`。

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

> `openExternal` 存在的原因：sandbox 模式下 `shell.openExternal` 不可用，必须走 IPC 到主进程。

## 事件监听器

| 方法 | IPC 通道 | 说明 |
|---|---|---|
| `onSettingsNavigate(cb)` | `settings:navigate` | Settings tab 导航（含 notice） |
| `onNavigate(cb)` | `app:navigate` | Chat UI 视图切换（返回 unsubscribe 函数） |
| `onKernelUpdateProgress(cb)` | `kernel:update-progress` | 内核升级进度推送（返回 unsubscribe 函数） |
