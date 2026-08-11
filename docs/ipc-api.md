# CryoClaw IPC API Reference

> Preload (`src/preload.ts`) 通过 `contextBridge.exposeInMainWorld("cryoclaw", {...})` 暴露的完整 IPC 接口清单。
> Electron 40 默认 sandbox 模式，所有渲染进程与主进程的交互必须经过此桥接层。

## Gateway 控制

| 方法 | IPC 通道 | 方向 |
|---|---|---|
| `restartGateway()` | `gateway:restart` | send |
| `startGateway()` | `gateway:start` | send |
| `stopGateway()` | `gateway:stop` | send |
| `getGatewayState()` | `gateway:state` | invoke |

## 自动更新

> 已移除：CryoClaw 自身的"检查更新"功能已删除（应用更新由内核升级器 `kernel:*` 系列接管，
> 见下方「内核升级」节）。本节保留作为历史参考，相关 IPC 通道不再存在。

| 方法 | IPC 通道 | 方向 | 状态 |
|---|---|---|---|
| ~~`checkForUpdates()`~~ | ~~`app:check-updates`~~ | send | 已删除 |
| ~~`getUpdateState()`~~ | ~~`app:get-update-state`~~ | invoke | 已删除 |
| ~~`downloadAndInstallUpdate()`~~ | ~~`app:download-and-install-update`~~ | invoke | 已删除 |
| ~~`onUpdateState(cb)`~~ | ~~`app:update-state`~~ | 推送 | 已删除 |

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
