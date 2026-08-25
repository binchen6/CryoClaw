# CryoClaw 优化工程 — 进度追踪（断点续作锚点）

> 新接手的模型/工程师：**先读「快速上手」+「关键路径地图」+「下一步计划」**，
> 再按需查「CryoClaw 重设计工程记录」（最新锚点）与「历史档案」（已验证事实，避免重复调查）。
> 创建：2026-07-29；最近重写：2026-08-11（压缩版，替代原 1641 行长文）；最近更新：2026-08-24（R24 全面审查批次）。

## 🚀 快速上手（必读）

**项目一句话**：**CryoClaw**（原 OneClaw，已完成更名）——基于 openclaw 内核的高效、易用、纯净 harness。
形态：Electron 桌面壳 + 自研 **Lit + Vite** chat-ui，经 gateway WebSocket RPC 与内核通信（file:// 加载）；
面向国内生态（Kimi / Moonshot / 飞书 / 企微 / 微信 / 钉钉 / QQ）。

**当前状态**：
- 更名 CryoClaw 完成；CryoClaw 重设计工程 **R1–R25 全部完成**（见下节），最新发版 **v2026.825.0**（R25 主进程大文件补审；v2026.824.3：R24 全面审查批次）。
- 内核 openclaw **2026.7.1-2**（版本 pin 在 package.json `cryoclaw.openclaw`）；**Electron 43.4.0**（R13 升级落地，audit 0 漏洞）。
- 测试基线 **499 pass / 0 fail / 4 skipped**（vitest 94 + node 74 + chat-ui 279 + scripts 52 + tsc typecheck；0 fail 为硬指标）。R24 新增 2 用例（会话切换竞态守卫 + patchSession 返回值契约，并入 chat-ui 279 内）；历史演进见测试体系节。
- 历史优化阶段 1–22 全部完成并逐版发版至 v2026.811.0（见历史档案）。
- 已开源发布至 GitHub（binchen6/CryoClaw，AGPL-3.0-only）；发布时以全新干净历史快照推送，旧本地历史（含已作废的 kimi-claw REFRESH 凭证）不出仓；`.env.build` 已转 gitignored，模板见 `.env.build.example`；git 身份统一为 binchen6。CI：`tests.yml` 每次 push/PR 全量回归（chat-ui/ui 独立依赖树需先安装）；上游签名/CDN 发版链 `build-release.yml`/`publish-release.yml` 已删除（依赖上游 oneclaw 签名证书与 oneclaw.cn CDN，本 fork 不适用，发版走本地 dist:win + gh release）。

**常用命令**：
- 构建：`npm run build`（vite chat-ui + tsc 主进程）
- 测试：`npm test`（vitest + node:test 编译前清空 .test-dist + chat-ui typecheck&测试 + scripts）
- 重复率度量：`npm run dupcheck`（jscpd，阈值 5%，配置 `.jscpd.json`，报告输出 `.jscpd-report/`，R22 新增）
- 一键打包（Win x64）：`npm run dist:win`（scripts/dist-win.js，串联 build → package:resources → electron-builder，注入 .env + npmmirror + `--use-system-ca`）
- 手动打包：`NODE_OPTIONS="--use-system-ca" CRYOCLAW_TARGET=win32-x64 npm run package:resources -- --platform win32 --arch x64` → `CRYOCLAW_TARGET=win32-x64 npx electron-builder --win --x64 --config.directories.output=out/win32-x64 --publish never`
- 安装：`out/win32-x64/CryoClaw-Setup-<v>-x64.exe /S`（**先清 CryoClaw-Setup* / CryoClaw.exe 残留进程**，见 gotchas #53；安装目录 `%LOCALAPPDATA%\Programs\CryoClaw`）
- 版本号：手工改 `package.json` version + `release-notes.json` 条目（日历版本 YYYY.MMDD.N，非 git tag 驱动）

**关键约束**：
- 只改 CryoClaw 自己的代码；内核 openclaw（gateway.asar 内 dist）**零改动**，仅可只读取证 RPC 契约。
- 不 git commit（除非用户明确要求）。
- 新 IPC 敏感通道必须加 `assertTrustedIpcSender`（src/ipc-sender-guard.ts）。
- **UI 规范（R2/R3 后新规范，取代旧「主题红」条目）**：TraeWork 规范 + 冰蓝 token
  （`shared/design-tokens.css`，brand-500 `#0EA5E9`）；样式一律走 design token / primitives 组件类，
  **禁止硬编码 hex**；iOS Switch；按钮右对齐（弹窗按钮右对齐）；不 text-transform:uppercase；
  浅色为默认主题，暗色走 `[data-theme=dark]`。
- 布局约定：顶部沉浸式 titlebar 高 44px，**顶部浮层 top ≥ 56px 避让**（计划面板/toast/错误条均已遵守）；
  极窄窗（≤768px）有 media query 适配（含 cron master-detail 纵向堆叠）；grid 容器防溢出用 `minmax(0,1fr)` + 子项 `min-width:0`。

**文档导航**：

| 文档 | 用途 |
|---|---|
| `CLAUDE.md` / `AGENTS.md` | 项目硬规范（版本号、分支、UI 条目——UI 部分已随 R3E 更新） |
| `docs/architecture.md` | 架构分层说明 |
| `docs/ipc-api.md` | 主进程 IPC 通道清单 |
| `docs/gotchas.md` | 60+ 条已验证坑（改代码前搜一遍） |
| `docs/provider-module-redesign.md` | provider 模块重设计背景（与 R4 相关） |
| `docs/PROMPT.md` / `docs/client-ticker.md` | 历史需求/设计稿存档 |

## 关键路径地图（改动前必读）

| 区域 | 路径 | 说明 |
|---|---|---|
| 主进程 | `src/main.ts` / `gateway-process.ts` / `preload.ts` / `ipc-sender-guard.ts` | Electron 壳；IPC 白名单；敏感通道必须过 sender guard |
| 应用配置 | `src/cryoclaw-config.ts`（R1 由 oneclaw-config.ts 更名） | 配置文件 `cryoclaw.config.json`，读取 fallback 旧名；含 gatewayControl token |
| 内核配置迁移 | `src/openclaw-config-migration.ts` | 规则列表形式，启动时 + 内核升级后双调用点；现有规则：删 `agents.defaults.llm`、deepseek 旧名迁移、`approve-all→full`、planTool 显式开启（显式 false 尊重不动） |
| CLI 集成 | `src/cli-integration.ts` | 生成 `%LOCALAPPDATA%\CryoClaw\bin\openclaw.cmd` wrapper（拦截 update / gateway 子命令）；`reconcileCliOnAppLaunch()` 自愈 |
| provider 配置 | `src/provider-config.ts`（verify-key 探测）/ ~~`src/provider-key-mask.ts`~~（R4 已退役）/ `src/settings-ipc.ts` | 模型配置读写已切内核 `config.get`/`config.patch`（chat-ui `controllers/config.ts`）；主进程仅保留 verify-key 真实 HTTP 探测 + kimi-code sidecar |
| 内核打包 | `scripts/package-resources.js` | 下载 openclaw（npm/npmmirror，版本 pin `cryoclaw.openclaw`）→ 6 个 asar 边界补丁（幂等）→ gateway.asar；skills/extension 白名单裁剪 |
| 内核升级器 | `scripts/updater/kernel-update.mjs` + `src/kernel-updater.ts` + `scripts/lib/kernel-dist-patch.js` / `kernel-prune.js` | 差分 asar 换装/回滚；注入物文件名 `cryoclaw-*`，**双名识别旧 oneclaw-***；npm install → prune → 搬运 → 补丁 → 冒烟 → 重打 |
| gateway CLI 托管 | `src/gateway-control-server.ts` + `scripts/updater/gateway-ctl.mjs`（R1.5 新增） | 127.0.0.1:17893+ 递增端口；GET /gateway/status + POST /gateway/restart；CLI wrapper 拦截 `openclaw gateway *` |
| 沙盒守卫 | `src/docker-check.ts` | 启用沙盒前探测 docker 命令 + daemon（8s 超时、60s 缓存）；不可用则拒绝写入（DOCKER_UNAVAILABLE） |
| chat-ui 视图 | `chat-ui/ui/src/ui/views/` + `controllers/` | views 纯渲染函数，controllers 封装 gateway RPC |
| 视图接线 | `chat-ui/ui/src/ui/app-render.ts` + `views/registry.ts` | 视图 id 唯一事实来源在 registry；**新视图接线点 3 处**（gotchas #49） |
| 样式 hub | `chat-ui/ui/src/styles.css` | **只做 @import，层叠顺序敏感**：design-tokens → tokens-ext → base → **primitives** → chat/components/panels/sidebar/skills/compose/workspace/cron/misc/panel/plan →（末尾）settings → setup |
| 设计 token | `shared/design-tokens.css` + `styles/tokens-ext.css` | TraeWork 体系 + 冰蓝；兼容别名 --accent/--bg 等 |
| 契约组件 | `styles/primitives.css`（R3A 新建） | cc-btn/cc-input/cc-card/cc-dialog/cc-tag/cc-menu/cc-alert/cc-skeleton/cc-table/cc-tabs/cc-chip |
| 设置/Setup 样式 | `styles/settings.css`（1224 行）/ `styles/setup.css`（448 行） | R3B 从 9 个视图抽取的内嵌 CSS；hub **末尾** import |
| 进度/坑 | `docs/OPTIMIZATION-PROGRESS.md` + `docs/gotchas.md` | 本文件 + 60+ 条已验证坑（gotchas 为准） |
| UI 设计规范 | `docs/design-guidelines-zh/en.md` | TraeWork + 冰蓝 token 规范（R3E 已重写，与代码现状对齐） |

## ⚙️ 运行机制既有事实（勿重复调查）

- **CLI 链路**：`openclaw` → `bin\openclaw.cmd` → `CryoClaw-CLI.exe`（CONSOLE 子系统）+
  `ELECTRON_RUN_AS_NODE=1` → `gateway.asar\node_modules\openclaw\openclaw.mjs`。
  换装 asar 不影响 CLI 路径；本机 PATH 上 npm 全局 openclaw 可能遮蔽 wrapper（见 watch list）。
- **安装产物 `runtime/` 无 node.exe**（afterPack 删除，npm.cmd/npx.cmd 已重写为 Electron 代理）：
  运行时脚本一律以 `CryoClaw-CLI.exe` + `ELECTRON_RUN_AS_NODE=1` 执行；`runtime/.npmrc` 指向 npmmirror。
- **内核版本唯一事实来源**：`gateway.asar\node_modules\openclaw\package.json` 的 version，
  About 页（`settings:get-about-info`）即读此处，换装后自动反映。
- **打包期对内核 dist 的全部改写**（运行时升级须复现相关子集）：windowsHide 注入、asar 边界补丁 6 类、
  builtin skills 注入、插件注入 + dingtalk shim、7 个 `@openclaw/*` vendor、esbuild 重 bundle、koffi/node_modules 裁剪。
- **应用不自动更新**：自身「检查更新」功能已整体删除（阶段 4）；只有内核升级器（阶段 1）。
  内核升级两个入口：设置-关于页「内核升级」卡片（IPC `kernel:check/update/rollback`，JSONL 进度转发
  `kernel:update-progress`）、CLI `openclaw update [--tag v] [--rollback]`（wrapper 拦截路由到 updater 脚本）。
