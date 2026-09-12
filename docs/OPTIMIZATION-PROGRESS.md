# CryoClaw 优化工程 — 进度追踪（断点续作锚点）

> 新接手先读「快速上手」+「关键路径地图」+「下一步计划」，再按需查「工程记录」与「既有事实」。
> 当此文档过长时，请将过时记录归档或简化。

## 🚀 快速上手

**项目一句话**：**CryoClaw**（原 OneClaw，已完成更名）——基于 openclaw 内核的高效、易用、纯净 harness。
形态：Electron 桌面壳 + 自研 **Lit + Vite** chat-ui，经 gateway WebSocket RPC 与内核通信（file:// 加载）；
面向国内生态（Kimi / Moonshot / 飞书 / 企微 / 微信 / 钉钉 / QQ）。

**当前状态**：
- 重设计工程 **R1–R72 完成**（R72：内核 2026.9.3 适配（Node runtime 22→24）+ 词条覆盖/长文案溢出审查 + 性能与内存批次 + 死代码清理；R71：故障路径审查——网关崩溃自动恢复；R70：交互级页面审查（新增发版固定步骤）+ 确认弹窗 Escape 修复；R69：无障碍批次——模态键盘关闭/焦点 + 可交互行键盘可达；R68：WebBridge 修复永久化——可自动更新的远端钉定清单；R67：第二轮功能/页面审查（P0 安装向导模型控件 + 9 项）；R66：WebBridge 钉定表随上游轮换 + 功能/页面审查 17 项修复；R65：WebBridge 供应链钉定；R64：三路全库审查 + UI 截图 QA；R63：MCP 页重叠修复 + 真静默更新换装；R62：回底按钮 + 消息对齐及时性；R61：内核问答卡片；R60：设置页 MCP 与 Hooks + 四路全库审查；R59–R58：在途输出恢复/对齐用量，详见工程记录），最新发版 **v2026.911.0**。
- 内核 openclaw **2026.9.3**（版本 pin 在 package.json `cryoclaw.openclaw`，捆绑 runtime Node **24.21.0**——2026.9.3 起 engines 剔除 Node 22/25 线；更新目标走 `kernel-channel.json` 策展渠道，minSupported 2026.7.0）；**Electron 43.4.0**（audit 0 漏洞）。
- 测试基线 **1074 pass / 0 fail / 4 skipped**（vitest 159 + node 191 + chat-ui 645 + scripts 79；2026-09-11 实测，0 fail 为硬指标）。
- 重复率 **1.17%**（96 clones，阈值 5%，`npm run dupcheck` 防回退）；视图 id 收敛为 6（chat/setup/settings/workspace/tasks/extensions）。
- 开源：GitHub `binchen6/CryoClaw`（AGPL-3.0-only，干净历史）；发版走本地 `dist:win` + `gh release`；CI `tests.yml` 每次 push/PR 全量回归。

**常用命令**：
- 构建：`npm run build`（vite chat-ui + tsc 主进程）
- 测试：`npm test`（vitest + node:test + chat-ui typecheck&测试 + scripts）
- 重复率：`npm run dupcheck`
- 打包（Win x64）：`npm run dist:win`（串联 build → package:resources → electron-builder，自动注入 .env + npmmirror + `--use-system-ca`）
- 安装：`out/win32-x64/CryoClaw-Setup-<v>-x64.exe /S`（先清残留进程，见 gotchas #53；安装目录 `%LOCALAPPDATA%\Programs\CryoClaw`）
- 发版：改 `package.json` version + `release-notes.json` 条目（日历版本 YYYY.MMDD.N）→ commit → push → dist:win → `gh release create`；**顺手同步 `website/index.html` 的版本徽章硬编码 fallback**（`hero-version` / `download-version`，P6）

**关键约束**：
- 只改 CryoClaw 自己的代码；内核 openclaw（gateway.asar 内 dist）**零改动**，仅可只读取证。
- 不 git commit（除非用户明确要求）。
- 新敏感 IPC 通道必须加 `assertTrustedIpcSender`（src/ipc-sender-guard.ts）。
- **UI 规范**：2026.9 R2b——中性灰 + CryoBlue 蓝青混色强调色（`shared/design-tokens.css`，浅色主色 brand-600 `#1a6fd0`，辅色 cyan `--accent-2`；签名渐变蓝→青仅用于品牌时刻），浅色为一等主题；图标全部自绘（CryoIcons，`icons.ts`，24 网格/2px 描边/currentColor）；样式走 design token / cc-* 原语；**禁止硬编码 hex**；按钮右对齐。规范全文见 `docs/design-guidelines-zh.md`。
- 布局：顶部沉浸式 titlebar 44px，浮层 top ≥ 56px；窄窗（≤768px）media query；grid 防溢出 `minmax(0,1fr)` + `min-width:0`。

**文档导航**：

| 文档 | 用途 |
|---|---|
| `CLAUDE.md` / `AGENTS.md`（symlink） | 项目硬规范 |
| `docs/architecture.md` | 架构分层说明 |
| `docs/ipc-api.md` | 主进程 IPC 通道清单 |
| `docs/gotchas.md` | 98 条已验证坑（改代码前搜一遍） |
| `docs/design-guidelines-zh/en.md` | 2026.9 R2b 设计规范（中性灰 + CryoBlue 混色 token + CryoIcons 图标规范） |

## 🗺 关键路径地图（改动前必读）

| 区域 | 路径 | 说明 |
|---|---|---|
| 主进程 | `src/main.ts` / `gateway-process.ts` / `preload.ts` / `ipc-sender-guard.ts` | Electron 壳；IPC 白名单；敏感通道必须过 sender guard |
| 应用配置 | `src/cryoclaw-config.ts` | 配置文件 `cryoclaw.config.json`，读取 fallback 旧名；含 gatewayControl token |
| 内核配置迁移 | `src/openclaw-config-migration.ts` | 规则列表，启动时 + 内核升级后双调用点；规则：删 `agents.defaults.llm`、deepseek 旧名、`approve-all→full`、planTool 显式开启 |
| CLI 集成 | `src/cli-integration.ts` | 生成 `%LOCALAPPDATA%\CryoClaw\bin\openclaw.cmd` wrapper（拦截 update / gateway）；reconcile 自愈；cmd `%` 双写转义（R25） |
| provider 配置 | `src/provider-config.ts` / `src/settings-ipc.ts`（薄注册） | 模型读写已切内核 `config.get`/`config.patch`（chat-ui `controllers/config.ts`）；主进程仅留 verify-key 探测 + kimi-code sidecar |
| 内核打包 | `scripts/package-resources.js` | 下载 openclaw（版本 pin）→ 6 个 asar 边界补丁（幂等，未命中 die，R25）→ gateway.asar；skills/extension 白名单裁剪 |
| 内核升级器 | `scripts/updater/kernel-update.mjs` + `src/kernel-updater.ts` + `scripts/lib/kernel-dist-patch.js` / `kernel-prune.js` | 差分 asar 换装/回滚；注入物 `cryoclaw-*` 双名识别；编排带 15 分钟整体看门狗（R25） |
| gateway CLI 托管 | `src/gateway-control-server.ts` + `scripts/updater/gateway-ctl.mjs` | 127.0.0.1:17893+ 递增端口；GET /gateway/status + POST /gateway/restart |
| 沙盒守卫 | `src/docker-check.ts` | 启用沙盒前探测（8s 超时、60s 缓存）；不可用拒绝写入 |
| chat-ui 视图 | `chat-ui/ui/src/ui/views/` + `controllers/` | views 纯渲染，controllers 封装 RPC |
| 视图接线 | `app-render.ts` + `views/registry.ts` | 视图 id 唯一事实来源；**新视图接线点 3 处**（gotchas #49） |
| 样式 hub | `chat-ui/ui/src/styles.css` | **只做 @import，层叠顺序敏感**：design-tokens → tokens-ext → base → **primitives** → **utilities** → chat/components/panels/sidebar/skills/compose/workspace/cron/misc/panel/plan →（末尾）settings → setup |
| 设计 token | `shared/design-tokens.css` + `styles/tokens-ext.css` | 中性灰 + CryoBlue 混色；兼容别名 --accent/--bg |
| 契约组件 | `styles/primitives.css` | cc-btn/cc-input/cc-card/cc-dialog/cc-tag/cc-menu/cc-alert/cc-skeleton/cc-table/cc-tabs/cc-chip |
| 进度/坑 | `docs/OPTIMIZATION-PROGRESS.md` + `docs/gotchas.md` | 本文件 + 98 条已验证坑（gotchas 为准） |

## ⚙️ 运行机制既有事实（勿重复调查）

- **CLI 链路**：`openclaw` → `bin\openclaw.cmd` → `CryoClaw-CLI.exe`（CONSOLE 子系统）+ `ELECTRON_RUN_AS_NODE=1` → `gateway.asar\node_modules\openclaw\openclaw.mjs`。换装 asar 不影响 CLI 路径；PATH 上 npm 全局 openclaw 可能遮蔽 wrapper（watch list）。
- **安装产物 `runtime/` 无 node.exe**（afterPack 删除，npm.cmd/npx.cmd 重写为 Electron 代理）：运行时脚本一律 `CryoClaw-CLI.exe` + `ELECTRON_RUN_AS_NODE=1`；`runtime/.npmrc` 指向 npmmirror。
- **内核版本唯一事实来源**：`gateway.asar\node_modules\openclaw\package.json` 的 version；About 页即读此处。
- **打包期对内核 dist 的全部改写**（运行时升级须复现相关子集）：windowsHide 注入、asar 边界补丁 6 类、builtin skills 注入、插件注入 + dingtalk shim、7 个 `@openclaw/*` vendor、esbuild 重 bundle、koffi/node_modules 裁剪。
- **应用不自动更新**（自身检查更新已删）；只有内核升级器。入口两个：设置-关于页「内核升级」（IPC `kernel:check/update/rollback`，JSONL 进度 `kernel:update-progress`）、CLI `openclaw update [--tag v] [--rollback]`。App 自动更新（electron-updater → GitHub Releases）在 R20 重新引入，换装自实现（#67）。
- **打包 env**：`CRYOCLAW_TARGET=win32-x64`；镜像 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` 指向 npmmirror；`NODE_OPTIONS="--use-system-ca"`（dist:win 自动注入）。
- **本机用户配置**：`~/.openclaw/openclaw.json`；`cryoclaw.config.json` 有 `"updateChannel": "off"`。

## ✅ 测试体系（勿重复搭建）

- 基线 **1034 pass / 0 fail / 4 skipped**（vitest 159 + node 180 + chat-ui 618 + scripts 77；0 fail 硬指标）。
- 基础设施：`tsconfig.test.json`（outDir `.test-dist/`）、`vitest.config.ts`（vitest include 列表）、`scripts/run-node-tests.js`（编译前清空 .test-dist，排除 vitest 文件）、npm scripts `test` / `test:unit(:vitest|:node)` / `test:scripts` / `test:typecheck`。
- **chat-ui 用真 typecheck**（阶段 13 起接入；旧 `--noCheck` 假检查曾掩盖 303 个类型错误）。
- `i18n.test.ts` 源码审计：zh/en 键集合一致、无重复键、分区语言正确。
- 新增 vitest 文件需三处同步：`vitest.config.ts` include、`run-node-tests.js` 排除名单。

## 🔬 内核 RPC 契约要点（2026.7.1-2 取证结论，只读）

- **RPC 全集 237 个方法**（core-descriptors 注册表，唯一事实来源）。
- **sessions.patch**：label/category/archived/pinned/unread/thinkingLevel/verboseLevel/reasoningLevel/responseUsage/model/fastMode 等。**sessions.list**：limit/offset/activeMinutes/includeDerivedTitles/label/search/`archived`（true=**只列已归档**，非包含）。
- **思考强度优先级链**：chat.send {thinking} → /think 指令 → sessions.patch {thinkingLevel} → provider 默认 → 配置默认；基础五档 off/minimal/low/medium/high；**会话行自带 thinkingLevels/thinkingDefault**；provider 硬编码兜底（`chat/thinking-levels.ts`）。
- **流式协议双通道**：chat 事件（delta/final/aborted/error）+ agent 事件（assistant/thinking/tool/item/compaction/lifecycle；lifecycle 含 fallback/fallback_cleared）。
- **消息级 usage/model**：chat.history 投影保留 assistant 的 usage/cost/model，可直接渲染。
- **tasks**：tasks.list/get/cancel；task 事件 `{action: upserted|deleted|restored}`，未知 action 全量重拉兜底。
- **审批**：exec.approval（含 allow-always）与 plugin.approval（only allow-once/deny，timeoutMs 70s）两条链，按 `` `${kind}.approval.resolve` `` 分发。
- **exec 模式**：`tools.exec.mode` 只接受 `deny|allowlist|ask|auto|full`；沙箱 `agents.defaults.sandbox.mode`（off/non-main/all）。
- **图片 block**：`{type:"image", url:"/api/chat/media/outgoing/..."}`，gateway HTTP **强制 Bearer header**，`<img src>` 直连不可行。
- **update_plan**：开关 `tools.experimental.planTool`；参数 `{explanation?, plan:[{step,status}]}`。
- **cron payload**：支持 `agentTurn.model` / `fallbacks` / `thinking` / `timeoutSeconds`。
- **sessions rewind/fork**：`sessions.compaction.list/restore/branch`（restore 对 control-ui client id 豁免）。
- **杂项**：`skills.status`（UI 过滤 disabled/ineligible）；`commands.list {includeArgs:true}`；`models.list {view:"all"}`（5min 缓存）；`config.schema.lookup`；tool result `data.isError`。
- **内核无**：记忆浏览/清空、审批历史查询（list 只返回 pending）、真 steer 插入（WS dispatch 是 followup 语义）、feedback。

## 🧊 工程记录

> **增删规则**：每轮完成在本节末尾追加一个 `### RNN` 小节；里程碑小节完成后压缩进下方表格并删除详录。

### 里程碑记录（R1–R23，全部完成）

| 轮次 | 主题 | 版本 | 关键决策/锚点 |
|---|---|---|---|
| R1 | 更名 CryoClaw | 811.1 | productName/appId/二进制/安装目录全量更名；`window.cryoclaw` 桥；内核 `~/.openclaw`/oneclaw.cn 刻意不动；新图标冰晶+三爪痕 |
| R1.5 | gateway CLI 托管 | 811.1 | `gateway-control-server` 17893+ 递增端口 + token；wrapper 拦截 `openclaw gateway *` |
| R2/R3 | 设计体系 | 811.1 | TraeWork token + 冰蓝 #0EA5E9；浅色默认；cc-* 原语层；9 视图内嵌 CSS 抽到 settings.css/setup.css；设计规范重写 |
| R4 | 设置改造 | 811.1 | 全量切内核 config.get/patch（快照缓存 + baseHash 乐观锁 + 冲突重放）；退役 15 IPC；settings-ipc 拆 11 模块；tab-channels.lib 737 行 |
| R5 | 执行效率 | 811.1 | 流式 O(n²)→纯文本流式（streaming 不解析 markdown）；markdown LRU 防污染 + memo + details 懒渲染；终态单次拉取；主进程 diagLog 异步 |
| R6 | 存储裁剪 | 811.1 | gateway.asar 279.6→237.6MB；vite sourcemap off；嵌套平台包/vendor/插件树裁剪（打包与运行时口径一致，先取证再裁剪） |
| R7 | kimi-claw 移除 | 811.1 | 插件全删（含 20 测试，基线 449→429）；插件 pin 更新 |
| R8 | 插件管理页 | 811.9 | plugins CLI wrapper（90s/8MB）；已安装/ClawHub 市场双视图；启用走 config.patch |
| R9 | 模型分组 | 811.2 | model-org.lib（localStorage 展示层，内核 config 仍是事实来源）；四处选择器联动；教训：输入类 handler 必须 `state.requestUpdate()` |
| R10 | 开源后迭代 | 811.3–8 | markdown GFM/任务列表；代码块复制 + hljs 高亮 + 语言标签；KaTeX；MEDIA 图片渲染；audit 清零；tests.yml CI |
| R11 | 引用/重发 + rewind/fork | 811.9 | 失败重发（resendText）+ 消息引用；rewind/fork 真机联调全 PASS；**发现主会话 chat.history 滞后** |
| R12 | history 滞后兜底 | 811.9 | `mergeIfStale`：滞后短读保留本地 |
| R13 | Electron 43 | 811.9 | 40→43（高危漏洞销账）；42+ 需显式安装二进制（CI 固化） |
| R14/R15 | 易用性/裁剪 | 811.9 | rewind/fork 收敛 + Ctrl+N/L；.pdb 调试符号裁剪 -10.3MB |
| R16 | 发版验证 | 811.9 | NSIS 沙箱安装教训；CI `node node_modules/electron/install.js` |
| R17 | 内核取证 + 插件安全 | 820.0 | 根因：`SESSION_STORE_SNAPSHOT_CACHE` 无 TTL 仅 mtime/size 校验（上游待修）；runtimeId 冲突检测 + stdout 覆盖警告；插件清单 60s 缓存 |
| R18 | 思考档位 + 健壮性 | 820.0 | `patchKimiThinkingProfile`（compat 感知）；对话健壮性 6 项（compaction 替换/跨 run final/僵尸流丢弃/context 解冻/会话过滤/去重指纹/转义）；requestUpdate 批量补 20 处 |
| R19 | 打包顺序回归 | 820.0 | 教训：**验证终点必须是打包产物内容断言**；三层防线（bundle 后重打/未命中大声告警/verifyAsarContents marker 校验） |
| R20 | 性能/更新体系 | 821.2 | Chromium 特性收敛；quit-cleanup；渲染韧性自愈；日志统一 ~/.openclaw/logs + 诊断包；V8 编译缓存；窗口创建提前；app 自动更新（GitHub Releases + 自实现换装，#67） |
| R21 | 能力编辑 | 821.3 | `applyCapabilityOverrides` 单模型能力（上下文/多模态/思考）；分组内新增模型；设置 12 项修复；dingtalk 僵尸字段删；死 i18n key 清理 |
| R22 | 重复代码治理 | 824.0 | jscpd 基线化（阈值 5%）；2.29%→1.22%；6 共享模块；豁免项定案 |
| R23 | 聊天增强批次一 | 824.1/2 | MEDIA 文件卡片；子代理等待卡；流式加固（空读保护/重连重建/800ms 提速）；审查修复（span 段落合法性 + 无状态僵尸卡） |

### R24 · 全面代码审查批次（完成，随 v2026.824.3 发版）

