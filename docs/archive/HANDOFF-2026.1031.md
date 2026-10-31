# CryoClaw 下一模型接续文档（暂停快照）

> 整理日期：2026-10-31
> 仓库根目录：`C:\Users\binchen\Desktop\code\Oneclaw2\Oneclaw`
> 当前结论：**工作已暂停，目标未恢复；当前工作树不能直接发版。**

## 0. 给接续模型的首要提示

1. 不要从“继续优化”直接开始。先读完本文和 `CLAUDE.md`，再检查工作树。
2. 当前有一处**尚未闭环的插件清单类型改动**，见第 5 节；先完成或回退这两处，再跑类型检查和完整测试。
3. 用户最后要求暂停所有子智能体并整理交接。本文件只是交接，不代表恢复性能优化、真实安装或发布。
4. 用户原始总目标仍保留：完成全页面冷启动与消息链路优化、深度 UI/代码审查、完整真实验收，稳定后发版并 push；但必须由用户明确恢复后再执行。
5. 不得把旧测试结果、合成夹具指标或静态审查候选写成当前工作树的最终收益。

---

## 1. 用户目标、暂停状态与版本状态

### 1.1 已完成的主要需求

- 修复对话输入框停止按钮发黑。
- 参考 `C:\Users\binchen\Desktop\code\Oneclaw2\参考图` 的 13 张图完善 UI，保留 CryoClaw 的 CryoBlue、MiSans、图标与主题体系。
- 优化看板滚动、首次聊天历史加载、Markdown 内存、构建准备和更新器并发安全。
- 新增真实工具展示、命令记录、可搜索快捷键目录。
- 将模型设置重构为“供应商目录 → 供应商详情 → 添加供应商”三层工作台。
- 全部预置供应商改为统一手绘 SVG；未知自定义供应商显示名称首字母。
- 消除连接后重复的 `agent.identity.get`。

### 1.2 尚未完成的总目标

- 所有页面冷启动速度与数据加载优化。
- 对话发送、ACK、流式接收、渲染和终止链路的进一步优化。
- 深度全面 UI/代码审查收尾。
- 当前工作树完整构建、四层测试、真实 Electron/安装/更新/启动验收。
- 版本发版、提交、push、GitHub Release 与资产核验。

### 1.3 当前暂停与 Git 状态

- 暂停目标：`goal-ee653f2f-7075-4b13-9a52-2a442f13db46`，revision 5，`phase=paused`，`activation=disarmed`。
- 当前分支：`codex/backend-performance-2026-1026`。
- HEAD：`0af6419 release 2026.1030.0: overlay return rules, unified focus system, startup and size gains`。
- 最后核对时 `origin/main` 也在 `0af6419`；本地 `main` 较旧（`fbcebf2`），最终需按发布流程 fast-forward，不要强推。
- 当前 `package.json` 和 `release-notes.json` 顶部版本均为 **2026.1030.0**；下一版预计 **2026.1031.0**，尚未 bump。
- 交接时：32 个 tracked 文件修改，约 912 insertions / 219 deletions，另有多组新源码、测试、脚本和文档；`git diff --check` 通过。
- **未提交、未 push、未生成新发布包、未覆盖安装、未创建 Release。**
- 所有后台 job 已结束；durable teammates 均 inactive；没有应继续运行的子智能体。

---

## 2. 必须遵守的项目约束

先读：

- `CLAUDE.md`
- `docs/architecture.md`
- `docs/TESTING.md`
- `docs/VISUAL-SYSTEM.md`
- `docs/releasing.md`
- `documents/designs/reference-refinement.md`
- `documents/designs/provider-workbench.md`

关键约束：

- 不新增依赖，不为了“简化”破坏物理 gateway、独立 Node、配置/认证、preload 白名单、备份、签名、journal 或回滚。
- UI 使用语义 tokens、MiSans、CryoBlue/CryoIcons；不写死主题颜色，不添加无后端能力的假按钮。
- 保留原生滚动能力；只去除不需要的滚动条装饰，不能禁止页面、列表、代码或 textarea 滚动。
- 编辑前读取文件；遇到 `FS_STALE_VERSION` 先重读并 rebase，不能覆盖其他改动。
- `ops_bash` 在此环境实际执行 Bash，不是 PowerShell。
- 共享 `.test-dist` 和应用构建产物不能由多个任务并发写；定向测试使用独立输出目录，最终统一跑全量。
- 隔离 UI 验收必须：临时 profile、禁 HTTP(S)/WS(S)、专属空闲端口、随机 UUID `qaMarker`，连接前核对目标 URL，防止误控真实应用。
- 不读取或修改真实凭据，不默认调用收费 provider；`--live` 只能显式使用。
- Hindsight 服务此前持续报 `connect ECONNREFUSED 127.0.0.1:9077`，不要编造记忆结果，以当前源码和测试为准。

---

## 3. 已落地工作及验证边界

### 3.1 对话、工具和快捷键 UI

主要文件：

- `chat-ui/ui/src/styles/compose.css`
- `chat-ui/ui/src/styles/chat.css`
- `chat-ui/ui/src/ui/chat/tool-presentation.ts`
- `chat-ui/ui/src/ui/chat/tool-cards.ts`
- `chat-ui/ui/src/ui/chat/code-block-enhance.ts`
- `chat-ui/ui/src/ui/chat/command-history.ts`
- `chat-ui/ui/src/ui/components/oc-command-jobs.ts`
- `chat-ui/ui/src/ui/keyboard-shortcuts.ts`
- `chat-ui/ui/src/ui/views/settings/tab-shortcuts.ts`
- `chat-ui/ui/src/ui/views/chat.ts`

已实现：

