# CryoClaw 优化工程 — 进度追踪（断点续作锚点）

> 新接手先读「快速上手」+「关键路径地图」+「下一步计划」，再按需查「工程记录」与「既有事实」。
> 创建：2026-07-29；最近重写：2026-08-25（R27 精简重构）。

## 🚀 快速上手

**项目一句话**：**CryoClaw**（原 OneClaw，已完成更名）——基于 openclaw 内核的高效、易用、纯净 harness。
形态：Electron 桌面壳 + 自研 **Lit + Vite** chat-ui，经 gateway WebSocket RPC 与内核通信（file:// 加载）；
面向国内生态（Kimi / Moonshot / 飞书 / 企微 / 微信 / 钉钉 / QQ）。

**当前状态**：
- 重设计工程 **R1–R39 全部完成**（二期 P1–P7 收官），最新发版 **v2026.828.2**（R39 屎山清理/健壮性/效率收尾；v2026.828.1：R38）。
- 内核 openclaw **2026.7.1-2**（版本 pin 在 package.json `cryoclaw.openclaw`）；**Electron 43.4.0**（audit 0 漏洞）。
- 测试基线 **650 pass / 0 fail / 4 skipped**（vitest 94 + node 130 + chat-ui 374 + scripts 52；0 fail 为硬指标）。
- 重复率 **1.06%**（69 clones，阈值 5%，`npm run dupcheck` 防回退）。
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
- **UI 规范**：TraeWork 规范 + 冰蓝 token（`shared/design-tokens.css`，brand-500 `#0EA5E9`）；样式走 design token / cc-* 原语；**禁止硬编码 hex**；按钮右对齐；浅色默认主题，暗色 `[data-theme=dark]`。
- 布局：顶部沉浸式 titlebar 44px，浮层 top ≥ 56px；窄窗（≤768px）media query；grid 防溢出 `minmax(0,1fr)` + `min-width:0`。

**文档导航**：

| 文档 | 用途 |
|---|---|
| `CLAUDE.md` / `AGENTS.md`（symlink） | 项目硬规范 |
| `docs/architecture.md` | 架构分层说明 |
| `docs/ipc-api.md` | 主进程 IPC 通道清单 |
| `docs/gotchas.md` | 72 条已验证坑（改代码前搜一遍） |
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
| 样式 hub | `chat-ui/ui/src/styles.css` | **只做 @import，层叠顺序敏感**：design-tokens → tokens-ext → base → **primitives** → **utilities** → chat/components/panels/sidebar/skills/compose/workspace/cron/misc/panel/plan →（末尾）settings → setup |
| 设计 token | `shared/design-tokens.css` + `styles/tokens-ext.css` | TraeWork + 冰蓝；兼容别名 --accent/--bg |
| 契约组件 | `styles/primitives.css` | cc-btn/cc-input/cc-card/cc-dialog/cc-tag/cc-menu/cc-alert/cc-skeleton/cc-table/cc-tabs/cc-chip |
| 进度/坑 | `docs/OPTIMIZATION-PROGRESS.md` + `docs/gotchas.md` | 本文件 + 72 条已验证坑（gotchas 为准） |

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
- 导出压缩段 worker 化（R33 已 async 化缓解，worker 化收益不成比例 defer）；kimi-auth-proxy 回环鉴权（R33 评估为中风险 backlog）。
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
