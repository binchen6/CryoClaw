# CryoClaw 九项问题研究文档（2026-10-04）

调研日期：2026-10-04。信息来源：仓库源码实测（`src/`、`chat-ui/ui/src/`、`scripts/`）、内嵌内核产物实测（`resources/targets/win32-x64/gateway.asar` → `node_modules/openclaw/dist/*.mjs` 方法表与事件表）、QA 截图（`C:\Users\binchen\Desktop\code\Oneclaw2\QA\编辑模型能力.png`）、用户缺陷报告。配套执行文档：`docs/archive/2026-10-04-nine-fixes-execution.md`。

## 0. 总览

| # | 问题 | 根因类别 | 严重度 | 根因一句话 |
|---|---|---|---|---|
| 1 | 「任务」页 `Error: unknown method: tasks.list` | 内核适配缺失 | 高 | 内核 2026.9.7 已删除 `tasks.*` RPC 与 `task` 事件，前端无能力探测仍每 30s 调用 |
| 2 | 插件更新检查报 `Command failed: …`；启用插件不在白名单 | 错误处理 + 配置一致性 | 高 | dry-run 缺 ack 参数且失败文案裸漏 Node 原文；`plugins.allow` 非空时通用开关不同步白名单导致静默禁用 |
| 3 | 技能/插件首开慢、安装卸载反馈弱 | 体验 | 中 | 列表缓存冷启动（CLI 15s/5min TTL）且仅在视图打开时拉取；成功路径无 toast、长操作无进度 |
| 4 | 性能与流畅度 | 性能 | 中 | 1s 级 ticker 全量重渲染、渲染函数内触发 RPC、端口探测 500ms 固定间隔等 |
| 5 | 「远程控制」企业微信误报组件缺失 | 判定逻辑缺陷 | 高 | bundled 判定只查单一目录，未覆盖 npm/projects 与 mirror 根；查询不触发 reconcile |
| 6 | 模型配置页 bug/性能 + 编辑面板灰空白 | UI 结构 + 性能 | 中 | 编辑面板渲染在 flex 卡片行内；模块单例 state 每键全应用重渲染 |
| 7 | 新内核适配全面检查 | 工程化缺失 | 中 | 无「前端 RPC 用量 vs 内核 allowlist」系统化 diff，缺口靠运行时报错发现 |
| 8 | WebBridge「校验未通过（上游已更新）」永久失败 | 信任模型设计缺陷 | 高 | 精确 sha256 钉定 + 上游原地重建 latest，内嵌表与远程 manifest 双源同时过期即永久 fail-closed |
| 9 | 全面审查 + push + 发版 | 流程 | — | 按分期交付流程执行（审查→测试→发版→push→Release 三件套） |

## 1. 环境与内核 ground truth

| 项 | 结论 | 证据 |
|---|---|---|
| 内核版本 | openclaw **2026.9.7**（stable），minSupported 2026.7.0 | `kernel-channel.json`；`package.json:59`；`src/kernel-updater.ts:79` |
| RPC 方法表 | asar 内 `node_modules/openclaw/dist/core-method-policy-*.mjs` 注册 **483 个方法**；方法分发在 `server-methods-*.mjs`（未命中即 `unknown method: <name>`） | asar 实测 |
| 广播事件表 | `server-methods-list-*.mjs` 的 `GATEWAY_EVENTS`：含 `task.suggestion`，**不含 `task`** | asar 实测 |
| `tasks.*` | **不存在**。仅存 `taskSuggestions.list/create/accept/dismiss`、`cron.list/cron.runs/cron.history`、`update.runs.list`、`agents.list`。JSDoc 中 `client.experimental.tasks.listTasks()/cancelTask()` 属 ACP SDK（slash 形式 `tasks/list`，见 `package-update-activation-recovery.mjs`），非 gateway RPC | asar 实测 |
| 能力握手 | `hello-ok` 携带 `features.methods` 与 `features.events`（`message-handler-*.mjs`）；chat-ui 已声明类型但从未消费 | `chat-ui/ui/src/ui/gateway.ts:33` |
| 9.7 破坏性变更 | `sessions.compaction.*` 移除 → `sessions.branches.list/switch` + `sessions.rewind/fork`；telegram `token`→`botToken`；agent-DB schema ≥24 门控 | `docs/kernel-recon/2026.9.7-diff.md` |
| 前端传输 | 原始 WS 帧 `{type:"req", id, method, params}` 直达内核 gateway，主进程无方法注册表/白名单 | `chat-ui/ui/src/ui/gateway.ts:435-486` |