用户指令：不改变功能/视觉/IPC 契约/主进程行为的前提下系统性审查修复。
方法：5 个并行审查代理分区深审约 130 文件，对照 gotchas 69 条，共修复 34 处（32 文件 + 1 新增）。
- **阻塞性 ×2（构建链）**：① package-resources.js ASAR 边界补丁 0 命中仅告警——会静默发出坏包 → 未命中 die（与 kernel-update.mjs 对齐）；② merge-release-yml.js 同版本重建保留旧 exe → 覆盖（哈希一致性）。
- **功能性 ×16**：主进程——错误页 Retry 永无效 → 迁 `assets/error.html`（file:// origin）；kimi-auth-proxy 客户端中断不传播上游（SSE 继续计费）→ `proxyReq.destroy()`；listen 后缺运行期 error 监听；gateway-control persist 泄漏；gateway-auth 静默吞错；**settings/pairing 全项目唯一无超时的子进程调用 → 90s 兜底**；**workspace-ipc symlink 逃逸 → realpath 复核**；settings/advanced precheck lost-update 竞态 → 前移；`formatConsoleLevel` 错误映射（gotcha #47）→ 修正。渲染层——`sendChatMessage` 无会话归属守卫（错误卡/重发串会话）→ 快照守卫；`sendChatMessageNow` 同病 → 快照；`patchSession` 吞错致自动命名重试契约成死代码 → 返回 boolean；代码复制混入语言标签 → `code.textContent`；lightbox 点击关闭泄漏 keydown；`onWebbridgeRepairClick` unhandled rejection。
- **性能 ×8**：logger 轮转计数器卡死（每条日志同步 stat）；gateway-process `execFileSync` 冻结主进程 10s → async；skill-store 响应体无上限 → 8MB；state-archive `cpSync` 冻结 → `promises.cp`；`evictedLeadingSegments` 无上限 → 150 段；tool 消息 key 随 history.length 平移 → 固定基数 1e9；`adjustTextareaHeight` 每帧冗余布局 → 指纹守卫；managed-media 满 100 全清 → 逐出最旧。
- **可维护性 ×8**：legacy stamp 复制粘贴（`.cryoclaw-`→`.oneclaw-`）、build-config 原子写、PowerShell 引号、vendor die 泄漏、幂等 marker 三变体、dist-win `shell:true`、死代码、search query `-` 注入面、rmSync→rmRecursive、sidebar 双调用。
- **新增测试 2 用例**：会话切换守卫、patchSession 返回值。
- **未修项**（后续已闭环：飞书并发上限与 loadTasks 在途排队随 R28、负缓存随 R33、cleanStaleLockfile probe 随 R33、gateway-rpc 已删除随 R33）：导出压缩 worker 化（R33 已 async 化，worker 仍 defer）、kimi-auth-proxy 回环无鉴权。
- **教训**：gotcha #47 修复语义曾被回退——文档记载的修复语义应用单测钉死防回归（候选）。

### R25 · 主进程大文件补审（完成，随 v2026.825.0 发版）

方法：2 个并行代理深审 16 文件（含 browser.ts 37KB / webbridge.ts 30KB / cli-integration.ts 30KB），修复 9 处。
- **功能性 ×5**：① **cli-integration cmd 转义缺口**：`escapeForCmdSetValue` 未转义 `%`——路径含 `%` 时生成的 wrapper 路径段被批处理展开静默吞掉、CLI 硬损坏且不自愈 → 双写 `%%`；② extension-mirror 「永远不抛」契约但 `mkdirSync` 在 try 外——抛错中断启动链路 → 吞错返回；③ extension-mirror 升级「先删后复制」非原子——残缺扩展目录致 channel 被拒（#41）→ 同卷临时目录 + rename 原子换装；④ app-updater 安装无重入保护——双触发并发安装器互踩（#53）→ installing 标志；⑤ kernel-updater `runUpdater` 无整体看门狗——编排永久挂起、用户侧「升级中」卡死 → 15 分钟超时杀进程由上层回滚/恢复接管。
- **稳定性 ×3**：⑥ 用户 rc 文件原地写 → .tmp+rename；⑦ config-backup 恢复路径直写 → 原子写；⑧ browser 探测执行器无超时 → 10s + windowsHide。
- **可维护性 ×1**：⑨ 升级失败后网关恢复失败错误文案透出。
- **无发现区**：analytics / analytics-events / app-updater-state / install-detector / constants / diagnostics-export / provider-image-probe。
- **未修项（候选）**：webbridge 二进制下载无 SHA256 校验（需发布链配合产出哈希清单）。

### R26 · 设置页视图/组件层补审（完成，随 v2026.825.1 发版）

方法：2 个并行代理深审 56 文件（含全仓最大的 tab-provider.ts 83KB/1857 行、setup 向导、cron、skills、components、chat-ui/src 共享层），修复 9 处、否决 1 项误报。
- **安全 ×1**：① setup-step2 手动 custom baseUrl 只做非空校验（Settings 同路径有 `isValidHttpBaseUrl`）——任意字符串可落盘 → 补齐校验。
- **功能性 ×5**：② settings-view 导航回调未校验 `isKnownTab` → 补齐；③ tab-backup 三连网关状态刷新无 try/catch（unhandled rejection）→ 对齐稳态轮询防御；④ resizable-divider 窗口外释放鼠标致幽灵跟随 → `buttons===0` 补偿；⑤ app-skills 商店排序/搜索无代次守卫 → 请求代次 token；⑥ device-identity 首启并发生成密钥对致验签失败 → 并发记忆化。
- **性能 ×1**：⑦ tab-provider `loadAgents` 失败不置标记 → 每次重渲染发必失败 RPC → 60s 冷却。
- **可维护性 ×2**：⑧ `scheduleKind` 类型谎言（`"daily"` 未入联合，三处强转）→ 收录 + 删强转；⑨ setup-step2 恒假死代码删除。
- **否决 1 项**：format-relative dateFallback `en-US`——模块整体输出英文相对时间（`3d ago`），只改此处反而中英混杂。
- **候选（未修）**：app-skills `as unknown as SkillsState` 双重断言（类型层重构另立）；device-auth 签名载荷 `|`/`,` 规范化歧义（需网关侧同步）；设备密钥明文存 localStorage（OS keychain 待评估）。

### R27 · 文档精简重构（完成，随 v2026.825.2 发版）

- `OPTIMIZATION-PROGRESS.md` 从 ~800 行精简重构：里程碑记录（R1–R23）压缩为速查表格；工程记录区确立增删规则（新轮次末尾追加、完成后压缩入表）；头部/路径地图/既有事实/测试体系/契约要点全部保留（断点续作锚点不丢）。
- 无代码改动；随例行验证发版。

### R28 · 历史遗留清理（完成，随 v2026.825.3 发版）
从 R24–R26 未修项中选 3 个低风险可行项实施：
- ① **飞书授权条目名称补全并发限制**（settings/pairing）：`Promise.all` 无上限 → 每批 5 个串行；新环境首次打开不再触发 OpenAPI 限流致名称长期为空。
- ② **loadTasks 在途排队**（controllers/tasks）：在途刷新期间再被请求（如 task 事件）置脏标记、完成后补跑一轮——防旧响应晚到整体覆盖事件增量（列表陈旧最长一个 ticker 周期）。
- ③ **app-skills SkillsState 双重断言收敛**：`AppViewState`（= OpenClawApp 结构类型）本就满足 `SkillsState` 全部字段——删 7 处 `as unknown as` + 1 处冗余强转，契约由编译器接管（typecheck 证明）。
- **仍候选**：webbridge 二进制 SHA256（需发布链哈希清单）；device-auth 签名规范化（需网关侧同步）；设备密钥 OS keychain；导出压缩 worker 化（R33 已 async 化缓解）；kimi-auth-proxy 回环鉴权；IPC 细粒度授权（架构性）。

### R29 · 任务模块跳转会话修复（完成，随 v2026.827.1 发版）

用户指令：任务页「打开会话」跳转到正确对话 + 任务页展示优化。
- **根因**：app-tasks `onOpenChat` / app-cron `onNavigateToSession` 直接 `applySettings({sessionKey})`——只写持久化设置，不切活跃会话（`state.sessionKey` 不变、不重置流态、不拉历史），点击后仍停留旧对话。**修复**：统一走 `handleSessionChange`（与侧边栏点击同一条完整切换路径）。
- **审查发现连带修复**：显式跳转到已归档/被过滤会话后，30s tick 的 reconcile 会把不可见当前会话弹回 main（gotchas #50 语义）→ 新增 `session-jump.ts` 容忍记录（仅显式切换写入；删除该会话时清除），两处 reconcile（app-gateway tick 路径 + app-session-actions 删除路径）均豁免。
- **展示优化**：任务卡片新增耗时徽标（`taskDurationMs`：startedAt→endedAt，进行中用当前时间，终态缺 endedAt 退 updatedAt）；taskTimestamp 单次计算；`toTaskTimestampMs` 统一 number/ISO 解析。
- **测试 +14**：session-jump 纯函数 ×5、taskDurationMs/toTaskTimestampMs ×5、源码审计 ×4（跳转接线钉死 `handleSessionChange`；reconcile 双调用点钉死豁免——审计模式同 i18n.test.ts）。基线 499→513。
- **教训**：handleSessionChange 重依赖链（→ confirm-dialog → toggle-switch 顶层 `new CSSStyleSheet()`）在 node --test 下不可导入——UI 接线回归用源码审计钉住，纯逻辑抽 lean module 单测。

### R30 · 流式中断恢复全面加强（完成，随 v2026.827.2 发版）

用户指令：各种复杂情况下流式输出中断后能及时正确恢复。先取证（流式状态机全景 + 8 类中断场景清单），后实施 7 项：
- **重连续跑恢复**：断连前快照在途 runId 为 orphan（`stream-recovery.ts`，TTL 120s）；重连后同 runId 的 delta（全量累计文本，天然可续）收养为当前 run——流式续显 + Stop 恢复。防线不回退：收养要求 orphan 精确匹配 + sessionKey 前置过滤，非 orphan 外来 delta 仍丢弃。
- **挂起流看门狗**：final/aborted 帧在断连/gap 窗口丢失即永久挂起 → 新增 `chatLastActivityAt` 锚点（delta/tool/thinking 事件刷新，app.ts 非响应式字段），180s 空闲由 tick 触发历史探测，`hasAssistantReplyAfter`（run 开始后落盘的 assistant 回复）为真才清挂起态；探测带 runId+startedAt 双快照防队列冲刷出新 run 被误清（审查发现）。
- **滞后读退避补拉**：mergeIfStale 保留本地后 800/1600/2400ms 补拉（此前无重试，「问了没答」要等下轮终态）；替换成功/会话切走即停。
- **重连读改 mergeIfStale**（防撞上滞后快照视图倒退）；**error/aborted 本 run 无条件补拉历史**（中止前部分回复恢复上屏，外来 run 透传不补拉防 churn）；**gap 耗尽软恢复**（快照 orphan + 清态 + 重拉，此前只显示文案）；**onHello 清态统一走 `resetChatStreamState`**（消双份清理漂移）。
- **取证确认**：内核 transcript `message.timestamp` 为 epoch ms（数值），`hasAssistantReplyAfter` 假设成立。
- **测试 +17**：stream-recovery 纯函数 11 例；chat.test 追加 6 例（orphan 收养/丢弃/过期/终态清快照 + mock.timers 退避补拉链 ×2）。基线 513→524。
- **已知边界**：长 silent run（>180s 无任何事件）期间看门狗每 30s 探测一次，mergeIfStale 不挡等长替换，chatVisibleMessageCount 重置有轻微滚动抖动（既有语义频率放大，可接受）。

### R31 · 聊天/任务交互细节十二修（完成，随 v2026.827.3 发版）

用户指令：优化现有功能细节与交互体验、聊天与任务处理的流畅性。explore 代理摸排 12 条确凿问题，实施 11 项（#9 per-session 队列成本高，记入候选）：
- **草稿保护**：Stop 中止不再清空输入框（清草稿挪到 handleSendChat 的 stop 命令分支）；**切会话草稿/附件按 sessionKey 存取**（session-transition.ts 模块级 Map，空草稿不留条目，deleteSessionFromSidebar 清理，恢复后即删防膨胀）。
- **发送失败闭环**：乐观 user 气泡提取为 `echoMessage` 引用——失败时打 `cryoclawSendFailed` 标记（**只在失败时打**，成功回声若预打标会被 run-error 重发误删已落盘气泡）；重发/队列回退前经共享纯函数 `removeFailedSendArtifacts`（app-chat.ts）连卡带标记气泡一并移除。preserveRunState（队列「立即发送」busy 路径）失败不再注入消息流，撤回乐观气泡只写 lastError（条目回队列兜底）；**空闲路径同样先清残留再回队**（审查 minor 修复，复用同一函数）。
- **队列冲刷补全**：checkStalledStream 看门狗恢复分支与 onHello 重连收尾各加一次 `flushChatQueueForEvent`（内部自查空队列/断连直接返回，首次连接无副作用）。
- **杂项**：showNewMessages 改用 `chatNewMessagesBelow`（app-scroll 维护的「上翻期间来新内容」标记，此前无读取方、误用贴底取反）；任务页状态筛选删冗余 loadTasks（纯客户端过滤）；cron 重复点击收起并清 cronRuns 防旧数据闪现；loadCronRuns 加 `isCurrent` 回调 stale 守卫（展开态在 app-cron 模块级，控制器拿不到故用回调不用快照比对）；侧边栏 cron 徽标不计 `enabled === false`；队列行内编辑清空（无附件）即删除条目。
- **测试 +4**：chat.test 2 例（失败打标记/preserveRunState 不注入）、session-transition.test 2 例（草稿跨会话存取/删除清理）；复审后补 app-chat.test.ts 4 例（removeFailedSendArtifacts 纯函数）。基线 524→528。
- **审查发现未修**（记录在案）：非 deleteSessionFromSidebar 路径删除的会话草稿快照残留到重启（有界、可接受）；runCronJob 内 loadCronRuns 未传 isCurrent（视觉无闪现）；per-session 队列（#9）候选。

### R32 · UI 设计与布局细节（完成，随 v2026.827.4 发版）

用户指令：优化 UI 设计和布局细节。explore 代理全面审计（对照 TraeWork+冰蓝规范）后实施 P0/P1/P2 共 10 项，审查代理复审后修 4 个 minor：
- **分栏溢出（P0 根因）**：窗口最小宽 800px（src/constants.ts WINDOW_MIN_WIDTH）→ 所有 ≤768px 媒体查询永不命中。`.chat-main`/`.chat-sidebar` 的 min-width 400/300 改为 `min(400px,54%)`/`min(300px,44%)`（留 2% 给分隔条）；768px chat-split 全屏兜底块**直接删除**而非改档位——该块 inset:0 会遮住 titlebar 窗口控件（复审发现），且 min() 已根治默认比例溢出。
- **可达性**：settings.css 配对图标按钮 `box-shadow: 0 0 0 2px var(--focus-ring)` 是无效声明（--focus-ring 本身是完整阴影列表）→ `box-shadow: var(--focus-ring)`；oc-toggle-switch 补 role=switch/tabindex/aria-checked/Enter/Space（含 e.repeat 长按守卫）/:focus-visible/aria-label 转发（无 label 时不渲染空 span）；cron-manage/app-skills 两处自绘 checkbox 开关换成 oc-toggle-switch（删两份近逐字重复 CSS），调用方补 aria-label。
- **颜色 token 化**：compose 阴影 rgba→--shadow-lg/--shadow-md（!important 保留并注释：覆盖 ex-redesign 同名规则）；resizable-divider #007bff→品牌蓝；滑块钮 #fff→新增 `--toggle-knob`（tokens-ext :root，双主题恒浅色——暗色下 --text-on-accent 为深青趴在深色 OFF 轨道上不可见，复审 minor）；技能字母头像字色回退 #fff（底色是固定品牌色板不随主题，token 反而降对比度）；glow-pulse 起始帧 #ff5c5c00→transparent。
- **死代码清除**：app-scroll/app-lifecycle/app.ts 的 topbarObserver 死路径（TS 早无 .topbar markup）；base.css 旧 .shell/.topbar/.nav 布局块 + 1100/600/400px 三个永不命中媒体块；panels.css .shell--chat 两条；.chat-new-messages 重复定义合并进 panels.css（层叠胜者，独有属性已并入）。base.css 头注释同步更新。
- **毛边**：cron.css 列表顶部 padding 42px→48px（让开 44px titlebar，与右侧 detail 52px 取齐）；setup.css 进度条 top:0→44px；settings.css 两处 transition:all→具体属性；plan.css 999px→var(--radius-pill)。
- **测试 +6**：toggle-switch.test.ts 源码审计 6 例（switch 语义/键盘/repeat 守卫/aria-label 转发/focus 环/--toggle-knob）。基线 528→534。
- **记录在案候选**（R38 后复核）：tokens-ext 暗色默认值翻转、views 内联 style 间距收敛已随 R38 闭环；base.css 孤儿选择器清除、技能 12 色板合并已随 R33 闭环；仅剩 settings.css 孤 \r 行尾未统一。

### R33 · 可维护性收尾（完成，随 v2026.827.5 发版）

用户指令：优化软件可维护性。explore 代理对 Watch list 候选逐项核实现状后实施 6 项，审查代理复审后补 2 个 minor：
- **cleanStaleLockfile 先 probe 再杀**（R24 候选闭环）：旧逻辑 isProcessAlive 为真就直接 taskkill /F /T，PID 复用时误杀无关进程。现在杀前 `probeHealth()`：HTTP 健康则保留进程与 lockfile，交回 start() 的 stopExistingGateway 优雅停止；探测失败才认定半死强杀。复审补刀：stopExistingGateway 强杀兜底确认端口释放后补删 lockfile（被强杀进程没机会自清，死 pid 锁会阻塞下次启动 exit(1)）。
- **诊断导出 async 化**：zipSync→fflate 异步 zip() + fs.promises.writeFile（主进程不再因 ~10MB 同步压缩/写盘卡顿）；worker 化评估为收益不成比例（数据上限 ~10MB、用户手动低频触发），defer。readLogEntries 同步读盘仍在（记录在案，非阻塞源大头）。
- **飞书名称补全负缓存**：模块级 Map（id→失败时间戳，TTL 10min，纯内存），enrich 跳过 TTL 内失败 id、成功/approve 时删除——失败条目不再每次打开配对页全量重试。风格对齐既有 feishuTenantTokenCache。已知边界：approve 未传 name 时条目残留至 TTL 过期（可接受）。
- **孤儿 CSS 清除 ~430 行**：base.css 603→199 行（旧 shell/topbar/brand/nav/content/page-title/grid/row/stack/filters，逐 class grep + 动态选择器复核零引用）；panels.css `.shell--chat .chat`（活 .chat 保留）；sidebar.css `.shell/.topbar` display:none 中和块（复审发现同族残留）。
- **色板单一来源**：SKILL_AVATAR_COLORS/skillAvatarColor 收敛进 skill-store-view.ts（叶子模块无环），app-skills.ts 删本地副本；已安装视图颜色零变化，商店视图 idx 6/7/9 变化（纯外观）。
- **死代码**：删 src/gateway-rpc.ts（callGatewayRpc 全仓零调用）+ CLAUDE.md/architecture.md 对应条目；删 icons.ts renderIcon（零调用，其引用的 nav-item__icon CSS 随孤儿清理一并消失）。
- **文档债同步**：R24/R26 未修项清单、Watch list 候选列表按实际闭环状态重写（审查 minor）。
- 基线不变 534 全绿（纯删减+加固，无新测试件）；重复率 1.01%。
- **仍候选**：kimi-auth-proxy path secret 回环鉴权（中风险，~30 行 backlog）；settings.css CRLF/LF 混排统一（diff 噪音大 defer）。~~tokens-ext 暗色默认值翻转~~、~~views 内联 style 收敛~~ 已随 R38 闭环。

### R34 · 应用更新策略与进度提示（完成，随 v2026.827.6 发版；二期 P1）

