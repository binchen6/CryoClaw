# 消息流式体验优化 + 侧边栏重组与模块整合 — 设计文档

> 创建：2026-08-28。状态：已与用户对齐（分两期推进）。
> 参考基准：openclaw 官方 control-ui（已从 gateway.asar 提取取证，见 `.cache/control-ui-extract/`）。
> 所有 UI 改动遵循：TraeWork + 冰蓝 token（`shared/design-tokens.css`，含 R38 新 token 体系）、禁止硬编码 hex、浅色默认 + 暗色 `[data-theme=dark]`、`prefers-reduced-motion` 尊重、≤768px 窄窗适配、按钮右对齐。
> 硬约束：内核零改动；不动主进程行为（除非另有说明，本设计两期均为纯 chat-ui 改动）；测试基线 0 fail。

## 背景与目标

用户指令：优化消息刷新、流式渲染及恢复、消息有回复及时刷新的逻辑与流畅性；参考 openclaw gateway 网页端（control-ui）做法；主页侧边栏保持会话列表较大面积，放不下的入口折叠进「更多」；Worktrees + Git 面板 + 工作空间整合、任务 + 定时任务整合、技能 + 插件整合；化繁为简、保证便利性与流畅性。

**取证结论（官方 control-ui，Lit 技术栈同源）**：
- 会话列表刷新纯事件驱动：`sessions.changed`/`session.message` 先本地 patch 行，必要时才全量重拉；未读用服务端 `unread` 字段。
- 历史加载：in-flight 去重（WeakMap 按 `method\0session\0agent`）+ 请求版本号双重校验丢弃过期响应 + 按消息 id 增量合并保留本地乐观消息。
- 流式：Lit state 驱动；工具事件 80ms `setTimeout` 节流合并、上限 50 条；滚动 `updateComplete` + rAF 合并。
- markdown 流式/终态渲染用「安全前缀」切分：闭合围栏/空行之前的稳定段完整渲染，未闭合尾部转义纯文本渲染 + 结果缓存。
- 侧边栏：导航区 `max-height:60%`、会话列表弹性占主体；低频入口收「更多」折叠区。

**现状短板（代理摸排确凿，行号为 2026-08-28 快照）**：
1. 每轮终态 `chatVisibleMessageCount` 重置为 20 再逐批注水 → 视图缩回闪烁 + 滚动位移（`controllers/chat.ts` L235-243）。
2. 流式期间 `buildChatItems` memo 键含 `stream` 每帧 miss 全量重建；`computeSessionFileChanges` 每帧全组扫描（`views/chat.ts` L1650-1699）；单一 `OpenClawApp` 全树重求值。
3. 滞后补拉预算 `staleRetryAttempt` 是全局的，跨会话抢占不复位、耗尽后静默放弃（`controllers/chat.ts` L162-186）。
4. 重连后 800/1600/2400ms 退避窗口耗尽即无后续刷新通道；`hasAssistantReplyAfter` 只看最后一条 assistant、缺 timestamp 恒假（`stream-recovery.ts` L86-97）。
5. 后台会话（`sessionKey ≠ 当前`）的终态事件直接丢弃，不触发侧边栏刷新（`controllers/chat.ts` L494-496）；`lastActiveSessionKey` 被后台事件覆写（`app-gateway.ts` L456-463）。

## 执行策略

分两期，各自独立实施、验证、发版：
- **第一期（R41 候选）**：消息流式体验优化（渲染架构拆分 + 5 处缺口修复 + 及时刷新对齐官方）。
- **第二期（R42 候选）**：侧边栏重组（图标轨 + 「更多」）+ 三组模块整合视图。

两期均可启用 R38 新 token（display 阶梯、玻璃、阴影、高光、`--ease-standard`、`--hairline`）。

---

## 第一期：消息刷新 / 流式渲染 / 恢复 / 及时刷新