## 2. T1 「任务」页 unknown method: tasks.list

**现象**：打开「任务」页即报 `Error: unknown method: tasks.list`；后台每 30s 复现一次。

**调用链**：
`app-tasks.ts:50`（视图打开 → `loadTasks`）与 `app-gateway.ts:577`（`registerTickHandler("tasks", …)`，30s ticker，见 `docs/client-ticker.md:35`、`client-ticker.ts:8`）→ `controllers/tasks.ts:238 loadTasks` → `:250 client.request("tasks.list",{limit:200})`；取消走 `:265 cancelTask` → `:277 "tasks.cancel"`；`task` 事件分支 `app-gateway.ts:852-864`（`applyTaskEvent` + 失败回退全量 refetch）。错误在 `:255` 被 `state.tasksError = String(err)` 原样上屏。

**根因**：UI 按 v2026.7 内核面编写（`docs/OPTIMIZATION-PROGRESS.md:89`、`docs/gotchas.md:114` 佐证历史契约），9.3→9.7 升级删除 `tasks.*` 与 `task` 事件；前端无能力探测（`gateway.ts:33` 的 `features.methods` 从未消费），导致裸报错 + 死轮询。`app-gateway.ts:852` 的 `task` 事件分支同为死代码。

**影响**：任务页不可用；侧边栏进行中徽标依赖 `findActiveTaskForSession`/`activeTaskSessionKeys`（`tasks.ts:57,74`）恒为空；每 30s 一次失败 RPC 污染 WS 日志与内核开销。

**既有测试**：`chat-ui/ui/src/ui/controllers/tasks.test.ts`（纯函数）；`app-session-actions.test.ts:12` 钉住侧栏入口。

## 3. T2 插件更新检查失败 + 白名单不同步

### 3.1 `Command failed: …` 裸漏

**调用链**：`tab-plugins.ts:302`（错误上屏）← IPC `plugin-store:check-updates`（`src/plugin-store.ts:763-818`）← `execKernelCli(["plugins","update","--dry-run","--all"])`(:768) ← `execFile(nodeBin, ["--no-deprecation", entry, …])`(:96-125；Helper.exe 路径 `constants.ts:82-107`，`ELECTRON_RUN_AS_NODE=1` + `OPENCLAW_STATE_DIR` @ `plugin-store.ts:110`；超时 90s/8MB @ `:37-38`)。

**根因**：
1. 失败文案 = `String(stderr).trim() || err.message`（`:115`）→ stderr 为空时裸漏 Node 的 `Command failed: <cmd>`，经 `:792 stripAnsiCodes` 原样返回 UI。
2. 内核 `plugins-update-command-*.mjs` 退出码 1 的成因多样：单插件 ClawHub 失败（stderr `Failed to check <id>: …`）、blocked mutation preflight、invalid config、**install-policy warning 需 ack**（`install-policy-warning-acknowledgement-*.mjs` 在非 TTY 返回 `{}`；真实 update 传了 `--acknowledge-install-policy-warning` @ `plugin-store.ts:828-829`，**dry-run 未传**）。
3. R93 HTTP 兜底 `checkUpdatesViaHttp`(:570-617) 仅在解析到 `FAILED_CHECK_LINE_RE`(:186) 行（`parsed.failed.length > 0`，`:782`）时触发 → 内核「无信号死亡」（超时 kill、preflight 文本不匹配正则）时兜底不启动。

### 3.2 启用插件不在 `plugins.allow` 白名单

**内核语义**：`plugins.allow` 非空且 id 不在其中 → 即使 `plugins.entries.<id>.enabled=true` 也被静默禁用（`src/kimi-config.ts:12-14` 注释记载）。