- 停止按钮使用独立中性表面和明确的 `var(--destructive)` 方块，避免共享发送按钮黑底及 `.field span` 抢色；34px 按钮、10px 图标。
- 工具读取、请求编辑 diff、命令/输出分区、复制、换行、8k 有界显示和完整原文复制/侧栏。
- 命令记录只投影当前会话工具消息，不是 OS 后台进程管理器；不提供虚假 Kill 或存活状态。
- 修复高亮代码直接改写 Lit 文本节点导致 ChildPart marker 丢失的问题；空 code 元素由 ref 独占，异步高亮校验 source/lang/isConnected。
- 新增 7 个真实快捷键的可搜索目录，无伪造持久化编辑/删除。
- Ctrl+N/L 防 IME、keyCode 229、repeat、defaultPrevented、meta/alt/shift 和原生/自定义模态抢占。
- `tab-shortcuts.ts` 后续补了 `data-page-id="settings:shortcuts"`、`data-load-state="ready"`、`aria-busy="false"`，该最后改动尚需随当前树复验。

### 3.2 模型设置三层工作台与图标

主要文件：

- `chat-ui/ui/src/ui/views/settings/tab-provider.ts`
- `chat-ui/ui/src/ui/views/settings/settings-view.ts`
- `chat-ui/ui/src/styles/provider-workbench.css`
- `chat-ui/ui/src/ui/components/provider-icons.ts`
- `chat-ui/ui/src/ui/components/provider-segment.ts`
- `chat-ui/ui/src/ui/icons.ts`

已实现：

- 目录按托管/API 供应商分组，包含搜索、主模型概览、认证/协议/模型数量和入口。
- 详情显示真实 provider ID、协议、endpoint、脱敏 key、模型 ID/context/display name 与操作；高级账户、用量、角色、fallback、agents、排序仍可达。
- 添加页包含 17 个预设 chips、自定义 endpoint、现有 OAuth/API key/models/caps 流程。
- 修复原 `handleKeySave` 先置 busy、随后被 `runPatch` 自身 busy guard 拒绝的问题；独立 `keySaving` 和 `keySaveToken`。
- 添加/拉取/保存使用独立 token、selection fingerprint 和 lifetime 守卫；reset/离页清秘密，旧 verify/sidecar/finally 不污染新表单。
- `runPatch` 的 lifetime/isCurrent 只守 UI 收尾，**不能宣称撤销已经发出的 patch**。
- 预置供应商使用 12 类原创 24×24 线性 SVG；16px chips 也可辨识；无网络运行时图片。
- 已知 alias/endpoint 复用图标族，未知自定义供应商用 Unicode 首字母（英文大写）；手工 `custom` 预设仍用 sliders。
- 后续在窄屏 provider workbench 改了 detail/add header grid，让 badge 独立成行；**此最后 CSS 改动发生在 30/30 图标验收之后，需重新跑模型 UI 矩阵。**

### 3.3 看板、历史加载与内存

- `oc-dashboard.ts`：`WeakMap<MessageEventSource,HTMLIFrameElement>` 替代每消息全 iframe 扫描；visibility 不再触发 inspector/style 读取；wheel 逐帧合并；保留 sandbox、来源拒绝和原生嵌套滚动。
- `dashboard.css`：顶部 tabs 去除实时 backdrop blur。
- `controllers/chat.ts`：`cancelChatHistoryHydration` 移到真正替换 snapshot 前，慢/失败刷新不再中断 20→60→… 渐进加载。
- `markdown.ts`：200 条 LRU 增加 2,000,000 code-units 双预算。
- 200×约 50k 压力夹具：缓存保留约 60M→1.8M code units，独立 V8 强制 GC heap 增量约 60.05MB→1.83MB。**不是 Electron RSS 或正常会话内存降幅。**

### 3.4 构建、配置与更新器

- `scripts/build-chat.js`、`scripts/lib/build-chat-deps.js`：依赖输入/安装 inventory 指纹命中时跳过重复 npm 准备，Vite 始终执行；直接 Node 调 npm-cli，避免 `shell:true` 和 DEP0190。
- 单次准备阶段实测约 1655→20ms，Vite 仍约 2.3s；不是安装器或端到端安装提速。
- `src/kernel-updater.ts`：同时刻 `--check` singleflight；永久 quitting latch、spawn/await 守卫，退出不自动 rollback/restart；等待 probe 后再停 gateway。
- global npm config 内容加入缓存指纹，未知来源保守不 cache。
- `src/provider-config.ts`：写前同一份新鲜 raw 配置 parse 两次，去掉 parse→stringify→parse；保留损坏配置、并发修改和 EBUSY 防护。
- 226KB×2000×5 微基准 median 1206→1046ms，约 0.08ms/次；不是启动秒级收益。
- V8 compile cache 实测更慢，未启用；main-session recovery 已与插件并行，未做不安全的恢复绕过。

### 3.5 身份 RPC 去重（暂停前最后一项已定向验证）

- `chat-ui/ui/src/ui/app-gateway.ts`：捕获 `admissionSessionKey`，复用 admission 的 identity 响应。
- `chat-ui/ui/src/ui/controllers/assistant-identity.ts`：`loadAssistantIdentity` 新增 `opts?: {sessionKey?:string;snapshot?:unknown}`；传入 snapshot 时跳过第二次 RPC，仍保留 session guard。
- `app-gateway-reconnect.test.ts` 新增 identity 请求计数；红测曾稳定复现 `2 !== 1`，修后定向 **1/1 PASS**，每次 hello 一次 identity 请求。
- 该改动尚待最终完整 `test:chat`、UI typecheck 和真实重连验收。

---

## 4. 测试结果：哪些有效，哪些已过时

