# CryoClaw 九项修复执行文档（2026-10-04）

配套研究文档：`docs/archive/2026-10-04-nine-fixes-research.md`（根因与证据）。本文档为可执行清单：每任务给出改动点（文件+函数+改法）、复用点、测试清单、风险/回滚；末尾为全局排序、验证矩阵与发版步骤。约定：每任务一个独立可 revert 提交；全部完成后一次性审查 + 单版本发版（决策见研究文档 §11）。

## 全局排序与依赖

| 顺序 | 任务 | 依赖 | 说明 |
|---|---|---|---|
| 1 | T7 审计脚本 | — | 先产出 gap 表，为 T1 门控清单提供基线 |
| 2 | T1 任务页门控 | T7 | 新增 `controllers/capabilities.ts` 为共享基建，T7.3 复用 |
| 3 | T2 插件更新+白名单 | — | 独立 |
| 4 | T5 渠道判定+单测 | — | 独立 |
| 5 | T4 性能 | T1 | 死 ticker 由 T1 消除 |
| 6 | T3 预加载+反馈 | T2 | 开关校验复用 `plugin-store:set-enabled` |
| 7 | T8 WebBridge | — | 独立 |
| 8 | T6 模型页 | — | UI 风险最大，放最后 |
| 9 | T9 审查+发版 | 全部 | 验证矩阵全绿后执行 |

---

## T1 「任务」页能力门控 + 空态

**目标**：内核无 `tasks.*` 时页面显示说明性空态、停止 30s 死轮询；有能力时行为不变。

| 文件 | 位置/函数 | 改动 |
|---|---|---|
| `chat-ui/ui/src/ui/controllers/capabilities.ts` | 新增 | hello 时把 `features.methods`/`features.events` 存入 `Set<string>`（挂 state）；导出 `supportsMethod(state, name)`、`supportsEvent(state, name)`；hello 缺失字段时视为「未知」→ 保守放行一次调用（避免老内核无字段误伤） |
| `chat-ui/ui/src/ui/app-gateway.ts` | `:516 applySnapshot` 路径、`:577`、`:852-864` | applySnapshot 时填充 capabilities；`registerTickHandler("tasks", …)` 改为 `supportsMethod(…,"tasks.list")` 才注册（`:602` unregister 保持无条件）；`:852` `task` 事件分支保留但 fallback refetch 套同一门控 |
| `chat-ui/ui/src/ui/controllers/tasks.ts` | `loadTasks` :238、`cancelTask` :265 | 无能力时早退：清 `tasksError`、置 `state.tasksUnsupported = true`（`TasksState` :4-12 增字段）、`tasks = []`；不发请求 |
| `chat-ui/ui/src/ui/app-tasks.ts` | 视图渲染 | `tasksUnsupported` 时渲染空态说明（隐藏取消/过滤控件）；新 i18n key `tasks.unsupportedKernel`（`i18n/zh.ts`/`en.ts`）：「当前内核版本已移除后台任务接口（tasks.*），任务视图暂不可用；请等待 CryoClaw 适配新内核的任务能力。」 |

**复用**：既有 ticker register/unregister、`applyTaskEvent`、i18n `t()` 不动。
**测试**：新增 `chat-ui/ui/src/ui/controllers/tasks.lib.test.ts`（node:test，经 `scripts/run-chat-ui-tests.js`）：`supportsMethod` 判定表（有/无字段/空数组）；假 client 计数断言无能力时 `loadTasks` 零请求；typecheck。
**风险/回滚**：低；纯门控。回滚 = revert 单提交。

## T2 插件更新检查 + `plugins.allow` 同步

**目标**：更新检查失败给出人话原因（永不裸漏 `Command failed`）；启用/安装/恢复路径保证 allow 与 enabled 一致。