### 1.1 渲染架构拆分（渲染层组件化，状态归属不动）

方案取舍已定：全量状态重构风险过高；采用**渲染层组件化**——状态仍留在 `OpenClawApp`（`app-*.ts` 模块契约不变），render 树拆为独立 `LitElement` 子组件，各组件只接收自己需要的 props：

| 新组件 | 职责 | 更新频率 |
|---|---|---|
| `<cc-chat-stream>` | 当前流式气泡（纯文本流 + 工具流卡片） | 高频（每个 flush 帧） |
| `<cc-chat-history>` | 已落盘消息列表（memo 化） | 低频（历史/可见数变化） |
| `<cc-sidebar>` | 会话列表 + 图标轨（第二期的新侧边栏直接落在此组件） | 低频（会话数据变化） |

约束：
- 组件间只走 props + 事件回调，不共享可变引用；`requestUpdate` 粒度随组件隔离自然收敛。
- 既有全局行为（滚动跟随、键盘快捷键、菜单外部关闭）迁移时保持语义不变；`document` 级监听随组件 `disconnectedCallback` 清理。
- 拆分后 `views/chat.ts` 成为装配层，历史/流式渲染细节分别下沉。

配套派生计算优化：
- `buildChatItems` memo 键去掉 `stream`：流式条目由 `<cc-chat-stream>` 单独追加，历史部分保持命中。
- `computeSessionFileChanges` memo 键改为 `messages + toolMessages` 数组引用。
- 工具事件 80ms 节流合并（对齐官方），`toolStreamById` 上限 50 条淘汰最旧。
- markdown「安全前缀」切分（新纯函数，进 `markdown.ts`）：稳定段（最后一个闭合围栏/空行之前）走完整 `marked + DOMPurify`，尾部转义纯文本；与既有 LRU 叠加。消除半截代码块反复解析抖动。

### 1.2 刷新与恢复缺口修复

1. **终态抖动**：同会话刷新（`mergeIfStale` 路径）保留现有 `chatVisibleMessageCount`，仅会话切换/`/new`/`/reset` 走 20 条渐进注水。
2. **补拉预算 per-session 化**：切换目标会话时 `staleRetryAttempt` 复位；预算计数挂在会话键上而非全局。
3. **重连盲区**：存在未收养 orphan 快照时，以重连时刻为锚点做有限次（≤3）历史探测（复用看门狗通道），退避窗口耗尽不再失联。
4. **看门狗时间戳缺口**：`hasAssistantReplyAfter` 遇缺 `timestamp` 的 assistant 条目继续向前扫描。
5. **后台会话及时刷新**：`sessionKey ≠ 当前` 的 `final`/`error`/`aborted` 事件补触发一次 `loadSessions`（走既有 in-flight 合并）；`setLastActiveSessionKey` 仅当 `payload.sessionKey === host.sessionKey` 时写入。

### 1.3 及时刷新对齐官方

- `sessions.changed` 到达先本地 patch 会话行（事件携带行数据就地合并进 `sessionOptions`），合并不适用（缺字段/非默认查询）才全量 `loadSessions`。
- 看门狗历史探测走 `silent` 选项（不置 `chatLoading`），消除每 30s 一次「加载中」闪烁。
- 30s ticker 保留为兜底，不删除。

### 1.4 第一期测试

- 新纯函数单测：安全前缀切分、工具流节流合并、预算复位逻辑、`hasAssistantReplyAfter` 扫描。
- 源码审计测试（同 `i18n.test.ts` 模式）钉住：终态保留可见数、后台终态触发 `loadSessions`、`lastActiveSessionKey` 守卫、orphan 重连探测接线。
- 既有 `chat.test.ts`/`stream-recovery` 用例按新语义更新；基线 0 fail 硬指标。

### 1.5 第一期不做

- 不消费协议 v4 `deltaText/replace` 增量字段（需内核下发取证，记候选）。
- 不做会话列表服务端分页/虚拟滚动（官方也未做）。