- **打包 env**：`CRYOCLAW_TARGET=win32-x64`；镜像 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`
  指向 npmmirror；`NODE_OPTIONS="--use-system-ca"`（`npm run dist:win` 已自动注入）。
- **本机用户配置**：`~/.openclaw/openclaw.json`；`cryoclaw.config.json` 有 `"updateChannel": "off"`。

## ✅ 测试体系（勿重复搭建）

- 基线 **499 pass / 0 fail / 4 skipped**（vitest 94 + node 74 + chat-ui 279 + scripts 52；0 fail 为硬指标）；历史演进：142 → 185 → 194 → 288 → 320 → 334 → 391 → 400 → 418 → 425 → 449 → 429
  （R7 移除 kimi-claw 插件同步删除其 20 个测试所致，非回归）→ 439（R4 W2a）
  → 427（R4 W2b 删 3 个旧 config 测试文件 node -13；chat-ui 224 含 tab-channels.lib
  31 用例与 R5 性能用例 chat-memo / markdown 防污染 / usage-refresh / sessions in-flight）
  → 430（R6 scripts +3：pruneNonTargetNativePlatformPackages / prunePluginNodeModules /
  kernel-prune 嵌套平台包）→ 431（R9 model-org.lib +7 组）→ 487（R13/R20 逐步累积）→ 498（R23 文件卡片 +4、子代理状态卡 +7）→ 499（R23 审查修复 +1）。
- 基础设施：`tsconfig.test.json`（outDir `.test-dist/`、rewriteRelativeImportExtensions）、
  `vitest.config.ts`（vitest 文件 include 列表）、`scripts/run-node-tests.js`（跑 `.test-dist/*.test.js`，
  编译前清空 .test-dist，排除 vitest 文件）、npm scripts `test` / `test:unit(:vitest|:node)` /
  `test:scripts` / `test:typecheck`。
- **chat-ui 用真 typecheck**（阶段 13 起接入测试链；旧 `--noCheck` 假检查已废，曾掩盖 303 个类型错误）。
- `i18n.test.ts` 源码审计：zh/en 键集合一致、无重复键、分区语言正确（防阶段 11/12 两次锚点事故回归）。
- 新增 vitest 文件需三处同步：`vitest.config.ts` include、`run-node-tests.js` 排除名单。

## 🔬 内核 RPC 契约要点（2026.7.1-2 取证结论，只读）

- **RPC 全集 237 个方法**（core-descriptors 注册表，唯一事实来源）；取证方式：解压 gateway.asar
  读官方 dist chunk（历史研究脚本在 `.cache/`）。
- **sessions.patch**：label/category/archived/pinned/unread/thinkingLevel/verboseLevel/
  reasoningLevel/responseUsage/model/fastMode 等。**sessions.list**：limit/offset/activeMinutes/
  includeDerivedTitles（每会话读 8KB 头部推导标题）/label/search/`archived`（true=**只列已归档**，非包含）。
- **思考强度优先级链**：chat.send {thinking}（单条）→ 消息内 /think 指令 → sessions.patch
  {thinkingLevel}（会话级持久化）→ provider 默认 → 配置默认；基础五档 off/minimal/low/medium/high，
  xhigh/adaptive/max 按模型支持；**会话行自带 thinkingLevels/thinkingDefault/effectiveThinkingLevel**。
  provider 硬编码兜底（`chat/thinking-levels.ts`）：kimi-coding = off/low/high/max（默认 high）、
  deepseek = off/low/medium/high/max、zai 系 = off/on 二值。
- **流式协议双通道**：chat 事件（delta/final/aborted/error）+ agent 事件（stream:
  assistant/thinking/tool/item/compaction/lifecycle；lifecycle 含 phase=fallback/fallback_cleared）。
- **消息级 usage/model**：chat.history 投影保留 assistant 的 usage/cost/model，可直接渲染；
  responseUsage 是文本脚注开关（默认 off），结构化展示无需打开。
- **tasks**：tasks.list/get/cancel；task 事件 `{action: upserted|deleted|restored}`，未知 action 全量重拉兜底。
- **审批**：exec.approval（allowedDecisions 含 allow-always）与 plugin.approval（skill_workshop，
  allowedDecisions 只有 allow-once/deny，timeoutMs 70s）两条链，决议按 `` `${kind}.approval.resolve` `` 分发。
- **exec 模式**：`tools.exec.mode` 只接受 `deny|allowlist|ask|auto|full`；沙箱
  `agents.defaults.sandbox.mode`（off/non-main/all）+ workspaceAccess + exec.host。
- **图片 block**：`{type:"image", url:"/api/chat/media/outgoing/<sessionKey>/<id>/full"}`，
  gateway HTTP 端点**强制 `Authorization: Bearer <token>` header**，`<img src>` 直连不可行。
- **update_plan**：开关 `tools.experimental.planTool`；参数 `{explanation?, plan:[{step,status}]}`。
- **cron payload**：支持 `agentTurn.model` / `fallbacks` / `thinking` / `timeoutSeconds`（每任务模型选择已落地）。
- **sessions rewind/fork**：`sessions.compaction.list/restore/branch`（checkpointId/createdAt/reason/
  tokensBefore→After/summary；restore 对 control-ui client id 豁免）。
- **杂项契约**：`skills.status`（UI 过滤 disabled/ineligible）；`commands.list {includeArgs:true}`；
  `models.list {view:"all"}`（5min 缓存惯例）；`config.schema.lookup` 可查 schema，uiHints.advanced 区分
  common/advanced 字段；tool result 事件 `data.isError` 标记失败。
- **内核无**：记忆浏览/清空 RPC（只有 doctor.memory.* 诊断）、审批历史查询 RPC（list 只返回 pending）、
  真 steer 插入运行中回合（WS dispatch 是 followup 语义）、feedback RPC（已删模块本就全自研）。

## 🧊 CryoClaw 重设计工程记录

### R1 · 更名 CryoClaw（完成）
- productName / appId（`com.cryoclaw.app`）/ 二进制 / 安装目录（`%LOCALAPPDATA%\CryoClaw`）全量更名。
- CLI marker 改为「CryoClaw CLI」，**双 marker 识别旧 OneClaw CLI**；rc 块 `cryoclaw-cli`（双标记）。
- `oneclaw-config.ts` → `cryoclaw-config.ts`；配置文件 `cryoclaw.config.json`（读 fallback 旧名）；
  桥 `window.cryoclaw`；环境变量 `CRYOCLAW_*`；CSS 类 `.cryoclaw-*`；i18n key `settings.about.cryoclaw`。
- 内核注入物文件名 `cryoclaw-*`，kernel-update.mjs **双名识别**（新旧都能搬运）。
- 新图标：冰蓝系，`scripts/generate-icons.js` 生成（SDF 光栅化，六边形冰晶+三爪痕）。
- **刻意保留不改**：openclaw 内核一切、oneclaw.cn、utm_source=oneclaw、X-Msh-Platform:oneclaw、TOS_BUCKET、`~/.openclaw`。

### R1.5 · gateway CLI 托管适配（完成）
- 新增 `src/gateway-control-server.ts`：127.0.0.1:17893 起递增端口，token 存 cryoclaw.config.json
  `gatewayControl`；GET /gateway/status + POST /gateway/restart（走托管停启）。
- 新增 `scripts/updater/gateway-ctl.mjs`；CLI wrapper 拦截 `openclaw gateway *`：restart/status 转发，
  其余子命令退出码 2 提示托管，控制面不可达退出码 1。
- 修复 agent 执行 `openclaw gateway restart` 报错的问题。

### R2 · 设计 token（完成）
- `shared/design-tokens.css` 重写为 TraeWork 体系 + 冰蓝配色：brand-500 `#0EA5E9`、冷灰 grey-50..950、
  radius/spacer/字号阶梯；**兼容别名 --accent/--bg 等不变**。
- **浅色为默认主题**（storage.ts / theme.ts / app.ts / tab-appearance.ts 默认值改 light）；
  暗色 `[data-theme=dark]` 深冷灰蓝 `#0b1117` 系；tokens-ext.css 对齐。
- 旧主题红 fallback 78 处清理；setup/webbridge-enable-guide.html 同步。

### R3A · primitives 组件层（完成）
- 新建 `styles/primitives.css`（396 行）：TraeWork 契约组件 cc-btn/cc-input/cc-card/cc-dialog/cc-tag/
  cc-menu/cc-alert/cc-skeleton/cc-table/cc-tabs/cc-chip；hub 插入在 base.css 之后。
- redesign.css（594 行）按层叠胜负关系拆分合并进 chat/compose/panels/misc/sidebar.css 后**已删除**。

### R3B · 消灭 adoptedStyleSheets 双轨制（完成）
- 9 个视图（settings-view / tab-channels* / tab-backup / tab-provider / tab-session-usage /
  tab-approvals / setup-view）内嵌 CSS 抽取到 `styles/settings.css`（1224 行）+ `styles/setup.css`（448 行），hub 末尾 import。
- TS 内嵌 hex 清零；`components/` 4 个 Lit 组件局部样式保留（Shadow DOM 合理范围）。

### R3C · 对话页三件套 TraeWork 化（完成）
- chat.css / sidebar.css / compose.css / misc.css + sidebar.ts 品牌块。
- 会话项 active = `--accent-subtle` + 左 3px 指示条；用户气泡渐变胶囊圆角 `--radius-16`；
  tool card `--radius-12` + hover 微浮起；hero accent 光点；compose 容器 `--radius-16` + focus-ring。

### R3D · 设置页/Setup/面板全量 TraeWork 化（完成）
- 设置导航指示条化、卡片 cc-card 对齐、按钮 cc-btn 高 28、表单 cc-input、弹窗按钮右对齐；
  覆盖 cron / workspace / tasks / plan / skills / 弹窗 / components。
- 顺手修 4 个错色 bug：danger:hover 绑 accent 蓝 ×2、错误提示用 accent 蓝 ×2、fixed-tooltip 暗色不可读。

### R3E · 设计文档重写（完成）
- `docs/design-guidelines-zh.md` / `design-guidelines-en.md` 重写为 TraeWork token 体系 +
  冰蓝配色规范（token 分组、cc-* 原语清单、样式组织/层叠顺序、iOS Switch、按钮右对齐、
  禁硬编码 hex、mono 元信息），中英两份等价，内容对齐 design-tokens.css / primitives.css 现状。
- CLAUDE.md UI 规范条目同步：旧「主题红 #c0392b」替换为冰蓝 token + cc-* 原语指引。

### R7 · kimi-claw 插件移除 + 内置插件版本更新（完成）
- **kimi-claw（Kimi IM bridge 插件）完整移除**：package-resources.js 下载/注入/校验/白名单、
  kernel-dist-patch windowsHide 扫描、settings IPC（`settings:get/save-kimi-config`）、
  preload、chat-ui 渠道 tab（tab-channels-kimiclaw.ts + 注册/导航）、i18n key、
  `kimi-config.ts` 全部 kimi-claw 函数（saveKimiPluginConfig/ensureKimiPluginDeviceId/
  extractKimiConfig/isKimiPluginBundled 等）、main.ts deviceId 迁移、CI workflow env。
  kimi-search / dingtalk-connector 保留；`kimi-config.ts` 收缩为 kimi-search + API key sidecar。
- **插件 pin 更新**（openclaw 内核保持 2026.7.1-2 不动）：
  - kimi-search tgz 0.1.2 → **0.1.3**（CDN pin，无 peerDependencies）
  - @wecom/wecom-openclaw-plugin 2026.7.2 → **20206.7.201**（上游 latest dist-tag，版本号
    形如笔误但确为官方发布；peer openclaw >=2026.3.28 兼容）
  - officecli 1.0.47 → **1.0.143**（GitHub release 最新）
  - 其余已是最新：@openclaw/feishu/qqbot/moonshot/kimi/zai/qwen/deepseek-provider 2026.7.1、
    @dingtalk-real-ai/dingtalk-connector 0.8.24、@tencent-weixin/openclaw-weixin 2.4.6。

### R4 · 设置改造（完成）
- **W2a**：模型管理全面切内核 `config.get`/`config.patch`——chat-ui 新增 `controllers/config.ts`
  （快照缓存 + baseHash 乐观锁 + 冲突重取重放一次 + RFC7396 diff + 数组删/重排自动 replacePaths）。
  tab-provider 重写为分组 + 拖拽排序 + ≤4 步添加 + fallbacks + per-agent 指派（agents.update）；
  models.list 目录提供 input/reasoning/contextWindow 元数据（controllers/models.ts 全量条目缓存）。
  退役：`src/model-catalog.ts`（CLI spawn 目录）、`src/provider-key-mask.ts`（内核自带脱敏）、
  settings-ipc 的 6 个 provider/model handler（get-config/get-configured-models/delete-model/
  set-default-model/update-model-alias/save-provider）；新增 `settings:write-kimi-api-key`
  （kimi-code sidecar key + proxy token，config 只写 proxy-managed 占位符）。
  kimi-search + memorySearch 联动改由渲染层同一 config.patch 写入；不再整进程重启 gateway。
  **契约取证结论**：mergeObjectArraysById 保留 base 数组顺序，patch 数组顺序不生效——
  排序/删除必须 replacePaths 整体替换（内核有防丢条目护栏，缺 replacePaths 直接报错）。
- **W2b**：settings 其余 tab 全部 config.patch 化 + settings-ipc.ts 拆分 + setup step2 合并。
  - chat-ui 新增 `views/settings/tab-channels.lib.ts`（737 行纯函数：feishu/qqbot/dingtalk/wecom/
    weixin/kimi-search/memory/advanced 的 extract*/apply*，移植自主进程对应读写逻辑）+
    `views/settings/tab-patch.ts`（runConfigPatch 统一入口 + `settings.patch.*` i18n 提示）；
    tab-channels×6、tab-search、tab-memory、tab-advanced、app.ts execMode 全部改走
    `getConfigSnapshot`/`patchConfig`，**`writeUserConfigAndRestart` 全 repo 清零**。
  - 退役 15 个 settings get/save IPC（channel/wecom/qqbot/dingtalk/weixin/kimi-search/memory × get+save
    + add-feishu-group-allow-from）；新增 5 个保留 IPC（get-channel-runtime-state /
    ensure-weixin-plugin / get-kimi-search-key / write-kimi-search-key / ensure-kimi-proxy，
    均带 sender guard）；get/save-advanced 收缩为主进程职责字段（browserMode/browserProfile/
    launchAtLogin/clawHubRegistry/dockerAvailable）；verify-key 新增 wecom 分支。
  - `src/settings-ipc.ts` 拆分为 `src/settings/` 11 模块（types/tracked/verify/channels/weixin/
    pairing/webbridge/advanced/cli/backup/about），入口剩 40 行薄注册。
  - setup step2 与 tab-provider add 流程合并：前端 `saveProviderFragment` 复用
    tab-provider.lib 的 resolveAddTarget/buildModelEntry/buildProviderConfigForAdd 构造 fragment 直接
    写 openclaw.json（setup 期间 gateway 未运行，不走 config.patch）；`setup:save-config` 收缩为
    baseline 默认值 + primary model + 埋点；主进程 buildProviderConfig/saveMoonshotConfig/
    deriveCustomConfigKey 及 qqbot/dingtalk/wecom/weixin/kimi-search 的 extract/save 死函数全删
    （行为改由 tab-channels.lib 单测覆盖，删 3 个旧 config 测试文件 -13 用例，新增
    tab-channels.lib.test.ts 31 用例）。
  - **遗留**：docker 沙箱守卫只剩 UI 禁用（save-advanced 的 DOCKER_UNAVAILABLE 拒写已删）；
    dingtalk gateway token 仅缺失时渲染层兜底生成；weixin 登录后重启期间快照刷新 best-effort；
    pairing add/remove 仍走主进程直接写 config + 重启（pairing store 属主进程）。