| 文件 | 位置/函数 | 改动 |
|---|---|---|
| `src/plugin-store.ts` | `:763-818` check-updates | dry-run 参数补 `--acknowledge-install-policy-warning`（对齐 `:828-829`） |
| `src/plugin-store.ts` | 新增纯函数 `classifyUpdateFailure(combined, exitCode)` | 分档返回中文人话：blocked/mutation preflight、`Invalid config`、install-policy warning、`Failed to check` 网络行、通用兜底「插件更新检查失败（CLI 退出码 N）」+ 首行有意义 stderr（截断）；**任何分支不得返回 `err.message` 原文** |
| `src/plugin-store.ts` | `:782` 兜底触发 | 扩展：exec 失败且未解析到任何信号且 stderr 含网络标记（`fetch failed|ETIMEDOUT|UND_ERR_CONNECT|ECONNREFUSED`）时，对 `listInstalledPlugins()` 全量 id 走 `checkUpdatesViaHttp`(:570) |
| `src/plugin-allow-sync.ts` | 新增 | 从 `kimi-config.ts:16` 迁出 `syncPluginAllowOnEnable`（kimi-config 保留 re-export，兼容 `settings/memory.ts:19` 引用）；新增 `reconcilePluginsAllowWithEnabled(stateDir)`：allow 非空时把全部 `entries.<id>.enabled !== false` 的 id 并入；原子写模式抄 `extension-mirror.ts ensurePluginsAllow`(:307-360) |
| `src/main.ts` / `src/extension-mirror.ts` | `main.ts:474` 之后 | 启动 reconcile 完成后调用 `reconcilePluginsAllowWithEnabled` |
| `src/plugin-store.ts` | 新增 IPC `plugin-store:set-enabled` | 主进程一次性原子写 `entries.<id>.enabled` + allow 同步 + `invalidatePluginListCache()`(:46)；`assertTrustedIpcSender` 守卫照抄既有 handler |
| `chat-ui/ui/src/ui/views/settings/tab-plugins.ts` | `:151-171` 开关 | 改走 `plugin-store:set-enabled`（`window.api` 缺失时回退 `config.patch`） |
| `src/plugin-store.ts` | install 成功路径、stash 恢复 `:652-667` | 成功后调 `syncPluginAllowOnEnable` |

**复用**：`stripAnsiCodes`、`parseUpdateOutcomes`、`checkUpdatesViaHttp`、`ensurePluginsAllow` 写模式。
**测试**：扩 `src/plugin-store.test.ts`（`classifyUpdateFailure` 分档表：每档断言文案不含 "Command failed"；兜底触发谓词）；新增 `src/plugin-allow-sync.test.ts`（node:test + `src/test-support/vitest-state-dir.ts useTempStateDir`：allow 非空+enabled → 并入；allow 空 → 不动；幂等；disabled 不并入）。
**风险/回滚**：双进程写配置竞争由新 IPC 集中写消除；回滚 = 前端回退 `config.patch` + revert。

## T3 技能/插件预加载 + 安装卸载反馈

| 文件 | 位置/函数 | 改动 |
|---|---|---|
| `src/preload-warmup.ts` | 新增 | `warmCaches()`：fire-and-forget、仅记日志的 try/catch；调 `listInstalledPlugins`（plugin-store）与 skill-store 列表缓存路径（`skill-store.ts:608-680`、市场浏览缓存 :54） |
| `src/main.ts` | `:1464 startGatewayAndShowMain` 成功后 | gateway 健康（`gateway-process.ts waitForHealth` :442）后 `setTimeout(idle 延迟)` 触发 warmup，不与启动关键路径争 CPU；仅一次 |
| `chat-ui/ui/src/ui/app-gateway.ts` | 连接建立后 | `requestIdleCallback` 预取 `skills.status` 入 `controllers/skills.ts` 既有 state，首开视图即时 |
| `chat-ui/ui/src/ui/views/settings/tab-plugins.ts`、`chat-ui/ui/src/ui/app-skills.ts` | 变更回调 | 复用 `app-toast.ts:38 showToast`：技能/插件安装、更新、卸载成功 toast；失败 toast 带 T2 分类文案；按 id 的 busy spinner（仿 `tasksCancellingIds` 模式）；开关成功后 re-list 校验内核态再 toast |

**测试**：`src/preload-warmup` 冒烟（node:test，stub warmer 断言错误被吞、不抛）；chat-ui node:test 覆盖 busy-key 纯函数（如抽出）；其余手测矩阵。
**风险/回滚**：warmup 增加启动后 CPU——延迟+单次限制；回滚 = 删 hook 一行。

## T4 性能与流畅度（有界集，不做虚拟化）