二期立项首项：优化软件更新策略和进度提示。实施 coder 代理 + 审查代理复审（无 blocker/major），主代复审后修 1 个 minor：
- **更新检查策略**：启动后 ~15s 静默检查一次（`unref`、仅 packaged 创建、stopAppUpdater 清理）。~~4h 周期复查~~ 用户要求去除（v2026.827.6 后随下一版移除，连带的 `shouldSkipPeriodicAppUpdateCheck()` 及 3 例周期测试一并删除；保留启动时检测+自动下载+「重启更新」提示链路，设置页手动「检查更新」保留）。
- **更新提示链路**：chat-ui `bindAppUpdateState()`（connectedCallback 挂、防重入、disconnectedCallback 清理）+ `appUpdateBadge` 响应式字段 → 侧边栏设置入口「更新」角标（available/downloading/downloaded 三态常驻）；「重启更新」toast 带 action 常驻（`restartToApplyUpdate()` → `appUpdateQuitAndInstall`）。**复审 minor 修复**：常驻 toast 被后续普通 toast 覆盖后不再回来 → 条件补 `getToastMessage() === null`（同态且无当前 toast 时补弹）。
- **toast 系统重写**（app-toast.ts）：ToastAction/getToastAction/hideToast/getToastMessage 导出；带 action 的 toast 常驻不自动消失，普通 toast 4s。
- **关于页更新日志**：tab-about.ts 渲染 releaseNotes（getLocale 取 zh/en）、error 显示 `us.error` + 「重试」、进度条抽 class、「查看更新日志」按钮；`app:get-release-notes` 支持 `opts.all`（不碰 lastShownReleaseNotesVersion）。
- **启动+托盘**：main.ts 启动 +30s 静默 checkKernelUpdate；push 回调同步 `tray.setAppUpdateReady`；tray.ts downloaded 态加「重启以更新」菜单项。
- **接线**：preload.ts/ipc-bridge.ts bridge 扩展；i18n 新键 zh/en 齐全（sidebar.updateBadge、settings.about.appUpdateRetry/appUpdateReleaseNotes/viewReleaseNotes/releaseNotesEmpty、appUpdate.toastDownloaded/toastRestart/restartFailed）。
- **测试 +9**：node +3（77）、chat-ui +6（320，新增 app-update-notify.test.ts 源码审计 6 例）。基线 534→543 全绿；重复率 1.005%。
- **不修记录在案**：渲染进程重建导致 downloaded 边沿重弹（可接受）；kernel 30s timer 无退出清理（unref 足够）；checkAppUpdate 无并发守卫（概率极低）。

### R35 · 已发送附件卡片化 + 更新策略调整（完成，随 v2026.827.7 发版；二期 P2）

用户指令：已发送文件附件卡片化；另要求「去掉自动检查和下载更新，只在启动时检测」（确认保留启动时检测+自动下载）。explore 代理前置取证（内核 asar 解包确证 schema/上限）→ coder 实施 → 审查代理复审（无 blocker，修 2 major + 1 minor）：
- **文件附件走 base64 apiAttachments**：controllers/chat.ts sendChatMessage 文件附件逐个经新 IPC `file:read-base64`（main.ts，assertTrustedIpcSender + stat 预判 + 读后复核 TOCTOU 兜底）读盘编码，`{type:"file", mimeType, fileName, content}`；内核 offload media store，transcript 落顶层 MediaPaths/MediaTypes。mime 映射/路径校验/16MB 上限在纯函数 src/file-read-base64.ts。
- **乐观气泡与历史同构**：echoMessage 挂顶层 MediaPaths（本地 filePath）/MediaTypes 平行数组；grouped-render.ts 消费（兼容单数 MediaPath/MediaType）渲染附件卡片（`name---uuid.ext` 剥 uuid 段还原原名，media-attachments.ts 纯函数）；image/* 渲 `<img class="chat-attachment-image">`（onerror 降级卡片），复用 media-enhance 卡片样式/打开定位委托；**顺手修复已发送图片/文件刷新丢失**（此前 chat-ui 无人消费 MediaPaths）+ 附件图片并入 lightbox 点击委托（审查 minor）。
- **降级与预算**：单文件 >16MB（base64 后 ~21.9MB < WS 25MB 帧）或读取失败 → 旧版路径文本前缀 + toast；**累计帧预算 23MB**（图片 base64 计入，审查 major——多附件累计超限必败且重发死循环，现后续文件自动降级）。
- **重发链路修复**：错误卡带 resendAttachments（app-chat.ts messageOverride 分支允许 opts.attachments），重发按 filePath 重新读盘（文件已删自动降级）；已降级文件不带回防路径文本重复。
- **更新策略调整**：删 4h setInterval/PERIODIC_CHECK_INTERVAL_MS/periodicTimer/shouldSkipPeriodicAppUpdateCheck 及 3 例周期测试；仅启动 +15s 检测一次，autoDownload 与重启提示链路不变。
- **安全决策记录**：file:read-base64 是任意绝对路径读取原语（≤16MB/次），assertTrustedIpcSender 只放行 file:// 主 frame；XSS 滥用面已写进 handler 注释 + docs/ipc-api.md（审查 major 闭环：后续可加 picker 路径白名单收紧）。
- **测试 +29**：file-read-base64.test.ts 7、media-attachments.test.ts 6、attachment-cards.test.ts 12（含 lightbox 委托审计）、controllers/chat.test.ts +4（base64 发送/超限降级/错误卡附件/累计帧预算）。基线 540→566 全绿；重复率 1.012%。
- **不修记录在案**：降级文件乐观气泡双重呈现（路径文本+卡片，刷新后只剩文本）；restoreMediaFileName 对巧合含 `---uuid` 段的本地文件名误剥（概率极低）；UNC 路径 file:// 预览不可靠（有 onerror 兜底）；media store TTL 后历史卡片打开失败静默降级（未做真机端到端）。

### R36 · Worktrees 接入（完成，随 v2026.827.8 发版；二期 P3）

用户指令：worktrees。coder 实施 + 审查代理复审（无 blocker/major，可发版）：
- **git 探测降级**：src/git-detector.ts（`git --version` execFile 5s 超时 + 进程级缓存 + 启动预热）；无 git 时侧边栏入口隐藏、管理视图 callout 引导（i18n 文案如实写明装 git 重启恢复）。
- **新建 worktree 会话**：app-session-actions.ts `createNewWorktreeSession`（sessions.create {worktree:true}，非 git 仓库错误转友好引导）；侧边栏「Worktree 新会话」次级按钮（仅 gitAvailable 渲染）。
- **徽标反推（计划断言被侦察推翻）**：sessions.list 行不投影 worktree 字段（asar 取证确证），会话行分支徽标改由 worktrees.list `ownerKind==="session" && ownerId===sessionKey` 反推（buildWorktreeSessionMap）；canonical key 全小写形态与生成 key 匹配，乐观插入不分裂。
- **删除联动**：内核 sessions.delete 已自动 removeIfLossless；UI 侧在映射仍有活跃记录时补 worktrees.remove（有损场景内核自动快照），失败静默。
- **管理视图**：views/worktrees.ts（列表/打开目录/打开会话/删除/恢复/GC）；registry 三处接线（gotchas #49）齐全，不开放 URL 注入；app-gateway onHello 后 loadWorktrees，断连重连自动刷新。
- **白名单双根**：workspace-ipc.ts 守卫放宽为 workspace 根 + `~/.openclaw/worktrees/`（isInsideRoot + realpath 复核不变）。
- **测试 +26**：git-detector 6、workspace-ipc 6、worktrees controller 12、源码审计 8。基线 566→618 全绿；重复率 1.014%。
- **记录在案（P7 候选）**：resolveUserStateDir 与内核 resolveStateDir 的 legacy（~/.clawdbot）/env trim 分歧（既有系统性假设）；删除路径依赖 worktrees 快照 map，miss 时按 canonical key 兜底查（minor-2）；open-folder/list-dir 只走 lexical guard 无 realpath 复核（既有攻击面，未扩大）；gc toast 明细英文片段；sidebar.css 9999px vs --radius-full 不统一。

### R37 · Git 索引/审查/提交面板（完成，随 v2026.828.0 发版；二期 P4）

用户指令：git 索引创建、审查、修改、提交。coder 实施 + 审查代理复审（无 blocker；2 major + 1 minor 发版前修掉，余进 P7）：
- **主进程 5 通道**（src/git-ipc.ts）：git:status（porcelain v2 -z -b）/git:diff（cached/按文件懒拉）/git:stage/git:unstage/git:commit，统一 guardGitOp = assertTrustedIpcSender → no-git → cwd ∈ 白名单（workspace-ipc 新导出 resolveAllowedDir，realpath 复核防 symlink）；execFile 数组传参零 shell 面；结构化错误 no-git/denied/not-a-repo/git-error。
- **解析器纯函数**（src/git-parse.ts）：parsePorcelainV2Status（rename -z 下源路径占下一 NUL 段、quoted 中文八进制 unquote、untracked/ignored/branch header）、parseUnifiedDiff（多文件/rename/二进制/new/delete/`\ No newline`）、sanitizeGitRelPaths（拒绝对路径/../NUL/超量）、normalizeCommitMessage。
- **runner 抽离**（src/git-run.ts，审查 major 修复点）：maxBuffer 截断检测——Node ≥22 的 err.code 是字符串 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`（旧版 ENOBUFS/ERR_OUT_OF_RANGE 兼容），原实现只认数值 code 导致截断被静默吞掉；err.code 非数字非截断归 code 1 失败路径。git:status 同步透传 truncated。
- **空仓库 unstage 修复**（审查 major）：unborn HEAD 下 `restore --staged` 恒定失败，自动回退 `rm --cached`；docs 注明 unstage 要求 git ≥ 2.23。
- **chat-ui 面板**：controllers/git.ts（groupGitEntries 三分组、buildGitRepoOptions 仓库切换、initGitPanel 含 workspaceSetRoot 注册白名单根、selectGitFile 懒拉+seq 防竞态、错误模型 i18n-free 由 view 本地化）；views/git.ts（分组列表/状态字母 badge/rename old→new/行内单栏 diff 高亮/提交框 staged 非空才显示/identity 引导 callout/断连 callout（审查 minor 修复死 prop））；file-changes 面板尾部「在 git 中查看」链接（gitAvailable 才渲染）；registry/app-render/sidebar 三处接线；i18n zh/en 各 +30；misc.css gitp-* 全 token。
- **v1 边界守住**：无 hunk 级 stage、push/pull/branch 管理、merge 冲突 UI；untracked 不可展开 diff（git 本身不含），只能 stage。
- **测试 +44**：git-parse 23、git-run 5（截断/超时/ENOENT/信号杀死归类）、controllers/git 5、git-ui 源码审计 11。基线 618→641 全绿；重复率 1.08%（73 clones）。
- **记录在案（P7 候选）**：断连时面板仅 callout 提示不自动重试；diff/status 截断 UI 无单独提示；ENOENT 竞态归类为 git-error 而非 no-git；selectGitFile 收起/切仓库不 bump diffSeq（不可见状态残留）；diff removed 行用 U+2212 影响复制；git.title 文案偏窄。

### R38 · 设计 token 现代化 + 对话页布局重构（完成，随 v2026.828.1 发版；二期 P5）

用户指令：设计 token 现代化（双主题并重）+ 对话页布局重构。纯 chat-ui/shared 样式层改动，内核零改动。
- **token 新结构**（`shared/design-tokens.css` 全量重写，既有 token 名全保留）：新增阅读列宽 `--chat-column`(820px)、display 字号阶梯 `--display-sm/md/lg`(26/32/40)、字距 `--tracking-display/tight/body/wide/caps`、行高 `--leading-tight/title/body/relaxed`、字重 `--weight-*`、`--ease-standard`、`--duration-instant/slower`、玻璃模糊 `--glass-blur-sm/md`、hairline 快捷 token `--hairline/--hairline-strong`、卡片顶高光 `--highlight-inset`、`--shadow-xs`。**双主题独立调参**（暗色一等公民，非浅色+补丁）：阴影浅色低透明多层+负扩散、暗色 alpha ~3 倍；玻璃浅色深色压层/暗色白色提亮层；暗色 accent-glow 0.28→0.32。暗色仍双块（`[data-theme=dark]` + prefers-color-scheme 兜底）保持同步。`website/design-tokens.css` 手工同步（diff 一致）。
- **tokens-ext 默认值翻转为浅色**（R32/R33 候选闭环）：原 `:root` 默认暗色致浅色系统首帧闪暗；现 `:root` 浅色 + `:root[data-theme=dark]` + `prefers-color-scheme: dark` 兜底双通道，暗色系统用户也不闪白。已知残留：显式选暗色但 OS 浅色的用户在 settings IPC 落地前有短暂浅色首帧（两害相权选定的闪烁更小一侧）。
- **间距原子类 `styles/utilities.css`**（hub import 于 primitives 之后）：`oc-flex(-col)/oc-items-start/oc-justify-end/oc-gap-{4,6,8,12,16}/oc-m-0/oc-m{t|b}-{4..24}/oc-ml-auto/oc-p-16`，值全走 `--spacer` 阶梯。**收敛视图 TS 内联 style 间距 38 处**（15 个 views 文件，R32/R33 候选闭环）；功能性内联（尺寸/颜色/动态值，如 share-prompt 图标按钮尺寸）有意保留。
- **对话页布局重构**：`.chat-group`/`.chat-divider`/compose 子级统一 `max-width: var(--chat-column)` + margin auto 居中；compose.css **删除两个杀居中的旧 `!important` 覆盖**（`.chat-group{margin-left/right:0}`、`.chat-thread{padding:8px}`）；chat-thread padding 16/12 + 负 margin 配对；空态 hero 重写（display 字号、tracking、dashboard-enter 入场、chips rise+stagger+shadow-xs+hairline；chat.ts 加 `stagger-${i+1}` class 为唯一 DOM 改动）；助手正文 line-height `--leading-relaxed`；compose 圆角 16→`--radius-20`、padding 全 token；`.chat-new-messages` 加 shadow/hairline/入场动画（终态衔接无跳变）；sidebar header/content padding token 化 + hairline；新增 ≤768px media 块收缩留白。约束守住：transition 全具体属性不用 all、prefers-reduced-motion 尊重、R32 的 `min()` 分栏收缩未回退、按钮右对齐未回退、800px 最小窗口无横向溢出。
- **事故教训（gotchas #71）**：utilities.css 头注释写 `oc-items-*`（含 `*/`）致注释提前闭合，esbuild 打包后 base/primitives 整段嵌进 `.oc-flex-col{}`——body margin:0 丢失、全局偏移 8px+横向溢出 23px；构建退出码正常，靠产物 head 断言+截图发现。
- **验证**：`npm run build` + `tsc --noEmit` + 全量测试 641 全绿（新增 0，设计类改动以截图为准）；CDP 截图冒烟 10 场景（light/dark × 1280/800 宽 + hero × 双主题双宽 + settings 远程控制/关于页），无横向溢出、无裸 i18n 键、无裸 hex 违和。
- **记录在案（P7 候选）**：800×600 极限高度 + webbridge 未连接（大 pill 态）时侧边栏底部 pill 遮会话搜索框（同状态未截 baseline 对照，由 sidebar.css 本轮未变更推定既有）；显式暗色+浅色 OS 的首帧浅色闪（见上）；design-guidelines-en.md 未同步 P5 新 token 体系（双语 drift，P6 前补译或标注滞后）；CLAUDE.md 的 gotchas 计数（29 items）早已失真未同步。

### R39 · 收尾：屎山清理/健壮性/效率（完成，随 v2026.828.2 发版；二期 P7）

用户指令：清理屎山代码和历史遗留、提高健壮性与运行效率。explore 全仓审计（21 项核销表+新发现 sweep，无 P0）→ coder 实施 21/21 → 审查代理复审（无 blocker；M1/M2 发版前修，m1/m2/m4/n1/n5 顺手修）：
- **kimi-auth-proxy 回环鉴权**（积压中风险项闭环）：path secret 方案（内核零改动约束下 header 不可行）——启动期 `crypto.randomBytes(24)` base64url、会话内稳定（重启代理不复位，有测试钉住）；`extractSecuredPath` 校验剥离前缀，无/错 secret 一律 401 先于路由；16 条消费路径逐一核实带 secret（config provider baseUrl/memorySearch/kimi-search 端点/verifyKFC/图片探测/setup/settings IPC/chat-ui 5 处 URL 构建点）；日志打码。**审查 M1 修复**：ensureProxyConfig early-return 原会跳过 kimi-search 端点同步（setup 删 entry.config 后端点整场缺席到下次启动），端点同步提前并纳入新鲜度判断。**审查 m1 修复**：诊断包脱敏对回环代理 URL 的 secret 段按值打码（`redactSensitiveValues` 字符串值走 `127.0.0.1:<port>/<seg>/` 定向替换）。
- **行尾统一**（积压项闭环）：settings/components/misc.css 混排归一 CRLF + 新增 .gitattributes（css=crlf、ts/js/md=lf）；**审查 M2**：`git add --renormalize .` 一次性全仓归一独立提交（否则 ~400 个既有 CR blob 是后续每个提交的 churn 定时炸弹）。
- **diagnostics-export 全异步**：readdirSync/readFileSync/existsSync/mkdirSync → fs.promises（主进程不再因同步读盘卡顿，积压项闭环）。
- **附件降级双重呈现修复**：乐观气泡 MediaPaths 只收成功编码文件（echoMediaPaths 平行数组），降级文件仅文本前缀——气泡与 history 同构。
- **workspace open-folder/list-dir 补 realpath 复核**（与 open-file/read-file 的 guardRealPath 对齐，symlink 信息泄漏面收敛）。
- **git 面板打磨**：truncated 入 state + status/diff 区提示（i18n 双份）；selectGitFile 收起/切仓库补 `++diffSeq`（在途响应失效）；ENOENT 竞态归 no-git 且带 message（审查 m2）；diff removed 行 U+2212→ASCII "-"；git.title→「Git 变更/Git Changes」。
- **i18n/文档**：gc toast 英文片段改插值双语模板；CLAUDE.md gotchas 计数 29→「70+ 以 gotchas.md 为准」；design-guidelines-en.md 补译 P5 全部新 token 章节 + utilities 段落按现行集合修正（双语同步）。
- **死代码清除 20 处**（逐个 `\b` grep 含测试/scripts 确认）：主进程 7（checkForUpdate/isCliInstalled/isCryoclawSetupComplete/listInstalledBrowsers/uninstallForAllDetectedBrowsers/resolveOfficecliBin/stopAppUpdater）+ chat-ui 13（format×3/presenter×7/tool-display/registry/workspace/icons×2/approval-history）+ utilities.css 2 死类；formatConsoleLevel 抽 src/console-level.ts + 单测（R24 候选闭环）。
- **杂项**：tokens-ext 删 --bg-content 暗色死声明；sidebar.css 9999px→--radius-full（999px 渲染等价）；website spotlight/磁性 pointermove rAF 合帧 + :active 缩放保留；session-transition 动态 import 补 catch；删除会话 worktree map miss 按 canonical（trim+case）兜底。
- **审计确认无问题**：主进程无热路径同步 IO、execFileSync 残留全为 dev-only、timer/监听器无泄漏、unhandled rejection 仅一处近零概率（已补 catch）。
- **测试 +9**：kimi-auth-proxy 4（含真实服务 401/404 + 重启 secret 稳定）、console-level 2、diagnostics-export 3。基线 641→650 全绿。
- **仍留 backlog**：per-session 队列（产品决策项）；resolveUserStateDir legacy 分歧（用户面风险）；R38 800×600 pill；reduced-motion 局部冗余块；jscpd 两个大 clone（热路径/跨构建根）；零消费 token 储备；refreshGitStatus 成功分支未 bump diffSeq；website pointercancel；ensureProxyConfig 每次启动重写 config（secret 轮换所致，无害记录在案）。

### R40 · 热修复：kimi 代理 401 静默降级（完成，随 v2026.828.3 发版）

用户报告「kimi 代理失效」。取证：gateway.log 中 `provider=kimi ... url=http://127.0.0.1:18790/coding/v1/messages status=401 elapsedMs≈7`（7ms 即本地代理直接 401，未到上游）；`~/.openclaw/openclaw.json` 里除受管 `kimi-coding`（baseUrl 带 secret）外还有一个历史遗留 `kimi` provider（`http://127.0.0.1:18790/coding`，无 secret 段），而 `agents.defaults.model.primary = kimi/k3-256k` → 主模型全 401，静默 fallback 到 deepseek。
- **修复**：`kimi-config.ts` 新增 `healLegacyProxyProviders()`——扫描 `models.providers`，凡 baseUrl 匹配本地代理形态（`127.0.0.1:*/[seg/]coding`）且 `apiKey === "proxy-managed"`（应用自管占位符，防误伤用户自建本地服务）的条目，改写到当前端口+secret；`main.ts ensureProxyConfig` 接入并把结果并入 early-return 新鲜度判定，heal 单独记日志。
- **边界记录在案**：secret 为空（代理未启动鉴权）时不写（写出也必 401，纯 churn）；无 kimi-coding 时不 heal（那种配置下代理根本不起，症状是显眼连接失败而非静默 fallback）。
- **审查代理复审**：4 项反馈全部处理（apiKey 门控、空 secret 防御、边界注释、独立日志）。
- **测试 +7**：kimi-config heal 系列 7 条（无 secret 段/旧 secret/旧端口/幂等/非本地不动含 127.0.0.1 反例/空 secret/非 proxy-managed 门控）。基线 650→657 全绿。