**写入点盘点**：allow 仅由 `extension-mirror.ts ensurePluginsAllow`(:307-360，mirror reconcile 时 union 写 `~/.openclaw/openclaw.json`) 与两处特例同步：`kimi-config.ts:16-20 syncPluginAllowOnEnable`（调用点 `:112` kimi-search）、`settings/memory.ts:222`（memory-core）。

**根因**：通用 UI 开关 `tab-plugins.ts:151-171` 仅经 gateway `config.patch` 写 `entries.<id>.enabled`；`plugin-store:install` 与 stash 恢复（`plugin-store.ts:652-667`）置 `enabled:true` 同样不同步 allow。一旦 `ensurePluginsAllow` 使 allow 非空，市场安装/UI 启用的插件即被内核静默禁用——用户看到「已启用」但实际不加载。

**既有测试**：`src/plugin-store.test.ts`（parseUpdateOutcomes/stripAnsiCodes）、`src/kimi-config.test.ts:22-58`、`tab-plugins.lib.test.ts`。

## 4. T3 技能/插件预加载与安装卸载反馈

**冷路径**：插件列表 `plugins list --json` 冷 ~15s（`plugin-store.ts:39-42` 注释，10min 缓存 `:42`，`listInstalledPlugins` `:486-508`）；技能市场列表 clawhub CLI（`src/skill-store.ts:608-680`，5min 缓存）；已装技能 `skills.status` 仅在视图打开时拉（`controllers/skills.ts:88`；打开入口 `app-extensions.ts:31,46`、`app-skills.ts:247`）。启动 ticker 仅覆盖 sessions/tasks（`app-gateway.ts:558-577`），无预取。

**反馈缺口**：
- 技能安装成功无 toast（仅按钮 spinner `installingSlugs`，`app-skills.ts:201-215`）；失败 toast key `skillStore.installFailed`。
- 插件安装成功无 toast（仅配置恢复提示 `plugin-store.ts:730-735`）；卸载有确认框+toast（`tab-plugins.ts:173-198`）。
- 开关成功仅 hint 文本（`:163-168`），**不校验内核是否真的启用**（白名单 bug 在此隐身）。
- 长 CLI 调用无进度指示；更新有 mutex（`updatingId/updatingAll` `:315-322`）+ 重启提示（`needsRestart` `plugin-store.ts:837`）。
- toast 基建已存在：`chat-ui/ui/src/ui/app-toast.ts:38`；技能变更已有 per-skill busy + 内联消息模式 `controllers/skills.ts:49-73 runSkillMutation`。

## 5. T4 性能与流畅度

| 位置 | 问题 | 备注 |
|---|---|---|
| `chat-ui/ui/src/ui/app.ts:847` | 存在 pending question 时 1s ticker 触发全量 `requestUpdate` | 可见集合未变化时也重渲染 |
| `chat-ui/ui/src/ui/views/settings/tab-provider.ts:276-281` | 渲染函数内触发 `agents.list` RPC（注释自认「每次重渲染都会发起一次必失败的 RPC」） | 有 cooldown 但仍是渲染期副作用 |
| `src/gateway-lifecycle.ts:13` | 端口探测 10×500ms 固定间隔 | 快乐路径也要等满间隔 |
| `app-gateway.ts:577` | 死 `tasks.list` 每 30s 一次 | 由 T1 修复消除 |
| `tab-provider.ts:523` | dragover 每事件 `requestUpdate` | 拖拽期间高频全量重渲染 |
| 聊天历史 | 已有 `shouldUpdate` 门控(`oc-chat-history.ts:87`)、`repeat()`(:101)、200 条上限(:154)；**无虚拟化**为已知遗留债 | `docs/OPTIMIZATION-PROGRESS.md:675`，本期不做 |
| 工具流 | 80ms 节流 + WeakMap 缓存（`app-tool-stream.ts:22`） | 已受控，不动 |
| 启动 | `main.ts:1279-1470` 串行：analytics(:1334)→updater 延迟15s→控制服务(:1384)→配置健康检查(:1424)→4 个同步迁移+CLI reconcile(:1455-1462)→`startGatewayAndShowMain`(:1464)；gateway `doStart`（`gateway-process.ts:269-307`）含 stale lock 清理(:273)、`ensureAgentDbSchemaReady`(:279，可能跑 `doctor --fix`)、daemon 卸载(:287)、端口探测等待 | 迁移/reconcile 必须在 spawn 前（`openclaw-config-migration.ts:289` 注释约束），仅健康后工作可并行 |

