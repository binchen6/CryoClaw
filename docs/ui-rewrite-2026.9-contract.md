# UI 重写契约（2026.9 提案 A 落地）— 子任务执行约束

本文是 2026.9 UI 大规模重写的**强制契约**。所有视图/样式重写必须遵守；违反红线 = 返工。

## 新布局模型（提案 A）

```
┌────────┬──────────────┬──────────────────────────────────┐
│        │              │  .cryoclaw-titlebar (44px, drag)   │
│ cc-rail│cc-session-   │  = 上下文栏：面板开关+视图标题/    │
│ (60px) │panel(264px,  │    会话标题 (+各视图自有操作留     │
│ 常驻)  │可折叠/可拖宽)│    在内容区)                       │
│        │              ├──────────────────────────────────┤
│ 图标轨 │  仅 chat 视图│  .cryoclaw-content (唯一滚动区,  │
│        │  显示        │  各视图内部再分栏)                 │
└────────┴──────────────┴──────────────────────────────────┘
```

- **cc-rail 图标轨**：所有视图（除 setup 全屏向导）常驻。上→下：品牌标（拖拽区）→ chat / tasks(运行徽标) / workspace / extensions → 弹性间隔 → webbridge 修复(条件) → 完整版网页/重连(带错误徽标) → settings(带角标)。
- **cc-session-panel**：仅 chat 视图显示；`navCollapsed` 设置项现语义=「会话面板折叠」。折叠/展开按钮在上下文栏左侧。右缘拖拽调宽 220-420px 持久化（`sidebarWidth` 设置项语义不变，CSS 变量改为 `--panel-width`）。
- **setup** 仍是唯一 fullpage 视图（无 rail、无上下文栏）。registry meta 的 `fullpage` 仅 setup=true，`titlebarBack` 已删除（rail 提供全局导航，不再有「返回对话」浮动按钮）。
- 各视图**不再有顶部 44px 让位**：标题栏让位由壳层统一承担（`.cryoclaw-main` 内 `.cryoclaw-titlebar` 占位 44px），视图内容从标题栏下缘开始。旧 `padding-top: var(--titlebar-h)` 之类的视图级让位一律删除。

## DOM/类名契约（壳层，已锁定，勿改）

- 根：`.cryoclaw-shell`（修饰：`is-mac`/`is-win`/`cryoclaw-shell--focus`(onboarding)/`cryoclaw-shell--panel-collapsed`/`cryoclaw-shell--fullpage`(仅 setup)）
- `<cc-rail>`：`.cc-rail`、`.cc-rail__brand`、`.cc-rail__item`(+`.active`)、`.cc-rail__badge`、`.cc-rail__dot`、`.cc-rail__spacer`、`.cc-rail__error-popup`
- `<cc-session-panel>`：`.cc-panel`、`.cc-panel__header`、`.cc-panel__title`、`.cc-panel__actions`、`.cc-panel__search-input`、`.cc-panel__list`、`.cc-panel__group-label`、`.cc-panel__session-item`(+`.active`/`.menu-open`/`.is-archived`)、`.cc-panel__session-name`、`.cc-panel__session-edit`、`.cc-panel__session-menu*`、`.cc-panel__more-*`、`.cc-panel__empty`、`.cc-panel__unread-dot`、`.cc-panel__session-pin`、`.cc-panel__session-worktree`
- 调宽手柄：`.cryoclaw-panel-resize`
- 主列：`.cryoclaw-main` > `.cryoclaw-titlebar`（上下文栏：`.cc-contextbar`、`.cc-contextbar__toggle`、`.cc-contextbar__title`、`.cc-contextbar__subtitle`）+ `.cryoclaw-content`
- 全局浮层保持原名：`global-toast`、各 modal 组件。

## 红线（硬性）

1. `--titlebar-h: 44px` 不变；标题栏区域 `-webkit-app-region: drag`，其内每个可交互元素必须 `no-drag`（drag/no-drag 配对）。
2. z-index 三层契约：视图内菜单/气泡 **≤60**；标题栏/上下文栏 **100**；modal/toast/确认框 **≥1000**。禁止出现其他值。
3. 主题双通道：`:root[data-theme=dark]` + `@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) }` 都必须覆盖（design-tokens.css 内集中定义；视图 CSS **禁止**再写 `@media (prefers-color-scheme)` 或 `[data-theme=]` 块——用 token）。
4. 组件无 Shadow DOM（`createRenderRoot() { return this; }`），样式全走全局 CSS。
5. 颜色/间距/圆角/字号/阴影一律用 token（`--bg/--text/--border/--accent/--spacer-*/--radius-*/--text-*/--shadow-*`），禁止硬编码色值（rgba 语义色除外，但必须引用 token 变量组合）。图标用 `icons.ts` 现有图标，缺图标先报告，不要引入新依赖。
6. 不新增 npm 依赖；不改 `controllers/`、`gateway.ts`、`storage.ts`、`i18n` 机制、主进程 IPC。
7. 文案走 `t("...")`；优先复用现有 key。确需新 key：代码里照常用 `t("新key")`，**不要编辑 i18n/zh.ts、i18n/en.ts**（并行防冲突），把新 key 清单（key + 中文 + 英文）写进最终报告。
8. 行为测试必须保持绿。改了 DOM 结构导致结构断言失败的测试可同步更新，但**行为断言（回调、状态、数据）不得削弱**。`layout-qa.test.ts`/`layout-fix.test.ts`/`sidebar-resize.test.ts`/`cc-sidebar.test.ts` 由主代理统一重建，子代理不要碰这 4 个文件。
9. 每个视图 CSS 只操作自己域的分区文件，不碰 `styles.css` hub、不碰 `design-tokens.css`/`tokens-ext.css`/`base.css`/`shell.css`/`session-panel.css`（主代理负责）。

## 视觉规范（浅色一等公民，Linear/Notion 式）

- 浅色：纸白底（`--bg: #ffffff`）、次级 `#fafafa`、hairline 细分隔线（`--hairline`）、中性灰文字阶梯、**单一品牌强调色 indigo**（`--accent`）；留白加大（区块间距 ≥ `--spacer-24`）。
- 暗色：近黑中性底（`#101012` 系）、独立调参（勿从浅色反推）、accent 亮一档。
- 圆角收敛：按钮/输入 8px，卡片 12px，浮层 12px；阴影克制（`--shadow-sm/md` 为主，浮层 `--shadow-lg`）。
- 动效：hover/press 用 `--duration-fast`，面板开合 `--duration-normal`，全部走 `--ease-out`；尊重 `prefers-reduced-motion`（base.css 已全局处理）。
- 排版：视图标题 `--heading-md`/20px semibold；正文 `--text-base`；辅助 `--text-sm`/`--text-xs` + `--text-muted`。

## 测试与验收

- 完成标准：`cd chat-ui/ui && npx vitest run`（全绿）+ `npx tsc -p ../tsconfig.test.json --noEmit`（typecheck 绿，在 chat-ui 目录按仓库脚本）。
- 每个子任务结束前必须跑上述两条，报告结果。