### R41 · 消息流式体验优化第一期（完成，随 v2026.828.4 发版）

用户指令：优化消息刷新、流式渲染及恢复、有回复及时刷新，参考 openclaw gateway 网页端（control-ui）做法。先取证官方实现（从 gateway.asar 提取 minified 产物分析），后分 12 个任务子代理实施 + 逐任务双阶段审查（规格/质量）+ 终审。
- **渲染层组件化**（最大结构改动）：抽出 `<cc-chat-stream>`（流式气泡）/`<cc-chat-history>`（历史列表，`buildChatItems`/两个 memo 迁入）/`<cc-sidebar>`（侧边栏，`shouldUpdate` 数据字段比较 + 纪元机制），均无 shadow DOM。流式高频更新只命中流式组件；实测 50 流式帧侧边栏/历史 0 次重渲染；`buildChatItemsMemoized` memo 键去 `stream`（含不再消费的 `tasks`/`runActive`/`sessionKey`），`resolveSessionOptions` 加装配层 memo（5 数据源引用比较，否则隔离失效）。
- **流式气泡渐进 markdown**（升级 R5 纯文本定论，对齐官方安全前缀做法）：`splitMarkdownSafePrefix`（闭合围栏/空行边界，奇数围栏退到倒数第二个）+ `toStreamingMarkdownHtml`（稳定段走 `toSanitizedMarkdownHtml` 缓存、尾部转义纯文本，解析频率 = 边界推进频率而非帧率）；配套 CSS 白空复位（**不得含 `pre`**，终审修复：含了会折叠流式期已闭合代码块格式）+ 双光标修复（删容器级 `::after` 残留规则）；`gotchas #73` 钉住新链路与两条红线。
- **刷新/恢复 5 处盲区修复**：① 滞后补拉预算按目标会话复位（耗尽后不再永久放弃）；② 终态同会话刷新保留 `chatVisibleMessageCount`（消除每轮缩回 20 条再注水的闪烁/滚动位移）；③ 看门狗 `hasAssistantReplyAfter` 跳过缺时间戳条目继续向前扫；④ 重连后未收养 orphan 做 2/4/8s 三次静默探测（收养即清快照停探，`onGap` 软恢复不接）；⑤ 后台会话终态触发 `scheduleTerminalSessionsRefresh` + `lastActiveSessionKey` 仅当前会话写入（重启不再恢复到后台会话）。
- **及时刷新对齐官方**：`sessions.changed` 先本地 patch（保守白名单：不新增行/不写元字段/无有效字段回落全量，内核取证事件携带行快照子集）；看门狗/重连探测走 `silent`（不闪「加载中」）；30s ticker 保留兜底。工具流 80ms 节流取证为**已存在**（`TOOL_STREAM_THROTTLE_MS`），未重复实现。
- **终审修复**：流式代码块格式折叠（`pre` 误入复位名单，一行 CSS）；记录在案：静默探测命中滞后时派生的非 silent 补拉属有界预期行为（注释已钉）。
- **测试 +59**：控制器修复链、安全前缀/渐进渲染、事件 patch、孤儿探测、源码审计钉接线（三组件 `shouldUpdate` 白名单/无 shadow DOM/装配顺序），基线 657→716 全绿。重复率 1.19%（阈值 5%，可见克隆均为既有）。
- **流程**：每任务独立提交（15 个），逐任务规格符合性 + 代码质量双审，审查发现即修（4 轮修复提交）；终审 1 Blocker 修复后发版。
- **第二期（R42 待实施）**：侧边栏图标轨重组（会话列表 ≥75% 面积 + 「更多」菜单）+ 三组模块整合（任务双 tab、扩展双 tab、工作区 IDE 式融合），设计与接线清单见 `docs/archive/specs/2026-08-28-stream-flow-and-sidebar-design.md`；Task 12 审查建议顺手项：`cc-sidebar` 加 `disconnectedCallback` 清菜单态、`resolveSessionOptionsMemo` 依赖守护。
- **记录在案（候选）**：协议 v4 `deltaText` 增量字段未消费（需内核取证）；`>50k` 稳定段流式每帧重解析（可加单槽 memo）；`ChatItem` 三个死 kind 与 `views/chat.ts` 再导出残留（R42 清理）；website 版本徽章随官网改版在建未同步（用户工作区，R42 发版时已在工作区同步至 v2026.828.5，随官网改版提交）。

### R42 · 侧边栏重组 + 三组模块整合（完成，随 v2026.828.5 发版）

用户指令：实施消息流式体验优化第二期（侧边栏重组 + 三组模块整合，设计 `docs/archive/specs/2026-08-28-stream-flow-and-sidebar-design.md`）。子代理驱动：T1–T3 并发（≤2 个避共享文件冲突）+ 逐任务规格/质量双审 + 终审。
- **任务双 tab（T1）**：tasks/cron 合并为单视图双 tab（运行记录/定时任务）；任务卡以 `sourceId` 反查显示来源定时任务名 + 双向跳转；启用中任务数徽标降入定时 tab。
- **扩展视图（T2）**：新增 `extensions` 视图（技能/插件双 tab）；插件从设置页迁出（extensions 分组删除）；插件状态复位迁为视图 leave hook；`invalidateAllSettings` 同步。
- **工作区页（T3）**：IDE 式融合——左导航（仓库选择/文件树/「Git 变更」节点/Worktrees 区块）+ 右主区（文件预览 | Git 面板）；worktree→git 联动（节点选中切仓库 + 刷 status）；workspace 加载逻辑抽入 `controllers/workspace.ts`；`workspaceSetRoot` 白名单注册收敛为一处；**终审 Major 修复**：文件树刷新/打开根目录/逐项打开能力恢复。
- **侧边栏重组（T4）**：会话列表 flex:1 占纵向主体；主导航 6 项收敛为底部 5 图标轨（任务带运行中徽标/工作区/扩展/完整版网页·重连/设置带徽标点）；「Worktree 新会话」移入「更多」菜单（仅 `gitAvailable === true` 渲染）；双菜单互斥 + `disconnectedCallback` 清菜单态 + `aria-current`；R41 审查建议顺手项落地。
- **收敛（T5）**：视图 id 9→6（删 cron/worktrees/git/skills，INJECTABLE_VIEWS 同步）；6 个死键删除；git/worktrees 审计测试合并进 `workspace-ui.test.ts`。
- **边界记录**：主进程 `ipc-sender-guard` 白名单收紧曾越界实施后回退（主进程零改动约束，同步待下期授权）；`navigation.ts` Tab union 残留 `"cron"`/`"skills"` 为上游 13-tab 历史路由机制，另立项收口；并发提交教训：共享文件（app-render.ts）被两个任务交错提交（中间态 commit 不可独立编译，HEAD 自洽），后续并发任务应拆分共享文件触碰面或串行化。
- **测试 +128**：新审计测试（tasks-view/extensions-ui/workspace-ui/controllers/workspace）+ 旧测试合并迁移；基线 716→744 全绿。重复率 1.19%→1.16%。
- **记录在案（候选）**：主进程白名单同步（含 extensions 路由）待授权；docs/architecture.md 模块清单补新模块（app-extensions/app-workspace/controllers/workspace）；`cronSourceName` 的 `kind` 反查依据待内核取证；测试正则 `\[\s\S\]{0,N}` 限定长度断言的排版耦合（项目审计范式可接受）。

### R43 · UI 布局修复批次（完成，随 v2026.829.1 发版）