| 验证 | 结果 | 当前解释 |
|---|---|---|
| 首轮完整 build/test/typecheck | 2661 passed / 6 skipped / 0 failed | 早期首轮工作完成时有效，不能覆盖后续模型和性能改动 |
| 模型工作台阶段完整门禁 | 2688 passed / 6 skipped / 0 failed | 在图标、身份去重、窄屏 header、插件前置改动之前，不能作为当前最终门禁 |
| 模型+图标隔离 Electron | 30/30 场景 PASS | 1440/800/600×明暗，17 预设 SVG/12 族、自定义首字母、零 config.patch；窄屏 header 后续改动需复验 |
| 图标映射定向测试 | 4/4 PASS | alias、endpoint、自定义首字母等 |
| 模型保存/生命周期 VM | 23 个定向测试 PASS | 不代表真实 provider 写入；当前新增候选仍需补测 |
| 身份 RPC 去重 | 1/1 定向 PASS | 当前树仍需完整测试 |
| 工具定向 | 51/51 PASS | 后续集成真实 Electron smoke 也通过 |
| 看板定向 | 64/64 PASS | 合成 24 iframe CDP 通过，不等于全应用 FPS |
| 当前完整工作树 | **未验收** | 已知插件清单类型不一致，先处理第 5 节 |

常用最终门禁（从仓库根目录）：

```bash
npm run build
npm test
npm run test:typecheck
git diff --check
```

最终还需重跑：

```bash
node scripts/reference-ui-smoke.js --out out/ui-qa/reference-final-current
node scripts/dashboard-perf-cdp-smoke.js --out out/ui-qa/dashboard-final-current
node scripts/provider-workbench-cdp-smoke.js --out out/ui-qa/provider-workbench-current
```

以上均应在构建后、无其他共享构建/真实 app 基准并行时执行。

---

## 5. 插件清单改动（已闭环：按方案 A 回退；方案 B 经实测否定）

> **2026-10-31 接续结论：本节阻断已解除。** 两处前置改动已回退（`shared/channel-plugin-inventory.cjs`、`src/channel-plugin-inventory.ts` 恢复为 HEAD 状态），主进程与 chat-ui typecheck 均恢复全绿。回退不是"没做完就先撤"，而是方案 B 被实测数据否定——见 §5.3。

暂停时正在探索：用 kernel manifest registry 的轻量元数据替代插件列表的完整 CLI，减少冷加载约 6 秒；但只完成了前置改动。

### 已改但未完成

`shared/channel-plugin-inventory.cjs:23-27` 的 map 现在额外返回：

```text
name/version/description/format/kind/source/rootDir/origin/enabled/status
```

`src/channel-plugin-inventory.ts:5` 当前类型：

```ts
export type ChannelPluginInventory = {
  installed: Set<string>;
  channels: Map<string,string[]>;
  plugins: Record<string,unknown>[];
};
```

但 `src/channel-plugin-inventory.ts:20` 仍然只有：

```ts
return {installed,channels};
```

**结果：类型与实现不一致，当前树不能直接发布。** `src/plugin-store.ts` 尚未接入这些 metadata。

### 接续选择

A. 回退这两处前置改动，先恢复到最近可验证状态，再单独设计插件列表优化；或
B. 完成实现，但必须保留：

- `enabled/status/npmName/local/install-root` 等现有列表语义。
- kernel registry 的 manifest 选择、install-index 校验和 duplicate precedence。
- 不执行 plugin entry point。
- 解析/字段不完整时回退原 CLI，而非伪造空插件或成功。
- 启动 inventory 与插件列表 consumer 的各自超时、退出和错误边界。

完成后先跑主进程 typecheck 和插件相关定向测试，再考虑性能收益。

### 5.3 本轮实测：方案 B 不成立（2026-10-31）

实测环境：Windows，bundled `runtime/node.exe` v24.22.1，内核 openclaw 2026.10.9，真实用户态 `~/.openclaw`（74 个插件）。数字均为本轮实测，非沿用文档估算。

**基线（当前代码）**

| 测量 | 中位值 | 说明 |
|---|---:|---|
| pre-gateway inventory（`shared/channel-plugin-inventory.cjs`） | **3408.6ms** | 3 次采样 3355.8 / 3408.6 / 3479.3 |
| 冷 `plugins list --json` | **8183.4ms** | 3 次采样 7874.9 / 8183.4 / 8508.0 |

文档 §6.2 原估"inventory 约 1.4s""冷 list 5.8–7.6s"，与实测不符：真实值是 3.4s 和 8.2s。

**方案 B 的两条硬证据**

1. **registry 元数据缺 `enabled`/`status`。** 74 个插件逐个字段对比 registry 输出与真实 list 输出：`name/description/format/kind/source/rootDir/origin` 全部一致，但 `enabled` 与 `status` 在 **74/74 个插件上均为 `undefined`**（list 侧分别为 `true/false` 与 `loaded/disabled`）。另有 2 个插件版本号不一致（`kimi-search` registry 0.1.0 vs list 0.1.3；`llm-task` 2026.5.21 vs 2026.10.9）。而 `enabled/status` 正是 §5 方案 B 第一条硬性要求，故方案 B 会伪造禁用状态，不可接受。
2. **换等价调用路径也没有收益。** 让 bridge 子进程直接调用内核自己的 `buildPluginRegistrySnapshotReport`（与 CLI 完全同一条代码路径），输出与 `plugins list --json` **逐字节相同**（`plugins` 载荷、`workspaceDir`、`registrySource`、`diagnostics` 全部相等），但耗时 **7917ms vs CLI 7745ms**——没有变慢，也没有变快。

**成本结构（解释为什么"省 CLI 启动开销"这条路走不通）**

| 阶段 | 实测 |
|---|---:|
| bare node 进程启动 | 70–93ms |
| `openclaw.mjs --version`（含 CLI 框架引导） | 136ms |
| 仅 import manifest-registry 元数据模块 | 863–867ms |
| 完整 `plugins list --json` | 8183ms |

CLI 启动只占约 1.6%（136ms / 8183ms）。8.2s 中绝大部分是内核 discovery 与 manifest 加载本身。**想优化插件冷列表，必须减少 discovery 工作量或跨进程缓存结果，而不是换调用方式。** 后续若要重启此优化，先量 `loadPluginMetadataSnapshot` 内部的 registry/manifest 两段耗时，不要从 CLI bootstrap 入手。