## 6. T5 企业微信误报「插件组件缺失」

**现象**：「远程控制」页 wecom 面板显示「企业微信插件组件缺失，请遵循插件文档指引进行安装」并阻断保存。

**调用链**：`tab-channels-wecom.ts:53 loadBundledRuntimeState("wecom")`（`tab-channels-shared.ts:40-49`，IPC 类型 `ipc-bridge.ts:63`）→ IPC `settings:get-channel-runtime-state`（`src/settings/channels.ts:22-53`）→ `isWecomPluginBundled()`(:27) 为 false 时返回 `bundleMessages.wecom` = `resolveWecomMissingMessage()`(:72-78，文案在 `:77`) → banner `tab-channels-wecom.ts:127`、保存阻断 `:68`。同类 banner：dingtalk `tab-channels-dingtalk.ts:95`、qqbot `tab-channels-qqbot.ts:99`。

**判定逻辑**：`src/wecom-config.ts:17-25` 仅 `fs.existsSync` 检查 `~/.openclaw/extensions/wecom-openclaw-plugin/`（`resolveWecomPluginDir` `:12-14` + `constants.ts:393-395`）的 entry 文件 + `openclaw.plugin.json`。

**根因（三重）**：
1. **单根判定**：对照 `openclaw-config-migration.ts:289-296` 的四根可解析判定（bundled gateway ext / mirror 目录 / state extensions 目录 / npm 扫描），wecom 只查其一。
2. **R93「用户自装优先」分支**：`extension-mirror.ts:154-171` + `plugin-install-roots.ts:128-132 listNpmProjectPluginIds`——若 `~/.openclaw/npm/projects/` 存在 `@wecom/wecom-openclaw-plugin`（历史上出现过「一次混入 47 个假 id」，`plugin-install-roots.ts:20`），reconcile 会跳过/删除 extensions 副本；插件实际可用但 bundled 判定为 false。
3. **查询不触发自愈**：weixin 有 `settings:ensure-weixin-plugin`（`channels.ts:81-89` → `weixin-config.ts:36-41`）在查询前 reconcile；wecom 的运行态读取从不 reconcile，启动期一次瞬时失败（`main.ts:474` → `extension-mirror.ts:229-296`）即整会话误报。

**各渠道插件根**：wecom/weixin = mirror → `~/.openclaw/extensions/`（`scripts/package-resources.js:1403-1417 CHANNEL_MIRROR_PLUGINS`、`:1869-1878`、afterPack 注入 `afterPack.js:92-103`）；dingtalk = asar 内 `dist/extensions/dingtalk-connector`（`dingtalk-config.ts:13-26` + `constants.ts:238-240`，已从 mirror 退役 `extension-mirror.ts:121`）；qqbot = 内核 vendored（`qqbot-config.ts:10-18`）；feishu = 内核 vendored（`package-resources.js:1425 OFFICIAL_VENDOR_PLUGINS`、校验清单 `:1560-1574`）但**主进程完全没有 bundled 检查**（`feishu-config.ts` 仅配置迁移 `:46-52`）。

**既有测试**：仅 `src/wecom-config.test.ts`（vitest，`vi.mock("electron")`，只测 WS 帧解析）；可复用模式：`src/weixin-config.test.ts`（node:test + 临时 `OPENCLAW_STATE_DIR` 写假插件目录）、`src/test-support/vitest-state-dir.ts useTempStateDir`、`chat-ui/.../tab-channels.lib.test.ts`（node:test 纯函数）。**缺口**：`isWecomPluginBundled`/`isQqbotPluginBundled`/`isDingtalkPluginBundled`/`resolveWecomMissingMessage`/`channels.ts` IPC 均无测试。

## 7. T6 模型配置页 bug/性能 + 编辑面板灰空白