用户反馈 6 项 UI 问题：「更多」菜单遮挡、fullpage 视图顶部与窗口控件重叠、布局优化、侧边栏拖宽、响应式适配、全局布局 QA。子代理驱动 4 波次（≤2 并发避共享文件冲突）+ 逐任务规格/质量双审 + 终审；实施计划 `docs/archive/plans/2026-08-29-ui-layout-fixes.md`。
- **层叠契约**：菜单 ≤60 / titlebar 100 / 浮层 ≥1000；「更多」菜单 30→60（T1）；确认框遮罩 200→1000 + 同层 DOM 序守护、compose popover 100→60（T5 QA）。
- **标题栏让位（T2）**：`--titlebar-h: 44px` token（tokens-ext）；六视图让位统一 + `.cryoclaw-titlebar` 高度同源（单点可改）；既有让位全部视觉等价（calc 补偿）。
- **侧边栏拖宽（T3）**：右缘 6px 拖拽条，220–420px 持久化（`UiSettings.sidebarWidth`）；**0 哨兵方案**：未自定义时宿主无内联宽度 + `:root` 变量清除，窄窗媒体查询照常生效；`moved` 标志零位移不固化；`buttons===0` 窗口外释放补偿；`--sidebar-width` :root 同步供错误弹层定位跟随。审查发现两次实质问题并修复：内联宽度无条件废除媒体查询（I1）→ 0 哨兵；零位移按压固化哨兵 → moved 标志。
- **布局 + 响应式（T4）**：扩展页 `--ext-column: 980px` 内容收束（新 token）；断点：工作区 860/768 左栏分级收窄、扩展 768、任务 720、设置 768（含 `min-width` 同源覆盖）。评估：768/720 断点服务页面缩放降级，非死代码保留。
- **全局 QA（T5）**：7 项审计清单（六视图让位 / drag 区 no-drag 配对 13 组零遗漏 / 滚动容器唯一 / z-index 契约全量扫描 17 文件 / 最小尺寸无横向溢出 / 暗色无写死色值 / 按钮右对齐）；修复 3 处：确认框被设置弹窗遮挡、compose popover 越层、cron 嵌套双重让位。
- **守护测试 +27**：`layout-fix.test.ts` / `sidebar-resize.test.ts` / `layout-qa.test.ts`（动态样式枚举 / 全块扫描防媒体分支绕过 / 同层决胜顺序断言）；基线 744→771 全绿。重复率 1.16%→1.15%。
- **边界记录**：主进程零改动（终审核实）；website/* 未提交改动属用户官网改版（徽章已在工作区同步，随官网改版提交）；`.cm-layout__main` 死样式待后续清理；审计断言跨文件重复（双层守护，可后续收敛为单点）。
- **冒烟清单（真机待验）**：设置页 modal 上触发确认框应盖住 modal；思考档位/回放 popover 可点不遮挡；任务页双 tab 顶部对齐；拖宽后刷新持久化、窄窗未拖宽时自动收窄。

### R44 · 2026.9 UI 全面重写 + 2026.8.2 内核升级适配（完成，随 v2026.903.0 / v2026.904.0 发版）

用户指令：UI 全面重写（2026.9 新设计契约）+ 内核 openclaw 2026.8.2 升级适配。
- **UI 重写**：新应用壳 `cc-rail` / `cc-session-panel` 替换旧侧边栏布局；浅色升为一等主题；主题色从冰蓝 `#0EA5E9` 切换为中性灰 + 单一 indigo 强调色（`--brand-500: #6366f1`，`shared/design-tokens.css`）；默认窗口尺寸调为屏幕 80%。契约文档 `docs/archive/ui-rewrite-2026.9-contract.md`（已完成存档），规范见 `docs/design-guidelines-zh.md`。
- **内核 2026.8.2 适配**：配置双向迁移（新旧 schema 互转）；不兼容插件自动降级；gateway 握手 Origin 改写；webchat-ui 客户端身份适配。内核调研取证见 `docs/kernel-2026.8.2-research.md`。
- 内核 pin：`package.json` `cryoclaw.openclaw` = 2026.8.2；发版 v2026.903.0 → v2026.904.0。
- **测试基线 771→807 全绿**。

### R45 · asar gateway 启动崩溃修复 + 无载荷插件收敛降级（完成，随 v2026.904.2 发版）

- **问题**：打包安装后 gateway 无法启动——kernel-dist-patch 补丁 3/4 的 asar-bypass 分支 `rootRealPath` 为 undefined，2026.8.2 启动加载链直接崩溃（自 v2026.811.8 潜伏，dev 验证一直走散文件模式未暴露）；另装过无 payload 插件（目录在但无 package.json 且无 dist/，如纯技能插件）时 gateway 反复报「迁移未收敛」永不就绪。
- **方案**：`rootRealPath` 兜底 `params.rootPath`；迁移规则把此类 enabled 插件降级为禁用（配置完整保留，扩展商店重装可恢复）。
- **证据**：新增 `scripts/gateway-asar-smoke.test.js`（真实 asar 形态启动冒烟，`OPENCLAW_STATE_DIR` 隔离）+ kernel-dist-patch / openclaw-config-migration 测试扩充；提交 7bd4df0。

### R46 · 内核更新改策展稳定版渠道（完成，随 v2026.905.0 发版）

- **问题**：openclaw npm `latest` dist-tag 指向发行证据链未完成的 2026.9.1，被直接当更新目标误报「有新版本」。
- **方案**：新增 `kernel-channel.json`（仓库根策展清单）+ `scripts/lib/kernel-channel.js`（版本比较/清单解析）；`kernel-update.mjs fetchStableVersion()` 远程双源（raw.githubusercontent → jsdelivr 镜像，8s 超时）→ 构建期注入内置兜底，绝不回落 npm latest；`updateAvailable` 改三段数字比较，current 更高不再提示降级，无 tag 且不落后时早退。
- **证据**：`scripts/kernel-channel.test.js`；设置页内核面板「最新版本」→「稳定版本」（zh/en）；提交 dc45243。

### R47 · 更新弹窗 + 暂缓机制 + 非静默换装（完成，随 v2026.906.0 发版）

- **问题**：发现新版本即静默后台下载，用户无决策点；换装为无界面静默安装（`/S`），进度不可见。
- **方案**：`autoDownload=false`，启动检查发现新版仅弹窗（更新日志 + 更新/暂缓，chat-ui `views/update-available-dialog.ts`，下载进度 → 重启安装同弹窗完成）；`src/update-snooze.ts` 暂缓持久化（7 天/1 月/3 月/永久/自定义 1–3650 天，存 `userData/app-update-snooze.json`），期内跳过启动自动检查；quitAndInstall 去 `/S` 拉起带进度条的 NSIS 安装器窗口；设置-关于页适配（available 态手动下载按钮 + 暂缓状态/恢复入口）。
- **证据**：守护测试 9 个（`app-update-notify.test.ts` 源码审计）+ update-snooze 纯逻辑 3 个；提交 a05fb5e。

### R48 · 安装器品牌视觉 + Setup 快速通道 + 内核兜底自动升级 + 迁移可恢复性（完成，随 v2026.907.0 发版）

- **安装器品牌视觉**：Welcome 侧图/页头图走 `electron-builder.yml` 的 `nsis.installerSidebar`/`installerHeader`（installer.nsh 里 `!define` 同名宏会与命令行 `-D` 冲突，gotchas #74）；位图由 `scripts/gen-installer-bitmaps.ps1` 生成（.ps1 必须带 BOM，gotchas #75）。
- **Setup 快速通道**：`src/setup-env-detect.ts` 扫描环境变量已有的 provider key（OPENAI/ANTHROPIC/MOONSHOT/GOOGLE·GEMINI/DEEPSEEK），`setup:detect-env-keys` 只回掩码、`setup:adopt-env-key` 白名单校验 + 真实验证落盘——明文 key 不出主进程。
- **内核兜底自动升级**：`isKernelBelowMinSupported()`（门槛 2026.7，与 kernel-channel.json minSupported 双处同步）→ `main.ts scheduleAutoKernelUpgradeIfNeeded()`（仅 packaged、延迟 25s、导入进行中取消、失败不弹窗）；`kernel:update-progress` 载荷新增 `source:"auto"|"manual"`，渲染层 `kernel-auto-upgrade-banner` 全局横幅呈现。
- **迁移可恢复性**：导入 .openclaw 前自动创建应急归档（`%LOCALAPPDATA%\CryoClaw\import-backup`，滚动 2 份，解压失败自动还原，备份失败中止导入）；内核回滚三处（升级失败自动回滚/best-effort 回滚/换装成功）重跑双向配置迁移；内核备份附存 openclaw.json 快照（`scripts/lib/kernel-config-snapshot.js`，不自动恢复）；`cryoclaw-config.ts` 老版本迁移改「仅补齐缺失字段」（不再丢 updateChannel 等既有设置）。
- **证据**：新增测试件 setup-env-detect / kernel-config-snapshot / openclaw-state-archive / openclaw-state-import-lifecycle / kernel-auto-upgrade-banner / setup-quickstart 等；提交 41fbd7f。全量基线 889 pass / 0 fail / 4 skipped（2026-09-04 实测）。

### R49 · 移除 kimi-auth-proxy 回环鉴权（完成）

用户报告「kimi 回环鉴权导致无法使用 kimi 模型」。取证本机 `~/.openclaw/openclaw.json`：`kimi` 与 `kimi-coding` 两个 provider 的 baseUrl 均烙着某次会话的旧 path secret，主模型 `kimi/k3-256k` 每次请求被本机代理 401（7ms 内本地拒绝，未到上游），静默 fallback 到 deepseek——R40 事故的复发形态。
- **决策**：secret 写在 openclaw.json 里，应用重启即轮换，任何同步缺口（early-return/heal 盲区/手动改配置）都会让主模型静默 401；维护 16 条消费路径的成本远超「本机进程白嫖 token」这一低威胁场景收益。按用户授权直接移除该特性。
- **实施**：`kimi-auth-proxy.ts` 删 `generateProxySecret`/`extractSecuredPath`/`getProxySecret`/secret 状态，`handleRequest` 直接路由（未知路径仍 404、无 token 仍 401——代理自身 token 缺失语义保留）；`kimi-config.ts` `ensureMemorySearchProxyConfig` 去 secret 参数；**`healLegacyProxyProviders` 保留并反转语义**——把带旧 secret 段/旧端口的本地代理 provider 改写为当前端口无 secret 形态（用户现有坏配置下次启动自动治愈，主模型 `kimi/k3-256k` 无需手动干预）；`main.ts` ensureProxyConfig、`provider-config.ts` verifyKFC/图片探测、`setup-ipc.ts`/`settings/verify.ts` IPC 返回值（不再回 proxySecret）、chat-ui 五处 URL 构建点（setup-step2/tab-provider×2/tab-provider.lib/tab-channels.lib/tab-memory）全部改为 `http://127.0.0.1:<port>/coding` 形态。
- **保留**：diagnostics-export 对回环 URL 路径段的按值打码（磁盘上旧配置仍可能带历史 secret，无副作用防御）。
- **测试**：kimi-auth-proxy.test 重写为 3 例（路由 404/无 token 401/重启可再起；用 `keepAlive:false` agent 规避同端口快速重 bind 时复用已掐死池化 socket 的 ECONNRESET 假阳性）；kimi-config heal 系列更新为无 secret 断言 6 例。全量回归：vitest 146 + node 157 + chat-ui 521 + scripts 78 全绿；scripts 的 asar 冒烟 1 fail 为干净树上同样失败的既有问题（环境缺 gateway.mode），与本次无关。
- **记录在案**：威胁模型变化——本机任意进程可经 127.0.0.1:<port>/coding 借用代理注入的 token 调 Kimi API（白名单路由、固定上游、监听仅回环；接受此残余风险换取配置零同步面）。

### R50 · CryoBlue 设计规范确立 + CryoIcons 自绘图标 + 官网重设计（完成）

- 2026.9 R2b 规范：中性灰 + CryoBlue（brand-600 #1a6fd0）混色强调、浅色一等主题、CryoIcons 24 网格自绘图标全套替换、官网品牌化重设计、移除 kimi 回环鉴权。规范全文 `docs/design-guidelines-zh/en.md`。

### R51 · UI 精修落地 + 官网响应式 + stats 口径修正（完成）

- 官网平板/手机独立排版、发布 stats 口径修正；博客双仓同步部署链（blog/public 整拷 styles.css + 定向 patch）。

### R52 · openclaw 2026.8.2 对话内核深度适配（完成，随 v2026.909.1 发版）

- 内核取证 `docs/kernel-recon/2026.8.2-chat-capabilities.md`（progressCard.get/put/changed 契约）；Progress Card 替代旧 update_plan 面板（revision 去重、changed 失效重拉、切会话竞态保护、无卡回退 legacy 面板）；工具输入 delta 与终态展示增强（错误优先摘要、exit-code/diff ± 统计、fenced 语言推导）。验证：全量测试 0 fail + dupcheck 1.04% + dist 产物 sha512 断言 + win-unpacked 启动 18s 正常。

### R53 · 流式输出收敛修复 + 布局诊断体系 + asar 冒烟既有缺陷闭环（完成，随 v2026.909.2 发版）

- `chat-stream-reducer.ts` 纯函数消费协议 v4 deltaText/replace（append 或整段替换，旧版累计快照兼容回退）；终态前 flushPendingChatStream 防丢尾、error 终态保留部分回答；orphan 会话隔离改 sessionKey Map（迟到帧不跨会话收养）；`layout-diagnostics.ts` 三类结构化布局检查 + `scripts/layout-cdp-smoke.js` CDP 多断点冒烟固化；asar 冒烟 ANSI 色码剥离修复（OPENCLAW_DEBUG 下 includes 永不匹配）。

### R54 · 阶段一收尾（fallback replace 帧）+ 阶段二诊断全量场景化（完成，随 v2026.909.3 发版）

- 内核取证 replace 帧语义（provider 降级重生成发全文 replace）→ 修复 reducer replace 分支未剥离 frozenPrefix 的真 bug（+5 测试含 2000 帧混合压力）；诊断库补 dialog 层级检查；CDP 冒烟引擎场景化重写：全视图巡览 + 深浅主题 + DPI 三档 + reduced-motion + 双语重载，22 场景 strict 全绿。

### R55 · 阶段三 CLI 全兼容 + 阶段四取证与双内核能力 + 阶段五闸门实测（完成，随 v2026.909.4/.909.5 发版）

- `scripts/cli-compat-smoke.js` 70 命令矩阵 + 13 项行为电池全绿；修复重连后命令目录 TTL 不刷新。2026.9.2 取证（`docs/kernel-recon/2026.9.2-diff.md`：RPC 384→424 纯增量、resolveBroadcastDelta 逐字节一致、Node engine ≥24.15）；transcripts.get 优先 + 8.2 回退的会话导出。阶段五闸门：2026.9.2 打包成功但配置任意渠道即崩（fs-safe native realpath 身份校验 × asar 通用不兼容，与注入无关）→ 按闸门规则 pin 维持 8.2（R56 解决）。插件矩阵冒烟 69 扩展枚举 + 14 插件隔离 boot。

### R56 · 内核 2026.9.2 升级落地（asar 硬阻断解决）+ 存储裁剪 + 导出修复（完成，随 v2026.909.6 发版）

用户闲时任务批次：完成 2026.9.2 升级收尾、内存/存储分析落地与功能修复。
- **asar 硬阻断根因闭环（比 R55 记录更深一层）**：2026.9.2 把边界校验函数从 openclaw dist chunk 迁入**独立 npm 包 `@openclaw/fs-safe/dist/*.js`**（openclaw chunk 经 `@openclaw/fs-safe/advanced` import），旧 `patchAsarBoundaryCheck` 只扫 openclaw dist 根 → 快速通道全部漏打而**补丁计数仍 >0**（仅 peer-link 命中），闸门形同虚设。修复四层：① 扫描范围扩展到 fs-safe 包（openRootFileSync/openRootFile 快速通道、sameFileIdentity 任一侧 dev===1 放行、readRegularFileSync/readRegularFile 快速通道——v9 内联三次观测、旧 verifyStableReadTarget marker 已失效、openPinnedFileSync 兜底）；② `patchFsSafeAsarUnpacked` 改为**只映射两次 lstat 身份观测参数**（asarIdentityPath），openSync 与 `opened.path` 保持 asar 虚拟路径——R56 中继事故：早期版本整体重映射 realPath 导致下游 `openclaw/plugin-sdk/runtime-doctor` ESM 解析脱离 asar 内 node_modules；③ 打包侧 unpackDir 双目录（asar 库 unpack 按 minimatch 整文件名，目录级必须 unpackDir）；④ `assertAsarBoundaryCoverage` 形态感知断言（v9 验 root-file.js / v8 验 chunk marker）+ verifyAsarContents 产物级断言——**补丁计数 >0 从此不是充分条件**。
- **验证链**：kernel-dist-patch 17 项单测（新增 v9 形态 6 项）；v9 asar 重建 253.4MB；双冒烟（--version + qqbot 渠道 gateway run ready——即 R55 复现链的反向验证）；产物内标记断言（root-file/pinned-open/regular-file/file-identity 四文件全命中）。
- **存储裁剪落地（双侧对齐）**：`pruneFsSafeNativePlatforms`（@openclaw/fs-safe/dist/native/ 与 openclaw/dist/native/ 双份 × 7 平台仅留本机，win32-arm64 回退 win32-x64-msvc）+ `pruneTreeSitterSources`（parser.c 9.5MB，prebuilds/wasm 保留）进 package-resources 与 kernel-prune 两处；gateway.asar 263.2→253.4MB；kernel-prune 15 项单测。**新发现打包 bug**：`createPackageWithOptions` 不清理目标 .unpacked 的陈旧文件（上轮裁掉的非目标平台 native 目录曾随安装器原样分发）——packGatewayAsar 打包前先 rmDir .unpacked。claude.exe 322MB 保留（Claude Code attach 必需）；typescript/lib 19MB 暂不动（疑 jiti/插件链依赖，未取证不裁）。
- **导出配置修复（任务5）**：`.openclaw` 数据包导出恒失败——真实状态目录含 26 个符号链接/junction（内核 peer 链接 `extensions/*/node_modules/openclaw`、plugin-skills 缓存、npm projects），`collectOpenclawStateEntries` 遇链接抛「不支持的 .openclaw 条目」。修复：cp filter 跳过链接（跟随目标会把整个内核拷进快照）+ Dirent 防御性跳过；链接是机器相关运行时产物，跨机导入也必然失效。含 junction 的回归测试。
- **更新日志 15 条上限（任务7）**：`app:get-release-notes` all=true 分支 slice(0,15)。
- **验证与交付**：全量 0 fail（vitest 147 + node 157 + chat-ui 594 + scripts 77——R57 于干净 HEAD 复测修正口径）；README 基线同步；kernel pin `2026.9.2` 入 package.json；v2026.909.6。
### R57 · 三路全面代码审查修复 + 安装器 UI 重构 + 更新链路健壮性（完成，随 v2026.909.7 发版）

用户闲时任务批次：全面人工审查（bug/安全/效率）+ 安装器 UI 重构与安装更新流程优化 + 文档精简，按固定流程交付。
- **三路只读审查（主进程安全 / chat-ui 质量 / 构建更新脚本）**：0 critical / 1 high / 9 medium / 19 low，逐项甄别后落地 20+ 修复，其余记录 watch list（威胁模型不成比例或需发布链配合的 defer）。
- **主进程修复**：主窗口 will-navigate 限 Chat UI 目录内 + setWindowOpenHandler deny（此前无导航边界，子窗口继承 preload）；webbridge 下载拒绝 https→http 降级重定向；内核 tag 白名单（防 --tag 注入 --rollback 等开关）+ 卸载技能 resolved slug 复验；safe-open 白名单移除 svg（浏览器 file:// 打开 svg 执行内嵌脚本）；端口占用者强杀前 tasklist 校验镜像名（防误杀恰好占用 18789 的无关服务）；.openclaw 导出的全树 walk/rm 改 promises 版（数百 MB 目录的同步遍历曾冻结主进程数秒）。
- **chat-ui 修复**：思考档位/回放点弹层开关循环累积泄漏 document 监听（模块级单例 closer，切会话同步关闭）；发送流程 chatSending 先占位再进附件读取 await 窗口（队列「立即发送」曾在该窗口以 preserveRunState:false 踩坏在途 run）；popState 会话切换走 applySessionKeyTransition 统一守卫；头像 meta 拉取拼网关 HTTP origin（file:// 下相对 URL 恒失败）；renderApp 热路径 localStorage 读取改模块级缓存；managed-media origin 变化自动失效缓存；死代码链 chatManualRefreshInFlight/onRefresh 清除。
- **更新链路修复（含 1 项 high）**：**afterPack 补写 runtime/node.cmd 代理**——打包产物删 node.exe 后 npm 生命周期脚本的裸 `node`（openclaw preinstall 版本校验）在无系统 Node 的用户机上必然失败，运行期内核升级实为死功能；更新弹窗新版本说明改从 GitHub Release 正文拉取（本地 release-notes.json 不可能含未安装版本的条目，此前恒空）。
- **构建/更新脚本加固**：Node 发行包下载加 SHASUMS256.txt 内容校验（官方+镜像同源文件名，拿到校验值不匹配即硬失败，获取不到降级警告）；merge-release-yml 收集清单补 .blockmap（差分更新元数据此前永不进 release 目录）；execNpmSync 允许空格（checkout 路径含空格曾是硬 die）；officecli 校验随 pin 条件化；kernel-update：锁改 "wx" 独占创建（TOCTOU）、state.json 临时文件+rename 原子写、**换装崩溃残留自愈**（asar 缺失时 .new- 进位/.old- 还原，健康态清残留，锁保护防误删并发方临时物）。
- **安装器 UI 重构**（v2 位图之上）：欢迎/完成页品牌标题带版本号、卸载向导品牌标题（侧图 electron-builder 自动继承）、底部 BrandingText 替换 Nullsoft 默认、完成页更新日志链接；**installerLanguages 精简 en_US+zh_CN**（其他语言回退英文）；卸载清理选项（CLI/WebBridge 缓存/用户数据）改 LangString 双语（此前英文系统硬显中文）；杀进程等待条件化——taskkill 退出码全 128（无进程）时跳过固定 2s（全新安装提速）。审查代理对照 app-builder-lib 模板逐条核验 NSIS 语法（un.* LangString 双 pass、StdUtils 四参宏、寄存器占用）均正确。
- **安装器更新链路硬 bug（发版冒烟拦截，本轮最重要产出）**：静默更新 909.6→909.7 / 同版重装稳定失败——旧卸载器 `--updated` 模式下 electron-builder 26.7.0 atomicRMDir 逐项 rename 报 `Can't rename $INSTDIR` → exit 2 → 新安装器 5 轮重试（每轮 ~4 分钟）→ `uninstallFailed` MessageBox **无 /SD，静默链路永卡弹窗**（用户可见 "Failed to uninstall old application files"）。909.6 全旧代码对照复现 = 上游缺陷非本仓回归；Node/PowerShell/NSIS-mini 三重进程外复刻 rename 全过，失败仅在真实卸载器进程内（被锁文件未能定位，跨进程 LVM_GETITEMTEXT 乱码，取证边界如实记录）。修复双宏：`customRemoveFiles` 整体接管移除（RMDir /r 直删，更新场景无需暂存/还原语义）+ `customUnInstallCheck` 接管旧卸载器失败分支（兜底清场放行安装，弹窗永不出现）。909.6→909.7 升级一次性经历旧卸载器慢重试后成功，909.7 起快速路径。详见 gotcha #81/#82。
- **验证与交付**：全量 **992 pass / 0 fail / 4 skipped**（vitest 158 + node 163 + chat-ui 594 + scripts 77）；dupcheck 1.03%（81 clones）；README 基线同步；文档精简（R52–R55 压缩、测试基线口径修正）。v2026.909.7。

## 📦 发版与实测经验（套路已验证多次）


- 发版链路：`npm run build` → `npm run dist:win` → 产物级断言（@electron/asar 读 app.asar 版本/白名单）→ 静默安装 → 启动验证（gateway `GET http://127.0.0.1:18789/` HTTP 200）→ `gh release create`。发版后顺手 `npm run dupcheck` 防重复率回退。
- **沙箱内不做静默安装冒烟**：权限收紧/目录清空两个坑均有实录（见记忆）；安装验证走普通权限通道，沙箱用产物级断言替代。
- **发版后建议 CDP 冒烟**：点击关键入口 + 扫描裸 i18n 键 + 零 renderer 异常（vite 构建不查未定义标识符）。
- gateway 首次启动需 **20+ 秒**（内核渠道插件同步初始化）；CDP 等待留足余量。
- 多次 taskkill 会留 TIME_WAIT/进程残留——发版前彻底清理 + 等待（gotchas #53/#57/#64）。
- CDP 探针教训：Lit 重渲染会重建 `<details>` → 用 `summary.click()`；innerText 对未渲染子树返回空 → 用 textContent；`child.kill()` 杀不干净进程树 → `taskkill /F /IM CryoClaw.exe /T`。
- NSIS 压缩缓存非确定性（67/134/277MB 都出现过），功能无影响。
- 发版复验清单：安装目录关键文件时间戳与构建产物一致；app.asar 顶层仅白名单条目（node_modules/assets/chat-ui/dist/package.json/release-notes.json/setup/shared）。
- **版本号惯例**：日历版本 `YYYY.MMDD.N`；release-notes.json 顶部条目即新版说明；git tag 非驱动源。
- **811.2+ 教训**：officecli GitHub 直连 ECONNRESET → `https://gh-proxy.com/` 镜像 + SHA256 校验；NSIS 同版本覆盖安装可能卡收尾（时间戳判据 + taskkill 安装器）；安装器自启占单实例锁。
- **dev 联调要点**：`npx electron . --remote-debugging-port`；dev 需解包目录 `resources/targets/<target>/gateway/`（package:resources 只产 asar）；dev 网关就绪 ~40-50s；dev 下 webbridge 组件路径解析不过属环境差异；设置页保存测试会写 openclaw.json，测后从 `~/.openclaw/config-backups/` 恢复。

## 👀 Watch list / 遗留事项

**每次内核 bump 时核对**（内核升级兼容）：
- `OPENCLAW_SKILLS_ALLOWLIST` / `OPENCLAW_EXTENSION_ALLOWLIST` 对照上游目录更新（上游新增会被静默裁剪）。
- `carryOverInjected`（kernel-update.mjs）只搬运 `skills/` 与 `dist/extensions/`——上游布局迁移需人工核对。
- `verifyOutput` 对 bundled extensions 有 `extensions/` 与 `dist/extensions/` 双路径 fallback。
- `kernel-prune.js` 裁剪路径（koffi/ffmpeg/pdf-parse）与新包结构兼容（路径变化时静默跳过）。
- 官方 issue #65444 lazy channel connect 落地后可大幅加速 gateway 就绪（当前 ~22s 全耗在渠道初始化）。
- RPC 契约变化：sessions.list 排序/分组新参数、task 事件新 action（未知 action 已全量重拉兜底）。

**记录在案的遗留**：
- device token 明文存 localStorage（file:// 同分区）——威胁模型低，可改主进程/OS keychain 托管（待评估）。
- `handleOpenWebUI` 把 token 拼进外开 URL fragment（loopback，收益不成比例，维持现状）。
- Ctrl+S steer 真·插入当前回合需内核支持（「立即发送」已是最接近实现）。
- PATH 上 npm 全局 openclaw 可能遮蔽 CryoClaw wrapper（install-detector 已在 Setup 检测提示）。
- 会话菜单 `--up` 翻转极端时序取不到元素保持默认向下（优雅降级）。
- 会话管理 `includeDerivedTitles` 每行多一次 8KB 文件读——会话量极大时注意内核默认 limit。
- 主会话 chat.history 滞后：根因已定位（`SESSION_STORE_SNAPSHOT_CACHE` 无 TTL），待上游修复；UI 侧 `mergeIfStale` 兜底。
- ⚠️ 用户行动项：v2026.809 前历史安装包曾含 `.env.build`（已作废的 kimi-claw REFRESH 凭证）——若曾上传分发需轮换。

**R57 审查 defer 项（已评估、收益/风险比不划算或有前置依赖）**：
- webbridge 下载 pinned SHA-256（需发布链产出哈希清单，本轮已先落 https 降级拒绝）；kimi 凭据 Windows 侧 safeStorage/DPAPI 托管（涉文件格式迁移）。
- kernel-update 镜像源（npmmirror）packument 完整性 vs 官方 registry 交叉校验（需设计降级策略）；kernel-dist-patch injectWindowsHideAll 从正则启发式改函数标记锚定（补丁是实测过的，重写风险>收益）。
- runtime/.npmrc 只在 cwd 命中时生效——内核运行时若以 runtime 外目录为 cwd 起 npm 会绕过镜像配置（构建期 execNpmSync 已显式传 registry，仅运行时路径受影响，观察中）。
- vendorOfficialPlugin 无增量 stamp、7 插件串行 vendor（构建提速候选）；downloadFileWithFallback 失败分支 safeUnlink 可能删并行构建方刚 rename 完的缓存（.partial-<pid> 已保证写安全，仅多余重下）。
- before-quit 异步清理不 await 可能孤儿 gateway（settings/backup.ts 注释在案；改 preventDefault+异步收尾涉退出语义，需专项）。

**候选功能/加固（取证过、未做，按需立项）**：
- webbridge 二进制下载 SHA256 校验（需发布链产出哈希清单，R25 候选）。
- app-skills SkillsState 双重断言类型层收敛（R26 候选）。
- device-auth 签名载荷规范化（需网关侧同步修改）。
- 导出压缩段 worker 化（R33 已 async 化缓解，worker 化收益不成比例 defer）；~~kimi-auth-proxy 回环鉴权~~（R49 已移除该特性）。
- `terminal.*`（内嵌终端）、worktrees、完整语音会话 UI、device/node 管理——取证为低价值或高成本，未接入。
- IPC 通道按 webContents 来源细粒度授权（架构性改动，需逐 handler 评估）。
- 已发送文件附件卡片化（需先解决 gateway 发送契约一致性）。
- 安装体积：主体仍是 gateway.asar（~216MB）+ runtime；CryoClaw 侧裁剪已全部落地。
- tree-sitter-bash parser.c 9.4MB、typescript/lib 14.7MB（内核运行时依赖，勿动需先取证）。

## 📜 历史档案（阶段 1–22，压缩版）