### R5 · 执行效率（完成）
- **R5-A 流式 O(n²) → 纯文本流式**：chat delta 经 `scheduleChatStreamRefresh`（controllers/chat.ts）
  rAF 每帧只提交一次最新累计文本；streaming 期间气泡只渲染纯文本（lit 文本绑定自动转义，
  `chat-text--streaming` pre-wrap + 光标），不做 marked/DOMPurify/JSON 解析；run 终态后转入
  history 路径一次性解析渲染，最终呈现不变（`chat/grouped-render.ts` streaming 分支与 history 刻意分叉）。
- **R5-B 缓存防污染 + memo + 懒渲染**：`markdown.ts` LRU 新增 `bypassCache` 选项与 50k 字符
  读写上限（`MARKDOWN_CACHE_MAX_CHARS`），`markdownCacheSize()` 观测钩子 + 防污染回归测试；
  `views/chat.ts` `buildChatItemsMemoized` / `computeSessionFileChangesMemoized`（数组引用 +
  标量浅比较，chat-memo.test.ts 覆盖）；折叠 `<details>` 折叠态 body 不挂载、不解析 markdown，
  首次展开 `hydrateLazyDetailsBody` 一次性渲染（tool card 聚合区与 tool 消息气泡双懒渲染）。
- **R5-C 终态收敛 + 主进程 IO**：chat 终态 sessions.list 从「700ms + 1500ms 双次轮询」改为
  单次 1500ms 延迟拉取（app-gateway.ts `scheduleTerminalSessionsRefresh`，同 sessionKey timer 合并；
  usage 前进判定走 usage-refresh.ts；其余即时更新改由 sessions.changed 事件驱动；
  controllers/sessions.ts in-flight 合并保留）；`diagLog` 改 WriteStream 缓冲异步写，
  退出 `closeDiagLogStream` flush（gateway-process.ts），stdout/stderr 每行不再同步卡主进程。

### R6 · 存储裁剪 + 发版（完成，已随 v2026.811.1 发布）
- **先取证再裁剪**（@electron/asar getRawHeader 逐路径实测 gateway.asar，勿凭直觉删依赖）：
  - `@lydell/node-pty-*` 全平台包被 npm 装进**嵌套** `openclaw/node_modules/@lydell/`
    （win32-arm64 单个 11.43MB + darwin/linux 约 0.44MB）——collectTopLevelPackages 与
    assertNativeDepsMatchTarget 都只看第一层，嵌套平台包完全漏网。
  - 官方 vendor 插件 node_modules 从不裁剪 + 各插件安装缓存命中路径跳过重裁：
    feishu `@larksuiteoapi/node-sdk` types/index.d.ts 15.53MB；asar 内残留 .d.ts 约 20MB、
    .map 约 3.18MB（feishu 19.36MB/3.14MB、qqbot 0.64MB）。
  - chat-ui vite `sourcemap:true` 产物 .map 约 1.7MB——file:// 本地应用完全用不上。
- **R6-A chat-ui**：`vite.config.ts` `sourcemap:false`（dist 约 2.5MB→789KB，.map 清零）。
- **R6-B 打包期嵌套原生包**：package-resources.js 新增 `pruneNonTargetNativePlatformPackages`
  （BFS 收集树内全部嵌套 node_modules，逐层整包删除非目标平台原生包，仅保留 platform+arch
  精确匹配）；接在 installDependencies 缓存命中与全新安装两条路径的 assertNativeDepsMatchTarget
  之后（顶层守卫语义不变，不匹配仍 die）。
- **R6-C vendor/插件树补裁**：`vendorOfficialPlugin` 复制后新增 node_modules 裁剪
  （junk walk + 平台包 + prebuilds + 悬挂 binlink）；新增 `prunePluginNodeModules` 统一入口，
  installNpmPackagePluginInto / installTgzPluginDeps 的**缓存命中复用路径也全量重跑**
  （裁剪规则升级后旧构建树冗余靠这里清，幂等）。
- **R6-D 运行时升级同步**：`scripts/lib/kernel-prune.js` makeSteps 新增
  `pruneNonTargetNativePackages` 步骤（与打包期口径一致，含嵌套 node_modules），
  否则运行时内核升级后 ~11MB 平台包会重新长回 gateway.asar。
  语义变化：非目标平台原生包现在**任何目标下一律删除**（旧「win32 不动 darwin 包」仅
  darwin-universal 步骤的保守行为被取代；darwin 目标删 universal 的行为被包含，该步骤保留兜底）。
- 测试：scripts +3 用例（嵌套平台包递归清理 / prunePluginNodeModules 完整裁剪集 /
  kernel-prune 嵌套平台包），全量 430 pass / 0 fail。
- **发版 E2E（v2026.811.1，2026-08-11）**：gateway.asar **279.6→237.6MB（-42MB）**；
  取证复查 .d.ts 残留 20MB→0.01MB、.map 3.18MB→0.02MB、node-pty 仅存 win32-x64；
  chat-ui dist 2.5MB→789KB。安装包 127.2MB；app.asar 顶层白名单纯净；
  静默安装 → CDP 冒烟全绿（gateway 200、release-notes modal、设置页 16 tab、
  裸 i18n 键 0、renderer 异常 0；旧 OneClaw 会话/微信 bot 配置经迁移无缝继承）。
  冒烟脚本 `.cache/cdp-8111-smoke.js`（自启动版）/ `cdp-8111-check.js`（连接既有实例版）。

### R9 · 模型管理拖动排序 + 自定义分组（完成，已随 v2026.811.2 发布）
- **现状取证**：R4 已落地 provider 固定家族分组 + 组内模型拖拽（写内核 config，
  `tab-provider.lib.ts` reorderIds/applyIdOrder）与 fallback 链拖拽；R9 补齐的是
  **用户自定义分组**、**选择器联动**与页面易用性。
- **R9-A 自定义分组（展示层，localStorage）**：新增 `model-org.lib.ts` 纯函数库
  （parse/serialize 容错、分组 CRUD、reorderOrgGroups 复用 reorderIds、assignModelToGroup、
  pruneModelOrgAssignments、bucketModelsByOrg 分桶）+ `model-org.lib.test.ts`（7 组断言）。
  存储键 `cryoclaw.model-org.v1`：分组定义 + modelKey→groupId 指派；模型定义/顺序仍以内核
  config 为唯一事实来源，org 只影响展示（config 刷新时自动 prune 失效指派）。
- **R9-B 模型管理页重构**：分组管理区（新增/行内重命名/删除/拖拽排序 + 组内模型数徽标）；
  模型卡片新增「默认」「备用 N」徽标（fallback 链与卡片互见）+ 分组指派菜单（chip 态显示组名）；
  全页模型搜索框（名称/ID/key/provider 过滤，过滤时强制展开命中项）。
  UI bug 修复：输入类 handler 必须 `state.requestUpdate()`，否则 `?disabled` 不刷新、
  重渲染回滚已输入值（CDP 实测抓出）。
- **R9-C 选择器联动**：`components/model-options.ts` 共享渲染（optgroup 按分组序、
  未分组收尾、全未分组时退化扁平保持旧观感）；compose、cron 表单、fallback 添加、
  per-agent 映射四处下拉统一接入；默认模型在选择器带「· 默认」后缀。
- 样式全部走 design token（`--accent-subtle/--shadow-md/--radius-md` 等）；
  `.oc-provider-group` 弃 overflow:hidden 改 header 自担圆角（防裁指派菜单），
  菜单卡片 `.has-menu` 提升 z-index。
- **发版 E2E（v2026.811.2）**：officecli pin 1.0.143 GitHub 下载 ECONNRESET →
  gh-proxy.com 镜像拉取 + SHA256 校验过（缓存 `.cache/officecli/1.0.143/`）后打包成功；
  CDP 实测全绿（`.cache/cdp-8112-r9.js`）：17 卡片、默认/备用徽标、建组「工作」→ 指派 →
  localStorage 持久化、过滤 17→0→17、compose 选择器 optgroup「工作/未分组」、零 renderer 异常。
  测试基线 430→431。

### R10 · 开源后持续迭代
- **阅读体验**：chat-text markdown 标题层级样式（h1–h4 字号/间距收敛 + 首元素免顶距）；GFM 表格首次获得边框/内边距/斑马纹 + `display:block` 横向滚动防溢出。
- **markdown 引擎**：GFM 任务列表（input 白名单 + hook 强制只读复选框）；marked 解析异常兜底退化纯文本；配套 5 用例。
- **依赖安全**：根依赖 audit fix 19→1（electron 40→43 破坏性升级挂账）；chat-ui 7 项清零（dompurify 3.4.13 等）。
- **CI/遗留清理**：新增 `tests.yml` 全量回归（含 chat-ui/ui 独立依赖安装步骤）；删除上游签名/CDN 发版链 build-release/publish-release 与其 Volcano env 映射用例；actions v5。
- **发版 E2E（v2026.811.3，2026-08-11）**：gateway.asar 226.6MB；安装包 119.6MB；**静默安装** `/S` 无弹窗完成（沙箱内执行会拒绝访问，需普通权限通道）→ 启动 → gateway HTTP 200（9s）；Release 已附带安装包。
- **代码块复制按钮**：`chat/code-block-enhance.ts`（lit ref 回调幂等注入，安全 DOM 构建无 innerHTML）接入 grouped-render 两处 chat-text 挂载点；按钮悬停显现，复制/失败状态即时反馈。
- **代码块语法高亮**：highlight.js 11 按需动态 import（core + 15 常用语言，失败静默降级）；token 配色全走 design token（keyword→accent、string→ok、number→accent-2、title→info、comment→muted），浅/暗主题自动适配；主 bundle 仅 +2KB。**语言标签**：左上角 mono 弱显示 language-* 名，`pre:has` 自动顶部留白防遮挡。
- **发版 E2E（v2026.811.4，2026-08-11）**：静默安装后 CDP 实测（`.cache/cdp-8114-codecopy.js`）：新建对话让模型产出代码块 → `.chat-text pre` 与 `.chat-code-copy` 1:1 匹配、裸 i18n 键 0、renderer 异常 0。
- **发版 E2E（v2026.811.5，2026-08-11）**：CDP 实测（`.cache/cdp-8115-hljs.js`）：python 代码块 `language-python` 命中 → `code.hljs` 启用、hljs token span 生成、按钮 1:1、裸 i18n 键 0、renderer 异常 0；截图确认字符串着色生效。
- **发版 E2E（v2026.811.6，2026-08-11）**：CDP 实测（`.cache/cdp-8116-langlabel.js`）：标签 `python` 与按钮/代码块 1:1、高亮 token 正常；**浅/暗双主题截图走查通过**（高亮配色随主题适配、无不可读元素）。
- **KaTeX 公式渲染**：`chat/math-enhance.ts` DOM 层扫描 `$$块级$$`/`$行内$`（katex 动态 import + 字体按需，主 bundle 反而 -10KB）；启发式防金额误判（首尾空白/跨行/超长拒绝），渲染失败保留原文；配套 4 用例。
- **发版 E2E（v2026.811.7，2026-08-11）**：静默安装后 CDP 实测（`.cache/cdp-8117-katex.js`）：让模型产出双公式 → `.katex` 元素 4 个、块级 2 个、裸 i18n 键 0、renderer 异常 0；截图确认数学排版生效。
- **UI 布局走查（2026-08-11，无缺陷结案）**：CDP 逐 tab 截图走查设置页 11 tab（远程控制/外观/渠道/搜索/记忆/审批/高级/模型/备份恢复/环境信息/会话用量）+ 700px 窄窗设置/对话双视图（`walk-ui-audit*.js`）：无溢出/截断/错位，验证 R2/R3 设计体系与既有窄窗 media query 有效；截图存 `.cache/shots/walk-*`。
- **发版 E2E（v2026.811.8，2026-08-12）**：静默安装后 CDP 实测（`.cache/cdp-8118-media.js`）：发送含 MEDIA 标记消息 → `img.chat-local-media` 真实加载（naturalWidth=1024）、灯箱点击打开（document 委托在流式重渲染下仍生效）、裸 i18n 键 0、renderer 异常 0；打包注意：功能代码变更后必须重跑 dist:win（首次打包曾捕获重构前代码）。