**因此采用方案 A。** 两处改动已 `git checkout` 回退；`npm run test:typecheck` 与 `npx tsc -p tsconfig.json --noEmit` 均通过。

---

## 6. 冷启动/全页面报告汇总

### 6.1 当前已安装 2026.1030.0 的真实页面基线

报告：`out/ui-qa/page-perf-baseline-2026.1030.0`
命令使用 `scripts/frontend-page-performance-cdp-benchmark.js`，单轮、36 页；不是清 OS 缓存的严格冷启动。

单次首轮/复访代表值：

| 页面 | 首轮 | 复访 |
|---|---:|---:|
| 已安装插件 | 7248.6ms | 87.3ms |
| 用量 | 5908ms | 1130ms |
| 记忆 | 2986.2ms | 3137.7ms |
| 任务 | 3011.1ms | 1236.5ms |
| 飞书 | 4942.7ms | 4704.7ms |
| 企业微信 | 5018.1ms | 5187.4ms |
| 技能商店 | 18004ms | 76.2ms |

插件市场约 87.7 秒进入网络错误状态，因此 `pagesSuccessful=false`；**不能将更快报错计为加载提速。**

### 6.2 已确认/待实施候选

1. **身份重复 RPC：已修，见 3.5。**
2. **Hello 后请求突发**：`app-gateway.ts` admission 后一次启动 models/config/agents/channels/question/progress/board/worktrees/history/sessions 等约 10 个读取。首屏 chat 核心只需 identity/history/sessions；其他可延后或按视图触发。必须先记录实际 RPC 时序，保持重连和页面预载语义。
3. **Gateway spawn 前插件探测**：`src/main.ts` 的 `prepareGatewayForStart` → `ensureOptionalPluginDemand` → `readChannelPluginInventory` 每次启动 spawn Node。真实 pre-gateway inventory 约 1.4s。可研究内容指纹缓存或复用 metadata，但不能直接跳过配置同步。
4. **spawn 前四个迁移**：`src/main.ts:1571-1574` 串行执行迁移，每个可能 read/write 配置；可研究合并为一次 read-for-write + 条件写。必须保留备份、原子写和并发防护。
5. **冷插件列表 CLI**：`src/plugin-store.ts` 冷 list 走完整 `openclaw plugins list --json`，样本约 5.8–7.6s；10 分钟缓存只利复访。与第 5 节同一问题。
6. **设置页静态导入全部 tabs**：`settings-view.ts:14-28`，settings chunk 332,818B / 84,054B gzip。可按 provider/memory/appearance/advanced 等动态分包，但注意已有 `preloadSettingsTab` 和 reset/cleanup 生命周期。
7. **i18n 顶层 await**：`i18n/index.ts:26-30` 阻塞入口模块图；字典 parse 微基准约 0.9ms，优先级低于 RPC/主进程。
8. **401KB 单体 CSS**：首帧解析所有页面样式；可评估 setup 独立入口或按视图拆分，但不能为分包破坏层叠顺序。
9. **入口 chunk 530KB**：V8 parse 预热微基准约 7.6ms，不是当前首要瓶颈。
10. `constants.ts:24 resolveGatewayPort` 直接同步读配置，可评估复用现有配置缓存；收益可能很小。
11. extension reconcile 的逐插件 hash 读取尚未量化，不应直接写成已确认瓶颈。

### 6.3 已排除的伪优化

- 已有 lazy routes、hover preload、900ms dashboard 预热、Markdown cache、hljs/katex 动态分包，不得重复记为新增。
- `extension-mirror.copyDir` 已异步化。
- `loadSessions` 和 config 有 in-flight 去重，Hello 突发重复度低于表面。
- 不用 V8 compile cache，不后移/绕过安全 recovery。

---

## 7. 消息收发链路报告汇总（全部尚未实施）

以下去重合并了两份只读审查。除特别说明外均为候选，需要测试/基准确认，不是已经完成的优化。

### 7.1 优先处理的小范围问题

1. **多附件串行读取**
   `controllers/chat.ts:865-889` 在 for 循环逐个 `await readFileBase64`，4 个文件等待求和后才 echo/send。
   建议：有界并发启动读取，按原附件顺序消费，保留 23MiB 共享 frame budget 和 fallback。不要把 echo 移到 `sessionChangedDuringRead` guard 前。
   测试：deferred reads 同时启动、原始顺序、预算/fallback、会话切换不 echo、queue Send-now 串行。

2. **向上阅读时的滚动快速路径**
   `app-lifecycle.ts:59-77` 每次流式更新调度；`app-scroll.ts:60-87` 等 updateComplete/rAF 并读 layout 后才发现用户不在底部。
   建议：在现有 generation/取消逻辑后，对非 initial/non-force 且 `chatHasAutoScrolled && !chatUserNearBottom` 直接设置 `chatNewMessagesBelow=true` 并返回，避免 update/rAF/layout。
   保留 force、session restore、smooth-scroll suppression、120/150ms retry 和 near-bottom 行为。

3. **旧轮次 stale retry 泄漏到新 run**
   `controllers/chat.ts:229-236` 换 round 时只 reset attempt，不取消 pending timer；`:252-281` callback 没有 round 校验。
   建议：round 变化取消旧 timer/清 key，或 callback 捕获并校验 compound round。
   测试：terminal 后新 same-session run，旧 deadline 不得 RPC/消耗新预算；新 round 仍有 600/1500/3000/6000ms ladder。

4. **重复流气泡检测重复处理历史**
   `chat/stream-bubble-guard.ts:18-38` 每帧 uncached `extractText` + normalize 历史文本。
   建议：复用 `extractTextCached`，用 `WeakMap<object,string>` 缓存规范化历史文本；stream 侧仍需精确比较。
   保留 whitespace equality、严格 prefix=false、last-assistant 选择和 immutable message 语义。