- **阶段 1（内核升级链）**：官方 `openclaw update` 不支持 asar → 自研差分换装 `kernel-update.mjs`（staging install → carryOverInjected → 补丁 0 命中中止 → 冒烟 → 重打 → 备份 2 份 → rename → 健康失败回滚；锁文件防并发）。坑：Electron fs 拦截 asar 操作 → 脚本用 `original-fs`；asar v4 API `extractAll`。
- **阶段 2**：新 RPC 适配（models.list 动态化、审批历史、rewind/fork、语音只读）。
- **阶段 3**：`openclaw-config-migration.ts` 抽出（`since` 门控，双调用点）；wrapper `exit /b` 修复。
- **阶段 4**：应用自身「检查更新」整体删除（R20 重新引入为 GitHub Releases 方案）。
- **阶段 5**：升级链 43 单测；DEP0190 修复范式（禁 `shell:true`，Windows 显式 `cmd.exe /c npm.cmd`）。
- **阶段 7（安全）**：open-external 仅 http(s)；open-path 白名单；workspace root 限制；PID 复核；DevTools 生产禁用；渲染层 CSP；日历版本号确立。
- **阶段 8**：ipc-sender-guard 敏感通道加闸；日志降噪；vite vendor 分包。
- **阶段 9**：会话管理 + tasks 实时视图 + cron 每任务模型。
- **阶段 10（启动速度）**：窗口先行 + gateway 并行，用户感知 ~25s → ~0.6s；gateway HTTP 200 仍 ~22s（内核侧）。
- **阶段 11**：`gateway.reload.mode`；DeepSeek/GLM 预设；环境信息 tab。教训：vite 不查未定义标识符 → 发版前冒烟关键入口。
- **阶段 12**：加号菜单、`/` 命令补全、沙箱 UI、审批三态；强制 `lang=zh-CN`。教训：i18n 锚点事故 → `i18n.test.ts` 源码审计。
- **阶段 13**：chat-ui 真 typecheck（303 错清零）；官方 control-ui 死代码清除；`kernel-prune.js`（300.2→203.8MB）。
- **阶段 14**：`tools.exec.mode` 五值；`get-advanced` `{success,data}` 包装；docker-check 沙盒守卫。
- **阶段 15**：会话管理并入侧边栏；执行权限三态 + 引用技能；对话页去卡片化。
- **阶段 16（架构重构）**：`views/registry.ts` 视图接线 4+1→3 处；app-render 2271→~380 行；styles 11101→14 分块；i18n 拆分；IPC 113/113 全 sender guard；消息级 usage footer。
- **阶段 17**：思考强度接内核；单工具直显详情；阅读指示器阶段化；死代码清理（审批全局遮罩已删勿恢复）。
- **阶段 18**：图文混排（managed-media + Bearer fetch）；file-changes 本轮改动列表。
- **阶段 19**：审批面板 grid 陷阱（`minmax(0,1fr)`）；审批按 entry.id；token 日志脱敏；死 CSS ~2500 行清除。
- **阶段 20**：update_plan 计划面板；工具卡三态；错误卡片化。
- **阶段 21**：队列行内编辑/「立即发送」（直发走 preserveRunState）；fallback 提示；confirm-dialog 替换 9 处原生 confirm。
- **阶段 22（打包安全）**：electron-builder 平台级 files **覆盖**而非合并全局（曾致 571M asar 含 .env.build）；修复后 asar 4.1M；plugin.approval 入队修复。
### R58 · 模型设置在线能力 + Git/Worktree 完善 + 任务删除守卫 + 死代码清理（完成，随 v2026.909.8 发版）

用户闲时任务批次：模型设置在线化、git/worktree 功能补全、任务卡片精修与删除守卫、死代码清理，按固定流程交付（审查→冒烟→发版→去敏→push→发行版）。
- **在线模型列表**：新模块 `src/provider-live.ts` + IPC `settings:fetch-provider-models` ——按 api 形态构造 /models URL（openai 兼容直接拼、anthropic 按 base 是否含 /vN 补段、google key 进 query+pageSize=1000+generateContent 过滤、kimi-coding 始终用当前活跃 proxy 端口防陈旧端口）；UI 侧 provider 块头「同步模型」按钮 + 勾选批量添加面板 + 添加面板「从提供商获取」（目录与在线合并去重；手动 custom 以 providerKey 为 storage key 保证读写一致）。
- **用量/余额查询**：IPC `settings:get-provider-usage` ——DeepSeek `/user/balance`（官方）、Moonshot `/users/me/balance`（官方）、智谱 GLM Coding Plan `/api/monitor/usage/quota/limit`（社区验证端点，best-effort，0-1 百分比自动换算）；主进程归一化 balance/progress 两种形态，渲染层按 provider 隔离错误信息。凭据只在主进程读取（config 快照是脱敏的）。
- **Git 面板**：新增 git:branch-list/checkout/log/push/pull/discard/clean 七通道（execFile 数组传参 + GIT_TERMINAL_PROMPT=0 + sanitizeGitRefName 拒选项注入与 ref 语法炸弹）；UI 加分支切换面板、最近 30 条提交历史、推拉按钮（detached HEAD/空仓库前置拦截）、丢弃/删除（危险确认）。修复两个自查缺陷：嵌入模式（工作区页）推拉按钮此前不可达（唯一挂载点是 showRepoSelect:false）→ 抽 renderGitActions 共用；首屏不加载提交历史 → initGitPanel 补拉。
- **Worktree 手动创建**：内核取证确认 worktrees.create {repoRoot,name?,baseRef?} 与 worktrees.branches RPC 存在且无需 admin scope（workspace 内仓库）→ 管理视图新增创建面板（名称校验 ^[a-z0-9][a-z0-9-]{0,63}$ + 基线分支下拉，repoRoot 候选=既有 worktree 仓库根优先）。
- **任务删除守卫**：findActiveTaskForSession/activeTaskSessionKeys（childSessionKey/sessionKey 双命中）；侧边栏删除项按 activeTaskSessions 数据字段禁用（Lit shouldUpdate 需数据字段而非回调，app-render 按 tasks 引用记忆化保引用稳定）；deleteSessionFromSidebar 与 worktree 删除双拦截。
- **任务列表排版**：时间并入 meta 行、活动行 2px accent 左条、状态点对齐标题基线、actions 独占右缘垂直居中、密度收紧。
- **死代码清理**（全仓库扫描 1424 导出 + 865 i18n 字面量交叉引用）：删 56 个零引用 i18n 键（zh/en 成对）、17 个无消费方导出（DEFAULT_BIND/窗口重试孤儿常量/渠道 Status 类型存根 ×10/40 行未接线的 uninstallExtension 等）；en.ts 插件区块 4 空格缩进归一。
- **安全加固**：sanitizeGitRelPaths 拒绝含 `:` 路径——pathspec magic（`:(glob)**`）可绕过相对路径校验让 clean/restore 指向全仓库（审查代理实测复现）。
- **独立审查**：7 项发现（P2×2 + P3×5）全部修复；pathspec magic、kimi 陈旧 proxy 端口、同步错误跨 provider 串显、worktree 分支列表无序号守卫、untracked 行按钮文案错置既有键、unmerged 行丢弃必败、同步可复活并发删除的 provider 裸块。
- **验证**：全量测试 0 fail（178 node + 596 chat + 158 vitest + 77 scripts）+ dev 实例 CDP 功能冒烟 17 项断言 PASS（含 DeepSeek 官方余额接口实时返回、在线模型同步、git/worktree/任务全视图、0 裸 i18n key、0 renderer 异常）。


### R58a · 用户反馈修复批次：用量入口可发现性 + Kimi 过期会话自愈 + Progress Card 对齐（完成，随 v2026.909.9 发版）

- **用量/同步入口**：provider 块头的 13px 纯图标按钮（同步/查用量）几乎不可发现（用户三家提供商都没找到）→ 改为带文字胶囊按钮（`oc-provider-block__pill-btn`：同步模型 / 查用量），装机实拍验证。
- **Kimi 额度消失根因**：OAuth refresh token 被服务端作废时 auth.kimi.com 返回 400 invalid_grant（非 401/403），旧 `refreshOAuthToken` 不清理本地 token → getOAuthStatus 恒 loggedIn → UI 永显「登录成功」而用量接口 401 静默失败。修复：invalid_grant 同样 deleteOAuthToken（启动自动刷新链路即自愈）；`kimi:get-usage` 返回 authExpired 标记，渲染层清 loggedIn 引导重新登录；登录有效但拉取失败时显示可重试提示行（不再静默）。
- **Progress Card 对齐**（用户反馈的三项）：宽度收窄 `max-width: var(--chat-column)` 居中——与输入卡像素级对齐（实测 x/w 完全一致，此前撑满整行）；输入框下移 + 底部间距收紧（card padding-bottom 20→8 + compose 10→6，合计 30→14px）。
- **模型设置排版**：自定义分组管理区改 `<details>` 折叠（一行标题 + 分组数徽标），模型列表回到首屏。
- **验证**：全量测试 0 fail；安装 909.9 实拍 DOM 断言（三家 provider pill 按钮齐、org 折叠、0 裸 key）+ 进度卡/输入卡几何对齐断言 + 布局冒烟 22 场景 PASS。


### R58b · 子代理等待卡对齐（完成，随 v2026.909.10 发版）

- **问题**（用户反馈）：子代理等待状态卡与历史消息列未对齐——`.chat-subagent-cards` 容器无宽度约束撑满整个 `.chat-thread`，卡片另有 520px 限宽，视觉上远宽/窄于上下消息列。
- **修复**：容器走 `width:100% + max-width:var(--chat-column) + margin auto` 居中阅读列（与 `.chat-group`/`.chat-progress-card`(R58a) 同一契约）；卡片本体去 520px 限宽撑满列（与 `.chat-tool-card` 节奏一致）+ 补 `--shadow-xs` + pulse 偏移 token 化；`layout-fix.test.ts` 钉住契约回归。
- **验证**：全量测试 0 fail（597 chat-ui）；dev 实例 CDP 注入实测（容器/参照组 max-width 均 760px、内容盒对称居中 211/211px、左右缘与消息组 ≤1px、0 裸 key、0 renderer 异常）；安装 909.10 静默装 + 网关 200 + 附加冒烟同断言 PASS；应用内检查更新读到 feed `latest version: 2026.909.10` 更新链路端到端 PASS。
- **冒烟基建**：`.cache` 冒烟脚本改随机 CDP/网关端口 + 启动前 taskkill 清残留 + HTTP 探测加 timeout 销毁（防半开连接挂死 6 分钟全局超时；Windows 经典滚动条 ~15px 需按内容盒算居中断言）。

### R59 · 在途 run 输出恢复（完成，随 v2026.909.11 发版）

- **问题**（用户反馈）：切换会话或刷新对话窗口后，正在执行的任务消息输出不恢复。根因：`applySessionKeyTransition`/`onHello`/页面重载都清空本地 run 态，此后内核仍在跑的 run 的 delta 被 `handleChatEvent` 的僵尸帧过滤（「无本地活跃 run + 带 runId」按别家 run 丢弃）永久吞掉；orphan 收养只在断连重连路径标记。
- **修复 A（收养）**：内核 `chat.history`/`chat.startup` 响应附带 `inFlightRun` 快照（`{runId, text: 全量累计, startedAt?}`，gateway asar 实读确证 2026.8.2/2026.9.2 同构；来自实时 abort-controller 表，与消息列表持久化快照无关）——`loadChatHistory` 在会话守卫后、滞后读保留分支前收养（`adoptInFlightRunFromHistory`）：重建 runId/流式文本/startedAt/活动锚点；本地已有活跃 run 不覆盖；空文本收养为 busy 态（气泡降级思考指示）。切回会话、窗口刷新、断连重连三路径全覆盖；重连路径同时强化了 R30 orphan 机制。
- **修复 B（刷新兜底）**：排查中发现 Ctrl+R/窗口刷新会请求 UI pushState 改写的虚拟路径（/chat 等）→ 主帧 ERR_FILE_NOT_FOUND 白屏。`window.ts` did-fail-load 主帧分支回退真实入口 URL（沿用首载 gatewayUrl/token + 保留 ?session；5s 防抖 + 入口自身失败排除防循环），判定逻辑抽纯函数 `src/virtual-path-reload.ts`（6 项单测）。
- **验证**：全量测试 0 fail（新增 chat controller 收养 5 测 + 虚拟路径 6 测）；dev 实例端到端冒烟（真实 chat.send → 流式中 Page.reload → 断言流式态 30s 内恢复）PASS；安装 .11 同场景冒烟（剥离渠道插件的独立状态目录规避 asar 形态插件路径差异）PASS；0 裸 key、0 renderer 异常。

### R60 · 设置页「MCP 与钩子」+ 四路全库审查修复批次（完成，随 v2026.909.12 发版）

- **功能：设置页 MCP & Hooks tab**（`tab-mcp-hooks.ts` + 可单测纯逻辑 `tab-mcp-hooks.lib.ts` + 13 项 lib 测试）：管理 `mcp.servers`（stdio/sse/streamable-http 三形态；表单独占字段显式产出、enabled 恒显式写、RFC7396 删键置 null；编辑经 preserve 合并保留 timeouts/oauth/toolFilter 等高级字段但**剥离表单独占键**——防切换 transport 残留对侧 url/headers）与 `hooks` 段（开关/path/token/defaultSessionKey/mappings；token 透传 REDACTED 哨兵内核自还原；mappings 走 `replacePaths: ["hooks.mappings"]` 整体替换；agent+persistent 无会话锚点不落 sessionMode 规避内核 superRefine）。守卫：新增重名拒绝（防静默覆盖既有配置）、删除走 `showConfirm` danger 红色确认（项目惯例）、无 id mapping 兜底命名带碰撞避让（防内核按 id 就地合并丢条目）。
- **审查方法**：3 个并行审查代理（主进程 src/ 全量、chat-ui 全量、scripts 全量）+ 人工复核 R60 新代码；0 P0，共 3+2+3 个 P1 与 5+4+8 个 P2，本阶段修复全部 P1 与高价值 P2（19 项）。
- **主进程修复**：① `did-fail-load` 两处日志剥离 query（token 不落盘），诊断包导出对日志内容跑 `token=` 正则兜底脱敏（logger 新增 `sanitizeUrlForLog`）；② 内核升级 stopGateway 静默化（cancelPendingGatewayRestart + await inflightGatewayOp）+ requestGatewayStart/Restart 及防抖回调加 `getKernelUpdateState().running` 检查 + CLI `/gateway/restart` 入口补导入/升级互斥（防换装中途 spawn 半换装内核）；③ `ensureGatewayRunning` 重试链 try/catch（单次写盘异常不再打断 3 次重试与 whenReady 链）；④ `writeUserConfig` 原子写（.tmp+rename，对齐 config-backup 同款）；⑤ kimi-code 验证后恢复代理 token 为当前生效凭据（settings/setup 两入口，防失败验证永久劫持流量 401）；⑥ webbridge `home()` 平台优先序对齐 constants（Win USERPROFILE 优先，skill 路径延迟求值）；⑦ 插件可用性迁移把安装包 extensions-mirror 视为可解析（状态目录被清不再永久禁用渠道插件）。
- **chat-ui 修复**：渠道面板 runChannelSave/runChannelToggle try/finally（verify IPC reject 不再卡死保存按钮）+ provider 密钥保存 catch 回显；Setup 向导 kimi-code proxyPort≤0 中止（不落盘 :0 坏配置不误报成功）；`/` 命令补全浮层渲染前按 draft 防御校验 + 切会话重置（发送/切换后不再残留）；工作区面包屑按 `[/\\]` 切分（Windows 显根目录名）；config.patch 错误文案 i18n 化（7 键 zh/en）；handleAddToGroupSave 并发删除守卫移入 mutator（existedBefore 判定，不复活裸 provider 块）。
- **scripts 修复**：① 扩展白名单裁剪指到活路径 `dist/extensions/`（旧路径保留兼容）——此前指旧 `extensions/` 从未生效、68 个上游扩展全部进包；allowlist 基线固化为当前分发集合（今日包内容零变化，门禁恢复：升级新增扩展会被裁掉强制人工审阅）；② kimi-search tgz sha256 钉定（下载与缓存两路都校验，URL 覆盖时跳过并 WARN）；③ dist-all-parallel 先串行 `npm run build` 再并行打包段（四路并发 build 践踏共享产物目录的竞态）；④ 插件安装临时目录 try/finally 清理（installNpmPackagePluginInto/installTgzPluginDeps；assertPluginDir die→throw 使 bundlePlugin 既有清理不再是死代码）；⑤ kernel-update `npmRun` Windows 直执 npm-cli.js（ELECTRON_RUN_AS_NODE，`cmd.exe /c npm.cmd` 在含括号安装路径下断裂）。
- **连带发现并修复（冒烟暴露）**：kernel-update.mjs 换装残留自愈 `xfs.dirname/basename/join` 是 path 模块 API 误挂在 fs 上——**自愈逻辑从写下起就 100% 抛错从未生效**（gotcha #90）；dev 冒烟前须按 gotcha #89 从 gateway.asar 恢复散装树。
- **验证**：全量 **1034 pass / 0 fail / 4 skipped**（vitest 159 + node 180 + chat-ui 618 + scripts 77）；dupcheck 1.18%（94 clones）；dev 实例 CDP 冒烟（导航→tab 渲染→添加服务器填表保存→条目断言→删除确认弹窗→删键生效→0 裸 key/0 renderer 异常）PASS。

- **第二轮独立审查（review-agent，针对 MCP/Hooks 新代码）修复**：P0——mappings 走 replacePaths 整体替换时内核为字面整体赋值，条目内显式 null 不再走 RFC7396 删键而被 strict HookMappingSchema 拒绝（"expected string, received null"），条目空字段改省略键（hooks 顶层 path/token/defaultSessionKey 逐键合并路径不受影响，null 删键保留）；P2——saveServer/deleteServer 改单条目 upsert/removeMcpServerInDraft（陈旧本地集合全量替换会在 baseHash 冲突重试时静默删除并发新增的服务器）、agent+persistent 无会话锚点保存前 validateHooks 拦截提示（不再静默省略 sessionMode 让用户选择丢失）；P3——删除正在编辑的条目时同步关闭表单（防 Save 复活已删条目）、配置加载失败不再同时显示「尚未配置」空态、saveHooks 对表单状态做 structuredClone 快照（防在途输入被并入补丁）。lib 测试增至 23 项（含省略键形态与 validateHooks 用例）。
- **安装版验证**：静默安装 2026.909.12 后同套 CDP 冒烟 11 项全过（含确认弹窗删除链路；网关日志确证 config.patch changedPaths=mcp.servers.<name> + hot reload applied）。


### R61 · 内核问答卡片适配（完成，随 v2026.909.13 发版）

- **能力取证**（gateway asar 实读）：RPC question.list/get/resolve（operator.questions scope，2026.7+）；WS 事件 question.requested/resolved；QuestionRecord 形态 {id,status,questions[1..3]{questionId(^[a-z][a-z0-9_]*$),header,question,options[1..4],multiSelect?,isOther?,isSecret?,secretStore?},sessionKey?,runId?,createdAtMs,expiresAtMs}；resolve 参数 cancel / answers{[qid]:[label]} / secret 统一 ["stored"]+allowedHosts；control-ui 消费形态 gatewayQuestionPrompts。
- **实现**：纯逻辑 chat/question-cards.ts（归一校验对齐内核 strict 语义、pending 会话过滤+过期、事件 upsert/落终态、list 对齐「服务端终态覆盖一切、服务端 pending 不覆盖本地终态」、resolve 参数构造，10 测）；app-gateway 接线事件+onHello list 对齐+tick 过期清理；渲染 views/question-card.ts 挂线程尾部（历史→流式→子代理卡→问答卡），样式与进度卡同 --chat-column 居中列；tappable（单问题非多选非 secret）选项直答、secret 提交占位、多选/复合提示走输入框、Skip=cancel；本地即时落终态（resolved 事件幂等收敛）。
- **验证**：dev + 安装 .13 双轮 CDP 冒烟 10 项全过（注入模拟问题→卡片渲染/会话过滤→点选项断言 resolve RPC 参数→跳过断言 cancel→0 裸 key/0 异常）。

### R62 · 回底按钮修复 + 消息对齐及时性（完成，随 v2026.909.14/.15 发版）

- **回底按钮展示修复**（v2026.909.14，用户反馈）：CDP 几何取证发现按钮悬浮在 compose 顶缘上（重叠 12px 遮挡输入区上沿）——旧 margin 0 auto -52px 让 compose 上滑到按钮之下。修复 margin -44px auto -8px（总负占位不变、compose 位置不变），按钮悬于消息流内部底缘（实测 btnOverCompose:false、与消息列/compose 同中心 x）。CSS 契约钉进 layout-fix.test.ts。
- **消息对齐及时性**（v2026.909.15）：①滞后补拉退避 800/1600/2400 → 600/1500/3000/6000ms——首档提前 200ms，尾档 6s 覆盖内核慢持久化长尾（旧预算 2.4s 耗尽后「问了没答」无人收敛）；②活跃 run 45s 无流式活动（长思考/长工具）时提前做 silent mergeIfStale 预对齐（内核已落盘的子代理产出等及时并入历史），不等 180s 看门狗；对齐不改 run 态，看门狗判定不受影响。
- **验证**：全量测试 0 fail（chat-ui 630）；退避/预算用例同步扩档（预算耗尽 4 档共 5 次调用 + 会话切换预算复位）。