### R11 · 消息引用/重发 + rewind/fork 真机联调 + 设置走查 + Electron 升级评估

**R11-A 消息引用/重发交互补齐**（此前引用/重发均不存在，属功能缺失）：
- **失败重发**：`cryoclawError` 卡片增加「重发」按钮（`chat-error-card__resend`，rotate-ccw 图标）。
  发送同步失败路径（controllers/chat.ts catch）在合成错误消息上附带 `resendText`（原始用户消息文本）；
  grouped-render 据此渲染按钮，点击经 `handleSendChat(text)` override 直接重发（**不碰当前草稿**），
  `chatSending`/`connected` 守卫防并发，可反复点击多次重发；run 级 error 事件路径无原始文本，不提供按钮。
- **消息引用**：用户/助手文本气泡 hover 出现「引用」按钮（`chat-quote-btn`，与复制按钮同款交互；
  助手气泡同时有复制时左移 44px 避让）。新增纯函数 `chat/quote-text.ts`（`buildQuoteText` 逐行 `> ` 前缀 +
  4000 字符截断省略号；`appendQuoteToDraft` 追加草稿），点击后引用块追加到输入框草稿并把焦点送回
  输入框（「引用定位」：插入后可接着打字；与「引用技能」同模式）。样式全走 design token；配套 11 用例。

**R11-B rewind/fork 真机联调（首次，脚本 `.cache/cdp-8119-rewind.js`，三轮迭代后 ALL PASS）**：
- 真实链路（安装版 v2026.811.8 + 真实网关/真实模型）：新建会话 → M1/M2 真实模型回复 → 发送
  `/compact` 触发手动压缩 → `sessions.compaction.list` 轮询到 checkpoint（reason=manual，
  tokensBefore≈37.7k）→ UI 回放 popover 展示条目（时间/原因/tokens/摘要）→ 点「回放」二次确认弹窗 →
  toast「已回放到选中的回放点」→ UI 气泡减少（6→4，历史截断生效）→ **回放后继续对话 M3 正常** →
  点「分支」→ toast → 新会话 `agent:main:dashboard:*` 出现在 sessions.list → UI 自动切换（URL session
  参数同步）→ 分支 transcript 含 checkpoint 前历史（M1/M2 完整保留，`parentSession` 链正确）→
  **持久化验证**：`~/.openclaw/agents/main/sessions/sessions.json` 新条目 + 新 jsonl transcript 落盘；
  全程零 renderer 异常。内核取证同步修正：sessions store 路径是 `agents/<id>/sessions/sessions.json`
  （非 `~/.openclaw/sessions.json`）；`sessions.compact` RPC 可手动触发压缩生成 checkpoint。
- **新发现（入 watch list）**：主会话（agent:main:main）场景下 `chat.history` 读取存在滞后（轮询 150s
  仍返回旧计数；UI 终态刷新导致气泡数短时回退 8→7、9→2）；新会话场景无此现象——疑与主会话
  legacy-key/store 迁移读取路径有关，待内核侧只读取证定位。
- 脚本断言教训：新建对话按钮无 aria-label（文本匹配）；popover 打开后需等 `.chat-compose__rewind-item`
  渲染再点按钮；turn 完成检测用 `.chat-reading-indicator` 出现→消失（不要用气泡数/chat.history 计数）。

**R11-C 设置页深度走查（脚本 `.cache/cdp-8119-settings.js`，CDP 真机）**：
- 走查范围：高级设置（5 组 radio 16 项 + 保存链路 + webbridge precheck）、模型管理（135 卡片 + 搜索）、
  审批历史（列表/空态 + 刷新）；裸 i18n 键 0、renderer 异常 0。
- **发现并修复 1 类缺陷（tab-advanced）**：radio/输入类 handler 缺 `state.requestUpdate()`，
  导致条件区块不即时刷新——execMode 切「智能审批」后审阅模型输入框不出现、sandbox 切 non-main/all
  后工作区访问选项不出现（CDP 实测复现）。修复：clawHubRegistry @input、gatewayReload/execMode/
  sandbox/sandbox-ws/exec-host 全部 @change 补 `state.requestUpdate()`（R9 既有教训的同类残留）。
  **修复后 dev 实例 CDP 复验通过**（`.cache/cdp-8119-ui.js`，ALL PASS）：execMode=auto 后审阅模型
  输入框即时出现；消息引用按钮 6 气泡 1:1 挂载、点击后草稿出现 `> ` 引用块、重复点击正确追加；
  保存链路「已保存」提示正常。sandbox 探针本机因无 Docker 跳过（radio 禁用，环境门控非缺陷）。
- webbridge：本机 precheck 通过（三组件 + 默认浏览器全绿，无修复弹窗），模式切换链路正常；
  保存侧服务端兜底校验正确（dev 实例下预检不过会拒绝保存并给出明确错误提示）。

### R8 · 插件管理页 + ClawHub 插件市场（重启立项，完成）
- **取证**：内核 CLI `openclaw plugins list --json`（81 个已安装插件库存：id/name/version/description/
  format/kind/source/rootDir/origin/enabled/status）；`plugins search <q> --json --limit N`（ClawHub 包搜索：
  name/displayName/family/channel/isOfficial/latestVersion/summary/ownerHandle/stats/verificationTier）；
  `plugins install clawhub:<name> --acknowledge-clawhub-risk --force`（免交互安装）；
  `plugins uninstall <id> --force`（免交互卸载）。
- **主进程 `src/plugin-store.ts`**：IPC plugin-store:list/search/install/uninstall（全 sender guard），
  执行内核 CLI（resolveNodeBin + resolveGatewayEntry + ELECTRON_RUN_AS_NODE，maxBuffer 8MB/90s 超时）；
  包名安全面 `isValidPluginName`（防 --flag 注入/路径穿越）。
- **渲染层 `views/settings/tab-plugins.ts`**（设置页新 tab「插件」，group extensions）：双视图——
  「已安装」（81 插件列表 + kind/版本/状态标签 + 启用开关走 config.patch `plugins.entries.<id>.enabled`
  与渠道 tab 同机制 + 卸载二次确认）与「ClawHub 市场」（搜索 → 官方优先/下载量排序卡片 → 一键安装 →
  已安装徽标）。纯函数 `tab-plugins.lib.ts`（映射/校验/排序）+ 9 用例；样式走 design token（oc-tag 通用标签）。
- **CDP 真机验证（Electron 43 dev 实例，脚本 `.cache/cdp-8119-plugins.js`，ALL PASS）**：插件 tab 渲染
  81 行（含 kind/版本/描述）、市场搜索 weixin → WeChat 卡片（community/v3.1.4/51 下载/@newfuture/安装钮）、
  零裸 i18n、零 renderer 异常。**待发版冒烟项**：实际安装/卸载/启停（会写用户配置，dev 环境不执行）。
- 教训：插件清单 IPC 底层是内核 CLI 全量加载（约 15s），UI 等待需留足余量；冒烟脚本按钮选择器
  必须限定容器（「搜索」会误点导航 tab）。

### R12 · 主会话 chat.history 滞后 UI 兜底（完成）
- `loadChatHistory` 新增 `{mergeIfStale}` 选项：turn 终态刷新（app-gateway final 路径）启用——拉取结果
  落后本地视图（条数更少）时保留本地消息列表，等待下次刷新收敛，防消息短暂“消失”；
  会话切换/回放等替换语义路径不受影响。内核侧根因（主会话 legacy-key 读取路径）仍挂账待只读取证。

