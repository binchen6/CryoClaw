# CryoClaw Architecture — Key Design Decisions

> 从 CLAUDE.md 拆分出的详细设计文档。每个子系统的设计决策、状态机、启动序列均记录在此。

## Gateway Child Process (`gateway-process.ts`)

State machine: `stopped → starting → running → stopping → stopped`

**Generation tracking:** Each `spawn()` call increments a generation counter. The exit handler only processes exits matching the current generation, preventing stale process exits from corrupting the state machine during rapid restart cycles.

Startup sequence:

1. Inject env vars: `OPENCLAW_LENIENT_CONFIG=1`, `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_NPM_BIN`, `OPENCLAW_NO_RESPAWN=1`
2. Prepend bundled runtime to `PATH`
3. Resolve entry: try `openclaw.mjs` first, fall back to `gateway-entry.mjs` (legacy)
4. Resolve port: env `OPENCLAW_GATEWAY_PORT` > config `gateway.port` > default `18789`
5. Spawn: `<node> <entry.js> gateway run --port <resolved> --bind loopback`
6. Disable gateway's own npm update check (`update.checkOnStart = false`) — CryoClaw is packaged as a whole unit, users can't independently update the gateway
7. Poll `GET http://127.0.0.1:<port>/` every 500ms, 90s timeout
8. Verify child PID is still alive (avoid port collision false positives)

Main process retries gateway startup **3 times** before showing an error dialog. This covers Windows cold-start slowness (Defender scanning, disk warmup). On success, the current config is snapshotted as "last known good" for recovery.

All stdout/stderr is captured to `~/.openclaw/gateway.log` for diagnostics.

**Automatic restart:** Gateway automatically restarts after user config changes (provider switch, model change, etc.) to pick up the new settings.

## Token Injection (`window.ts`)

The gateway requires an auth token. The main process generates one (or reads from config), passes it to the gateway via env var, and injects it into the BrowserWindow via URL fragment (`#token=...`) before `loadFile()`.

## Provider Configuration (`provider-config.ts`)

Centralized module for all provider presets, API key verification, and config file I/O. Shared by both Setup wizard and Settings page.

Supported providers:

- **Anthropic** — standard Anthropic Messages API
- **Kimi** — 3 sub-platforms: `moonshot-cn`, `moonshot-ai`, `kimi-code`
- **OpenAI** — OpenAI completions API
- **Google** — Google Generative AI
- **Custom** — user-supplied base URL + API type

All sub-platforms (including Kimi Code) use a unified config format: `apiKey` + `baseUrl` + `api` + `models` written to `models.providers`.

## Kimi OAuth (`kimi-oauth.ts`)

Device code flow for Kimi Code login:

- Opens browser to `auth.kimi.com` with device code
- Polls for token completion (max 120 retries)
- Token refresh: 60s interval, triggers when remaining < 300s (aligned with kimi-cli)
- Tokens persisted to `~/.openclaw/credentials/`

## Setup Wizard (`setup-ipc.ts`, `setup/`)

First-launch wizard flow:

- **Step 0**: Installation conflict detection (`install-detector.ts`) — checks for global `openclaw`/`openclaw-cn` installs + port occupation, offers uninstall or port change
- **Step 1**: Welcome
- **Step 2**: Provider Config (API key + provider selection, or Kimi OAuth login)
- **Step 3**: Done — optional toggles for Install CLI + Launch at Login

v2026.907.0 起 Step 2 有「快速通道」（`setup-env-detect.ts`）：扫描本机环境变量中已有的
provider API Key（OpenAI / Anthropic / Moonshot / Google / DeepSeek），一键采用——
`setup:detect-env-keys` 只回掩码列表，`setup:adopt-env-key` 由主进程读明文、真实验证、
落盘（明文 key 不出主进程，详见 docs/ipc-api.md）。

Config is written to `~/.openclaw/openclaw.json`. Setup completion is marked by `config.wizard.lastRunAt`.

## Settings Page (`settings-ipc.ts`, `settings/`)

Post-setup configuration management embedded inside the Chat UI (via `app:navigate` IPC). Opened from tray menu "Settings", Chat UI sidebar button, or macOS `Cmd+,`.

