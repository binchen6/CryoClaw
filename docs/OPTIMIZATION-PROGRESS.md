# CryoClaw 优化工程 — 进度追踪（断点续作锚点）

> 新接手先读「快速上手」+「关键路径地图」+「下一步计划」，再按需查「工程记录」与「既有事实」。
> 创建：2026-07-29；最近重写：2026-08-25（R27 精简重构）。

## 🚀 快速上手

**项目一句话**：**CryoClaw**（原 OneClaw，已完成更名）——基于 openclaw 内核的高效、易用、纯净 harness。
形态：Electron 桌面壳 + 自研 **Lit + Vite** chat-ui，经 gateway WebSocket RPC 与内核通信（file:// 加载）；
面向国内生态（Kimi / Moonshot / 飞书 / 企微 / 微信 / 钉钉 / QQ）。

**当前状态**：
- 重设计工程 **R1–R30 全部完成**，最新发版 **v2026.827.2**（R30 流式中断恢复；v2026.827.1：R29）。
- 内核 openclaw **2026.7.1-2**（版本 pin 在 package.json `cryoclaw.openclaw`）；**Electron 43.4.0**（audit 0 漏洞）。
- 测试基线 **524 pass / 0 fail / 4 skipped**（vitest 94 + node 74 + chat-ui 304 + scripts 52；0 fail 为硬指标）。
- 重复率 **1.02%**（67 clones，阈值 5%，`npm run dupcheck` 防回退）。
- 开源：GitHub `binchen6/CryoClaw`（AGPL-3.0-only，干净历史）；发版走本地 `dist:win` + `gh release`；CI `tests.yml` 每次 push/PR 全量回归。

**常用命令**：
- 构建：`npm run build`（vite chat-ui + tsc 主进程）
- 测试：`npm test`（vitest + node:test + chat-ui typecheck&测试 + scripts）
- 重复率：`npm run dupcheck`
- 打包（Win x64）：`npm run dist:win`（串联 build → package:resources → electron-builder，自动注入 .env + npmmirror + `--use-system-ca`）
- 安装：`out/win32-x64/CryoClaw-Setup-<v>-x64.exe /S`（先清残留进程，见 gotchas #53；安装目录 `%LOCALAPPDATA%\Programs\CryoClaw`）
- 发版：改 `package.json` version + `release-notes.json` 条目（日历版本 YYYY.MMDD.N）→ commit → push → dist:win → `gh release create`

**关键约束**：
- 只改 CryoClaw 自己的代码；内核 openclaw（gateway.asar 内 dist）**零改动**，仅可只读取证。
- 不 git commit（除非用户明确要求）。
- 新敏感 IPC 通道必须加 `assertTrustedIpcSender`（src/ipc-sender-guard.ts）。
- **UI 规范**：TraeWork 规范 + 冰蓝 token（`shared/design-tokens.css`，brand-500 `#0EA5E9`）；样式走 design token / cc-* 原语；**禁止硬编码 hex**；按钮右对齐；浅色默认主题，暗色 `[data-theme=dark]`。
- 布局：顶部沉浸式 titlebar 44px，浮层 top ≥ 56px；窄窗（≤768px）media query；grid 防溢出 `minmax(0,1fr)` + `min-width:0`。

**文档导航**：

| 文档 | 用途 |
|---|---|
| `CLAUDE.md` / `AGENTS.md`（symlink） | 项目硬规范 |
| `docs/architecture.md` | 架构分层说明 |
| `docs/ipc-api.md` | 主进程 IPC 通道清单 |
| `docs/gotchas.md` | 69 条已验证坑（改代码前搜一遍） |
| `docs/design-guidelines-zh/en.md` | TraeWork + 冰蓝 token 设计规范 |

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
| 样式 hub | `chat-ui/ui/src/styles.css` | **只做 @import，层叠顺序敏感**：design-tokens → tokens-ext → base → **primitives** → chat/components/panels/sidebar/skills/compose/workspace/cron/misc/panel/plan →（末尾）settings → setup |
| 设计 token | `shared/design-tokens.css` + `styles/tokens-ext.css` | TraeWork + 冰蓝；兼容别名 --accent/--bg |
| 契约组件 | `styles/primitives.css` | cc-btn/cc-input/cc-card/cc-dialog/cc-tag/cc-menu/cc-alert/cc-skeleton/cc-table/cc-tabs/cc-chip |
| 进度/坑 | `docs/OPTIMIZATION-PROGRESS.md` + `docs/gotchas.md` | 本文件 + 69 条已验证坑（gotchas 为准） |