### R63 · MCP 页重叠修复 + 真静默更新换装（完成，随 v2026.909.16 发版）

- **MCP 页重叠修复**（用户反馈，QA 实拍 11/22.png）：设置页「MCP 与钩子」点「添加服务器」后表单与 Webhook 区块全页叠压。CDP 取证根因：`.oc-settings__section { flex:1 }`（basis-0）在 3 个平级 section 时平分容器高度，表单内容溢出 section 盒外与下方区块视觉重叠（关闭表单时也有 ~10-25px 的轻微叠压，只是肉眼难察）。修复双保险：① tab-mcp-hooks 收敛为与其他 tab 同构的单根 section（间距由 section 自身 gap 统一承载）；② 防御样式 `.oc-settings-content > .oc-settings__section { flex: 1 0 auto }`——任何未来多 section 写法不再收缩到内容以下（ext-layout 内 section 依赖 basis-0 做内部滚动，该路径不受影响）。同步去掉 `.oc-mcp__form` 的 margin-top（新结构下 24+12 不均匀间距）。坑记 gotcha #92。
- **真静默更新换装**（用户反馈）：`quitAndInstallAppUpdate` 此前 spawn 安装器不带 `/S`（v2026.906.0 起故意非静默"可观察进度"），用户必须点完 NSIS 向导。改为 `["/S", "--updated", "--force-run"]`：零 UI 全程；模板取证 installSection.nsh ONE_CLICK+isForceRun → doStartApp 装完自动拉起新版；appRunning/appCannotBeClosed 弹窗均带 /SD 旗标（静默默认动作，不隐形阻塞）；回退路径 `quitAndInstall(false,true)` 同步改 `(true,true)`。
- **静默换装端到端实证**：装回 .15 → 应用内「更新→重启安装」复现旧版弹向导卡死（旧行为实证，即用户投诉路径）；随后以 .16 修复代码的精确参数向量 `["/S","--updated","--force-run"]` 从 .15 换装——240s 窗口轮询 0 可见安装器窗口、安装位版本 .15→.16、`--force-run` 自动拉起新版全中。注：应用内路径从 .16 起才走新代码（.15 实机内仍是旧 spawn），下个版本的实机更新即全真静默路径。
- **验证**：全量 **1046 pass / 0 fail**（vitest 159 + node 180 + chat-ui 630 + scripts 77）；修复后安装包 CDP 全矩阵回归——表单关闭/打开 × 800/834/1024/1440px 跨组件叶子元素重叠全部 0（修复前 1440px 下 16 对、800px 下 19 对）；卡片级重叠 0；表单视觉重排确认正常；silent-install E2E 静默装 2026.909.16 通过；layout-cdp-smoke 24 场景 0 issue/0 异常/0 裸 key；新增 `scripts/settings-cdp-smoke.js`（设置页全 14 tab 巡览 + MCP 表单展开复测的跨组件重叠/异常/裸 key 冒烟，纳入发版固定一步）首跑全绿。

### R64 · 三路全库审查修复批次 + UI 截图 QA 固定流程（完成，随 v2026.909.17 发版）

- **审查方法**：3 个审查代理（主进程 src/ 86 文件、chat-ui 全量、scripts 全量）逐文件审查 + 交叉验证；0 P0，共 1+1+2 P1、4+2+5 P2、3+6+6 P3 = 29 项发现，本阶段修复 26 项（webbridge 二进制 sha256 钉定留 R65——需建立哈希清单；volcengine-cdn-refresh 超时（归档链路）与 cli-compat runCli 引号语义（P3，牵动断言语义）挂起）。
- **主进程**：① gateway start() 预启动步骤（cleanStaleLockfile/uninstallGatewayDaemon/probeHealth/stopExistingGateway/ensureClawhubWrapper）整体 try/catch，失败复位 stopped——磁盘满/杀软锁文件时状态机不再永久卡死 "starting"（start 的 state 守卫与 stop 的 !proc 早退双双空转）；stop() 对 "starting"+无 proc 半死态强制复位兜底。② 恢复出厂先 `gateway.stop({waitForStarting})` 再删 openclaw.json（SettingsIpcOptions 新增 stopGateway 注入）——内核 config observer 不再在退出前把配置写回复活。③ requestGatewayRestart 的 800ms 防抖定时器 unref + before-quit/quit() 开头 cancelPendingGatewayRestart（退出序列不再可能 spawn 孤儿 gateway）。④ gateway-auth token 补全改原子写（.tmp+rename 对齐 writeUserConfig）。⑤ dialog:select-files 失焦兜底从 `{} as any` 改 fromWebContents/无父窗口重载（旧实现原生参数转换抛错、文件选择打不开）。⑥ clawhub wrapper % 双写转义（对齐 escapeForCmdSetValue）；pairing code 拒 `-` 前缀（CLI 选项注入防护一致性）。
- **chat-ui**：① sendChatMessage 会话归属快照前移到附件读取 await 之前——带文件发送（单文件 16MB、数百毫秒窗口）期间切会话不再把消息发进新会话、乐观气泡 append 进新会话、run 态覆写新会话流式状态；chat.send 显式发往快照会话。② 问答卡 resolve 终态只在请求成功后落（questionResolvingIds 在途防重）——失败时卡片保持 pending，内核 run 不再空等答案到重连对账。③ no-branch 哨兵在 onPush toast 后即清（不再渲染成常驻「操作失败: no-branch」横幅）。④ applySessionKeyTransition 重置 chatLoading（断连交错下旧请求 finally 按 sessionKey 守卫跳过清位时不再滞留「加载中」）。⑤ 草稿快照 LRU 上限 20 条（大附件 base64 跨会话累积驻留内存）。⑥ tab-provider handleKeySave 入口占 busy（verify 数秒窗口防重复点击）；question-expiry tick 注销对称；enterHooks 死代码、looksLikeFeishuUserId 死函数清理。
- **scripts**：① asar→散文件反向切换清理遗留 gateway.asar(+.unpacked) + verifyOutput 断言散文件模式无 asar——此前 afterPack 按 existsSync 误判注入模式，发行包携带旧内核且全链路绿灯。② execNpmSync 校验放宽（execFileSync argv 直传无 shell，仅拒控制字符/引号）——含括号的合法 Windows checkout 路径不再构建失败。③ dist-win 产物校验假绿转硬失败（无 exe/latest.yml/blockmap → 非零退出）。④ Node 运行时钉定 package.json cryoclaw.node=22.23.2（原"取最新 22.x"随网络漂移不可复现）；sha256 校验硬失败 + 哈希旁路文件（.sha256）供缓存命中离线复核。⑤ plugin-matrix-smoke 修复（execFileSync 数组误用 + asar 路径绝对化），实测可用（69 扩展/68 manifest/boot 14 加载）。⑥ merge-release-yml 先清 release/ 再写合并 yml（顺序敏感；防旧 exe 混入上传集合 sha512 不一致）+ COLLECT_EXTENSIONS 死条目清理。⑦ installer.nsh CLI 生成改 -File + ps1 自定位（$PSScriptRoot 上级，去 $env:INST_DIR 内插，特殊字符安装路径免疫）。⑧ predev 显式 --no-asar（跨平台旗标，Windows npm 的 env 前缀语法不可用）。
- **杂项**：CSP meta 移除 frame-ancestors（meta 交付被浏览器忽略并告警；Electron 壳无被嵌入面）；网关冷启动 ws error 日志 error→warn（error 事件总伴随 close 的 warn，成串噪音）。
- **新增固定流程**：`scripts/ui-screenshot-qa.js`——主视图 × 宽度 × 主题 + 设置页全 tab + 英文语言的系统化截图（out/ui-qa/<ts>/）+ 每场景跨组件重叠检测 + 异常/裸 key 硬门槛，与 layout-cdp-smoke / settings-cdp-smoke 并列进 releasing.md。
- **验证**：全量 1046 pass / 0 fail（vitest 159 + node 180 + chat-ui 630 + scripts 77）；发版管线：silent-install E2E + 三 CDP 冒烟全绿（详见 R64 发版记录）。
- **验证补记**：UI 截图 QA 31 张 0 重叠/0 异常/0 裸 key（en rail「中文残留」为视觉模型误报，CDP 确证 ?lang=en 全英文）。
- **应用内静默换装实证（.16→.17，R63 修复的首个真实生效路径）**：装回 .16 → 应用内「更新→重启安装」→ app.log 确证「启动静默安装器」（新 /S 代码路径）→ 300s 窗口轮询 0 可见安装器窗口 → 安装位 .16→.17 完成换装；--force-run 自动拉起在参数向量级测试（.15→.16）已实证（换装完成即 4 进程自动运行）。用户投诉的「更新要手点安装器向导」双路验证修复。E2E 脚本教训：更新日志模态会挡住更新弹窗，自动化须先关「知道了」；弹窗按钮定位须精确匹配（宽松正则会点错按钮误报安装未触发）。

### R65 · WebBridge 供应链钉定 + CLI 冒烟修复（完成，随 v2026.909.18 发版）

- **webbridge sha256 钉定**（R64 审查遗留 P2，供应链）：CDN 只暴露 latest 别名（版本化 URL 实测 NoSuchKey）、内容上游随时可变，而 webbridge 二进制下载后即执行（install-skill）。取证后钉定当前 latest 三平台产物哈希（win-x64 2257775a…/darwin-arm64 30f676a0…/darwin-amd64 18b35c39…，全部 MZ/Mach-O 头校验），`verifyWebbridgeBinarySha256` 下载后校验、失败删产物 fail closed；缓存命中（ETag 跳过）路径复验——旧版本 App 无钉定时期落盘/被篡改的二进制作废重下；repair 路径（skipBinaryInstall）的既有二进制执行前同样过校验（复核 P2 修复），不匹配走既有 fail 链降级 openclaw 模式。升级 webbridge = 更新钉定表；KIMI_WEBBRIDGE_SKIP_PIN=1 排障逃生门。`expectedSha256: ""` 两路径统一为显式跳过（复核 P3）。
- **cli-compat-smoke 修复**（R64 遗留 P3 + 复核新发现）：quoteArgForCmd 只对含空白且无 cmd 元字符的参数整体加引号（实测引号段含 $/% 会让 cmd 语法报错 exit 255，元字符参数维持原样透传是 cmd 固有限制）；/s 形态按契约补外层引号包裹（旧形态经 libuv 转义后整条命令损坏，用户名含空格的机器 smoke 整体失败）。实测 13/13 断言通过（此前 worktrees --help 偶发超时为瞬时抖动）。
- **验证**：聚焦复核（审查代理）发现 1 P2 + 3 P3 全部修复（repair 绕过、空串语义、缓存复验零覆盖、/s 死分支）；全量 1047 pass / 0 fail（vitest 159 + node 182 + chat-ui 630 + scripts 77，新增 webbridge 钉定/缓存复验 2 测）；发版管线 silent-install E2E + 三 CDP 冒烟全绿。
- **收敛审查（R65 后增量）**：增量审查代理确认 R63/R64/R65 三轮 commit 无回归、volcengine-cdn-refresh 挂起项确证不在任何发版链（纯手动运维工具）、TODO/FIXME 扫描无未完成安全工作；唯一 P3（草稿快照 LRU 无直接单测）已补 testDraftSnapshotLruEviction（20 条上限、最旧逐出断言）。审查循环至此收敛——无新发现，任务闭环。

### R66 · WebBridge 钉定表随上游轮换 + 功能/页面审查修复（完成，随 v2026.910.0 发版）

- **用户报告的修复失败定位与处置**：高级设置「修复 WebBridge」报 `sha256 校验失败: expected 2257775a… actual 75f7f1b0…`。取证：上游 CDN 于 2026-09-10 09:46 GMT 换新全部三平台产物（win 2257775a→75f7f1b0、darwin-arm64 30f676a0→80d92c2c、darwin-amd64 18b35c39→9f25e250）；curl 与 Node https 两次独立下载哈希完全一致（排除传输污染），三平台同批替换（协同发版而非单文件篡改）→ 判定为上游正常换新，按 R65 定下的升级路径重新取证更新钉定表。
- **修复路径一次点击收敛**：此前 repair 路径遇到「钉定表已更新、本机仍是旧产物」会直接 fail（删产物 + 抛错），用户要点两次才成功；现改为作废旧产物 → 自动重下 → 由下载后校验决断（仍 fail closed），一次修复动作内收敛。repair 且重下失败时保持原有确定性降级语义（不写 config，由调用方决定）。
- **面向用户的错误文案**：钉定失败原文含内部哈希与 `KIMI_WEBBRIDGE_SKIP_PIN` 逃生门说明，终端用户无法操作；UI 两处（设置-高级修复弹窗、侧栏 pill 修复弹窗）改为「请升级 CryoClaw 后重试」，技术细节保留在日志。
- **三路审查（主进程 / chat-ui / scripts+发版物料）**：17 项发现全部核实并修复——
  - 主进程：Windows 全局 npm 卸载静默失效（`execFile` 直调 `npm.cmd` 在 Node ≥18.20 必抛 EINVAL，错误被当"未安装正常"记 info、调用方又忽略返回值）→ 改经 `cmd.exe /d /s /c` 调用并让 setup 感知失败；webbridge repair 校验失败自动重下；extension-mirror 直写 openclaw.json 后补 `syncOpenClawStateAfterWrite`（防 .bak 回退抹掉 plugins.allow → 外部通道能登录但永远不回消息）；Kimi OAuth 轮询容忍瞬时网络错误（连续 5 次才放弃，不再单次抖动中断登录）；webbridge needs-repair 复用默认浏览器解析（每 30s pill 轮询省 2 次 tasklist 进程枚举）；webbridge 测试 HOME/USERPROFILE 顺序与实现对齐。
  - chat-ui：模型选择器按会话显示真实模型（此前切会话后仍显示上一会话选的模型，内核却按本会话模型运行）+ patch 失败回滚；设置-高级页加载失败不再静默用默认值（浏览器模式/开机自启/ClawHub 源）覆写用户真实配置（loadFailed 禁保存 + 报错）；钉定失败文案；定时任务切换调度类型时归一化时间字段（修"显示有效时间却报无效"）；技能页计数与列表过滤口径统一；问答卡倒计时秒级 tick + 过期卡片自动回收。
  - 构建/发版物料：clawhub 依赖钉定 0.23.3（此前是唯一 "latest" 依赖，发行产物随构建时机漂移且不进缓存戳）；CI 脚本测试清单改为动态生成（原清单引用已删除的测试文件、且漏跑 5 个测试文件）+ `npm ci` + 依赖缓存 + Node 22.23.2 与发行运行时对齐；官网第三处版本徽章（terminal 标题）纳入自动刷新。
- **发版门禁工具两处假阳性修复**（本轮实际两次误拦发版）：① 裸 i18n key 扫描扫全 body 文本 → 命中模型思考块「…triggers additional tasks.Let me…」（内容污染；且 token 由相邻文本节点拼接而成，逐节点搜索反而定位不到）→ 抽 `scripts/lib/bare-i18n-scan.js` 只扫 UI chrome；② 重叠检测未考虑祖先裁剪 → 折叠思考块（height:0 + overflow:hidden）内不可见文本被算成"压住输入框" → 抽 `scripts/lib/overlap-scan.js` 按**可见矩形**（与所有裁剪祖先求交）判定。两者均做阳性/阴性双向对照（chrome 假键被抓到、内容容器假键排除；注入可见重叠被抓到、裁剪内容不误报），三个冒烟脚本共用，重复实现收敛。
- **验证**：全量 **1060 pass / 0 fail / 4 skipped**（vitest 159 + node 184 + chat-ui 640 + scripts 77；新增 webbridge repair 重下 2 测、cron 归一化 5 测、技能过滤 3 测、钉定错误判定 2 测）；dupcheck 1.17%；silent-install E2E 静默装 2026.910.0 通过；**发行产物内容断言**：安装位 app.asar 含新钉定且旧钉定 0 命中、gateway.asar 内 openclaw 2026.9.2 + clawhub 0.23.3；gateway `GET /` 200；三 CDP 冒烟全绿（layout 24 场景 0 issue/0 裸键/0 异常、settings 14 tab 0 重叠/0 裸键、UI 截图 QA 31 张 0 重叠/0 异常/0 裸键）。

### R67 · 第二轮功能/页面审查（未深审模块 + i18n/a11y/设计合规）

- **方法**：2 个并行审查代理——① 组件/控制器/setup/workspace-git 等 R66 未深审模块；② i18n 完整性 + 无障碍 + 设计 token 合规。共 17 项发现，本轮修复 10 项（P0×1/P1×2/P2×4/P3×3），其余（模态 Escape/焦点管理 7 文件、非原生可交互元素键盘可达 ~10 处、locale 持久化）登记为后续批次——它们需要组件生命周期改造，单点补丁风险高于收益。
- **修复**：①【P0】全新安装（主进程只开 Setup、不启 gateway）时 `models.list` 目录为空 → 模型下拉整体不渲染、下拉内「自定义模型」哨兵也不可达 → 选 Anthropic/OpenAI/Google/Moonshot-CN 的用户看到「请填写模型 ID」却无处可填，**Setup 无法完成**；新增 `STATIC_MODEL_FALLBACKS`（setup-constants，含回归测试锁定每个 provider 非空）+ 下拉渲染条件放宽为「非手动自定义或候选非空」，自定义入口永远可达。②【P1】更新弹窗「重试下载」必然失败：下载失败后 status 停在 `error`，而 `downloadAppUpdate()` 只在 `available` 放行 → 重试前先 `appUpdateCheck` 重新检查（唯一脱离 error 的路径）。③【P1】`document.documentElement.lang` 从不随 locale 更新（index.html 写死 en）→ 启动时同步为 zh-CN/en（WCAG 3.1.1）。④【P2】侧栏会话重命名/置顶/未读/归档失败只写进无人消费的 `sessionsError` → 统一 toast。⑤【P2】Setup 第三步 WebBridge 开关是 click-only div → 补 role=switch/aria-checked/tabindex/Enter+Space。⑥【P2】断连时新建 worktree 弹「已创建」却什么都没做 → 显式校验 connected + 空响应报错。⑦【P2】聊天/密码框图标按钮无无障碍名 → aria-label（chat.scrollToBottom / chat.stop / chat.send* / settings.show|hidePassword）。⑧【P3】移除 6 处违反规范的 `text-transform: uppercase`（cron/primitives/session-panel/workspace/tasks-misc×2）。⑨【P3】message-box 的 `--accent-subtle` 兜底残留退役 indigo → CryoBlue。⑩【P3】`docs/ipc-api.md` 补齐 workspace:* 与 R58 git 通道、删除已退役的 `setup:retry-random-port` 幽灵行；managed-image 放大补键盘可达；`#fff` 内联色改用 `--text-on-accent`。
- **i18n 复核（代理全量扫描）**：zh/en 各 1084 键、键集完全一致、无重复键；927 个静态调用点全部命中；14 个动态键族全部被类型并集覆盖。

### R68 · WebBridge 修复永久化：可自动更新的远端钉定清单（用户报告复发）