**组件结构**：`chat-ui/ui/src/ui/views/settings/tab-provider.ts`（2352 行），非 LitElement；模块级单例 `s = createProviderState()`(:172，工厂 :87)，所有变更调 root `OpenClawApp.requestUpdate()`（`app.ts:173`，`render()` :1633）→ **每次按键全应用重渲染**。

**灰空白根因（QA 截图复现）**：编辑面板在模型卡片行内输出——`tab-provider.ts:1719` `${s.editingModelKey === entry.key ? renderModelEditPanel(...) : nothing}` 位于 `.oc-provider-card` 内；CSS `.oc-provider-card { display:flex; align-items:center; }`（`styles/settings.css:969`）无 `flex-wrap`，`.oc-provider-edit-panel`（`:1158-1166`）无宽度/`flex` 约束 → 高面板成为横向 flex 单项，撑高整行，其余区域为 `--bg-secondary` 灰空白。

**性能问题清单**：
- caps 编辑器每个 input `@input` 即 `state.requestUpdate()`（`tab-provider.ts:1439`；面板 `renderModelEditPanel` :1492、标题 :1496、`renderCapsEditor` :1429：上下文窗口 :1450、最大输出 :1457、输入模态 :1459-1464、支持思考 :1467、思考档位 :1471-1487）。
- `renderTabProvider`(:1296) 每渲染重算 `groupProvidersFromConfig(snap.config)` + fallback map + default 查找 + `totalModels` reduce(:1299-1303)，无记忆化。
- 卡片列表 `.map()`(:1634) 非 `repeat()`，拖拽重排（`onDragStart` :507、`onCardDragOver` :514、`handleModelDrop` :534-549 → `runPatch` `replacePaths:["models.providers.<key>.models"]` :549）时 DOM 无 key 复用。
- dragover 每事件 requestUpdate(:523)。
- 渲染期 RPC（:276-281，见 T4）。

**已知 bug 面**：单例 state 跨 tab 共享，`resetProviderTab`(:1294) 漏清即脏状态；hash 冲突乐观锁在 `controllers/config.ts:268-274`（`runPatch` :311-340）；配置读 `config.get` 缓存(:83-110)；`models.list` 5min TTL + 30s 失败退避（`controllers/models.ts:22-28`）；自定义分组仅 localStorage（`model-org.lib.ts:25`，key `cryoclaw.model-org.v1`）；用量卡 kimi `renderUsagePanel`(:1899-1935，`ipc.kimiGetUsage()` :1099 @ `loadUsage` :1094，`checkOAuthStatus` :1085 初始化自动加载)、per-provider `renderProviderUsage`(:1809-1846 @ `handleFetchUsage` :1270)、推导 `tab-provider-usage.lib.ts deriveUsageView`(:117-131)。

## 8. T7 新内核适配检查

**已有 shim**：`controllers/session-branches.ts:3`（9.7 分支树）、`app-chat-props.ts:132`、`grouped-render.ts:321`、`transcript-export.ts:88`（feature-probe `transcripts.get`，失败回退）、`controllers/board.ts:17`（`board.get` 不可用时静默）、`tab-provider.ts:276-281`（agents.list cooldown）、`tab-channels.lib.ts:587-597`（R89 tools.exec.mode 5 枚举）、`src/agent-db-migration.ts`（schema≥24 + lease 死锁自愈，挂 `gateway-process.ts:279`）。

**缺口**：无系统化 diff——前端/主进程使用的 RPC 方法串与内核 allowlist 之间没有机器可比对的清单，`tasks.*`（T1）即漏网鱼；各 caller 以 ad-hoc try/catch 处理「method not found」，无统一能力门控（`gateway.ts:33` 的 `features.methods` 闲置）。

## 9. T8 WebBridge「校验未通过（上游已更新）」