## ⚙️ 运行机制既有事实（勿重复调查）

- **CLI 链路**：`openclaw` → `bin\openclaw.cmd` → `CryoClaw-CLI.exe`（CONSOLE 子系统）+ `ELECTRON_RUN_AS_NODE=1` → `gateway.asar\node_modules\openclaw\openclaw.mjs`。换装 asar 不影响 CLI 路径；PATH 上 npm 全局 openclaw 可能遮蔽 wrapper（watch list）。
- **安装产物 `runtime/` 无 node.exe**（afterPack 删除，npm.cmd/npx.cmd 重写为 Electron 代理）：运行时脚本一律 `CryoClaw-CLI.exe` + `ELECTRON_RUN_AS_NODE=1`；`runtime/.npmrc` 指向 npmmirror。
- **内核版本唯一事实来源**：`gateway.asar\node_modules\openclaw\package.json` 的 version；About 页即读此处。
- **打包期对内核 dist 的全部改写**（运行时升级须复现相关子集）：windowsHide 注入、asar 边界补丁 6 类、builtin skills 注入、插件注入 + dingtalk shim、7 个 `@openclaw/*` vendor、esbuild 重 bundle、koffi/node_modules 裁剪。
- **应用不自动更新**（自身检查更新已删）；只有内核升级器。入口两个：设置-关于页「内核升级」（IPC `kernel:check/update/rollback`，JSONL 进度 `kernel:update-progress`）、CLI `openclaw update [--tag v] [--rollback]`。App 自动更新（electron-updater → GitHub Releases）在 R20 重新引入，换装自实现（#67）。
- **打包 env**：`CRYOCLAW_TARGET=win32-x64`；镜像 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` 指向 npmmirror；`NODE_OPTIONS="--use-system-ca"`（dist:win 自动注入）。
- **本机用户配置**：`~/.openclaw/openclaw.json`；`cryoclaw.config.json` 有 `"updateChannel": "off"`。

## ✅ 测试体系（勿重复搭建）

- 基线 **524 pass / 0 fail / 4 skipped**（vitest 94 + node 74 + chat-ui 304 + scripts 52；0 fail 硬指标）。
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
- **未修项**：飞书名称补全并发上限、loadTasks 在途丢弃、导出压缩 worker 化、kimi-auth-proxy 回环无鉴权、cleanStaleLockfile 先 probe 再杀、gateway-rpc 无调用点（疑似预留）。
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
- **仍候选**：webbridge 二进制 SHA256（需发布链哈希清单）；device-auth 签名规范化（需网关侧同步）；设备密钥 OS keychain；导出压缩 worker 化；kimi-auth-proxy 回环鉴权；cleanStaleLockfile 先 probe 再杀；IPC 细粒度授权（架构性）。

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

**候选功能/加固（取证过、未做，按需立项）**：
- webbridge 二进制下载 SHA256 校验（需发布链产出哈希清单，R25 候选）。
- app-skills SkillsState 双重断言类型层收敛（R26 候选）。
- device-auth 签名载荷规范化（需网关侧同步修改）。
- 飞书名称补全并发上限/负缓存；loadTasks 在途排队重跑；导出压缩段 worker 化；kimi-auth-proxy 回环鉴权；cleanStaleLockfile 先 probe 再杀（R24 候选）。
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