5. **无 narration 时每 delta 全文 concat**
   `controllers/chat.ts:1287-1289` 先拼接 frozenPrefix+body，callee `app-tool-stream.ts` 在无 narration 时才 early-return。
   建议：把 concat 移到 narration guard 之后，或用明确 flag 避免无意义调用；`trim()` 热路径也需基准后优化。
   不得改变正文保留、append/replace、partial overlap 和内容不丢失。

6. **不匹配 narration 的重复全文扫描**
   `app-tool-stream.ts:433-480` 可对增长 body 重复 normalize，存在 O(n²) 风险。
   建议：先做 microbench；必要时使用有界 normalized-prefix comparator/缓存 segment。必须覆盖 whitespace drift、replacement delta、拒绝候选正文保留。

7. **pre-align 与 180s watchdog 同 tick 双发 silent history**
   `app-gateway.ts:278-377` 两个分支可能同时满足。
   建议：stall 已成立时让 watchdog 独占，pre-align 跳过；fake timer 断言只发一次 silent load。

8. **发送时取消渐进 hydration 并展开全部历史**
   `controllers/chat.ts:933-937` 发送 echo 时设置 visibleCount=全部并 cancel hydration，可能在发送时一次渲染 200 条。
   这是需要专门 interleaving 测试的候选，不要简单删除 guard；同时处理 terminal refresh 不缩窗、echo 仍可见。

### 7.2 渲染与分配热点（先基准，再落地）

1. `chat/grouped-render.ts:933`：stableHtml 未变时仍每帧执行 `linkifyPaths(renderMediaMarkers(...))`。可按 stableHtml + preferredFiles identity + output 做 memo。
2. `grouped-render.ts` 的 `toLocaleTimeString` 每帧/每组重复格式化固定 timestamp，可小缓存。
3. 每个 stream frame 重建 compose/panels 等模板；`<oc-chat-history>` 和 `<oc-chat-stream>` 已有 shouldUpdate。结构化抽 `<oc-chat-compose>` 或 memo callbacks 必须 benchmark-gated，不在未测量时大改。
4. Markdown 2M budget 在长会话/工具输出下可能 thrash；优先研究 per-message TemplateResult WeakMap memo，或隔离 streaming one-shot cache，不能盲目加内存上限。
5. `oc-chat-history.ts:228-229` `mergeToolResultHistory` 两次调用是否必要尚未取证，先跑 merge 测试和调用语义审查。
6. `splitMarkdownSafePrefix` 每个增长帧扫 fence；只有 benchmark 证明需要时才做增量扫描，并保持 unclosed-fence 规则。
7. `app-chat-props.ts:127-132` 斜杠输入在命令缓存命中时仍 `loadCommands(...).then(requestUpdate)`；可用 `getCachedCommands()` 快速返回。不是每次按键 RPC。
8. `app-scroll.ts` 连续 cancel/re-arm rAF/timeout 的调度 churn 可测量后优化，不能与第 2 项混为一谈。

### 7.3 连接观察项，不要轻率修改

- `gateway.ts:548-558` 无 connect.challenge 时最多 750ms fallback；先确认当前 kernel 是否总发 challenge。
- `agent.identity.get` admission gate 是有意设计；测量“启动→首发→首回复”时包含该阶段，不要为了速度删除准入门。
- `setLastActiveSessionKey` 相同值早退，无需优化。

### 7.4 推荐消息链路基準

使用独立 Chromium/Electron + fake GatewayBrowserClient/file bridge，禁真实网络/provider/profile：

- 发送：1/4/8 文件，每个 fake read 80ms；记录 send start→echo→fake chat.send，断言附件顺序和 fallback。
- 接收：200 历史 + 20k/100k 文本，固定 120B deltas/60Hz；记录 input-to-paint、frame p95、long task、JS/layout/style、scroll metric reads。
- 滚动：at-bottom 与上方 2000px 两组。
- 纯函数：duplicate guard、stableHtml linkify、nonmatching narration、safe-prefix，报告原始样本 median/p95 和 heap，不只报百分比。
- A/B 用临时 worktree 或 bench flag，不能通过 revert 当前 dirty tree 获得“旧版”。

---

## 8. 深度 UI/代码审查汇总与已排除候选项

审查约完成 70% 时暂停，当时暂无 P1。以下需继续核实。

### 8.1 已在交接前通过源码排除的候选

- `settings-view.ts` 的 `resetProviderTab` import **存在**于 `:24`，不是缺失 import。
- `provider-segment.ts:16` `createRenderRoot(){return this;}` 是 light DOM，且样式通过 `document.adoptedStyleSheets` 注册；不是审查报告猜测的 Shadow DOM 样式无法穿透。仍建议补 Setup Step2/Search 的真实视觉 smoke，但不能按错误根因修改。

### 8.2 已确认需要优先处理的候选

- `tab-provider.ts:906` 和 `:1154` 当前有 `if (isCurrent()) throw error`；按钮调用 `:2255`、`:2384` 没有 `.catch`，与 `handleKeySave` 调用点不一致。可能产生 unhandled rejection。应统一错误呈现并补 VM/render 测试。

### 8.3 待验证候选

1. `command-history.ts:18` 用过滤后的 toolcall index 对齐 `extractToolCards` 卡片 index；无配对 call 的 toolresult 也可能产卡，repeat key 可能错位。只影响 key/去重的可能性需测试证明。
2. `tool-cards.ts` wrap 用命令式 class toggle，pending→完成导致 section 数量变化时状态可能丢失；wrap 图标语义也可审查。
3. `model-picker.css` 移除 thin 是用户“去除滚动条样式”需求的一部分；不要因默认滚动条出现而盲目恢复 thin，需确认视觉规范和滚动能力。
4. `compose.css` 同时有 `scrollbar-width:none` 和 WebKit 伪元素；在 Chromium 后者可能冗余，但保留跨引擎 fallback 不一定是死代码，清理前确认目标浏览器。
5. provider workbench CSS 的响应式、暗色、a11y、container queries 尚未完成最终人工审查。
6. stop gate 与 `computeStopButtonVisible`、command jobs a11y、Ctrl+S/F 文档与实际 workspace binding 尚待核对。
7. 主进程 `kernel-updater.ts` / `provider-config.ts` 的最终 diff 审查和死代码扫描尚未收尾。
8. `.chat-compose__field` 旧 transform transition 被移除，但 field 本体无 transform，目前判为无回归。