### R13 · Electron 40→43 升级落地（完成）
- `devDependencies.electron` 40.10.6 → **43.4.0**；`npm audit` 高危 GHSA-9f4c-93c8-jc8g 销账（0 漏洞）。
- **42+ 新行为踩坑**：npm 包不再 postinstall 下载二进制，首次导入 electron 会尝试 fetch 下载（此环境
  fetch 失败致 vitest 15 例挂）——须显式 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node
  node_modules/electron/install.js` 预置二进制（dev/CI 环境需固化到流程，dist:win 走 electron-builder 自取不受影响）。
- 全量测试 468 pass / 0 fail；dev 实例（Electron 43 + 内核 Node 24.17）全链路冒烟通过（gateway ready
  11.7s、渠道/会话/chat.history 正常、插件页/快捷键/引用全绿）。
- **待发版**：`npm run dist:win` + 静默安装 CDP 冒烟（随下一发版窗口）。

### R14 · 易用性小项（完成）
- rewind/fork 成功后：popover 自动收起 + 回放点列表重拉 + 侧边栏 sessions 刷新（restore 路径补 loadSessions）。
- 全局快捷键：**Ctrl+N** 新建对话（弹确认）、**Ctrl+L** 聚焦输入框（document 级监听，模块级持有最新
  props 引用防闭包旧值；CDP 实测通过）。

### R15 · 存储裁剪二期：.pdb 调试符号（完成）
- 实测确认（v2026.811.8 gateway.asar）：conpty.pdb 6.17MB + conpty_console_list.pdb 4.12MB = 10.29MB
  调试符号仍在产物。打包期 `pruneNonTargetNativePlatformPackages`（package-resources.js）与运行时升级
  `pruneNonTargetNativePackages`（kernel-prune.js）的 BFS 遍历同步增加 `.pdb` 删除（幂等、占用静默跳过、
  计入裁剪统计）；scripts 新增 1 用例（嵌套 .pdb 删除 + .node 二进制保留 + 字节统计）。
  发版后预期 gateway.asar -10.3MB（≈227MB）。

## 📋 下一步计划

（R8 重启完成；R9/R11–R25 全部完成并发版至 v2026.825.0。剩余候选按需立项：）

### R16 · 发版验证（v2026.811.9 完成）
- 版本 bump → dist:win（Electron 43 + pdb 裁剪）→ 安装验证。产物：安装包 129.0MB；
  gateway.asar **226.8MB（-10.8MB，pdb 裁剪生效）**。
- **发版冒烟 ALL PASS**（`.cache/cdp-8119-release.js`，打包版真机）：gateway 200、设置页 13 tab
  （含插件）、插件清单 81 行、ClawHub 市场搜索、**真机安装/卸载全流程**（风险确认弹窗 →
  安装成功 → 出现在已安装列表 → 卸载成功）、引用按钮、Ctrl+L、**R12 兜底复验（气泡 8→10
  不回退）**、零裸 i18n、零 renderer 异常。

### R17 · 内核根因取证与插件页安全增强（完成）
- **chat.history 主会话滞后根因锁定**（只读取证）：内核 `SESSION_STORE_SNAPSHOT_CACHE`
  （store-BJJhlPrk.js）是**无 TTL 的进程内 Map，仅以 (mtimeMs, sizeBytes) 校验**；主会话 entry
  每轮 turn 原地更新 `updatedAt`/`totalTokens`（等长数字，文件字节数不变），同毫秒写入即长期
  命中陈旧快照——与「滞后一回合、下轮写入后才刷新」症状吻合。UI 侧 R12 兜底已缓解；
  内核修复需上游（缓存键加内容哈希或读时强制失效），已整理为上游 issue 素材。
- **⚠ 发现并拦截真实事故**：ClawHub 社区包 `openclaw-wechat` 的 manifest id 与官方
  `openclaw-weixin` 相同——`plugins install` 会**静默覆盖官方插件及其渠道配置**（真机实测抓出，
  已修复用户环境：卸载社区版 + 从 config-backups 恢复渠道配置 + ext-mirror 自愈官方 2.4.6）。
  修复：市场条目映射 `runtimeId` → 安装前冲突检测（红色确认「安装将覆盖已装插件」）+
  主进程探测安装 stdout 覆盖警告透出（`differs from npm package name` / `Removed previous
  plugin install`）。
- 重发覆盖 run 级失败：error 事件路径从本地消息流恢复最后一条 user 消息提供重试。
- 性能：插件清单主进程 60s TTL 缓存（内核 CLI 全量加载约 15s，避免重复进入设置页重付），
  install/uninstall 后主动失效。

### R18 · 思考档位路由修复 + 对话健壮性批次 + 模型页增强（完成）
- **思考档位根因（内核侧取证）**：bundled kimi 插件（`dist/extensions/kimi/dist/index.js`）的
  `resolveThinkingProfile` 钩子无视上下文，对 kimi/kimi-code/kimi-coding 一律返回二值
  [off,on]，导致 k3-256k 选 high 报 `Thinking level "high" is not supported ... Use one of: off, on.`。
  模型条目的 `thinkingLevelMap` 只在请求层透传，不参与档位门禁；`compat.supportedReasoningEfforts`
  仅在无插件钩子时才被读取。**修复**：`scripts/lib/kernel-dist-patch.js` 新增
  `patchKimiThinkingProfile`（marker 匹配、幂等、未命中静默跳过），钩子改为读
  `context.compat.supportedReasoningEfforts`——有则全档位（off 首位、默认 high），无则保持二值。
  接线：package-resources.js installDependencies 两条路径 + kernel-update.mjs patch 步骤
  （未命中仅告警不中止）。scripts +4 用例（含打补丁后钩子行为直测）。
- **chat-ui 侧配套**：`thinking-levels.ts` normalizeProvider 归一 kimi/kimi-code→kimi-coding；
  新增 `catalogCompat` 参数（models.list 目录条目 compat）作为内核会话行缺失时的精确回退，
  app.ts 两处调用点经 `getCachedGatewayModelEntries` 注入。thinking-levels +4 用例。
- **/new 及时刷新**：内核 /new、/reset 同 key 轮换 sessionId 并清空 transcript，但 R12 的
  mergeIfStale 会把重置后的短历史误判为「滞后读」继续显示旧对话。修复：
  `session-pending.ts` 新增 `pendingSessionResets`——发送 /new 立即清空本地视图并置位，
  final 强制替换历史（绕过 mergeIfStale），error/aborted 撤销标记并重拉恢复（app-chat.ts /
  app-gateway.ts）。
- **对话健壮性批次**（审查发现，全部有代码证据）：
  ① mergeIfStale 遇 compaction 标记（`__openclaw.kind==="compaction"`）必须替换——否则压缩后
  本地恒长于服务端，新回复永不上屏；② cross-run final（sub-agent announce）不再
  resetToolStream/clearFallbackNotice（此前会瞬间清空进行中主 run 的工具卡片并破坏
  frozenPrefix 切段）；③ 无活跃 run 时带 runId 的 delta/error 一律丢弃（防僵尸流式气泡与
  误注入带「重发」的错误卡），final/aborted 仍透传刷新；④ context meter 解冻条件从
  「totalTokens 单调推进」改为「变化即解冻」（内核 totalTokens 是当次值非累计，压缩后/
  短 prompt 会下降导致永不解冻）；⑤ compaction 事件补 sessionKey 过滤 + 会话切换清理
  compactionStatus/fallbackNotice 及定时器（session-transition.ts）；⑥ delivery-mirror
  去重指纹从 200 字符前缀改为全文（防模板化长回复撞车误丢消息）；⑦ path-linker 链接文本
  补转义（`&` 类实体子串显示错乱）。chat controller +5 用例；context-meter 1 用例按新契约改写。
- **模型管理页**：模型卡片新增「思考」（tooltip 列出支持档位）与上下文窗口（256K/1M 格式）
  徽标，数据直接来自 config 条目（reasoning/contextWindow/compat）；CUSTOM_PRESETS 新增
  xiaomi（xiaomi-coding/mimo）与 ollama 本地预设。**requestUpdate 批量修复**：tab-provider 6 处
  + 渠道/搜索/setup 14 处输入 handler 补 `state.requestUpdate()`（R9/R11 同类残留；fallback
  添加下拉不刷禁用态是真 bug）。
- **动效**：`.chat-group` 新消息入场 rise .22s（repeat 按 key 复用节点只在创建时播放）；
  base.css 补全局 `prefers-reduced-motion` 收敛（动画/过渡瞬时化）。
- **遗留（未做）**：发送在途时手动刷新可能短暂隐藏未落库的本地 user 消息（自愈于 final）；
  忙碌中「立即发送」/new 的边界路径不置 pendingReset（兜底为旧行为）。

### R19 · 发版验证（v2026.820.0）+ 思考补丁打包顺序回归修复（完成）
- **⚠ 发版实测抓出回归：思考补丁根本没进安装包。** R18 的 patchKimiThinkingProfile 只在
  installDependencies 阶段打（Step 2），但 Step 2.5 的 vendorOfficialPlugin（OFFICIAL_VENDOR_PLUGINS
  含 kimi，openclaw ≥2026.6.x 起 provider 插件不再随内核 npm 包发布、构建期 vendor）会
  `rmDir+copy` 整个覆盖 `dist/extensions/kimi/`，把已打的补丁冲掉；且补丁未命中时静默返回 0
  无日志——单测全绿、打包也"成功"，asar 探针（解包 grep marker）才暴露。教训：**内核补丁的
  验证终点必须是打包产物内的内容断言，不是函数级单测。**
- 修复（三层防线）：① main() 在 bundleAllPlugins 之后重打补丁（幂等）；② wrapper 区分
  幂等跳过与 marker 未命中——后者大声告警（⚠⚠），不再静默；③ verifyAsarContents 新增
  asar 内 kimi 插件 marker 内容校验（extractFile 读包内文件，未命中告警不 die——上游若原生
  修复则不阻断）。kernel-update.mjs 顺序本就正确（patch 在 carryOverInjected 之后），不受影响。
- 验证：重打包后 asar 探针确认 marker 在包内、旧二值硬编码不再匹配；scripts 52 用例全绿。
- 打包增量路径约 4 分钟（stamp 匹配跳过 npm install；vendor 插件走 .cache tgz 复用）。
- **⚠ 冒烟环境教训**：安装器装完会自启应用（无调试端口），后续带 --remote-debugging-port 的
  启动撞单实例锁直接退出——必须先 taskkill 再起；Git Bash 下 taskkill 要用 `cmd //c` 包一层
  （`/F` 会被 MSYS 转成路径 F:/）。
- **发版冒烟 ALL PASS**（`.cache/cdp-8200-release.js`，打包版真机，19 项）：gateway 200、
  设置 13 tab、k3-256k 卡片「图像/思考/256K」徽标、**思考档位 popover 全 7 档
  （关闭/极简/低/中/高/超高/最大，含「高」——k3 high 档路由修复坐实）**、消息组 rise 动效、
  引用按钮、Ctrl+L、scratch 会话真消息往返、**/new 旧内容 +2ms 立即消失、终态后不回退、
  新会话确认消息落位**、零裸 i18n、零 renderer 异常。
- **⚠ 冒烟断言教训**：/new 的判定基准必须是「内容」而非气泡计数——内核重置后的新 transcript
  本身就含 [/new, ✅ New session started.] 两条消息，气泡数恒为 2；首轮冒烟用 `bubbles<=1`
  误判 FAIL，内容级复测（marker 文本消失时刻 + 终态文本）证明功能本就正确。

### R20 · 性能/稳定性/更新体系批次（完成，v2026.821.2）

用户指令：架构优化、日志统一、渲染韧性、图标统一、打包分发优化（ASAR/差分/签名）、更新链路验证。

- **P0-1 Chromium 特性收敛**（`src/main.ts`）：模块顶层 appendSwitch 组——禁用
  BackForwardCache/重图编译等无用特性，降低内存与后台唤醒。
- **P0-2 退出清理临时缓存**（`src/quit-cleanup.ts`+测试）：app quit 时清理 `%TEMP%` 下
  cryoclaw/openclaw 临时目录（保留用户配置与会话历史）。真机实测 quit 日志「删除 308」。
- **P0-3 渲染进程韧性**（`src/window.ts`）：render-process-gone/unresponsive 自愈重载 +
  内存软监控（超限告警不杀）。
- **P0-4 日志统一 + 诊断包**：全部日志收口 `~/.openclaw/logs/`（app.log/gateway.log，
  `CRYOCLAW_LOG_LEVEL` 级别过滤，旧位置文件一次性迁移）；`src/diagnostics-export.ts` +
  设置-高级「导出诊断包」按钮（IPC `settings:export-diagnostics`，已接
  assertTrustedIpcSender/preload/ipc-bridge/tab-advanced/i18n）。
- **P1-5 Gateway V8 编译缓存**：gateway spawn env 注入 `NODE_COMPILE_CACHE=
  ~/.openclaw/cache/v8-compile`（Node 22+ 内建）；kernel-update.mjs 换装/回退后
  clearCompileCache()；openclaw-state-archive 的 VOLATILE_RUNTIME_FILES 增补
  "logs"/"cache"。
- **P1-6 首屏提前**：`src/main.ts` 窗口创建提到 reconcileExtensionsOnAppLaunch 与四个
  同步迁移之前（switch case 加块级作用域修 lexical declaration 报错）。
- **P2-7 图标统一 lucide**：icons.ts 重写统一风格、补 tool-display 5 个缺失键、svgo
  压缩（`scripts/optimize-svg.js`）。
- **P3-8~11 更新体系**：`src/app-updater-state.ts`（纯状态机 +6 单测）+ `src/app-updater.ts`
  （electron-updater 接线）+ settings/about.ts 三个 `app-update:*` handler + 设置-关于
  「应用更新」卡片（i18n 各 11 键）+ electron-builder.yml publish→github binchen6/CryoClaw
  （删 differentialPackage:false 启用差分、dmg.writeUpdateInfo:true）+ dist-win.js PE 签名
  接线（无证书 ⚠ 不 fail）+ blockmap/latest.yml 断言 + `docs/releasing.md`。
- **P3-12 更新链路实测（双包差分 + 悬案定案）**：本地 generic 服务器实测
  821.0→821.1→821.2：检查/下载/校验/回退全通，但 electron-updater `quitAndInstall()`
  spawn 的 NSIS 安装器 ~37s 后静默死亡（uninstall/copy 之前），手动同参 spawn 全部成功
  （已排除 taskkill /T 自杀、quit-cleanup、父退出方式、cwd/MOTW/签名——gotchas #67/68）。
  **定案：app-updater.ts 自实现换装 spawn**（detached+stdio:ignore+unref → app.quit()），
  真实链路 821.0→821.2 换装+自启实测通过（asar md5 变更 + 新进程 + 新启动日志三件套）。
  821.1/821.0 为测试中间版不发布，正式发 821.2。
- 测试基线 **487 pass / 0 fail / 4 skip**（vitest 94 + node 74 + chat-ui 267 + scripts 52）。

### R21 · 模型管理增强：单模型能力编辑 + 分组内新增模型（完成，v2026.821.3）

用户指令：联网研究 openclaw 官方配置文档；模型管理支持每个模型单独自定义上下文长度、
思考模式、图像/视频等能力；分组旁「新增模型」自动复用分组配置；检查其他设置可优化项。

- **内核 schema 取证**（gateway.asar 内 `zod-schema.core-*.js`）：`ModelDefinitionSchema`
  为 `.strict()` 对象（**裸字符串 entry 非法**，id/name 必填）；白名单字段含
  reasoning / input（**text/image/video/audio 四模态**）/ contextWindow / contextTokens /
  maxTokens / thinkingLevelMap / compat.supportedReasoningEfforts（档位数组，不含 off）等；
  官方文档确认 provider 级字段可被 models[] 单模型覆盖，自定义模型接受图像必须显式
  `input:["text","image"]`。
- **lib 纯函数**（`tab-provider.lib.ts`）：`CapabilityOverrides` / `applyCapabilityOverrides`
  （null=删字段回落 provider 默认、input 恒含 text、thinkingLevels 写
  compat.supportedReasoningEfforts 且保留 compat 其他键、白名单外字段剔除）/
  `deriveOverridesFromEntry`（编辑表单初始值）；+3 测试组。