| 文件 | 位置/函数 | 改动 |
|---|---|---|
| `chat-ui/ui/src/ui/app.ts` | `:847` questionTicker | 抽纯函数 `questionsChanged(prev, next)` 脏比较；可见集合未变化不 `requestUpdate` |
| `chat-ui/ui/src/ui/views/settings/tab-provider.ts` | `:276-281` | 渲染期 `agents.list` 移到 tab 激活 handler（settings 切 tab 处），保留 60s cooldown 兜底 |
| `src/gateway-lifecycle.ts` | `:13` 端口探测 | 100ms 起步、2s 后指数退避至 500ms，总预算 10s 不变（快乐路径更快） |
| `src/main.ts` | `:1279-1470` | 仅健康后工作并行化（warmup/analytics/窗口显示）；迁移与 mirror reconcile 保持 spawn 前（`openclaw-config-migration.ts:289` 约束） |
| 死 ticker | `app-gateway.ts:577` | 由 T1 消除 |

**不动**：聊天历史虚拟化（已知债 `docs/OPTIMIZATION-PROGRESS.md:675`）、工具流 80ms 节流（`app-tool-stream.ts:22`）。
**测试**：`questionsChanged` 纯函数 node:test；`gateway-lifecycle.test.ts`（vitest include 已有）扩新探测时序；`scripts/measure-startup.js` 前后数据记入 PR 描述。
**风险/回滚**：探测改动在启动关键路径——总预算不变；每文件独立可 revert。

## T5 渠道 bundled 判定统一 + 五渠道单测

| 文件 | 位置/函数 | 改动 |
|---|---|---|
| `src/plugin-presence.ts` | 新增 | `isPluginPresentAnywhere(id, probeEntry)`：四根判定对齐 `openclaw-config-migration.ts:289-296`——bundled gateway `dist/extensions`、`resolveExtensionsMirrorDir()`、state `extensions/`、npm-projects 扫描（`plugin-install-roots.ts scanNpmProjectPlugins/listNpmProjectPluginIds` :78-132）；entry 探针（index.ts/dist 变体 + `openclaw.plugin.json`）以回调传入 |
| `src/wecom-config.ts` | `:17-25` | `isWecomPluginBundled` 改用 `isPluginPresentAnywhere`（签名不变） |
| `src/weixin-config.ts` / `src/dingtalk-config.ts` / `src/qqbot-config.ts` | `:21-33` / `:13-26` / `:10-18` | 同上改写 |
| `src/feishu-config.ts` | 新增 `isFeishuPluginBundled` | 查 gateway `dist/extensions/feishu/openclaw.plugin.json`（vendored 于 `scripts/package-resources.js:1425,1562`） |
| `src/settings/channels.ts` | `:22-53` | wecom 判定前先 throttled（每进程最短间隔+超时）`reconcileExtensionsOnAppLaunch()`（仿 weixin `:81-89`）；bundled map 与 bundleMessages 增 `feishu` 键（文案仿 `:72-78`） |
| `chat-ui/.../tab-channels-shared.ts` / `tab-channels-feishu.ts` | `:40-49` 等 | 消费新 `feishu` 键；feishu 面板缺组件时 banner（仿 wecom `tab-channels-wecom.ts:127`） |

**测试**（三种既有模式）：
- vitest：扩 `src/wecom-config.test.ts`（`vi.mock("electron")` 已有）——任一根存在即 bundled=true；mirror 删但 npm-projects 在 → true；四根全空 → false。
- node:test：新增 `src/plugin-presence.test.ts`（`useTempStateDir`）；扩 `src/feishu-config.test.ts`（bundled 检查）。
- chat-ui node:test：扩 `tab-channels.lib.test.ts`——六渠道（weixin/qq/feishu/wecom/dingtalk + kimiSearch）message 映射与 extract/apply 纯函数。
**风险/回滚**：运行态查询加 reconcile 有延迟——throttle 限制；presence 误报 true 仅抑制 banner（插件加载仍以内核扫描为准，fail-open 仅限 UI）。

## T6 模型配置页：抽屉化 + 性能 + bug 修