---

## 9. 发布准备与阻断

### 9.1 当前发布阻断

- 第 5 节类型不一致。
- 当前树没有完整 build/test/typecheck。
- 最新窄屏 header 等改动未重跑模型 UI 矩阵。
- 冷启动和消息链路多数仅为报告，未实施/未测收益。
- 深度 UI 审查未完成。
- 尚无新 installer、真实安装/更新/启动/全页面 UI 验收。
- 最后 `git ls-remote origin` 报 `Connection was reset`；发布前需重试并确认网络。

### 9.2 稳定后必须执行的发布顺序

1. 冻结生产代码，跑完整 build/test/typecheck、`git diff --check` 和隔离 UI 矩阵。
2. 更新 `package.json` version 与 `release-notes.json` 顶部 zh/en 条目，预计 `2026.1031.0`。
3. 更新 README、`docs/OPTIMIZATION-PROGRESS.md` 和新的发布验收文档；所有数字只写本轮实测。
4. 确保所有新源码/脚本被提交；否则 fresh clone 的 `build:chat` 会因缺少 `scripts/build-chat.js` 等文件失败。
5. Windows 打包：

   ```bash
   npm run dist:win
   ```

6. 必须生成同批三件套：
   - `CryoClaw-Setup-<version>-<arch>.exe`
   - 对应 `.exe.blockmap`
   - `latest.yml`

7. 真实静默安装（会覆盖已安装应用，只有恢复发布任务后执行）：

   ```bash
   node scripts/silent-install.js <installer> <version>
   ```

8. 启动安装版，确认 `http://127.0.0.1:18789` 健康为 200，再执行：

   ```bash
   node scripts/release-ui-smoke.js --exe <installed-CryoClaw.exe> --full
   ```

   修改首装路径时另跑 `setup-ui-smoke.js`；真实消息只有显式 `--live` 才运行。

9. 按发布流程提交并 fast-forward/push `main`，不要只 push 当前工作分支。
10. 用 gh CLI 创建 draft Release，上传 exe/blockmap/latest.yml；核对后转 latest。
11. 执行资产硬门禁：

   ```bash
   npm run release:assert
   # 或本地/远端联合核对
   node scripts/release-assert.js --allow-draft --local-dir out/win32-x64
   ```

12. 复核 `draft=false`、三件套、latest.yml version/size/sha512、公开更新发现和 latest 指向。网络失败不能跳过或写成成功。

发布凭据只从本地 `.env.build`/环境读取，绝不入库或写入文档。

---

## 10. 建议接续执行顺序

1. **确认用户已明确恢复任务**，再恢复 goal/task；不要因子智能体旧报告自动继续。
2. `git status --short --branch`、读当前 diff，核对本文之后的任何变化。
3. 完成或回退第 5 节两处插件前置改动，先恢复可类型检查的工作树。
4. 跑主进程/UI typecheck 与相关定向测试；处理已确认的 add-save unhandled rejection。
5. 重跑完整 build/test/typecheck，建立“可继续优化的稳定基点”。
6. 重跑当前模型/通用/看板 UI 矩阵，完成深度 UI 审查剩余项。
7. 冷启动按实测优先级：插件冷列表/启动 inventory → Hello 突发 → migrations → settings 分包；每项独立 A/B 和回归。
8. 消息链路先小范围：附件并发、滚动 fast path、旧 round retry、duplicate guard；再做纯函数 memo；结构性 compose/history 优化必须 benchmark-gated。
9. 更新性能/发布文档，明确 fixture、真实页面和真实启动的口径。
10. 全部稳定后再 bump、打包、真实安装/更新/启动/UI 验收，最后提交、push、Release 和资产断言。

---

## 11. 证据索引

### 本轮新增/更新文档

- `docs/archive/UI-PERFORMANCE-2026.1031-VERIFICATION.md`
- `docs/archive/PROVIDER-WORKBENCH-VERIFICATION.md`
- `docs/archive/TASK2-FRONTEND-PERFORMANCE.md`
- `docs/archive/TASK4-TOOLS-VERIFICATION.md`
- `scripts/INSTALLER-PERF-NOTES.md`
- `documents/designs/reference-refinement.md`
- `documents/designs/provider-workbench.md`
- `.learnings/ERRORS.md`

### 主要报告/截图

- `out/ui-qa/reference-final/report.json`
- `out/ui-qa/dashboard-final/report.json`
- `out/ui-qa/provider-icons-final/run-TYUnQp/report.json`
- `out/ui-qa/provider-icons-final/run-TYUnQp/catalog-1440-light.png`
- `out/ui-qa/provider-icons-final/run-TYUnQp/add-1440-dark-preset.png`
- `out/ui-qa/provider-icons-final/run-TYUnQp/detail-600-light-long-id.png`
- `out/ui-qa/page-perf-baseline-2026.1030.0`
- `.cache/test-results/report.json`（旧完整门禁，需重跑）

注意：`out/`、`.cache/` 被 gitignore；它们可作为本机证据，但不会被提交。发布说明不能只依赖这些临时路径，应把最终结论写入 tracked 验收文档。

---

## 12. 任务/子智能体状态