**信任模型**：精确 sha256 fail-closed。内嵌钉定表 `src/webbridge.ts:38-50`（`WEBBRIDGE_BINARY_SHA256_PINS`，2026-09-10 值）；远程 manifest `src/webbridge-pins.ts`（URL :25-27：jsDelivr → raw.githubusercontent 的 `binchen6/CryoClaw@main/resources/webbridge-pins.json`；24h 缓存 :30；严格 64-hex 解析 :52-73；`loadRemotePins` :176-207）；仓库副本 `resources/webbridge-pins.json`（updatedAt 2026-09-10，同三枚哈希）。校验 `verifyWebbridgeBinarySha256`(:129-171) 不匹配即**删除二进制**并抛错（:168「上游 latest 内容已变化…升级需更新钉定表」）；逃生阀 `KIMI_WEBBRIDGE_SKIP_PIN=1`(:35,:146)。

**失败链路**：修复/更新返回 `code === "PIN_STALE"` 或 `isWebbridgePinStaleError`（`webbridge-error.ts:11-16` 匹配「sha256 校验失败」「缺少 sha256 钉定」）→ `tab-advanced.ts:274` / 修复模态 :457 显示 `settings.advanced.wbRepairPinStale`（`zh.ts:659`/`en.ts:620`）=「WebBridge 组件校验未通过（上游已更新）。请先将 CryoClaw 升级到最新版本，再重新修复。」reason `"pin-stale"` 映射于 `src/settings/webbridge.ts:605`；修复路径会 force 刷新 pins（`settings/webbridge.ts:171-177`、`webbridge-update.ts:480-510`）。

**永久失败根因**：上游对 `…/webbridge/latest/releases/<name>` **原地重建**（同字节大小、新 Go build ID，`webbridge-pins.ts:3-6` 注释记载）→ 下载物哈希既不匹配内嵌表也不匹配远程 manifest（两者冻结于 2026-09-10）→ fail-closed 拒绝安装；UI 唯一话术是「升级应用」，而新版应用的内嵌表同样可能过期 → 死循环。真实修复只能靠人工更新 `resources/webbridge-pins.json`（无需发版，manifest 走 repo main）或发新内嵌表，二者都无自动化。

## 10. T9 审查/发版约定（现状）

- 开源仓 `binchen6/CryoClaw`（AGPL-3.0-only，main），orphan 干净历史推送；提交身份 `binchen6 <binchen6@users.noreply.github.com>`；push 前对 diff 做凭证扫描（`sk-*`/`AKIA*`/私钥头/已知 token）。
- 发版：bump `package.json` 日历版本（当前 `2026.1004.1`，hotfix 用 `.N`）+ `release-notes.json` 顶部条目 → `npm run dist:win` → 安装验证（gateway `http://127.0.0.1:18789/` 200 + CDP 冒烟）→ `gh release create`，资产三件套：`CryoClaw-Setup-<v>-x64.exe` + `.exe.blockmap` + `latest.yml`。
- 测试门：`npm test` = `test:unit:vitest` + `test:unit:node`（`scripts/run-node-tests.js`，编译至 `.test-dist`）+ `test:chat`（`scripts/run-chat-ui-tests.js`）+ `test:scripts`（`scripts/*.test.mjs` 等，`package.json:22-29`；vitest include `vitest.config.ts:7-27`）。CI `tests.yml` 每次 push/PR 全量；chat-ui/ui 独立依赖树；Electron 42+ 需 `npm install` 后 `node node_modules/electron/install.js`。

## 11. 决策记录（2026-10-04 用户确认）

| 决策点 | 选择 | 理由 |
|---|---|---|
| T1 任务页 | 能力门控 + 空态说明 | 内核已删接口，重映射（cron.* 子集）语义不等价且无 cancel 对应物；门控止血成本最低、无伪造数据风险 |
| T6 编辑面板 | 右侧抽屉（fixed ≈480px + 遮罩） | 卡片下方整宽块会在长列表滚动出视口；模态遮挡列表上下文；抽屉保留上下文且不动 `.oc-provider-card` flex |
| T8 WebBridge | 远程多哈希 manifest + workflow 自动刷新 + 应用内「刷新钉定」 | 保持 sha256 fail-closed 安全模型；多哈希容忍上游原地重建；自动化消除「人工改 manifest」单点 |
| 发版节奏 | 9 项完成后一次性审查 + 单版本发版 | 用户任务 9 描述；用户只升级一次 |