---

## 第二期：侧边栏重组 + 三组模块整合

### 2.1 侧边栏新结构（`<cc-sidebar>` 组件，会话列表最大化）

```
┌ brand 行（标题 + 折叠按钮）
├ 新会话按钮
├ 「更多」入口（下拉菜单：Worktree 新会话[仅 gitAvailable]）
├ 会话列表（flex:1 弹性主体，占纵向 ≥75%）
│   ├ 标题行：归档切换并入此处（保留现有归档按钮 + 搜索行）
│   └ 分组列表（置顶 + 时间分组不变）
└ 底部图标轨（单行紧凑图标，悬浮 tooltip 显示名称与详情）
    [任务(运行中徽标)] [工作区] [扩展] ───── [完整版网页] [设置(更新/微信徽标)]
```

- 主导航 6 项（任务/定时/技能/工作空间/Worktrees/Git）收敛为图标轨 5 图标。
- 原「Worktree 新会话」次级按钮移入「更多」菜单；断连时图标轨右侧「完整版网页」位置替换为重连入口（同现有断开连接语义）。
- 徽标：任务图标 = 运行中任务数（实时）；设置图标徽标不变；「启用中定时任务数」降为任务页定时 tab 内徽标。
- 图标轨样式走 `cc-*` 原语 + 新 token；悬浮详情用既有 `data-tooltip` 机制。

### 2.2 整合视图 ①：任务页（双 tab）

- 顶层双 tab：**运行记录 / 定时任务**；视图 id 收敛为 `tasks`。
- 删除 `cron` 视图 id：`registry.ts` 移除登记，`onOpenCron` 改为打开任务页并定位定时 tab；`INJECTABLE_VIEWS` 中 `cron` 移除；`app-gateway.ts` 硬编码 `"tasks"`/`"cron"` 视图 id 判断同步改；`app-view-switch.ts` hook 同步。
- 联动增强：任务卡 `runtime==="cron"` 显示来源定时任务名并可跳定时 tab；定时任务详情「最近运行」链到运行记录。
- 既有约束守住：侧边栏徽标不受页内过滤器影响（`tasks.list` 全量拉取语义不变）；`task` 事件增量合并、`loadTasks` 在途排队不变。

### 2.3 整合视图 ②：扩展页（双 tab：技能 / 插件）

- 新视图 `extensions`，顶层双 tab 技能 / 插件；技能内部保留「已安装 / 商店」子 tab（现有 `skillsSubTab` 模式）。
- **插件从设置页迁出**：`tab-plugins.ts` 状态迁为独立视图模块（新建 `app-extensions.ts` 承接所有权）；`app-view-switch.ts` leave hook 接管 `resetPluginsTab` 复位；`invalidateAllSettings` 对 `resetPluginsTab` 的引用同步迁移；设置页 `extensions` 分组删除（它是该组唯一 tab）。
- 双数据通道差异保留：技能已安装走网关 `skills.*`、技能商店与插件走主进程 IPC；插件启停 `config.patch`、市场安装确认流（冲突/验证级别提示）原样保留。
- 侧边栏新「扩展」入口指向该视图；`skillsActive` prop 更名/替换为 `extensionsActive`。

### 2.4 整合视图 ③：工作区页（IDE 式融合）

```
┌ 左导航列（固定宽，可折叠）
│  ├ 仓库选择（工作区根 + 活跃 worktrees，现有 buildGitRepoOptions 复用）
│  ├ 目录/文件树（面包屑 + 上下级导航，现有工作空间能力）
│  ├ 「Git 变更」固定节点（选中 → 右区切 Git 面板）
│  └ Worktrees 区块（列表 + 恢复/删除/打开目录/打开会话 + GC）
└ 右主区（按选中上下文切换）
   ├ 文件预览（现有白名单扩展名纯文本预览）
   └ Git 变更（三分组 + 内联 diff + 提交，现有全部能力）
```