- **模型卡片能力编辑器**（`tab-provider.ts` renderCapsEditor/renderModelEditPanel）：
  卡片加编辑按钮 → 就地展开：contextWindow（128K/256K/512K/1M 预设 chip）、maxTokens、
  图像/视频/音频开关、思考开关 + 档位 chips；保存走 `runPatch`（config.patch + baseHash
  乐观锁），裸字符串 entry 自动升格 `{id,name}`；卡片徽标新增视频/音频。
- **分组内新增模型**：单 provider 组头「+ 新增模型」按钮（kimi-coding/custom 组除外）、
  多 provider 组子头「+」→ renderGroupAddPanel：复用提示（显示 providerKey）、目录下拉/
  自定义 id、别名、可折叠能力编辑器（选目录模型时 initAddCapsFromCatalog 预选能力）；
  `handleAddToGroupSave` 跳过 verify-key、查重、push 进同组 models、无 primary 则设默认。
- **设置页审查 12 项修复**：settings-view 两处漏调 `resetEnvInfoTab()`（过期数据）；
  approvals 裸 `…`→`chat.loading`；feishu/wecom 加群 Enter 补 `!e.isComposing`（输入法
  误提交）；weixin 断开按钮补 tooltip/aria + showConfirm + busy 守卫；三处错误色
  `--accent`→`--danger`；tab-backup 重置 catch 吞错→`s.error`；plugins 已安装角标与
  冲突检测的 runtimeId 一致化；pairing 面板 tooltip 独立 key（不再跨模块借用）；
  about「重启以更新」加确认；**dingtalk sessionTimeout 僵尸字段删除**（schema 已废弃，
  保存时被 strip 永不落盘）；死 i18n key 清理 17 个（zh/en 对称，i18n.test.ts 审计）。
- **验证**：全量回归 **487 pass / 0 fail** 维持；CDP 真机冒烟（`.cache/cdp-r21-caps.js`）：
  编辑 deepseek-v4-pro → contextWindow=131072 + input 含 video 落盘 + 卡片徽标「视频/128K」
  更新；分组「+」新增自定义模型落盘同组且 baseUrl/apiKey 未动；零 renderer 异常。
  （dev 冒烟三坑——asar 打包删散文件 / TaskStop 残留 electron / 首个 patch 落盘 >60s——
  已记 gotchas #70。）
- 发版 v2026.821.3：版本号 + release-notes + dist:win + GitHub Release。

### R22 · 重复代码治理（完成，随 v2026.824.0 发版）
- 用户指令：全源码重复代码率降至 5% 以下，自动识别 + 重构 + 验证。
- **度量基建**：新增 `.jscpd.json`（threshold 5%、minTokens 50，覆盖 src + chat-ui/ui/src +
  chat-ui/src，排除产物目录）+ jscpd devDependency + `npm run dupcheck`（报告 `.jscpd-report/`，防回退）。基线 2.29%（102 clones）。
- **新增共享模块 6 个**：`src/safe-open.ts`（openPath 扩展名白名单）、`src/time-format.ts`
  （YYYYMMDD-HHMMSS）、`src/vitest-state-dir.ts`（vitest 临时状态目录）、
  `tab-channels-shared.ts`（四渠道面板保存/开关/弹窗/配对/状态工厂）、
  `data/kimi-oauth-flow.ts`（Kimi OAuth 登录公共流程）、`test-utils/fake-scheduler.ts`（测试假调度器基类）。
- **主进程**：settings/webbridge.ts 两个 repair handler 的浏览器准备/选择性修复/precheck 三段流水线；
  provider-config.ts 飞书/QQ Bot/钉钉凭据验证 → `httpsJsonVerify`；webbridge.ts HEAD/GET 重定向与非 200 检查 →
  `guardRedirectAndStatus`；logger/gateway-process 日志流关闭 → `endStreamWithTimeout`；build-config 候选路径导出复用；
  kimi-config sidecar 写入、settings/backup 保存对话框、settings/pairing 配对码校验等。
- **渲染层**：tab-provider 两个 add panel 的模型选择/别名表单块；四渠道面板全量接入共享模块；
  message-extract 文本提取、cron 投递配置、tab-backup 恢复流程、exec-approval payload 外壳校验；
  app-settings 无调用方的死代码删除。
- **测试层**：weixin-config.test 临时目录装配、gateway-control-server.test 端口占用、
  chat/gateway.test 假调度器、cryoclaw-config/startup-ownership vitest 状态目录。
- **结果**：重复率 **2.29% → 1.22%**（102 → 65 clones）；`npm test` 487 pass / 0 fail 维持；`npm run build` 通过。
- **豁免保留**（已定案不再动）：setup-constants ↔ provider-config 的 MOONSHOT_SUB_PLATFORMS（跨进程边界有意对齐）；
  迁移测试的同输入异语义断言；tab-provider draft 写入小块（强上下文依赖）；其余均 < 70 token 小片段。

### R23 · 聊天增强批次一（完成，随 v2026.824.1 发版）

用户指令：① MEDIA 非图片路径以文件卡片展示（点击打开 + 在文件夹中显示）；② 子代理等待期的继续流式输出与 plan 进度同步；③ 流式输出完整性/流畅性/及时性；⑤ 问答卡片网关支持取证；（④⑥ 交互体验/渲染效率/启动加速归入批次二）。
- **W1 MEDIA 文件卡片**（`chat/media-enhance.ts` 扩展）：新增 ~45 个常见文件后缀识别（文档/表格/演示/压缩/音视频/代码，与 safe-open 白名单对齐并扩充）；图片仍走 `<img>` 链，非图片输出 `chat-file-card`（图标 + 文件名 + 扩展名徽标 + 「在文件夹中显示」按钮）；图标取 lucide v0.577.0（ISC）内联 SVG 按类别区分，未覆盖后缀回落通用图标；点击打开走 `app:open-path` 白名单（拒绝时 toast），新增 `app:reveal-path` IPC（`shell.showItemInFolder`，sender guard，不执行文件故无白名单限制）；事件用 document 级委托（防 lit 重渲染丢监听）+ 键盘可达。裸路径截断正则交替项按长度降序（防 xls 抢先 xlsx）。+4 用例。
- **W2 子代理等待状态卡**（新模块 `chat/subagent-status.ts`）：主 run 活跃时把当前会话相关的 subagent 任务（sessionKey/ownerKey 关联，跨会话不显示）投影为聊天区内联卡片——标题/状态脉冲/progressSummary 实时行，终态定格 15s 后由 tick 刷新自然移除；阅读指示器在等待子代理时显示「等待子代理返回…」（优先级低于工具名）。plan 面板维持现状：主 run update_plan 同步已存在，子代理自身 plan 属其他会话不注入主面板，进度经 progressSummary 行呈现。连接审计：gateway 客户端无连接级空闲超时，请求超时仅针对单次 RPC，长等待不误断连。+7 用例。
- **W3 流式加固**：① `mergeIfStale` 补空读保护（非重置路径拿到空历史保留本地，防 delta 丢失叠加空读清空视图）；② 重连兜底：握手完成后（仅重连路径）重拉持久化历史重建被断连清掉的流式气泡；③ 终态 sessions 拉取 1500ms → 800ms 提速（usage 未落盘由 sessions.changed 事件兜底清 dirty）。流式期 rAF 单帧提交纯文本、终态一次性排版 + 缓存既有链路未动（无测量支撑不重写）。+1 用例。
- **问答卡片取证结论**（网关不支持，本批不做应用层实现）：内核 `poll` RPC（core-descriptors，operator.write，不广播）面向外部渠道出站投票（Telegram/Discord/iMessage 等，`callMessageGateway method:"poll" {to,question,options,maxSelections}`）；webchat 无问答卡片消息块/事件；现有交互卡片仅 exec.approval / plugin.approval 两条链。若上游后续原生支持再按契约接入。
- 验证：测试基线 487 → **498**（0 fail）；`npm run build` 通过；重复率 1.21% 未回退（65 clones）。
- **审查修复（随 v2026.824.2）**：全量代码审查无 Critical/Major，2 条 Minor 已修——① 文件卡片根元素 `<div>` 在 marked `<p>` 内触发隐式闭合段落 → 改 `<span>`（phrasing content 合法）；② `selectSubagentCards` 对缺失 `status` 的任务被 `isActiveTask` 默认 queued 误判为活跃恒显示 → 无 status 一律走终态时间窗兜底；另修正定格窗口注释（收敛依赖下一次重算）。基线 498 → **499**。

### R24 · 全面代码审查批次（完成，随 v2026.824.3 发版）
用户指令：在不改变现有功能/视觉/IPC 契约/主进程行为的前提下，对主进程、渲染层、测试基建、构建脚本做系统性审查修复，分级输出。
方法：5 个并行审查代理分区深审（主进程核心/主进程配置 IPC/渲染层数据层/渲染层视图/构建脚本）约 130 文件全量阅读，对照 gotchas 69 条逐条验证，共修复 34 处（32 文件 + 1 新增）。
- **阻塞性 ×2（构建链）**：① package-resources.js ASAR 边界补丁 0 命中仅告警——会静默发出 asar 校验恒失败的安装包（新增 `hasAsarBoundaryPatchMarker` 区分幂等/未命中，未命中 die，与 kernel-update.mjs 对齐）；② merge-release-yml.js 同版本重建保留旧 exe——与合并后 latest.yml 哈希不匹配致 updater sha512 校验失败 → 改覆盖语义。
- **功能性 ×16**：主进程——① window.ts 错误页 data: URL 的 Retry 永无效（Chromium 禁 data→file 导航 + sender guard 拒绝）→ 迁 `assets/error.html`（file:// origin，视觉一致，Retry 校验 file: 协议回跳），顺带修复 `this.win!` 销毁竞态空解引用；② kimi-auth-proxy 客户端中断不传播上游（SSE 流式场景上游 LLM 继续计费）→ 断开同步 `proxyReq.destroy()`；③ kimi-auth-proxy listen 后未补挂运行期 error 监听（无监听器即崩主进程）；④ gateway-control-server persist 抛错泄漏已监听 server；⑤ gateway-auth token 持久化失败静默 → 记日志；⑥ settings/pairing runGatewayCli 全项目唯一无超时的子进程调用（死锁时 IPC 永 pending + 泄漏进程）→ 90s 兜底 kill；⑦ **workspace-ipc symlink 逃逸**（agent 可在 workspace 建指向 `credentials/*` 的符号链接绕过字符串前缀守卫）→ `resolveRealInsideRoot` realpath 复核，应用于 read-file/open-file；⑧ settings/advanced webbridge precheck 两次秒级 await 夹在 read/write 之间的 lost-update 竞态 → precheck 前移；⑨ main.ts `formatConsoleLevel` 映射正是 gotcha #47 记载的错误早期版本 → 修正为 VERBOSE/INFO/WARNING/ERROR。渲染层——① controllers/chat `sendChatMessage` 失败回调无会话归属守卫（在途发送时切会话，旧会话错误卡含 resendText 重发会把旧文本发进新会话并清掉新会话 run）→ 快照守卫；② app-chat `sendChatMessageNow` 用当前 sessionKey 而非快照（误删新会话 pendingReset 标记/自动命名串会话）；③ `patchSession` 吞错永不 reject 致 flushPendingSessionLabel 重试契约成死代码（自动命名静默丢失）→ 返回 boolean；④ code-block-enhance 复制取 `pre.innerText` 混入绝对定位语言标签 → 改 `code.textContent`；⑤ media-enhance lightbox 点击关闭泄漏 document keydown 监听；⑥ app.ts `onWebbridgeRepairClick` 缺 catch 产生 unhandled rejection。
- **性能 ×8**：① logger 轮转计数器重置在 try 内——stat 失败一次后永久每条日志同步 stat（对齐 gateway-process diagLog 正确模式）；② gateway-process `stopExistingGateway`（10s）/`killProcess`（5s）execFileSync 同步阻塞主进程（窗口未响应 + 全 IPC 停摆）→ execFileAsync；③ skill-store registry 响应体无上限（恶意自定义源滴流可 OOM）→ 8MB 上限；④ state-archive 导出 `cpSync` 整树复制数百 MB 冻结主进程 → `fs.promises.cp`；⑤ app-tool-stream `evictedLeadingSegments` 无上限（超长 run 线性累积 + 每节流帧全量重建）→ 150 段上限；⑥ views/chat tool 消息 key 用 `i + history.length` 动态偏移（run 期间 chatMessages 追加致全批 tool 卡 key 平移整批重建）→ 固定命名空间基数 1e9；⑦ `adjustTextareaHeight` 经 lit ref 每帧冗余布局 → value+宽度指纹守卫；⑧ managed-media 缓存满 100 全清（作废仍在用的 URL 触发批量 refetch）→ 逐出最旧。
- **可维护性 ×8**：legacy stamp 复制粘贴 bug（`.cryoclaw-` 应为 `.oneclaw-`，旧树增量复用永远失效）、build-config.json 非原子写、PowerShell 单引号转义（路径含撇号截断）、vendorOfficialPlugin die 泄漏临时目录、kernel-dist-patch 幂等 marker 只认 1/3 变体、dist-win.js `shell:true` 残留（DEP0190）与 isExeSigned 整读数百 MB、weixin-config 死代码删除、plugin-store search query 的 `-` 前缀注入面、run-*-tests rmSync→rmRecursive、sidebar renderErrors 双调用。
- **新增测试 2 用例**：`chat.test.ts` 发送在途会话切换守卫、`sessions.test.ts` patchSession 失败返回 false。
- **未修项（建议后续立项）**：飞书名称补全并发上限（影响小，自愈面内）；loadTasks 在途丢弃（≤30s 陈旧 ticker 自愈）；导出压缩段同步 fflate（worker 化超出最小改动）；kimi-auth-proxy 回环无鉴权（威胁模型低，需评估 CLI 兼容）；cleanStaleLockfile 先 probe 再杀（属行为变更）；gateway-rpc 无生产调用点（疑似预留，不删）。
- **验证全绿**：`npm test` 499 pass / 0 fail / 4 skipped（基线零破坏）；主进程与 chat-ui typecheck 0 错；`npm run build` 通过；jscpd **1.01% / 65 clones**（过程引入的 1 处新 clone 已提取 `guardRealPath` 消除）。
- **教训**：gotcha #47 修复后的 `formatConsoleLevel` 正确映射曾被回退为错误早期版本——“文档记载的修复语义”应用纯函数单测钉死防回归（后续候选）。