- **复发取证**：用户在新版（v2026.910.0，含 R66 的友好文案）仍看到「组件校验未通过」。实测上游 **当日第二次换新**：`.../latest/releases/kimi-webbridge-windows-amd64.exe` 字节数与前次完全相同（10342912B），逐字节比对仅 **177B 差异，首个差异即 `Go build ID`** 字符串——上游把 latest 当"可反复重建的发布位"，而 exact-hash 钉定写在 App 里，于是每次重建都要等发版才能修复（R65 建立、R66 更新的模型本身不可持续）。
- **永久修复**：新增 `src/webbridge-pins.ts` + 仓库内 `resources/webbridge-pins.json`——钉定值改为**可自动更新的远端清单**：修复/安装时读本地缓存（24h 新鲜期）→ 过期则按序拉取 jsDelivr → raw.githubusercontent（限 64KB/10s、禁 https 降级、JSON 严格校验：值必须 64-hex，任一条目非法即整体丢弃）；校验链 = 内置嵌入表 ∪ 远端清单，任一精确匹配即通过；两者都不匹配维持 fail closed 删产物。上游再换新时，**更新清单文件即可修复所有用户，无需发版**。repair 跳过下载的既有二进制复核同样接入远端清单；`installWebbridge` 缓存命中复核与下载后校验共用同一 `remotePins`。
- **验证**：新增 3 个单测（清单严格解析/缓存新鲜期与过期回退/远端命中放行且不删产物、双不匹配删产物）；真实 CDN E2E：`installWebbridge`（force）下载并校验通过（etag EEED8871…）；远端清单在本仓库 push 前 404 时正确回退内置表（不阻断修复）。内置表同步更新为当前三平台哈希（win eec1976d…/darwin-arm64 04532d77…/darwin-amd64 931769e9…）。

### R69 · 无障碍批次：模态键盘关闭/焦点 + 可交互行键盘可达

- **来源**：R67 第二轮审查登记并延后的 a11y 批次（当时判断需组件生命周期改造，本轮找到低侵入实现方式）。
- **弹窗键盘可达（9 处）**：新增 `chat-ui/ui/src/ui/dialog-a11y.ts`——app 层安装一个 document 级 keydown：Escape 时对**最上层可见弹窗遮罩**派发一次 click（各处遮罩点击语义已统一为"关闭/取消"，且"下载中不可关"这类守卫写在 click 处理器内部，因此同样生效），并在 `updated()` 里于弹窗出现且焦点仍在外部时把焦点移入遮罩（9 个遮罩补 `tabindex="-1"`）。此前 8 个文件 9 处弹窗只有鼠标可关、打开时焦点留在背后页面（读屏用户被困）。
- **可交互行键盘可达**：新增 `a11y.ts#activateOnKeydown`（Enter/Space 触发、`e.repeat` 防护、Space 拦截滚动）。接入：会话列表行（`cc-session-panel`，附 `aria-current`）、工作区导航节点 ×3 与文件树行、Git 文件行、worktree 卡片、设置页 CLI 开关（补 `role=switch`/`aria-checked`）。这些行此前 Tab 到不了、Enter 无效。
- **测试**：新增 `a11y.test.ts`（Enter/Space 触发与拦截、Tab/Escape 不拦截、长按 repeat 不触发、isEscapeKey 含 keyCode 兜底）；chat-ui 645 pass。语义用单测钉死，避免后续回退。
- **验证**：全量 **1068 pass / 0 fail / 4 skipped**（vitest 159 + node 187 + chat-ui 645 + scripts 77）；发版管线 silent-install E2E + 产物断言 + gateway 200 + 三套 CDP 冒烟全绿（详见发版记录）。

### R70 · 交互级页面审查（新增发版固定步骤）+ 确认弹窗 Escape 修复

- **新增交互级冒烟** `scripts/interaction-cdp-smoke.js`（发版固定步骤第 4 个，docs/releasing.md 3.6）：逐视图点击 rail、逐设置 tab 巡视、触发危险确认弹窗并验证 Escape 取消，全程追踪 renderer 异常。与既有三个冒烟的差别：那三个是"看"（几何/截图/文本），这个是"动"（真实控件交互）。防误触设计：危险操作本体都有 `await showConfirm` 前置守卫，脚本点开确认框后立刻 Escape，并断言取消后应用与网关均未受影响。
- **它发现的真缺陷（本阶段修复）**：通用确认弹窗（`confirm-dialog.ts`，用于「重置配置并重启」等危险操作）的遮罩**不响应点击**（这是刻意的——避免"点外面就取消危险操作"的歧义），因此 R69 加入的 Escape 关闭对它无效。修复：`closeTopDialog` 优先点击弹窗内显式标记 `data-dialog-dismiss` 的取消/关闭按钮，找不到才回退遮罩点击；9 处弹窗的取消/关闭按钮补齐该标记。
- **顺带修正的审查脚本问题**（避免误判）：① 先切到「备份恢复」tab 再找重置按钮（tab 循环结束时停在最后一个 tab）；② 设置页「搜索」tab 会按设计触发热应用重启，网关健康检查改为轮询 30s（此前单次检查过早 → 误报"网关不可用"）；③ SPA 会把 URL 重写为虚拟路径，断言不再要求 `index.html`；④ 残留实例会占单实例锁/端口，审查前需清理。
- **验证**：交互冒烟 10 步全绿（6 视图 + 13 tab 0 渲染异常；对话 5 个、工作空间 33 个键盘可达行；确认框 Escape 关闭 1→0；取消后网关仍 200）；全量 **1068 pass / 0 fail**；发版管线 silent-install E2E 装 2026.910.3 + gateway 200 + 四套 CDP 冒烟全绿。

### R72 · 内核 2026.9.3 适配 + 词条/长文案/性能三轴审查 + 死代码清理

- **内核 2026.9.3 适配（取证先行）**：docs/kernel-recon/2026.9.3-diff.md（npm 双版本解包 + 真实 npm install 树实跑补丁 + Electron-as-Node CLI 矩阵）。两处硬阻断：① engines 剔除 Node 22/25（`>=24.16.0 <25 || >=26.1.0`，preinstall + 运行时双守卫）→ 捆绑 runtime 22.23.2 → **24.21.0**（Electron 43 内嵌 24.18.1 本就满足，gateway/CLI 路径不受影响）；② dist 根 chunk **.js → .mjs 翻转**（5380 个 .mjs）→ kernel-dist-patch 三个扫描点（asar 边界候选 / windowsHide 收集 / marker 检查）扩展收 .mjs，`assertAsarBoundaryCoverage` 追加 peer-link .mjs 形态断言（堵住「root-file PASS 但 peer-link 整体漏打」盲区），测试补 .mjs fixtures。fs-safe 0.8.5 六注入点逐字节同形态零改动；RPC +6/-0 纯增量；config migration 零新增。**适配过程中实测发现并修复**：`resolveUserStateDir()` 对相对 OPENCLAW_STATE_DIR 不做绝对化，gateway 子进程（cwd 在 openclaw 包目录）解析到不存在路径——2026.9.2 静默回退 ~/.openclaw 误读生产配置掩盖了该 bug，2026.9.3 严格校验 exit 78 将其暴露。kernel-channel.json stable 保持 2026.8.2（旧产物内升级会 npm 拒装，携带 Node 24 的本版发布后再推进）。
- **词条覆盖率审查**（.cache/i18n-audit/ 脚本可复跑）：1088/1088 zh-en 完全 parity、静态使用 932 key 零缺失、英文侧零硬编码；3 条死词条清理（sidebar.brand / settings.provider.syncModels / settings.provider.usage.query，白名单同步）；commands.ts 21 条手写中文映射迁入 commands.* 词典（en 界面优先内核描述防漂移）；用量面板 reset 文案入词典并把 lib 层冗余 locale 参数移除；setup auth proxy 错误双语化。
- **长文案溢出审查**：3 条 nowrap tooltip（setup WebBridge 双提示 + worktree 新会话提示，英文最长 130 显示宽 ≈900px 单行）补 data-tooltip-wide；CDP 裸 key 扫描前缀从 8 族扩到全部 30 族（此前 sidebar./cron./git./goal./theme./confirm. 等 21 族线上漏检）。
- **性能/内存批次（长历史/大量会话）**：① 工具流 80ms tick 的段包装消息对象稳定化（StreamSegment.renderMessage 缓存）+ 时间线未变时保留旧数组引用 → 下游引用比较 memo 继续命中；② extractToolCards / extractImages / detectJson 三处派生加 WeakMap（对齐 extractTextCached 模式）——工具密集 run 每 tick ~450 项的全量重算被消除；③ toStreamingMarkdownHtml 单槽 memo（>50k 稳定段不再每帧 escapeHtml+DOMPurify）；④ 会话搜索 150ms 防抖（草稿本地化，断连清理）；⑤ tasks 事件本地增量应用（视图打开时不再每事件全量重拉 tasks.list）；⑥ gateway request 日志走 debugLog 门控（默认零 IPC 转发）。审查结论：无 P0 泄漏（监听器/定时器全成对清理、缓存全有界）；DOM 全量驻留（200 条窗口无虚拟化）记录为候选欠账。
- **死代码清理**：chat-ui __fixtures__/loader.mjs（strip-types 时代遗留 ESM resolver，零消费者）删除；src/vitest-state-dir.ts 移入 src/test-support/ 并排除出生产 tsc（此前 vitest 依赖会被编译进 dist/ 打入发行包）。
- **验证**：npm test 1074 pass / 0 fail（+2 新测试）；内核补丁在 2026.9.3 真实树实跑：6 文件命中、peer-link .mjs 已打、coverage PASS、幂等；gateway 2026.9.3 就绪（health 200 + qqbot 渠道 ready）。
### R71 · 故障路径审查：网关崩溃自动恢复（新轴）

- **新审查轴**：此前各轮覆盖功能/页面/i18n/a11y/交互，本轮做**故障注入**——杀掉网关子进程观察应用行为。
- **发现（真缺陷）**：网关非预期退出后 `gateway-process` 只把状态置为 `stopped`，**没有任何重启路径**（`start()` 里的 5s 崩溃冷却说明设计上预期会有重启，但触发点从未接线）；渲染层只会无限重连一个已经死掉的 WebSocket。实测崩溃后 60s 内未恢复，用户会一直停在「无法连接到 Gateway」，只能手动点重启或重启应用。
- **修复**：`GatewayProcess` 新增 `onCrash` 回调（running 期崩溃与 starting 期退出均触发）；main 侧新增有界自动重启——延迟 3s 重启、**5 分钟滑动窗内最多 3 次**（防崩溃循环），达上限转 `openRecoverySettings("gateway-recovery-failed")` 人工入口；退出序列（`isQuitting`）不再拉起新进程，定时器 unref 且随退出清理。策略抽为纯函数 `src/gateway-crash-restart.ts`（`decideCrashRestart`）并加 4 个单测（上限拒绝、窗口滑动恢复、部分过期只数窗内、自定义参数）。
- **验证**：故障注入脚本 `.cache/r71-crash-recovery.js`（杀端口占用进程 → 观察恢复）；node 测试 195 项（191 pass / 4 skipped / 0 fail）；发版管线 silent-install E2E 装 2026.910.4 + gateway 200 + 四套 CDP 冒烟全绿。

### R73 · 两轮全面 debug 审查（主进程/settings/scripts/chat-ui 四路）+ 稳定内核渠道推进

- **审查方法**：Round 1 四路并行审查代理——① 主进程 src/ 顶层 75 模块（异步/泄漏/竞态/错误路径）② settings+配置子系统（配置完整性/迁移/IPC 健壮性/密钥/跨平台）③ scripts+CI（构建正确性/失败检测/确定性/工作流）④ chat-ui 渲染层（状态竞态/监听泄漏/渲染/IPC 契约/localStorage）。基线全量 1074 pass / 0 fail。共 36 项核实发现（P1×4 / P2×6 / P3×26），两轮修复 30 项，其余登记（见末尾）。
- **Round 1 修复（主进程 + settings + scripts）**：
  - 【P1】`.openclaw` 导入在 Windows 必败：`withFileLoggingPaused` 只关 app.log 流，gateway 诊断流（`gateway.log`）未关——本会话启动过 gateway 时 `fs.rm` 清状态目录被自己句柄卡死（EBUSY 连 maxRetries 亦无解）。修复：importArchive 内先 `closeDiagLogStream()`（gotcha #99）。
  - 【P1】R71 崩溃重启定时器未接导入/内核换装护栏：延迟 3s 窗口内进入导入/换装会把 gateway 拉到半清空状态目录或半换装内核上。修复：定时器回调复检 `isImportActive()`/`getKernelUpdateState().running`，新增 `cancelScheduledCrashRestart` 接入 quiesceGateway / 内核 stopGateway。
  - 【P1】`readUserConfig()` 把「读不到」当「空配置」：RMW 保存链路在文件瞬时损坏/被占（Windows 杀软 EBUSY）时把改动合并进 `{}` 整文件写回——providers/channels/keys 全蒸发，且 backupCurrentUserConfig 跳过坏文件、.bak 又被同步覆盖，恢复链一并失守。修复：`writeUserConfig` 加保险丝（磁盘配置存在但不可解析 → 留存为 `openclaw.json.corrupt-<ts>` 并拒绝写入），单咽喉点覆盖全部 21 个调用方。
  - 【P1】merge-release-yml 对缺架构静默放行 → 残缺 latest.yml（该架构用户永远收不到更新）。修复：缺任一架构硬失败，`--allow-partial` 显式逃生（gotcha #101）。
  - 【P2】`GatewayProcess.start()` 双启动竞争：入口守卫只查一次，stopping 等待（≤6s）与崩溃冷却（≤5s）窗口内第二个 start 各自 spawn（旧世代 exit 被忽略，孤儿进程抢端口）。修复：inflightStart promise 串行化。
  - 【P2】备份恢复路径不复跑迁移、不停 gateway：恢复旧备份后重启 gateway 被 strict 校验拒起（旧 dingtalk 字段等，同导入路径已知的坑），且内核活着时 config observer 可写回复活。修复：两个 restore 通道先 `stopGateway`，恢复后经注入的 `migrateRestoredConfig` 跑存量迁移（settings/types.ts + main.ts 接线）。
  - 【P2】CI 漂移：tests.yml 跑在 Node 22.23.2，发行运行时已是 24.21.0（b559a51 漏改）——Node 24 Windows fs.rmSync 静默失败类问题 CI 结构性复现不了；chat-ui 用 npm install 漂移。修复：CI 升 24.21.0 + chat-ui `npm ci`。
  - 【P2】`dist:win:x64/arm64` env 前缀在 Windows cmd 非法（开发机不可用）+ `npm run clean` 用 rm -rf 同样 Windows 必挂。修复：都改走 node 脚本（`dist-win.js --arch` / 新增 `scripts/clean.js` 走 lib/rm-rec）（gotcha #103）。
  - 【P2】发行包带全部 6 平台 prebuilds（`pruneNonTargetPrebuilds` 只接了插件路径，installDependencies 两分支漏调，实测 win32-x64 unpacked 树 5.6MB+ 冗余）。修复：两个分支补调（幂等）。
  - 【P2】`writeCryoclawConfig` 是最后一个非原子主配置写（崩溃 → readCryoclawConfig 永远 null，updateChannel "off" 失效重收自动更新等）。修复：统一走新 `src/atomic-write.ts`（tmp + fsync + rename，补齐「断电」 durability 承诺；provider-config/config-backup/gateway-auth 四处收敛共用）。
  - 【P3 批】verifyMoonshot 未知子平台裸 TypeError → 回退默认；rawJsonRequest 加 8MB 响应上限（对齐 skill-store，防自定义 baseURL 无限滴流 OOM）；kimi-oauth token 原子写 + 轮询间隔下限（防 0/缺失时紧密打满 120 次）+ slow_down 递增 + 并发登录 epoch 化（旧全局 abortFlag 会被第二次登录重置、两份 token 互相覆盖）；resolveGatewayPort/构造器端口范围校验（>65535 使 http.get 同步抛错被吞成含混「预启动失败」）；日志轮转 destroy 后立即截断在 Windows EBUSY（改 end+close 后截断，logger + gateway-process 双处）；save-advanced 参数守卫 + 配置写提前（写失败不留 OS 半提交状态）；afterPack 符号链接目录 EISDIR；OfficeCLI SHASUMS 行尾精确匹配（防前缀兄弟条目错哈希）。
- **Round 2 修复（chat-ui + 增量复核）**：
  - 【P2】助手身份跨会话串扰：`agent.identity.get` 在途时切会话，迟到响应把旧 agent 的名字/头像落到新会话（刷新点只有切换/重连，会一直错到下次动作）。修复：落地前对 sessionKey 重检（对齐 loadChatHistory 守卫）。
  - 【P2】模型切换失败回滚污染新会话：patch 在途（可 30s）切会话后失败——旧会话模型写回跨会话兜底 `currentModel`，且 `updateThinkingCapabilities` 失配时会向「当前」会话 patch `thinkingLevel:"off"`（静默改写新会话配置）。修复：catch 路径 sessionKey 守卫（切换路径由 sessionKey watcher 自行重算，跳过即正确）。
  - 【P3】cron Run-now 迟到 runs 渲到别的展开任务详情下（复用 loadCronRuns 的 isCurrent 守卫，onRun 传展开态判定）；tab-about 订阅泄漏 + tab-backup 30s 轮询残留（init await 窗口竞态 → 代际计数器，gotcha #100）；saveSettings localStorage 裸写（禁用/损坏时抛进会话切换中段 → best-effort try/catch）；聊天 Ctrl+N/L 在无关视图生效（document 级监听加视图门）。
- **稳定内核渠道推进（随本阶段）**：`kernel-channel.json` stable 2026.8.2 → **2026.9.3**（R72 证据链 + Node 24 载体版 2026.911.0 已发布，兑现 R72「本版发布后再推进」）；清单新增可选 `minRuntimeNode: "24.16.0"`，kernel-update.mjs 换装前快速失败并提示先升级应用（旧 Node 22 运行时 App 不再撞 npm preinstall 裸错误；旧解析器自动忽略新字段）。npm dist-tag latest 的 2026.9.4（同时挂 beta）证据链未核验，**不推进**。architecture.md 同步。已随 50ef462 推送（CI 绿），jsDelivr 镜像即时生效（raw CDN 有分钟级缓存，gotcha #102）。
- **登记未修（评估后明确挂起）**：① chat 聊天视图快捷键 document 监听无生命周期拆除（已加视图门，彻底改造需 app 壳重构，与 props 驻留一并评估）；② package-resources STEP 1.5 的 `.npmrc` 写在 npm 从不读取的位置（构建实际用宿主 registry——改为显式 `--registry` 会改变「跟随宿主」的既有行为，需产品决策）；③ DOM 200 条窗口无虚拟化（R72 已记录的候选欠账）；④ fsync 目录级持久性（Windows/Node 无公开 API，文件级 fsync 已落地）。
- **二轮复核（修复 diff 的回归性复审）**：4 项发现全部修复——① start() 在「旧启动已死未落定」（restart 先 stop 杀子进程，doStart 健康轮询待下个 tick 才察觉）窗口复用旧 promise 会静默不 spawn：state===stopped 且 inflightStart 未清时改为等旧 promise settle 后重入 start()；② merge-release-yml 全缺失场景绕过硬失败且 release/ 已被清空：缺架构检查前移 + 清空挪到全部合并判定成功之后；③ 日志轮转窗口内置 rotating 标志，迟到截断不再抹掉窗口内新写入的行（logger + gateway-process）；④ 恢复路径补 cancelScheduledCrashRestart 注入（crash 定时器不得在恢复写盘期间拉起 gateway）。
- **验证**：全量 **1076 pass / 0 fail / 4 skipped**（vitest 159 + node 191 + chat-ui 645 + scripts 81，新增 kernel-channel minRuntimeNode 2 项用例）；双 tsc 通过；dupcheck 1.13%；`kernel-update.mjs --check` 真机冒烟（current=2026.9.3、远端清单解析正常、current 更高时不提示降级）；diff 复核代理对全部未提交改动做回归性复审。