- task-1～task-7：已完成其历史范围。
- task-8（所有页面冷启动）、task-9（消息链路）、task-10（发布准备）：任务板仍为 `in_progress`，owner=lead，但总 goal 已暂停；**不代表仍有执行中的 worker**。
- durable teammates：`startup-perf`、`frontend-perf`、`installer-perf` 均 inactive；`tool-ui` 创建失败（当时达到 3 个子智能体上限）。
- 默认子智能体路由曾因额度/模型失效无产出；后续只读调查使用显式 `qodercn/qmodel_38max`。如恢复并需委派，先检查可用路由，不要假设旧 worker 还在。
- 所有只读报告的结论已合并到本文；不需要重新唤醒旧子智能体来“收尾汇报”。

---

## 13. 不可回归清单

- latest-wins delta、seq 去重/gap、terminal tombstone、stale-short/equal-length merge。
- abort ACK 不等于 terminal；只有匹配的 persisted terminal reply 清理对应状态。
- terminal 同步 flush 和 synthetic `cryoclawPartial` 不重复/不丢失。
- 慢/失败 history refresh 不得取消渐进 hydration；只有真正 snapshot replacement 才取消。
- 不在附件读取后的 session-change guard 前写乐观 echo。
- 不将独立 RPC 错误合并，不用旧 session/client/run 响应覆盖新状态。
- 不削弱 iframe sandbox、未知来源拒绝、原生嵌套滚动。
- 不破坏 Kimi sidecar、proxy sentinel、配置 optimistic hash、备份/原子写/并发修改保护。
- 不伪造“已撤销已发 patch”、后台进程状态、供应商重命名、密钥保存或真实性能收益。
- 不跳过签名、SHA-512、blockmap、journal、备份、回滚和 release 资产断言。

---

## 14. 完成定义

只有同时满足以下条件，才能向用户宣称全部完成：

- [ ] 当前工作树类型一致，无未闭环临时改动。
- [ ] 所有确认的 P1/P2 已修复或有明确不接受理由。
- [ ] 全页面和消息链路优化有当前代码的真实前后测量，夹具指标口径清楚。
- [ ] 深度 UI/代码审查完成，窄屏/宽屏、明暗、键盘、滚动和长内容通过。
- [ ] 最新代码完整 build/test/typecheck 全绿，跳过项有解释。
- [ ] 最新隔离 Electron UI/消息/看板/模型矩阵通过。
- [ ] 新安装包三件套齐全，真实安装、更新、启动、全页面 UI 和必要的真实消息验收通过。
- [ ] 版本、双语 release notes、README、优化和发布验收文档同步。
- [ ] 所有新源码/脚本提交并 push 到正确 main，GitHub Release 资产及公开更新发现核验通过。
- [ ] 最终复查无遗漏项，且未把历史结果冒充本次结果。

---

## 15. 2026-10-31 接续执行记录

用户在本轮中途叫停了"继续铺开"，要求收尾。以下只记录**已完成并有证据**的部分；未做的一律留空，不写成已完成。

### 15.1 本轮净改动：三处

| # | 改动 | 依据 |
|---|---|---|
| 1 | 回退 §5 两处插件清单前置改动 | §5.3 实测否定方案 B；类型恢复一致 |
| 2 | `tab-provider.ts` 添加保存按钮的 unhandled rejection | 本文 §8.2 已确认候选 |
| 3 | `chat.ts` 附件并发读取 + 旧轮次 stale retry 泄漏 | 本文 §7.1 第 1、3 项 |

第 2 项：`handleAddSave` / `handleAddToGroupSave` 在当前 token 失败时会 rethrow（旧 token 的错误才该被吞），而 `:2255`、`:2384` 两个按钮调用点没有 `.catch`，点击后按钮弹回、零提示。新增 `submitAddSave` 统一入口走 `tWithDetail("settings.error.saveFailed", …)`，与 `handleKeySave` 两个调用点既有做法一致。

第 3 项细节：

- 附件读取：`readFileBase64` 之间无依赖，原 for 循环逐个 `await` 让等待相加。改为并发启动、按原附件顺序消费；帧预算（23MiB 共享）仍按消费顺序结算，`sessionChangedDuringRead` guard 与 echo 位置不变。实测（4 文件 × 80ms fake read）**340.8ms → 87.1ms**；8 文件 **674.2ms → 83.1ms**。这是夹具口径的客户端等待，不是端到端发送时延。
- stale retry：`noteStaleRetryNewRound` 换轮次时只重置档位、不取消挂起的 `staleRetryTimer`，且回调无轮次校验。旧 deadline 会为新 run 多打一次 `chat.history` 并提前吃掉新轮档位预算。修复为换轮即取消定时器 + 回调捕获并校验轮次。

三处改动均配**红测**：临时回退修复后新测试精确失败（分别报"旧轮次的 deadline 不得在新 run 里发出 chat.history"、"快速路径不得再调度 rAF"级断言），恢复后全绿。

### 15.2 已回退：滚动快速路径

§7.1 第 2 项（向上阅读时绕过 updateComplete/rAF/layout）曾实现，但**无法测出真实收益**：隔离 Electron 探针未能有效建立测量（CDP target 反复落到 error.html 重试页）。按项目规则"没有实测支撑的收益不能写"，该改动连同其测试已完整 `git checkout` 撤销，`app-scroll.ts` 恢复原状。此项仍为未实施候选。

### 15.3 门禁结果（本轮实测）

```
npx tsc -p tsconfig.json --noEmit          PASS
npm --prefix chat-ui/ui run typecheck      PASS
npm test                                   PASS（四层）
git diff --check                           PASS
```

四层明细：vitest 330 passed、node:test 411（407 pass + 4 skip）、chat 1485 passed、scripts 449（447 pass + 2 skip）。合计 **2669 passed / 6 skipped / 0 failed（总计 2675）**。本节曾把 skipped 也计入 passed，本次按分层明细修正。

### 15.4 仍未做（不要误读为已完成）