| 文件 | 位置/函数 | 改动 |
|---|---|---|
| `chat-ui/ui/src/ui/views/settings/tab-provider.ts` | `:1719` | 删除卡片行内 `renderModelEditPanel` 输出；改为在 `renderTabProvider`(:1296) 根部渲染右侧抽屉（`s.editingModelKey` 非空时） |
| `chat-ui/ui/src/styles/settings.css` | `:1158-1166` 旁 | 新增 `.oc-provider-edit-drawer`：`position:fixed; top:0; bottom:0; right:0; width:min(480px,90vw); z-index` 高于内容；半透明遮罩点击关闭；Escape 关闭；原 `.oc-provider-edit-panel` 样式迁入抽屉内容区 |
| `tab-provider.ts` | `renderCapsEditor` :1429 / `:1439` | draft 本地化：打开 `startModelEdit`(:840) 时深拷贝 entry 到 `s.draft`；输入改非受控（打开时设 `.value`），仅 open/close/save/cancel 调 `requestUpdate`；保存走既有 `runPatch`(:311-340) |
| `tab-provider.ts` | `:1299-1303` | 分组记忆化：以 `getCachedConfigSnapshot()` rev 为 key 缓存 `groupProvidersFromConfig` 结果，rev 变化才重算 |
| `tab-provider.ts` | `:1634` | 卡片列表改 `repeat()` 带 provider key（模式照 `oc-chat-history.ts:101`） |
| `tab-provider.ts` | `:514-523 onCardDragOver` | 60ms 节流 + drop-target 未变即跳过 |
| `tab-provider.ts` | `:1294 resetProviderTab` | 清 `s.draft`、agents 缓存、`agentsLoadFailedAt`、定时器，防单例脏状态 |

**测试**：抽纯 helper（分组缓存 key、draft 合并/还原）入新增 `tab-provider.lib.test.ts`（chat-ui node:test）；typecheck；手测截图对比（抽屉开/关、无灰空白、输入不重渲染列表——DevTools performance 验证）。
**风险/回滚**：本期 UI 风险最高；抽屉 CSS 独立新类不污染旧布局；非受控输入需在 open 时重置（由 reset 测试覆盖）；回滚 = revert 单提交。

## T7 内核 RPC 适配审计（CI 化）

| 文件 | 位置/函数 | 改动 |
|---|---|---|
| `scripts/kernel-method-audit.mjs` | 新增 | 用 `@electron/asar`（已是 devDep）`listPackage/extractFile` 读 `resources/targets/win32-x64/gateway.asar`：解析 `core-method-policy-*.mjs` 方法表（正则 `^\t\[\n\t\t"([a-zA-Z0-9_.]+)"`）与 `server-methods-list-*.mjs` `GATEWAY_EVENTS`；grep `chat-ui/ui/src` + `src` 的 `client.request("X"` / RPC 方法串；产出 gap 表；与基线 `docs/kernel-recon/rpc-baseline.json` 对比（已知门控缺席如 `tasks.list` 记为 `gated`）；解析到 0 方法即硬失败（防内核改名静默通过） |
| `scripts/kernel-method-audit.test.mjs` | 新增 | 入 `test:scripts` glob（`package.json:29`）：新出现未门控 gap 或使用了 `features.events` 之外的事件 → CI 红 |
| `docs/kernel-recon/rpc-baseline.json` | 新增 | 首版基线（含 `tasks.list/tasks.cancel/task` 记 gated） |
| 既有 ad-hoc probe | `controllers/session-branches.ts`、`transcript-export.ts:88`、`controllers/board.ts:17` | hello 可用处改用 T1 `supportsMethod`，保留 try/catch 兜底 |
| `docs/kernel-recon/2026.9.7-diff.md` | 追加 | 本期 gap 表 |

**风险/回滚**：正则依赖 asar 产物格式——glob 钉文件名 + 0 方法硬失败；回滚 = 删脚本与 CI 依赖。

## T8 WebBridge 钉定永久化