### R25 · 主进程大文件补审（完成，随 v2026.825.0 发版）
用户指令：继续审查 R24 未覆盖的主进程大文件（analytics/updater/kernel-updater/browser/webbridge 等）；后续阶段：设置页视图与组件层补审 → 文档重写精简 → 历史遗留清理，每阶段独立发版。
方法：2 个并行审查代理深审 16 文件（含 browser.ts 37KB / webbridge.ts 30KB / cli-integration.ts 30KB），对照 gotchas 69 条，共修复 9 处。
- **功能性 ×5**：① **cli-integration cmd 转义缺口**：`escapeForCmdSetValue` 未转义 `%`——批处理上下文成对 `%VAR%` 会被环境变量展开，路径含 `%`（用户可选安装目录/用户名）时生成的 wrapper 路径段被静默吞掉、CLI 硬损坏且 reconcile 不自愈（内容比对认为“正确”）→ 双写 `%%` 转义；② extension-mirror `reconcileExtensionsOnAppLaunch` 契约是“永远不抛”但 `mkdirSync` 在 try 外——权限/磁盘满时抛错中断启动链路（网关不启动且失败上报/恢复路径全被跳过）；③ extension-mirror 升级路径“先删旧目录再复制”非原子——复制中途失败留下残缺扩展目录，依赖该目录的 channel 在 config 校验阶段被拒（gotcha #41）→ 同卷临时目录 + rename 原子换装；④ app-updater `quitAndInstallAppUpdate` 无重入保护——双触发并发两个静默安装器互踩文件（后起实例退出码 2 静默退出，#53）→ 模块级 installing 标志；⑤ kernel-updater `runUpdater` 无整体看门狗——脚本外原因（管道阻塞/磁盘 I/O 挂起）导致编排永久挂起，此时 gateway 已停、用户侧“升级中”永久卡死 → 15 分钟整体超时杀进程，由上层编排（回滚 + 恢复启动）接管。
- **稳定性 ×3**：⑥ cli-integration 用户 rc 文件（~/.zshrc 等）原地写 → .tmp+rename 原子写（高价值用户配置，损坏影响所有新终端）；⑦ config-backup `writeConfigRaw`（恢复路径）直写 → 原子写（恢复是最后救命稻草，自身损坏配置尤不该，对齐 ensurePluginsAllow 模式）；⑧ browser `DEFAULT_PROCESS_EXEC`/`defaultRegExecutor` 无超时——PowerShell/reg.exe 在 Defender 干扰等环境长不返时，Settings/Setup IPC 链路无限挂起 → 10s 超时 + windowsHide（误超时仅单次探测降级，下次轮询自愈）。
- **可维护性 ×1**：⑨ kernel-updater 异常恢复路径重启 gateway 失败空吞 → 错误文案透出“且 Gateway 恢复启动失败”。
- **无发现区**（全读核验）：analytics（心跳/刷发窗口/AbortSignal 兜底均稳）、analytics-events、app-updater-state（纯 reducer）、install-detector（超时齐备无 shell）、constants（兜底完整）、diagnostics-export（脱敏递归+双上限）、provider-image-probe（TINY_PNG 符合 #44）。
- **未修项（候选）**：webbridge 二进制下载无 SHA256 校验（ETag 只是缓存一致性，非完整性机制）——需发布链配合产出哈希清单，独立安全加固项排期。
- **验证**：`npm test` 499 pass / 0 fail / 4 skipped（基线维持）；`tsc -p tsconfig.json` 0 错；`npm run build` 通过。

### R8 · 插件管理页面（已重启完成，见上节 R8 记录）

### 剩余候选（按需立项）
- 插件页：详情视图（description 全文/来源/依赖）；安装后自动启用（需 runtimeId→id 映射）。
- 引用跳转定位原消息；附件卡片化（阶段 20 挂账）；i18n 死键审计；会话 includeDerivedTitles 大列表性能核。
- device token 主进程保管（威胁模型低）；tree-sitter-bash/typescript 内核运行时依赖取证（维持不裁）。

## 📦 发版与实测经验（套路已验证多次）

- 发版链路：`npm run build` → `npm run dist:win` → 静默安装 → 启动验证（gateway `GET http://127.0.0.1:18789/` HTTP 200）。发版后 `npm run dupcheck` 顺手复测重复率（防回退，R22 起）。
- **发版后必做 CDP 冒烟**：点击关键入口（设置/加号菜单/审批/计划面板）+ 扫描裸 i18n 键 + 零 renderer 异常。
  历史脚本在 `.cache/cdp-*.js`；vite 构建不查未定义标识符，运行时才暴露（阶段 11 教训）。
- gateway 首次启动需 **20+ 秒**（内核渠道插件同步初始化），CDP 脚本连接等待要留足余量（120s 保险）。
- 多次 taskkill 会留下 TIME_WAIT/进程残留导致 gateway 启动失败——发版实测前彻底清理 + 等待（gotchas）。
- CDP 探针教训：Lit 重渲染会重建 `<details>`，注入 setAttribute('open') 会被清掉 → 用 `summary.click()`；
  innerText 对未渲染子树返回空 → 验证文本用 textContent。
- NSIS 压缩缓存非确定性：同内容安装包体积可能大幅波动（67MB/134MB/277MB 都出现过），功能无影响。
- 发版复验清单：安装目录关键文件时间戳与构建产物一致；app.asar 顶层仅白名单条目
  （node_modules/assets/chat-ui/dist/package.json/release-notes.json/setup/shared），无 .env/.cache/src/docs。
- **811.1 新教训**：CDP 冒烟自启动实例后，脚本 `child.kill()` 可能杀不干净（Windows GUI 进程树），
  残留实例占住单实例锁 → 后续新实例拿不到锁直接退出、调试端口不开，表现为「120s 无 CDP 页」。
  冒烟前后一律 `taskkill /F /IM CryoClaw.exe /T` 并确认 tasklist 清零（gotchas #53 的强化版）。
- **811.1 版本号惯例**：OneClaw 末版与 CryoClaw 首发同日（2026-08-11），后者顺延 `.N` 为 811.1；
  release-notes.json 顶部条目即新版说明（`app:get-release-notes` 按版本匹配）。
- **811.2 新教训**：① officecli pin 升到 1.0.143 后 GitHub release 直连 `read ECONNRESET`
  （SHA256SUMS 能下、30MB 二进制被重置）——用镜像前缀 `https://gh-proxy.com/<原URL>` 拉取，
  落 `.cache/officecli/<version>/<asset>` 后脚本自动命中缓存（SHA256 校验兜底）；
  ② NSIS 同版本覆盖安装 `/S` 可能在文件拷贝完成后卡收尾（app.asar 时间戳已更新即视为装好，
  taskkill 安装器即可）；③ 安装器结束可能自启应用 → 占住单实例锁，CDP 冒烟前先 taskkill 清零。
- **811.9 dev 模式联调要点（R11）**：dev 用 `npx electron . --remote-debugging-port=<port>`，
  进程名是 **electron.exe**（taskkill 需按 Path 过滤，`Get-Process CryoClaw` 杀不到）；dev 网关
  需要**解包目录** `resources/targets/<target>/gateway/`（gateway-entry.mjs + node_modules），
  package:resources 只产 gateway.asar —— 可复制 `.cache/asar-x`（完整解包内核树）补齐；dev 网关
  就绪 ~40-50s（http 200 后还需等 hello-ok/sessions.list 通，冒烟等待要留足）；dev 下 webbridge
  组件路径解析不过，浏览器模式保存会拒绝并报「WebBridge 条件未满足」（环境差异非缺陷）；
  设置页保存测试会写 openclaw.json（browser 插件/skill enabled），测后需从 `~/.openclaw/config-backups/`
  恢复。CDP 断言教训：新建对话按钮无 aria-label（按文本匹配）；turn 完成检测用
  `.chat-reading-indicator` 出现→消失（chat.history 计数有主会话滞后，不可用）；popover 打开后
  等 `.chat-compose__rewind-item` 渲染再点操作按钮。

## 📜 历史档案（阶段 1–22，压缩版；只保留仍有效事实）

> 全部为已完成历史。细节被取代处已略去；仍有效的决策/数字/契约如下。
> 版本轨迹：2026.730.0（阶段 7 首发）→ 731.x（阶段 9–13）→ 801.0（阶段 15）→ 803/804/805（16–18）
> → 806–808（19）→ 809（20）→ 810（21）→ 811.0（22，OneClaw 末版）→ 811.1（CryoClaw 重设计 R1–R7 含 R6 裁剪，首发）
> → **811.2（R9 模型管理自定义分组 + 选择器联动）**。
> （历史需求清单无第 6 项，编号沿用原清单，故无「阶段 6」。）