- 选中 worktree 节点时仓库上下文自动切换并刷新 git 状态（补上现有缺失的 worktree→git 联动）。
- `workspaceSetRoot` 白名单注册收敛为一次；`resolveAgentWorkspacePath` 共享不变；`workspace.ts` 内嵌加载逻辑先抽到 `controllers/workspace.ts` 对齐另两者范式。
- 降级语义保留：无 git callout、断连 callout、提交身份引导。
- 删除 `worktrees`、`git` 两个视图 id（registry 反向操作）；其能力全部并入工作区页。

### 2.5 接线与清理（隐性同步点逐一处理）

| 点 | 动作 |
|---|---|
| `views/registry.ts` | 删 `cron`/`worktrees`/`git`，加 `extensions`；`INJECTABLE_VIEWS` 同步 |
| `storage.ts` 视图 union | 自动生效，核对持久化旧值兼容（旧 `cron`/`worktrees`/`git` 值回落到合理默认） |
| `app-render.ts` `renderActiveView` | switch 分支增删；侧边栏 props 精简（删 `cronActive`/`worktreesActive`/`gitPanelActive`/`skillsActive`，加 `extensionsActive`） |
| `app-view-switch.ts` | enter/leave hook 增删（插件状态复位迁入） |
| `app-gateway.ts` | 硬编码视图 id 字符串、连接预拉取（`loadWorktrees` 保持连接级——侧边栏分支徽标依赖） |
| `sidebar.ts` | 重写为 `<cc-sidebar>` 组件内容（第一期产物上叠加） |
| i18n | zh/en 键增删对齐，`i18n.test.ts` 审计守护 |
| 样式 | 新组件样式进 `styles/sidebar.css` 等既有分块；layer 顺序敏感区不动结构，仅追加 |

### 2.6 第二期测试

- 源码审计测试钉住：视图接线（同 `git-ui.test.ts`/`worktrees-ui.test.ts` 模式，含旧视图 id 不存在、`onOpenCron` 路由、插件复位接线）。
- 新纯函数单测：工作区树构建/选中路由、任务↔定时互跳参数。
- 验证：`npm run build` + typecheck + 全量测试 + CDP 截图冒烟（light/dark × 1280/800 宽 × 新侧边栏与三个整合视图）。

### 2.7 不做（YAGNI）

- 官方「用户自定义置顶路由」（右键配置菜单）——入口已收敛，无必要。
- 侧边栏宽度可调（官方 `navWidth` 持久化）——桌面壳场景固定宽度足够。
- 技能/插件统一数据层——双通道差异保留。

## 风险与回退

- **第一期最大风险**：渲染层组件化触及滚动跟随、草稿、审批弹层等全局交互。缓解：组件拆分按「先抽 `<cc-chat-stream>`（最独立）→ `<cc-chat-history>` → `<cc-sidebar>`」顺序，每步全量测试 + CDP 冒烟；任何一步回归即单独回退该组件。
- **第二期最大风险**：视图 id 删除影响持久化旧值与注入白名单。缓解：`storage` 读取处对已删视图值做回落映射，审计测试钉住。
- 两期均为纯 chat-ui 改动（主进程零改动），回退边界清晰。

## 验收标准

1. 流式期间侧边栏与历史列表不再每帧重求值（性能验证：长 run 帧率主观流畅 + 无每轮终态缩回闪烁）。
2. 断连重连、后台会话回复等场景刷新及时且正确（第 1.2 节 5 项修复均有测试钉住）。
3. 侧边栏会话列表占据纵向主体；5 图标轨 + 「更多」替代原 6 项主导航。
4. 三个整合视图能力无丢失（对照各自现有功能清单逐项验证）。
5. 全量测试 0 fail、typecheck 通过、重复率不回退（`npm run dupcheck`）。