Since R4, all `openclaw.json` reads/writes from the settings UI go through the kernel-native `config.get` / `config.patch` RPC (chat-ui `controllers/config.ts` + pure-function libs under `views/settings/`); the main process keeps only what it owns — credential verification (`settings:verify-key`), sidecar key/proxy files, channel pairing store, weixin login flow, webbridge/browser integration, CLI install, and backup/restore. `src/settings-ipc.ts` is a thin entry registering handlers from the `src/settings/` modules.

Tabs:

- **Provider** — View/edit provider config, verify API key, switch models, Kimi usage display
- **Search** — Kimi Search web search toggle + dedicated API key (auto-reuses Kimi Code key if available)
- **Channels** — Multi-channel chat integration (WeChat, Feishu, WeCom, DingTalk, QQ Bot) with platform status indicators
- **Appearance** — Theme selector (system/light/dark), thinking process visibility
- **Advanced** — Browser profile selector (openclaw/Chrome), iMessage channel toggle, Launch at login toggle, CLI command (`openclaw`) install/uninstall
- **Backup & Restore** — Rolling backup list, restore last-known-good, gateway start/stop/restart, factory reset

## Multi-Channel Chat Integration

### DM Policy

New installs default `channels.feishu.dmPolicy = "open"` + `allowFrom = ["*"]` (any user can DM the bot). Advanced users can switch to `dmPolicy = "pairing"` from Settings, in which case only IDs in `allowFrom` respond. There is no background polling for pending pairing requests — approved users are managed via the sidecar (below). Gateway enforces the policy server-side based on `openclaw.json`.

### Channel Allow-From Sidecar (`channel-pairing-store.ts`)

Persistent storage for per-channel `allowFrom` entries (the "approved users" list rendered in Settings → Channels → Feishu / WeCom). Normalized and deduped. Backward-compatible with legacy single-channel files.

### WeCom (`wecom-config.ts`)

WeCom (企业微信) plugin configuration:

- DM policy: `pairing` or `open`
- Group policy: `open`, `allowlist`, or `disabled`
- Crypto callback verification for webhook events

### DingTalk (`dingtalk-config.ts`)

DingTalk connector plugin configuration:

- Client ID + secret based auth
- Configurable session timeout (default 30min)

### QQ Bot (`qqbot-config.ts`)

QQ Bot plugin configuration:

- App ID + client secret
- Optional Markdown support toggle

## Config Backup & Recovery (`config-backup.ts`)

Non-destructive config safety net:

- **Rolling backups**: Max 10 timestamped copies in `~/.openclaw/config-backups/`, created automatically before every config write
- **Last Known Good**: Snapshot of config at most recent successful gateway startup (`openclaw.last-known-good.json`)
- **Setup baseline**: Read-only copy of initial post-wizard config
- **Recovery flow**: On startup, if config is invalid JSON or gateway fails to start, the main process offers "Restore Last Known Good" / "Open Settings" / "Dismiss"
- **Factory reset**: Delete config entirely and relaunch into Setup wizard (preserves chat history)
- **导入应急归档（v2026.907.0）**：`settings:import-openclaw-state` 导入会清空状态目录，
  清空前自动把当前状态导出为应急归档（`%LOCALAPPDATA%\CryoClaw\import-backup`，
  滚动保留 2 份，见 `openclaw-state-archive.ts`）；备份失败中止导入，解压中途失败
  best-effort 自动还原。
- **内核配置迁移双向可回退（v2026.907.0 加固）**：`openclaw-config-migration.ts` 的
  2026.8 挪位类规则（planTool、memorySearch）是双向的——内核回退到 <2026.8 时按反向
  规则搬回旧位置；`kernel-updater.ts` 在换装成功、自动回滚、best-effort 回滚三处都会
  重跑迁移，保证回退后配置仍被旧内核接受。内核备份同时附存 `openclaw.json` 快照
  （`scripts/lib/kernel-config-snapshot.js`，回退时**不自动恢复**，避免覆盖回退前新写的
  配置，提示用户手动核对）。

## Share Copy (`share-copy.ts`)

Remote marketing content distribution for the "Share CryoClaw" feature in Settings:

- Fetches from CDN (`oneclaw.cn/config/share-copy-content.json`) with 5-minute cache
- Falls back to bundled `settings/share-copy-content.json`, then hardcoded defaults
- Bilingual (zh/en) with automatic field normalization

## Kimi Search (`kimi-config.ts`)

Kimi Search plugin configuration management:

- **kimi-search**: Dedicated API key stored in sidecar file (`~/.openclaw/credentials/kimi-search-api-key`); auto-reuses kimi-code provider API key if no dedicated key configured
- (The bundled `kimi-claw` IM bridge plugin was removed in R7.)

## Skill Store (`skill-store.ts`)

Skill marketplace integration via clawhub CLI:

- Registry URL from `build-config.json` or `cryoclaw.config.json`, fallback to `https://clawhub.ai`
- Install/uninstall via `clawhub install/uninstall` subprocess (not self-implemented ZIP extraction)
- Skill directory: `~/.openclaw/workspace/skills/`
- Store config in standalone `~/.openclaw/skill-store.json` (not in gateway config)
- API field mapping: `items→skills`, `displayName→name`, `summary→description`, `tags.latest→version`, `stats.downloads→downloads`

## Build Config (`build-config.ts`)

Build-time injected configuration reader (renamed from `analytics-config`):

- Reads `build-config.json` from packaged resources (multiple candidate paths)
- Cached after first read
- Provides PostHog API key, clawhub registry URL, and other build-time constants

## Install Detector (`install-detector.ts`)

Setup Step 0 conflict detection:

- Port occupation check (default 18789)
- Global `openclaw`/`openclaw-cn` npm install detection
- CryoClaw's own CLI wrapper excluded via marker string detection
- Provides `resolveConflict()` for uninstall or port reassignment

## Gateway ASAR Packaging (`package-resources.js` + `constants.ts`)

Optional single-file archive for the gateway directory, dramatically reducing Windows install time (5000+ files → 1 file).

**Build-time** (`CRYOCLAW_GATEWAY_ASAR=1`):

1. `package-resources.js` patches openclaw's `openBoundaryFileSync()` to skip `.asar` path validation
2. Creates `gateway.asar` via `@electron/asar`, unpacking `*.node` files and `extensions/` directory
3. Result: `gateway.asar` (~230MB) + `gateway.asar.unpacked/` (native modules + extensions)

**Runtime path resolution** (`constants.ts`):