| 文件 | 位置/函数 | 改动 |
|---|---|---|
| `src/webbridge-pins.ts` | manifest schema v2 | `pins[filename]` 接受 `string | string[]`（多哈希，保留最近 5 枚）；v1 单串兼容；`loadRemotePins`(:176-207) 增 `{force:true}` 绕 24h 缓存(:30)；raw.githubusercontent 优先（jsDelivr 有缓存滞后） |
| `src/webbridge.ts` | `verifyWebbridgeBinarySha256` :129-171 | 接受集合 = 内嵌表(:38-50) ∪ 远程多哈希；不匹配仍删二进制+抛错；错误信息附「可在设置中点击刷新钉定」指引 |
| `src/settings/webbridge.ts` + `chat-ui/.../tab-advanced.ts` | 新增 IPC `webbridge:refresh-pins` + 按钮 | 按钮置于 PIN_STALE 提示(:274)与修复模态(:457)附近：force 拉远程 manifest，成功/失败 toast；成功后自动重试当前修复流程 |
| `scripts/refresh-webbridge-pins.mjs` | 新增 | 下载上游 latest 二进制、算 sha256、prepend 进 `resources/webbridge-pins.json`（保留最近 5、更新 `updatedAt`） |
| `.github/workflows/refresh-webbridge-pins.yml` | 新增 | `workflow_dispatch` + release 触发：跑上脚本并提 PR/直推 main（manifest 源即 repo main） |
| `docs/webbridge-pins-runbook.md` | 新增 | 轮转操作手册；安全立场：信任锚 = repo main 写权限（HTTPS manifest，不另加签名，记录为已接受风险）；fail-closed 与 `KIMI_WEBBRIDGE_SKIP_PIN=1`(:35) 保留 |

**测试**：扩既有 webbridge pin 测试（node:test 临时目录 fixture）：多哈希接受、未知哈希拒绝+删除、force 绕缓存、v1 兼容。
**风险/回滚**：多哈希略扩大攻击面——限于发布者可控 manifest；内嵌表保留供离线；回滚 = schema 回 v1（兼容路径已在）。

## T9 全面审查 + push + 发版

**审查**：CodeReview 代理对 9 个提交逐任务过验证矩阵；重点复查：T2 配置写竞争、T5 presence 误报面、T6 抽屉焦点/Escape/遮罩、T8 信任模型、全 diff 凭证扫描（`sk-*`/`AKIA*`/私钥头）。
**测试门**：`npm test` 四段全绿（`test:unit:vitest` + `test:unit:node` + `test:chat` + `test:scripts`）+ CI `tests.yml` 通过。
**发版**（单版本）：
1. bump `package.json` → `2026.MMDD.0`（当日日历版）；`release-notes.json` 顶部 zh+en 条目（九项摘要）。
2. `npm run dist:win`；安装器验证须在普通权限通道（沙箱内 `/S` 会清空安装目录；应急可 robocopy `out/win32-x64/win-unpacked` 恢复，正式发版必须真实安装器）。
3. 启动验证：gateway `http://127.0.0.1:18789/` 200 + CDP 冒烟（`scripts/interaction-cdp-smoke.js` / `layout-cdp-smoke.js`）。
4. orphan 干净历史 push（身份 `binchen6 <binchen6@users.noreply.github.com>`，push 前凭证扫描）。
5. `gh release create v<ver>`，资产三件套：`CryoClaw-Setup-<v>-x64.exe`、`.exe.blockmap`、`latest.yml`。
6. CI 注意：chat-ui/ui 独立依赖树先装；Electron 42+ 在 `npm install` 后 `node node_modules/electron/install.js`。

---

## 验证矩阵

| 任务 | 自动门 | 手测 |
|---|---|---|
| T1 | `tasks.lib.test.ts` + typecheck | 任务页显示空态说明；DevTools WS 日志 30s 内无 `tasks.list` 报错 |
| T2 | `plugin-store.test.ts`、`plugin-allow-sync.test.ts` | 断网/模拟 blocked 时检查更新显示人话文案；UI 启用插件后 `~/.openclaw/openclaw.json` 的 `plugins.allow` 含该 id |
| T3 | preload-warmup 冒烟 | 冷启动后首开插件/技能 tab < 2s；安装/卸载/更新均有 toast 与进度 |
| T4 | `gateway-lifecycle.test.ts`、questionsChanged 单测、measure-startup 对比 | 拖拽模型卡不卡；pending question 存在时 DevTools performance 无 1s 全量渲染 |
| T5 | wecom/feishu/plugin-presence 单测、`tab-channels.lib.test.ts` | 仅 npm-projects 存在 wecom 时 banner 消失；六渠道面板逐一打开无误报 |
| T6 | `tab-provider.lib.test.ts` + typecheck | 抽屉开/关/Escape/遮罩；输入上下文窗口数字时列表不重渲染；截图对比无灰空白 |
| T7 | `kernel-method-audit.test.mjs` 绿 | 基线文件人工 review |
| T8 | webbridge pins 单测 | 构造 stale-pin 场景 →「刷新钉定」按钮修复成功 |
| T9 | 全量 `npm test` + CI | 安装器 + gateway 200 + CDP 冒烟四步 |