- **阶段 1（内核升级链）**：官方 `openclaw update` 不支持 asar 部署 → 自研差分换装
  `scripts/updater/kernel-update.mjs`（staging npm install → carryOverInjected 搬运 → 补丁 0 命中即中止 →
  冒烟 → 重打 asar → 备份 2 份 → rename 换装 → 健康失败自动回滚；锁文件防并发；备份根
  `%LOCALAPPDATA%\CryoClaw\kernel-backup\`）。E2E 通过。
  关键坑：Electron fs 补丁会拦截对 gateway.asar 的操作 → 脚本内一律用 `original-fs`；asar v4 API 是 `extractAll`。
  版本配套风险：package.json `cryoclaw.*` 对 9 个插件有版本 pin，运行时只升内核可能错配——UI 有配套关系警告。
- **阶段 2（新 RPC 适配）**：models.list 动态化（5min 缓存）；审批历史 tab（内核 list 只返回 pending，
  已完结靠本地事件流）；memory doctor 状态卡；会话 rewind/fork（compaction.restore/branch）；语音只读 tab。
- **阶段 3**：`src/openclaw-config-migration.ts` 从 main.ts 抽出（`since` 版本门控 ≥2026.7，
  main 与 kernel-updater 双调用点）；wrapper `exit /b` 退出码修复。
- **阶段 4**：应用自身「检查更新」功能整体删除（auto-updater 链 + 更新 banner + electron-updater 依赖）；
  应用不自动更新，只有内核升级器。
- **阶段 5**：升级链 43 单测（迁移 18 + kernel-updater 25）；DEP0190 修复范式：spawn 禁 `shell:true`，
  Windows 显式 `cmd.exe /c npm.cmd`。
- **阶段 7（安全）**：open-external 仅放行 http(s)；open-path 扩展名白名单；workspace:set-root 限
  `~/.openclaw/workspace/` 内；setup:resolve-conflict PID 复核；skill slug 正则校验；DevTools 生产禁用；
  custom provider baseURL 仅 http(s)；渲染层 CSP（connect-src 只允许 127.0.0.1）；日历版本号 YYYY.MMDD.N 确立。
  已审查无需改动：preload contextIsolation+白名单、installer.nsh 路径固定、install-detector 全部 execFile 数组参数。
- **阶段 8**：`src/ipc-sender-guard.ts` 敏感通道加闸（模式：新敏感 handler 必须照此加）；
  日志降噪（console level 0=verbose，生产丢弃 debug）；vite manualChunks vendor 分包（lit/marked/dompurify 等）。
- **阶段 9**：会话管理 + tasks 实时视图 + cron 每任务模型。契约事实：`sessions.list archived=true` 是
  **仅返回已归档**（切换需重拉）；task 事件 `{action: upserted|deleted|restored}`，未知 action 全量重拉兜底。
- **阶段 10（启动速度）**：窗口先行 + gateway 并行 + ready-to-show → 用户感知启动 ~25s → **~0.6s**；
  gateway HTTP 200 仍 ~22s（内核渠道插件同步初始化，官方 issue #65444 lazyConnect **未落地**，内核侧不可改）。
  坑：package-resources.test.js 曾因 CRLF 正则失配真实执行打包（227s→0.27s，已修）；
  sender guard 曾因 history 路由改写 URL 误拒 → 前缀放宽到 `chat-ui/dist/` 目录 + 已知路由集合。
- **阶段 11**：`gateway.reload.mode`（hybrid/restart/hot/off）暴露；DeepSeek v4 预设 + 旧名迁移；
  GLM 二值思考；环境信息 tab。教训：vite 不查未定义标识符（`nothing` 未导入致设置页崩）——发版前 CDP 冒烟关键入口。
- **阶段 12**：加号菜单、目标横幅（官方 /goal 命令）、`/ 命令补全`（commands.list）、沙箱 UI、审批三态；
  `app.commandLine.appendSwitch("lang","zh-CN")` 强制中文 locale。教训：i18n 插入锚点 bug 曾把 63 个英文值插进 zh 区
  → 现有 `i18n.test.ts` 源码审计防回归（zh/en 键集合一致、无重复、分区语言正确）。
- **阶段 13**：chat-ui typecheck 假检查（--noCheck）改真检查，303 错清零并接入 `npm test`
  （其中含真 bug：`config-form.node.ts` 调用了不存在的 `renderFields()`，假检查掩盖）；
  官方 control-ui 死代码 18 文件清除；`scripts/lib/kernel-prune.js`（升级后内核树裁剪，
  **实测 300.2MB → 203.8MB，省 96.4MB**；不含 CryoClaw 专属白名单防双源漂移）。
- **阶段 14**：内核 `tools.exec.mode` 只接受 `deny|allowlist|ask|auto|full`——UI「完全同意」= `full`，
  存量 `approve-all` 由迁移归一；`settings:get-advanced` 返回 `{success,data}` 包装，必须经 ipc-bridge 解包；
  `src/docker-check.ts` 沙盒前置守卫（无 Docker 拒绝启用，DOCKER_UNAVAILABLE）。
- **阶段 15**：会话管理并入侧边栏 ⋯ 菜单（置顶/已读/重命名/归档/删除）+ 搜索 + 归档切换；
  执行权限三态与「引用技能」（skills.status，`@技能名 ` 插入草稿）入加号菜单；对话页去卡片化。
- **阶段 16（架构重构）**：`views/registry.ts` 视图 id 唯一事实来源（接线点 4+1 → **3 处**）；
  app-render.ts 2271 行 → 拆 8 模块剩 ~380 行；styles.css 11101 行 → styles/ 14 分块（hub 保序，等价 diff 零差异）；
  i18n 拆 zh.ts/en.ts；IPC 113/113 全部 sender guard；**消息级 usage footer + 模型标签**
  （内核 chat.history 投影保留 assistant 的 usage/cost/model，responseUsage 开关无需打开）。
  顺手修复：app-gateway hello 处补 loadChannels（cron 渠道下拉为空的潜伏 bug）。
- **阶段 17**：思考强度接内核——会话行自带 `thinkingLevels[{id,label}]/thinkingDefault/effectiveThinkingLevel`，
  UI 直接渲染内核列表，`sessions.patch {thinkingLevel}` 持久化（`chat/thinking-levels.ts`，provider 硬编码仅兜底）；
  单工具直接显示详情（`chat/tool-summary.ts`，如「exec · npm test」）；阅读指示器阶段化（思考中…/调用工具 xx…）。
  死代码清理：focusMode 死路径、disabledReason 恒 null 链路、**审批全局遮罩弹窗已删**（保留内嵌 strip，
  勿恢复双轨）。
  （注：本阶段的石墨色系设计语言已被 R2 冰蓝 TraeWork 取代。）
- **阶段 18**：图文混排——内核图片 block url 是 gateway 相对路径且**强制 Bearer header** →
  `chat/managed-media.ts`（fetch→blob object URL，缓存 100）+ `<oc-managed-img>`（点击就地放大）；
  本轮改动文件列表 `chat/file-changes.ts`（按组扫描 tool cards 派生 added/modified/deleted，默认折叠；
  受 200 条历史窗口限制，窗口外 write 倾向判 added）；删除「教程文档」「反馈」模块（全自研，内核零依赖）。
- **阶段 19**：审批面板 grid 陷阱——`display:grid` 单列默认 max-content，长命令撑爆面板 →
  `grid-template-columns: minmax(0,1fr)` + 子项 `min-width:0`（同类陷阱：cron 表单已同修）；
  审批决议必须按 entry.id（否则恒批 queue[0]）；token 日志脱敏 `sanitizeLogText`（`[?&]token=` → ***，
  message 与 sourceId 双脱敏）；死 CSS ~2500 行清除。
  仍有效范式：长轮询/在途请求用代际守卫防泄漏（weixin 扫码、managed-media）；退出前 `closeAllConnections`
  （SSE 会挂起 quit）；reset-config 用 `app.quit` 不用 `app.exit`（防 gateway 孤儿）；
  打包下载原子写（.partial+rename）；dist-win 加载 .env.build 且 process.env 优先。
- **阶段 20**：`update_plan` 计划悬浮面板（开关 `tools.experimental.planTool`，kimi-coding 需显式开启，
  迁移已处理存量）；工具卡三态（result 事件 `data.isError` → ✗ 红）；错误卡片化。
  （注：本阶段图标产物已被 R1 冰蓝图标取代。）
- **阶段 21**：队列行内编辑 / 「立即发送」直发内核（**关键：直发走 preserveRunState，否则进行中 agent 事件被过滤**）；
  fallback 提示（lifecycle 流 phase=fallback/fallback_cleared → toast）；`src/provider-key-mask.ts`
  apiKey 掩码（前4+***+后4，R4 计划随 config.patch 化退役）；`confirm-dialog.ts` 替换 9 处原生 confirm()。
- **阶段 22（打包安全，严重历史遗留）**：electron-builder **平台级 files 会覆盖而非合并全局 files**——
  纯否定模式被自动补 `**/*`，曾致整个项目根（含 .env.build、.cache、resources/targets）打进 app.asar（571M）。
  修复后 asar 4.1M、安装包 130.6MB（gotchas #61/#62）。plugin.approval 入队修复
  （skill_workshop 审批走 plugin.approval.requested，70s 超时，此前不弹窗必错过）。

## 👀 Watch list / 遗留事项

**每次内核 bump 时核对**（内核升级兼容）：
- `OPENCLAW_SKILLS_ALLOWLIST` / `OPENCLAW_EXTENSION_ALLOWLIST` 对照上游 skills/extensions 目录更新（上游新增会被静默裁剪）。
- `carryOverInjected`（kernel-update.mjs）只搬运 `skills/` 与 `dist/extensions/`——上游布局再迁移需人工核对，抽查新 asar 内注入插件（kimi-search / dingtalk-connector / @openclaw/* vendor；kimi-claw 已于 R7 移除）。
- `verifyOutput` 对 bundled extensions 有 `extensions/` 与 `dist/extensions/` 双路径 fallback，再迁路径则扩展。
- `kernel-prune.js` 裁剪路径（koffi/ffmpeg/pdf-parse）与新包结构兼容（路径变化时静默跳过，不破坏升级）。
- 官方 issue #65444 lazy channel connect 是否落地——落地后开启可显著加速 gateway 就绪（当前 ~22s 全部耗在内核渠道初始化）。
- RPC 契约变化：sessions.list 排序/分组新参数、task 事件新 action（未知 action 已全量重拉兜底）。

**记录在案的遗留**：
- ✅ **OneClaw 已于 2026-08-11 完成迁移并卸载**：内核态 `~/.openclaw` 本就两代共享（会话/渠道/凭据无缝继承）；`oneclaw.config.json` 首启自动迁为 `cryoclaw.config.json`；OneClaw 内核备份搬至 `%LOCALAPPDATA%\CryoClaw\kernel-backup`；UI 偏好 theme=system 经 CDP 合并落盘；OneClaw 应用静默卸载、AppData 三目录与 out/ 下 809/810/811 旧安装包移回收站；清理后 gateway 200 复验通过。教训：localStorage 合并须「静置→setItem→`window.cryoclaw.quit()` 优雅退出」才落盘，`taskkill /F` 会丢写（脚本 `.cache/migrate-theme-v2.js` / `post-cleanup-verify.js`）。
- ⚠️ **用户行动项（待核）**：v2026.809 前的历史安装包含 `.env.build`（CRYOCLAW_KIMI_CLAW_REFRESH）——若曾上传 CDN/分发，需轮换该凭证（旧包已移回收站，可清空回收站彻底销毁；kimi-claw 插件已于 R7 移除，该 env 随之作废）。
- Ctrl+S steer 真·插入当前回合需内核支持（内核 WS 是 followup 语义，「立即发送」已是最接近实现）；队列重排低优先未做。
- PATH 上 npm 全局 openclaw 可能遮蔽 CryoClaw wrapper（install-detector 已在 Setup 检测提示，代码层无法根治）。
- 会话菜单 `--up` 翻转在极端时序下取不到元素则保持默认向下（优雅降级）；计划面板与顶部错误条同现叠放已修（chat.css `.chat:has(.plan-panel)` 避让规则）。
- 历史消息里旧 `MEDIA:<路径>` 纯文本残留已修（v2026.811.8，应用户要求推翻原「有意决策」）：`chat/media-enhance.ts` 两段式——字符串层 `renderMediaMarkers` 在 sanitize 后/linkify 前替换为 `<img file://>`（先于 path-linker 否则路径被拆进 <a>；pre 内不渲染），DOM 层 `enhanceMedia` 挂失败回退原文，灯箱点击用 document 级事件委托（逐元素绑定会被 lit 流式重渲染丢监听，CDP 实测发现）；配套 8 用例。
- 会话 rewind/fork 的 restore/branch 两条路径**已完成真机联调**（R11-B，2026-08-13：压缩→回放→续聊→分支→持久化全链路 PASS，脚本 `.cache/cdp-8119-rewind.js`）。
- ⚠️ **R11-B 新发现**：主会话（`agent:main:main`）场景下 `chat.history` 读取存在滞后（RPC 轮询 150s 仍返回旧计数；UI 终态刷新读滞后历史导致气泡数短时回退 8→7、9→2）；新会话场景不复现。疑与主会话 legacy-key/store 迁移读取路径有关。影响：主会话 turn 刚结束时消息可能短暂“消失”，下一次刷新恢复。建议后续：内核侧只读取证 `loadSessionEntry` 主会话路径 + 双连接对照实验；UI 侧可评估终态刷新改“本地消息与 history 合并”而非整体替换。
- 会话 rewind/fork UI 细节待打磨（R11-B 顺带发现，未修）：回放/分支成功后 popover 不自动收起、checkpoints 列表不刷新；回放成功后侧边栏 sessions 列表未刷新（updatedAt/label 滞后）。低优先级。
- 阶段 17 附带发现 `.chat-session` 疑似死样式已核：全 repo 无此样式定义与引用（早已随重构清除），结案。
- 会话管理页 `includeDerivedTitles` 每行多一次 8KB 文件读——会话量极大时注意内核默认 limit（待核）。

**候选功能（取证过、未做，按需立项）**：
- `terminal.*`（内嵌终端）、worktrees / environments、完整语音会话 UI（tts 运行时/talk.realtime 只有 config.patch 写路径）。
- 已发送文件附件卡片化（需先解决 gateway 发送契约一致性，阶段 20 挂账）。
- installer 体积主体仍是 gateway.asar（R6 后 237.6MB）+ runtime；CryoClaw 侧三项裁剪目标已全部落地。
- tree-sitter-bash parser.c 9.4MB、typescript/lib 14.7MB（内核运行时依赖，勿动需先取证）；
  @lydell 的 .pdb 调试符号已于 R15 裁剪落地（非候选）。