- §8.3 深度审查 7 项待验证候选：本轮派出的只读审查 teammate 被中途停止且无产出，**全部仍待核实**。
- §7.1 第 2、4、5、6、7、8 项，§7.2 全部渲染/分配热点：未实施。
- §6.2 冷启动其余候选（Hello 突发、spawn 前迁移、settings 分包等）：未实施。
- 隔离 UI 矩阵（reference / dashboard / provider-workbench）未在最终树上重跑。
- 未 bump 版本、未打包、未真实安装/更新/启动验收、未提交、未 push、未建 Release。
  - **注意：`docs/archive/HANDOFF-2026.1031.md` 本身仍为 untracked，未被任何提交包含。**

---

## 16. 2026-10-31 第二次接续：审查、稳定化与消息链路小批次

### 16.1 Hindsight 已恢复并持久化

- 既有本机 daemon 已恢复，`/health` 正常；MCP 状态、知识页列表和搜索均可调用，最终 `hindsight_sync_status` 为 **`synced=true`、`activeOps=0`**。
- 已创建当前用户的 `HindsightDaemon` 登录任务，手动触发返回 `LastTaskResult=0`，新 Node 进程状态查询成功。所有已接线 agent 继续共用 `127.0.0.1:9077`。
- 内置每日自动更新已关闭（`autoUpdate=false`）；`HindsightCodingAgentsWeeklyUpdate` 每周一 04:17 执行官方 runtime update，手动验收返回 0。未改 memory bank 或凭据。

### 16.2 本轮净改动与审查结论

1. **附件读取改为最多 4 个在途 worker**：原实现是无上限全量并发，与“有界并发”目标不符。保留原附件顺序、23MiB 帧预算、失败降级、session guard 和 echo 位置；无文件附件时不新增 `Promise.all([])` 微任务。6 文件红测先证明第 5 个读取越界，修后通过；Chat 全量测试覆盖停止与 ACK 时序。§15 的 4/8 文件旧耗时不再当作当前有界实现的收益，需另行重测。
2. **provider 可读性与测试健壮性**：只整理新增目录/详情模板，未改交互。密码输入 VM 测试改为容忍模板空白，避免换行格式化造成假失败。`docs/feature-evaluation.md` 是用户主动删除并已自行恢复的文件，本轮未修改。
3. **watchdog 与 pre-align 同 tick 双发**：同一次 tick 只计算一次 stall 状态；stall 已成立时由 watchdog 独占 silent history。行为红测从 2 次拉取降为 1 次，gateway 定向 27/27 通过。
4. **重复流气泡判重复用缓存**：历史消息使用 `extractTextCached` + `WeakMap` 归一化缓存，保留不可变消息、严格全等和严格前缀不抑制语义。合成夹具（100,007 code units、2,000 次/轮、5 轮）中位值 **53.3044ms → 19.0474ms**；这不是 Electron 帧率或端到端时延。
5. **reference smoke 环境修复**：连续失败定位为隔离页 `visibilityState=hidden` 导致双 rAF 永不完成，不是生产 renderer 异常。fixture 禁用后台节流、脚本显式 `Page.bringToFront`，保留全部原断言；临时诊断日志已删除。
6. §8.3 的快捷键说明与工作区实际 Ctrl+S/F 绑定一致，停止按钮门控未改，命令记录 call 索引与工具卡顺序一致。发送时展开全部历史目前是显示最新 echo 的必要行为；在现有末尾 N 条渲染模型下不做简单删除。§7.1 第 5、6、8 项和结构性渲染优化未实施。

### 16.3 当前工作树实测门禁

```
npm run build                 PASS
npm test                      PASS（四层）
npm run test:typecheck        PASS
git diff --check              PASS
```

四层明细：vitest **330 passed**、node:test **407 passed / 4 skipped**、chat **1486 passed**、scripts **447 passed / 2 skipped**。合计 **2670 passed / 6 skipped / 0 failed（总计 2676）**。

隔离 Electron：

- `reference-ui-smoke.js`：PASS；4 组宽窄屏/明暗、停止、快捷键、命令记录、工具卡与高亮更新，零 renderer exception。
- `dashboard-perf-cdp-smoke.js`：PASS；24 iframe、来源拒绝、嵌套滚动、滚动期零 style read / iframe 全扫描。
- `provider-workbench-cdp-smoke.js`：PASS；30 个场景及交互，含最新窄屏 header、17 预设图标、自定义首字母、无水平溢出和秘密遮蔽。

### 16.4 仍未完成

- §6.2 冷启动其余候选尚未实施或形成当前代码的 A/B 证据；不得重启已被 §5.3 否定的 metadata 替代 CLI 路线。
- §7.1 第 2、5、6、8 项及 §7.2 渲染/分配热点仍未实施；本轮只做有测试或小基准支撑的小批次。
- 未 bump 版本、未打包、未真实安装/更新/启动验收、未提交、未 push、未建 Release。当前完整门禁不等于发布验收。

---

## 17. 最终验收与发布状态

- 已按后续要求完成插件持久缓存、供应商图标重绘、全站方向动效、消息与全页面优化、测试发布提速和 docs 归档。最终版本为 **2026.1031.0**。
- 插件 inventory 首次 1567.7ms、后续 2.5/1.8ms；插件列表首次 3697.9ms、模块重载 2.0ms，74 插件结果一致。
- 三次启动对照：完整可用中位 71.57→56.73 秒，综合前后端中位下降 19.3%。最终安装版复核：窗口 1.018s、readyz 49.439s、完整可用 56.985s、退出 3.656s。
- 36 页完成测量，外部插件市场仍为网络错误，不计为提速；消息离线基准无 long task、无文本丢失。
- 最终四层测试 **2677 passed / 6 skipped / 0 failed**；完整构建、typecheck、diff check 通过。最终安装版完整 UI **92 场景 / 11 截图**通过。
- 当前状态：**本地验收完成，发布中**。公开 Release、latest 指向、更新发现和资产断言结果见 `docs/RELEASE-2026.1031.0-VERIFICATION.md`。