## 手测总清单（发版前）

1. 任务页空态；侧边栏任务徽标不报错。
2. 插件页：检查更新（在线/断网/模拟 blocked）、启用/禁用/安装/卸载/更新全路径 toast 与白名单落盘。
3. 技能页：首开速度、安装/卸载反馈。
4. 远程控制：六渠道面板、wecom 保存与凭据验证、feishu banner 条件。
5. 设置-模型：抽屉编辑保存、拖拽排序、默认星、用量卡加载。
6. 设置-高级：WebBridge 修复 + 刷新钉定。
7. 启动耗时对比（measure-startup）与聊天流式无回归。

---

## 执行记录（2026-10-04 实施）

状态：九项全部实施完成；全量测试通过（vitest 18 文件 / node 302 / chat-ui 855 / scripts 129）；CodeReview 代理评审完成，Critical 1 项、Important 5 项、Minor 数项已全部修复后再次全量通过。

### 与本文档设计的偏差（均经评审确认为改进，不改变验证目标）

1. **T1**：门控放在 `loadTasks/cancelTask` 内部 + ticker 条件注册双保险（重连切换内核也安全）；不限于文档只写的条件注册。
2. **T4**：1s questionTicker 保留（它驱动问答卡可见倒计时，脏比较会冻结倒计时）；main.ts 并行化收敛为 T3 的异步预热，迁移/reconcile 顺序不变。
3. **T6**：编辑器落成独立 LitElement（`oc-caps-editor`，按键只重渲染编辑器子树），非文档的「非受控输入」方案；记忆化 helper 放 `tab-provider.lib.ts`（node 测试可导入，绕开组件链的 DOM 依赖）。dragover 经核实已有 dropTarget 脏比较，不再加节流。
4. **T3**：插件市场安装/更新/卸载 toast 原已存在；实际补齐的是技能安装/卸载 toast、插件开关 toast 与开关后后台回拉校验。
5. **T7**：既有 ad-hoc 探测（session-branches / transcript-export / board）保留 try/catch 形态未改 `supportsMethod`（功能等价、避免扩大改动面），在基线登记为 fallback。
6. **T5**：飞书面板 i18n 兜底 key `settings.channels.feishu.notBundled` 由协调者在整合期补入 zh/en。
7. **T8**：`resources/webbridge-pins.json` 数据文件未改（由 workflow/脚本轮转）；IPC 通道改名 `settings:webbridge-refresh-pins` 对齐既有命名空间。

### 评审修复清单（Critical / Important / Minor）

- **[Critical]** `scripts/kernel-method-audit.test.mjs` 依赖 gitignored 的 gateway.asar（CI 不构建）→ 产物缺席时 skip（本地/发版机仍全量校验，0 方法解析仍硬失败）。
- **[Important]** 技能预热参数与商店首开请求不一致（缓存永不命中）→ 对齐 `sort=trending, limit=20, cursor=""` 同键。
- **[Important]** 抽屉 Escape 焦点不可达 → `tabindex="-1"` + `ref` 打开时聚焦（焦点在抽屉内不抢），遮罩点击关闭保留。
- **[Important]** `refresh-pins` 把 stale-cache 回落当成功上报 → source === "stale-cache" 按失败返回（网络指引）。
- **[Important]** 插件开关 await 冷缓存 `plugins list`（~15s）→ 乐观更新 + 后台回拉校验，不阻塞开关。
- **[Minor]** 网络标记正则去掉裸 `network`（防 stdout 文本误触发回退）；冷缓存跳过 HTTP 回退（避免二次 90s CLI）；刷新成功提示在自动重试流程后被清空 → 按需补回；IPC 命名对齐；`--hairline` 未定义 token 换 `1px solid var(--border)`；删除死 CSS `.oc-provider-edit-panel` 容器规则。

### 验证结果

- `npm test` 四段全绿：vitest 18 文件 258 用例、node 302（298 pass + 4 skip）、chat-ui 855、scripts 129（含审计门）。
- 发版：v2026.1004.2（见 release-notes.json 顶部条目）。
