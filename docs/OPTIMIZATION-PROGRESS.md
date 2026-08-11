# CryoClaw 优化工程 — 进度追踪（断点续作锚点）

> 新接手的模型/工程师：**先读「快速上手」+「关键路径地图」+「下一步计划」**，
> 再按需查「CryoClaw 重设计工程记录」（最新锚点）与「历史档案」（已验证事实，避免重复调查）。
> 创建：2026-07-29；最近重写：2026-08-11（压缩版，替代原 1641 行长文）。

## 🚀 快速上手（必读）

**项目一句话**：**CryoClaw**（原 OneClaw，已完成更名）——基于 openclaw 内核的高效、易用、纯净 harness。
形态：Electron 桌面壳 + 自研 **Lit + Vite** chat-ui，经 gateway WebSocket RPC 与内核通信（file:// 加载）；
面向国内生态（Kimi / Moonshot / 飞书 / 企微 / 微信 / 钉钉 / QQ）。

**当前状态**：
- 更名 CryoClaw 完成；CryoClaw 重设计工程 **R1 / R1.5 / R2 / R3A–R3E / R4 / R5 / R6 / R7 / R9 / R10 全部完成**（见下节），最新版 v2026.811.7。
- 内核 openclaw **2026.7.1-2**（版本 pin 在 package.json `cryoclaw.openclaw`）。
- 测试基线 **439 pass / 0 fail / 4 skipped**（vitest 94 + node 64/68 + chat-ui 234 + scripts 47 + tsc typecheck；
  chat-ui 234 含 markdown 渲染引擎增强 5 用例 + KaTeX 公式识别启发式 4 用例；scripts 47（上游 build-release 工作流删除后同步移除其 Volcano env 映射用例）；0 fail 为硬指标）。
- 历史优化阶段 1–22 全部完成并逐版发版至 v2026.811.0（见历史档案）。
- 已开源发布至 GitHub（binchen6/CryoClaw，AGPL-3.0-only）；发布时以全新干净历史快照推送，旧本地历史（含已作废的 kimi-claw REFRESH 凭证）不出仓；`.env.build` 已转 gitignored，模板见 `.env.build.example`；git 身份统一为 binchen6。CI：`tests.yml` 每次 push/PR 全量回归（chat-ui/ui 独立依赖树需先安装）；上游签名/CDN 发版链 `build-release.yml`/`publish-release.yml` 已删除（依赖上游 oneclaw 签名证书与 oneclaw.cn CDN，本 fork 不适用，发版走本地 dist:win + gh release）。

**常用命令**：
- 构建：`npm run build`（vite chat-ui + tsc 主进程）
- 测试：`npm test`（vitest + node:test 编译前清空 .test-dist + chat-ui typecheck&测试 + scripts）
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

## 🗺 关键路径地图（改动前必读）

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
- **本机用户配置**：`~/.openclaw/openclaw.json`；`cryoclaw.config.json` 有 `"updateChannel": "off"`（待核）。

## ✅ 测试体系（勿重复搭建）

- 基线 **431 pass / 0 fail / 4 skipped**；4 skipped 均为 Windows 平台门控跳项，正常。
  历史演进：142 → 185 → 194 → 288 → 320 → 334 → 391 → 400 → 418 → 425 → 449 → 429
  （R7 移除 kimi-claw 插件同步删除其 20 个测试所致，非回归）→ 439（R4 W2a）
  → 427（R4 W2b 删 3 个旧 config 测试文件 node -13；chat-ui 224 含 tab-channels.lib
  31 用例与 R5 性能用例 chat-memo / markdown 防污染 / usage-refresh / sessions in-flight）
  → 430（R6 scripts +3：pruneNonTargetNativePlatformPackages / prunePluginNodeModules /
  kernel-prune 嵌套平台包）→ **431**（R9 chat-ui +1 文件 model-org.lib：分组 CRUD/排序/
  指派/prune/分桶 7 组断言；0 fail 为硬指标）。
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

## 🧊 CryoClaw 重设计工程记录（R1–R6，最新锚点）

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

### R10 · 开源后持续迭代（进行中，随阶段发版）
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

## 📋 下一步计划（未做，按优先级）

（R8 已取消、R9 已完成——当前无排期任务，按需立项。）

### R8 · 插件管理页面（已取消）
- ~~设置页新增插件管理 tab~~：已取消立项，不做任何接线。

## 📦 发版与实测经验（套路已验证多次）

- 发版链路：`npm run build` → `npm run dist:win` → 静默安装 → 启动验证（gateway `GET http://127.0.0.1:18789/` HTTP 200）。
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
- device token 明文存 localStorage（file:// 同分区共享）——威胁模型低，如需可改主进程保管（待核，阶段 19 审查遗留）。
- `handleOpenWebUI` 把 token 拼进外开 URL query（loopback，已有 openWebUI 优先通道；阶段 21 评估收益不成比例，维持现状）。
- Ctrl+S steer 真·插入当前回合需内核支持（内核 WS 是 followup 语义，「立即发送」已是最接近实现）；队列重排低优先未做。
- PATH 上 npm 全局 openclaw 可能遮蔽 CryoClaw wrapper（install-detector 已在 Setup 检测提示，代码层无法根治）。
- 会话菜单 `--up` 翻转在极端时序下取不到元素则保持默认向下（优雅降级）；计划面板与顶部错误条同现叠放已修（chat.css `.chat:has(.plan-panel)` 避让规则）。
- 历史消息里旧 `MEDIA:<路径>` 纯文本残留仅按路径链接展示，不做本地文件 img 兜底（有意决策）。
- 会话 rewind/fork 的 restore/branch 两条路径未做过真机联调（阶段 2 挂账，待核）。
- 阶段 17 附带发现 `.chat-session` 疑似死样式已核：全 repo 无此样式定义与引用（早已随重构清除），结案。
- 会话管理页 `includeDerivedTitles` 每行多一次 8KB 文件读——会话量极大时注意内核默认 limit（待核）。

**候选功能（取证过、未做，按需立项）**：
- `terminal.*`（内嵌终端）、worktrees / environments、完整语音会话 UI（tts 运行时/talk.realtime 只有 config.patch 写路径）、
  wizard 运行时、device/node 管理——阶段 17 取证为「低价值或高成本」，未接入。
- IPC 通道按 webContents 来源细粒度授权（当前 assertTrustedIpcSender 只校验是否 chat-ui，
  未区分 setup 窗口等来源；架构性改动，需逐 handler 评估）。
- 已发送文件附件卡片化（需先解决 gateway 发送契约一致性，阶段 20 挂账）。
- installer 体积主体仍是 gateway.asar（R6 后 237.6MB）+ runtime；CryoClaw 侧三项裁剪目标已全部落地。
- gateway.asar 内残余可裁候选（R6 取证顺带发现，未做）：@lydell/node-pty-win32-x64 的
  conpty.pdb + conpty_console_list.pdb 共 10.3MB（调试符号，运行时无用）；tree-sitter-bash
  parser.c 9.4MB、typescript/lib 14.7MB（内核运行时依赖，勿动需先取证）。