- `resolveGatewayRoot()` — auto-detects `gateway.asar` vs `gateway/` directory
- `resolveGatewayCwd()` — ASAR mode returns `~/.openclaw/` (OS can't chdir into ASAR); non-ASAR returns package dir
- `resolveGatewayPackageDir()` — always points inside gateway root (ASAR patch transparent for main process reads)
- `resolveCliRuntime()` — ASAR mode uses Electron binary + `ELECTRON_RUN_AS_NODE`; non-ASAR uses real Node.js

**CLI wrapper ASAR support** (`cli-integration.ts`):

- `WrapperOptions.asarEntry` flag skips shell-level file existence check (shell can't see inside `.asar`)
- `WrapperOptions.env` injects `ELECTRON_RUN_AS_NODE=1` and `OPENCLAW_INSTALL_ROOT` for ASAR mode

## Multi-Model Management (chat-ui, R4)

Model management runs on the kernel-native config RPC (`config.get` / `config.patch` via
`chat-ui/ui/src/ui/controllers/config.ts`): the Provider tab renders provider groups from the
redacted config snapshot, and all mutations (add/delete/set-default/alias/reorder/fallbacks)
are written as merge patches with `baseHash` optimistic locking and `replacePaths` for array
removal/reorder. The legacy IPC handlers (`settings:get-configured-models`, `settings:delete-model`,
`settings:set-default-model`, `settings:update-model-alias`, `settings:save-provider`,
`settings:get-config`) have been retired; `settings:verify-key` (real HTTP probe) and the new
`settings:write-kimi-api-key` (Kimi Code sidecar key + auth-proxy token) remain.

Chat UI includes a per-session model selector for switching models without changing settings.

## CLI Integration (`cli-integration.ts`)

Cross-platform `openclaw` command-line wrapper management:

- **POSIX**: Wrapper script at `~/.openclaw/bin/openclaw` + PATH injection into `.zprofile`/`.bash_profile` via `# >>> cryoclaw-cli >>>` markers
- **Windows**: Wrapper `.cmd` at `%LOCALAPPDATA%\CryoClaw\bin\` + PowerShell user PATH modification; legacy `~/.openclaw/bin/` path auto-migrated
- **ASAR mode**: Wrapper uses Electron binary + `ELECTRON_RUN_AS_NODE=1` + `OPENCLAW_INSTALL_ROOT` env var; skips shell-level entry file check (`.asar` paths invisible to OS)
- **Non-ASAR mode**: Wrapper uses real bundled Node.js binary (SUBSYSTEM:CONSOLE for TTY support)
- Idempotent install/uninstall with marker-based detection
- Auto-install during Setup completion (optional, enabled by default); manual toggle in Settings > Advanced
- CLI preference persisted in `cryoclaw.config.json` (migrated from legacy `cli-preferences.json` sidecar)

## Launch at Login (`launch-at-login.ts`)

System startup integration via `app.getLoginItemSettings()` / `setLoginItemSettings()`:

- Supported on macOS and Windows only (Linux unsupported)
- Pure functions for testability
- Configurable in Setup wizard step 3 and Settings > Advanced

## macOS Dock Visibility (`main.ts`)

Dynamic Dock icon toggle: visible when any window is shown, hidden when all windows are closed (pure tray mode). Driven by `browser-window-created` + `show`/`hide`/`closed` events.

## Tray i18n (`tray.ts`)

Tray context menu labels are localized (Chinese/English) based on `app.getLocale()`. Menu includes: Open Dashboard, Gateway status, Restart Gateway, Settings, Quit.

## App Auto-Updater (`app-updater.ts` + `update-snooze.ts`)

> 阶段 4 曾整体删除，R20 以 GitHub Releases 方案重新引入；本节描述现行行为。

App 级更新客户端（electron-updater，provider = GitHub Releases）：

- 仅 packaged 环境启用；启动后 ~15s 检查一次（无周期复查），失败只记日志不打扰用户
- **v2026.906.0 起弹窗决策模式**：`autoDownload=false`，发现新版本弹出更新弹窗
  （chat-ui `views/update-available-dialog.ts`，更新日志 + 更新/暂缓）；点「更新」才下载，
  下载进度与「重启安装」在同一弹窗完成；设置-关于页有手动下载按钮与暂缓状态/恢复入口
- **暂缓机制**（`update-snooze.ts`）：7 天/1 月/3 月/永久/自定义（1–3650 天），持久化在
  `userData/app-update-snooze.json`；期内跳过启动自动检查，手动检查不受影响
- **非静默换装**：quitAndInstall 拉起带进度条的 NSIS 安装器窗口（去 `/S`，
  `autoInstallOnAppQuit=false`）；换装 spawn 为自实现（gotchas #67），
  `autoUpdater.quitAndInstall()` 仅作 pending 安装器缺失时的回退
- 状态机纯逻辑在 `app-updater-state.ts`；IPC 通道 `app-update:*` 见 docs/ipc-api.md

Historical CDN-based update flow via `electron-updater`（阶段 4 前的旧方案，仅作参考）:

- macOS requires ZIP artifact (DMG is for manual distribution)
- Auto-check every 4 hours (30s startup delay)
- Download progress shown in tray tooltip
- Pre-quit callback ensures window close policy doesn't block `quitAndInstall()`

## 内核升级器与策展渠道（`kernel-updater.ts` + `scripts/updater/kernel-update.mjs`）

内核（openclaw runtime）升级独立于 App 更新，走自研差分 asar 换装链路（staging install →
carryOverInjected → 补丁命中校验 → 冒烟 → 重打 → 备份 → rename，失败自动回滚）。

- **策展稳定版渠道（v2026.905.0 起）**：更新目标不再取 npm `latest` dist-tag（会指向发行
  证据链未完成的版本，见 gotchas #76），改为仓库根 `kernel-channel.json` 策展清单——
  运行时远程双源拉取（raw.githubusercontent.com → fastly.jsdelivr.net 镜像，各 8s 超时），
  双源失败回退到**构建期注入的内置兜底版本**（package-resources.js 复制脚本时替换
  `__CRYOCLAW_FALLBACK_STABLE__` 占位符为 `package.json` 的 `cryoclaw.openclaw` 钉版本），
  绝不回落 npm latest。`updateAvailable` 用三段数字比较：current 更高（手动 `--tag` 装过
  新版）时不提示「更新」（那是降级）；无 tag 且 current 不落后 stable 时早退。
- **minSupported 兜底自动升级（v2026.907.0）**：内核低于 `kernel-channel.json` 的
  `minSupported`（判定门槛硬编码在 `kernel-updater.ts` 的 `MIN_SUPPORTED_KERNEL_VERSION`，
  推进 minSupported 需同步两处）时，`main.ts scheduleAutoKernelUpgradeIfNeeded()` 在启动
  后延迟 25s 自动升级到策展 stable：仅 packaged 生效、模块级布尔防重复调度、.openclaw
  导入进行中取消、失败只记日志不弹窗。进度经 `kernel:update-progress`（载荷带
  `source: "auto" | "manual"`）推到渲染层全局横幅（chat-ui
  `views/kernel-auto-upgrade-banner.ts`）。
- 配置随版本双向迁移（见「Config Backup & Recovery」）；编排整体看门狗 15 分钟。

## Incremental Resource Packaging (`package-resources.js`)

A stamp file (`resources/targets/<target>/.node-stamp`) records `version-platform-arch`. If stamp matches, skip download. Cross-platform builds (e.g., building win32-x64 on darwin-arm64) auto-detect the mismatch and re-download.

openclaw is installed directly from npm (no local upstream directory needed). Node.js download mirrors: npmmirror.com (China) first, nodejs.org fallback.

## afterPack Hook (`afterPack.js`)

electron-builder strips `node_modules` during packaging. The afterPack hook injects the pre-built gateway resources from `resources/targets/<target>/` into the final app bundle **after** stripping, bypassing the strip logic entirely.

Target ID resolution: env `CRYOCLAW_TARGET` > `${electronPlatformName}-${arch}`.

ASAR mode: copies `gateway.asar` + `gateway.asar.unpacked/` instead of `gateway/` directory.
Non-ASAR mode: copies `gateway/` directory as before.

Windows Helper: creates a hard link `CryoClaw Helper.exe` → `CryoClaw.exe` for use as `ELECTRON_RUN_AS_NODE` process (avoids taskbar icon flash).

## Windows Installer (`installer.nsh`)

Custom NSIS assisted installer with:

- **Desktop shortcut on update**: Detects `CRYOCLAW_IS_UPDATE` env to force desktop shortcut creation during silent updates
- **Custom uninstall page**: Offers CLI cleanup (wrapper + PATH removal) and user data removal (`~/.openclaw/`) as opt-in checkboxes
- **CLI cleanup**: Runs PowerShell to remove `%LOCALAPPDATA%\CryoClaw\bin` from user PATH and delete wrapper files

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                   Electron Main Process                       │
│                                                              │
│  main.ts ─── gateway-process.ts ─── constants.ts             │
│     │              │                     │                   │
│     │         spawn child ──────── path resolution           │
│     │              │                                         │
│     ├── window.ts (BrowserWindow + token inject)             │
│     │     └── window-close-policy.ts (hide vs destroy)       │
│     ├── tray.ts   (system tray + i18n menu)                  │
│     ├── provider-config.ts (presets + verify + config)       │
│     ├── config-backup.ts (rolling backups + recovery)        │
│     ├── setup-manager.ts + setup-ipc.ts (wizard + CLI)       │
│     │     ├── setup-completion.ts (completion detection)     │
│     │     └── install-detector.ts (conflict detection)       │
│     ├── settings-ipc.ts + settings/ (embedded settings)      │
│     ├── kimi-oauth.ts (device code login + token refresh)    │
│     ├── share-copy.ts (CDN content + fallback)               │
│     ├── kimi-config.ts (Kimi plugin + Kimi Search)           │
│     ├── skill-store.ts (clawhub marketplace integration)     │
│     ├── cli-integration.ts (CLI wrapper + PATH injection)    │
│     ├── launch-at-login.ts (system startup toggle)           │
│     ├── channel-pairing-store.ts (allowFrom sidecar)         │
│     │     ├── wecom-config.ts (WeCom channel)                │
│     │     ├── dingtalk-config.ts (DingTalk channel)          │
│     │     └── qqbot-config.ts (QQ Bot channel)               │
│     ├── build-config.ts (build-time injected config)         │
│     ├── analytics.ts + analytics-events.ts (telemetry)       │
│     ├── app-updater.ts (GitHub Releases 更新)                │
│     ├── update-snooze.ts (更新暂缓持久化)                    │
│     ├── kernel-updater.ts (内核换装 + 兜底升级)              │
│     ├── gateway-auth.ts (token management)                   │
│     └── logger.ts (file + console)                           │
│                                                              │
│  preload.ts ─── contextBridge (~77 IPC + 5 listeners)        │
└──────────────────┬───────────────────────────────────────────┘
                   │
     ┌─────────────┴─────────────┐
     │   Gateway Child Process   │
     │   Node.js 22 + openclaw   │
     │   :configurable loopback  │
     └─────────────┬─────────────┘
                   │ HTTP + WebSocket
     ┌─────────────┴─────────────┐
     │      BrowserWindow        │
     │  loads Lit Chat UI from   │
     │  file:// (chat-ui/dist/)  │
     └───────────────────────────┘
```

## Chat UI 视图层（`chat-ui/ui/src/ui/`）

图形 UI 是自研 **Lit 3 + Vite** 应用，经 gateway WebSocket RPC（`gateway.ts` 的
`GatewayBrowserClient`）与内核通信，不经过 preload IPC（IPC 只用于主进程能力，
如剪贴板/文件系统/外部打开）。

分层约定：

- `views/`：纯渲染函数（`renderXxx(props)` 返回 `html` 模板），无业务副作用。
- `controllers/`：封装 gateway RPC 的状态读写（`loadXxx` / `patchXxx`），组件无状态；
  **RPC 只允许出现在 controllers**（阶段 16 起，视图内联 RPC 已全部归位）。
- `views/registry.ts`：视图 id 唯一事实来源（`CRYOCLAW_VIEW_IDS` / `CRYOCLAW_VIEW_META` /
  `INJECTABLE_VIEWS`）。**新增视图只接线 3 处**：registry 两条目 → `app-render.ts`
  `renderActiveView()` switch 分支（storage.ts 类型自动生效）。
- `app-render.ts`：壳层渲染入口（~380 行）：侧边栏 / 标题栏 / 内容区分发 / 全局弹窗。
  各视图实现已拆分为 `app-chat-props.ts`（对话 props 装配）、`app-skills.ts`、
  `app-cron.ts`、`app-tasks.ts`、`app-feedback.ts`、`app-session-actions.ts`（会话操作）、
  `app-view-switch.ts`（`setCryoClawView()` + enter/leave 钩子表）、`app-toast.ts`。
- `app-gateway.ts`：gateway 事件分发（chat / agent / cron / task /
  sessions.changed / exec/plugin.approval 等）。
- `sidebar.ts` + `sidebar-grouping.ts`：Codex 风侧边栏（新对话 + 主导航：任务/定时/
  技能/工作区；会话列表搜索常驻 + 置顶 + 时间分组（纯函数 `groupSidebarSessions`）+
  ⋯菜单 + 归档视图；footer：设置/文档/连接态）。
- `i18n/`：`i18n.ts` 薄 re-export → `i18n/index.ts`（API）+ `zh.ts`/`en.ts`（字典，
  各 700+ 键）；新增键必须双区同步（i18n.test.ts 审计兜底）。
- `styles/`：样式模块化（hub `styles.css` @import 14+ 个分文件，顺序=原层叠顺序）；
  设计令牌单一事实来源是 `shared/design-tokens.css`。

阶段 16 消息级元数据：助手消息 footer 展示实际生成模型 + usage
（`chat/message-meta.ts`，内核消息级 `model`/`usage` 字段，取证见
`.cache/stage16-usage-model-forensics.md`）；工具调用折叠行摘要逻辑抽为
`chat/tool-summary.ts` 纯函数。

## 测试体系（`npm test`，三层）

1. **vitest**（`src/*.test.ts` 7 文件，106 用例）：依赖 `vi.mock`/`vi.stubEnv` 的主进程
   逻辑（内核升级链、配置迁移、启动所有权、IPC sender guard 等）。
2. **node:test**（src 编译到 `.test-dist/`，71 pass + 4 平台门控 skip）：不依赖 vitest
   的 src 测试，由 `scripts/run-node-tests.js` 运行（`test:compile` 先 tsc 编译）。
3. **chat-ui**（`chat-ui/ui/src/**/*.test.ts`，132 用例）：node:test 风格，
   `chat-ui/tsconfig.test.json` 编译到 `chat-ui/ui/.test-dist/`（产物标 `type:module`），
   由 `scripts/run-chat-ui-tests.js` 运行。**新增 chat-ui 控制器/纯函数请同步补该层测试**。
4. **scripts**（`scripts/*.test.js` 40 用例）：打包/升级脚本纯逻辑。

基线：**349 pass / 0 fail / 4 skipped**（2026-08-03，阶段 16）。
