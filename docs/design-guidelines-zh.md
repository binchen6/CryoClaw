# CryoClaw 设计规范（2026.9 R2 品牌焕新版）

CryoClaw 的设计语言为 **CryoBlue 蓝色 `#1A6FD0` + 中性灰表面 + MiSans/Inter 排版**。
默认主题保留原蓝色，绿色作为辅助点缀；内置主题配有各自的深浅表面、文字和控件。
主题包可自定义界面强调色，主操作与控件随之切换。当前细则见 [VISUAL-SYSTEM.md](VISUAL-SYSTEM.md)，其说明优先于本文历史阶段数值。事实
来源是 `shared/design-tokens.css`、`chat-ui/ui/src/styles/tokens-ext.css`、
`chat-ui/ui/src/styles/primitives.css`、`chat-ui/ui/src/ui/icons.ts`（CryoIcons
自绘图标体系）与强制契约 `docs/archive/ui-rewrite-2026.9-contract.md`（已完成存档），
冲突时以代码与契约为准。

## 1. 总则

1. **一律走 design token，禁止硬编码 hex**（如 `color: #fff`）、禁止硬编码
   `border-radius` / 间距 / 字号 / 阴影数值、禁止 `transition: all`（必须列具体属性）。
   唯一例外：rgba 语义色允许，但必须引用 token 变量组合（如
   `color-mix(in srgb, var(--destructive) 18%, transparent)`）。
2. **主题差异全部由 token 承担**。视图 CSS **禁止**写 `[data-theme=]` 覆盖块、
   禁止写 `@media (prefers-color-scheme)` 块 —— 暗色定义只存在于
   `design-tokens.css` 与 `tokens-ext.css` 两处（双通道：`[data-theme=dark]` 主通道 +
   `prefers-color-scheme` 兜底）。当前全仓视图样式中已无此类块，新增即返工。
3. **组件优先复用 `.btn` / `cc-*` 原语**（见第 5 节），不要新造按钮/卡片/弹窗样式。
4. **不 `text-transform: uppercase`**：label 按原文显示，尊重品牌名大小写与 CJK 文本。
   例外：会话面板分组标签（`oc-panel__group-label`）沿用组件契约的
   uppercase + caps 字距样式。
5. **布尔设置一律 iOS 风格 Switch**（`<oc-toggle-switch>`，label 左、开关右），
   不用 radio / checkbox。
6. **默认操作按钮右对齐**：弹窗底部与设置页按钮行 `justify-content: flex-end`
   （`cc-dialog__foot` 已内置）；仅列表内联局部操作可例外。
7. **元信息一律等宽小字**：模型标签、工具名、token 用量、时间戳、路径、状态行使用
   `var(--font-meta)` + `var(--font-size-meta)`（11px），弱化色用
   `var(--text-muted)` / `var(--text-faint)`。信息层级靠灰阶 + 字重，不靠卡片堆砌。
8. **圆角收敛，去胶囊化**：按钮/输入/菜单项 radius-8，卡片/浮层/toast radius-12，
   对话框 radius-16；`--radius-pill` / `--radius-full` 只保留给徽章、tag、chip
   等小型指示元素，按钮不再是胶囊。
9. **组件无 Shadow DOM**（`createRenderRoot() { return this; }`），样式全走全局 CSS；
   不新增 npm 依赖；图标一律用 CryoIcons 自绘体系（`icons.ts`，规范见第 6 节），
   缺图标按该节规范自绘补充，不引入第三方图标库。

## 2. Token 体系

token 分两层：**基础层 `shared/design-tokens.css`**（全局唯一事实来源，独立页面也
@import 它）+ **Chat UI 扩展层 `chat-ui/ui/src/styles/tokens-ext.css`**（壳尺寸变量 +
兼容别名）。token 名称在 2026.9 重写中保持不变（下游零改名成本），值全面重调。

### 2.1 静态 token（主题无关，`design-tokens.css`）

- **radius 数值阶梯**：`--radius-2/4/6/8/10/12/16/20/24/32`；
  兼容别名 `--radius-xs/sm/md/lg/xl`（= 4/8/12/16/20）、`--radius-pill`（999px）。
- **spacer 数值阶梯**（4px 基网）：`--spacer-2/3/4/6/8/10/12/16/20/24/32/40/48/64`。
- **icon 尺寸**：`--icon-size-12/14/16/20/24`。
- **阅读列宽（R84 流式化）**：`--chat-column`（`min(92%, 1000px)`，消息流/compose
  的居中列）、`--ext-column`（`min(92%, 1200px)`，扩展视图内容列）、
  `--page-column`（`min(92%, 1080px)`，设置/任务等表单页内容列）——内容列铺满
  可用宽度约 92% 并随窗口伸缩，仅超宽窗口按可读性上限收束。
- **字体栈**：`--font-body`（Inter + SF Pro Text + PingFang SC 回退）、
  `--font-display`、`--mono`（JetBrains Mono 系）、`--font-meta` = `--mono`；
  `--font-size-meta: 11px`、`--font-size-body: 14px`。
- **字号阶梯**：正文 `--text-2xs/xs/sm/base/lg`（10/11/12.5/14/18），
  标题 `--heading-xs/sm/md/lg/xl/2xl/3xl`（13/15/18/20/24/28/32），
  display（空态 hero 等大标题）`--display-sm/md/lg`（26/32/40）。
- **字距**：`--tracking-display`（-0.03em）、`--tracking-tight`（-0.02em）、
  `--tracking-body`（-0.011em）、`--tracking-wide`（0.04em）、
  `--tracking-caps`（0.08em，徽章/分组标签）。
- **行高**：`--leading-tight/1.25`、`--leading-title/1.35`、`--leading-body/1.6`、
  `--leading-relaxed/1.75`（助手正文）。
- **字重**：`--weight-regular/medium/semibold/bold`（400/500/600/700）。
- **动效**：`--ease-out/--ease-in-out/--ease-standard/--ease-spring`，
  时长阶梯 `--duration-instant/fast/normal/slow/slower`（0.08/0.12/0.2/0.35/0.5s；
  instant=微反馈瞬时切换 / fast=hover·press / normal=面板开合·入场 /
  slow=卡片入场 / slower=大面积过渡），循环指示器（pulse/spin/shimmer 等
  无限循环动画）统一走 `--duration-loop`（1.2s）；stagger 入场延迟步长
  `--delay-step`（50ms，`.stagger-1..6` = 0~5 步 calc 计算式）。
- **玻璃模糊量**：`--glass-blur-sm/md`（8/16px，配 `--glass-*` 底色做 backdrop-filter）。

### 2.2 色板

- **brand CryoBlue 自绘色阶**（蓝 × 青混色，非现成库色阶）：
  `--brand-50 … --brand-950`（`#eef6fd` … `#0f2a4e`），
  浅色主色 **`--brand-600: #1a6fd0`**（白底对比度 ≈4.95:1，过 AA），
  基准色 `--brand-500: #2a89dd`。
- **中性灰阶**（零色相，Notion 式纸感）：`--grey-50 … --grey-950`
  （`#fafafa` … `#0a0a0a`）。
- 语义色：`--ok`（`#16a34a`）、`--destructive`（`#dc2626`）、`--warn`（`#d97706`）、
  `--info`（= brand），各配 `-muted` / `-subtle` 变体；暗色下语义色各自提亮
  （`#4ade80` / `#f87171` / `#fbbf24`）。
- **辅助强调色 cyan**：`--accent-2`（tokens-ext 定义，浅色 `#0891b2`、
  暗色 `#22d3ee`，配 `-muted`/`-subtle`），仅用于 worktree 徽标等第二强调场景，
  不得取代主 accent。

### 2.3 主题变量（浅色默认 / 暗色独立调参）

浅色与暗色是**两个一等公民主题**：文字对比度、阴影深度、玻璃参数各自独立定义，
暗色不是浅色的反推。

- 背景：`--bg`、`--bg-secondary`、`--bg-elevated`、`--bg-hover`、`--bg-input`、
  `--bg-muted`。浅色 = 纸白层级（`#ffffff` / `#fafafa`）；暗色 = 近黑中性四档深度
  （`#101012` / `#17171a` / `#1e1e22` / `#26262b`）。
- 文字：`--text`、`--text-strong`、`--text-secondary`、`--text-muted`、
  `--text-faint`、`--text-on-accent`（五级中性灰阶）。
- 边框：`--border`、`--border-strong`、`--border-hover`、`--border-focus`；
  hairline 快捷 token `--hairline` / `--hairline-strong`（1px solid 边框色）——
  分隔一律优先 hairline，不用生硬粗线。
- 强调：`--accent`（浅色 = brand-600 `#1a6fd0`，暗色亮一档 = brand-400 `#4ba4e6`）、
  `--accent-hover`（brand-700 / brand-300）、`--accent-subtle`、`--accent-glow`
  （暗色 glow 更强，补暗场氛围）。
- 遮罩/玻璃：`--overlay(-heavy)`、`--glass-xs/sm/md/lg`、`--glass-border`
  （浅色 = 深色压层，暗色 = 白色提亮层，两套参数独立）。
- 卡片顶部高光：`--highlight-inset`（浅色亮边 / 暗色微弱白边）。
- 阴影：`--shadow-xs/sm/md/lg/xl`（浅色低透明多层，收敛克制；暗色 alpha 更深更实）。
  用量约定：卡片 `--shadow-xs/sm`，浮层/菜单 `--shadow-lg`，对话框 `--shadow-xl`。
- 暗色定义两处、变量集完全一致：`:root[data-theme=dark]`（Chat UI 主通道）与
  `@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) }`
  （Settings/Setup iframe 等独立页面兜底）。两处都设 `color-scheme`。

### 2.4 Chat UI 扩展变量（`styles/tokens-ext.css`）

- **壳尺寸变量（静态）**：`--rail-width: 68px`（带简短文字标签的图标轨，除 setup 外常驻）、
  `--panel-width: 264px`（会话面板默认宽；用户拖宽后由 `:root` 内联覆盖）、
  `--titlebar-h: 44px`（沉浸式标题栏/上下文栏高度，壳层统一占位）、
  `--toggle-knob`（开关滑块钮，双主题恒为白色）、`--radius` / `--radius-full` 别名。
- **focus ring**：`--ring` = `--accent`；`--focus-ring` =
  `0 0 0 2px var(--bg), 0 0 0 4px var(--ring)`（双层环，底色隔断 + accent 外环）；
  `--focus-glow` 额外加 16/20px glow。
- **兼容别名**：`--card(-foreground/-highlight)`、`--popover(-foreground)`、
  `--panel(-strong/-hover)`、`--chrome(-strong)`、`--muted(-strong/-foreground)`、
  `--input`、`--primary(-foreground)`、`--secondary(-foreground)`、
  `--danger(-muted/-subtle)`、`--accent-muted`、`--accent-foreground`、
  `--bg-accent`、`--bg-content`、`--chat-text`、`--grid-line`、`--shadow-glow` 等，
  均映射到 design-tokens 语义 token。新代码优先用第 2.3 节的语义变量；
  别名层为存量兼容，勿再扩张。
- **首帧防闪**：`:root` 默认值为**浅色**（浅色系统首帧不闪暗）；暗色值在
  `[data-theme=dark]` + `prefers-color-scheme: dark` 兜底块双通道定义，
  暗色系统用户在 data-theme 落地前也不会闪白。

### 2.5 间距/布局原子类（`styles/utilities.css`）

R75 清理后原子类只保留现行使用的 15 个（flex 骨架 `oc-flex(-col)` /
`oc-items-start` / `oc-justify-end` / `oc-gap-{6,8,12,16}`、外边距 `oc-m-0` /
`oc-mt-{2,4,6,8,12,24}` / `oc-mb-*` / `oc-ml-auto`、内边距 `oc-p-16`），
值走 `--spacer` 阶梯，以文件现行集合为准——**新代码不要引用此清单之外的
原子类**（R75 起死类即删）。功能性样式（尺寸、颜色、定位、动态值）不适用，
仍写 CSS 块。

### 2.6 按钮体系（R84 收敛）

按钮一律用 `primitives.css` 的 `.btn` kit：`.btn`（hairline 描边默认）/
`.btn.primary`（主题强调色实心）/ `.btn.danger`（语义危险）/ `.btn--sm`（28px 小号）/
`.btn--text`（无边框低强调文本动作）。历史上并存的四套视图私有 kit
（`oc-settings__btn*` / `oc-setup-btn*` / `cron-form__btn*` / `chat-goal__btn`）
已于 R84 全量迁移删除，**不要再新建视图私有按钮类**。

## 3. 主题与配色使用

- 品牌基准 `--brand` 使用原 CryoBlue；`--accent` 负责可自定义的主题强调。红/绿/黄用于语义状态（error/ok/warn）。
- 大面积留白 + hairline 细分隔线 + 微小明暗对比分区；hover 反馈 = 底色微调
  （`--bg-hover`）+ 边框加深（`--border-strong`）。区块间距 ≥ `--spacer-24`。
- 旧「indigo 品牌色 `#6366f1`」「冰蓝（ice-blue）品牌色 `#0EA5E9`」与更早的
  「主题红 `#c0392b`」规范均已废弃，不要再引用。
- **主题适配红线（复述，硬性）**：视图 CSS 不写 `[data-theme=]` 覆盖块、不写
  `@media (prefers-color-scheme)` 块、不硬编码色值；主题差异全部由上述 token 承担。

## 4. 应用壳布局（2026.9 提案 A）

```
┌────────┬──────────────┬──────────────────────────────────┐
│        │              │  .cryoclaw-titlebar (44px, drag)   │
│ oc-rail│oc-session-   │  = 上下文栏：面板开关+会话名/      │
│ (68px) │panel(264px,  │    视图标题                        │
│ 常驻)  │可折叠/可拖宽)├──────────────────────────────────┤
│        │  仅 chat 视图│  .cryoclaw-content                 │
│ 图标轨 │  显示        │  （各视图内容区）                  │
└────────┴──────────────┴──────────────────────────────────┘
```

### 4.1 oc-rail 图标轨（`shell.css`）

- 宽 `--rail-width`（68px），所有视图（除 setup 全屏向导）常驻；整轨为拖拽区，
  每个可交互项 `no-drag`。
- 上→下顺序：品牌标（拖拽区）→ chat / dashboard / tasks（带运行中任务数徽标）/
  workspace / extensions → 弹性间隔（`oc-rail__spacer`）→ webbridge 修复（条件出现，warn 色）→
  完整版网页/重连（断连时 destructive 色 + 错误徽标，hover 弹出
  `oc-rail__error-popup` 错误列表）→ settings（带圆点角标 `oc-rail__dot`）。
- 主导航项为 48×48、radius-10、19px 图标 + 简短文字标签；其余纯图标项保持 40×40。
  默认 `--text-muted`，hover 出 `--bg-hover` 底，active = `--accent` 文字 +
  `--accent-subtle` 底。
- 数字徽标 `oc-rail__badge`（accent 底、断连时 destructive 底）与圆点角标
  `oc-rail__dot` 是仅有的 pill 圆角用法之一。

### 4.2 oc-session-panel 会话面板（`session-panel.css`）

- **仅 chat 视图显示**；`navCollapsed` 设置项语义 = 「会话面板折叠」，折叠/展开
  按钮在上下文栏左侧（`cc-contextbar__toggle`）。
- 默认宽 `--panel-width`（264px）；右缘调宽手柄 `.cryoclaw-panel-resize`（6px 命中区，
  hover/active 显示 accent 指示条）拖拽调宽 **220–420px**，持久化到 `sidebarWidth`
  设置项（语义不变，CSS 变量改为 `--panel-width`，用户值经 `:root` 内联覆盖）。
- 窄窗自适应（未自定义宽度时生效）：≤900px → 232px，≤720px → 220px。
- 结构：面板头（标题 + 更多/归档切换图标按钮）→ 全宽「新建对话」主按钮 →
  搜索框 → 会话列表（唯一滚动容器；分组标签 + 会话项 + 未读点/置顶/worktree 徽标 +
  内联重命名 + 「⋯」管理菜单，z-index ≤60）。

### 4.3 上下文栏与标题让位

- `--titlebar-h: 44px` 不变；`.cryoclaw-titlebar` 由壳层 `.cryoclaw-main` 统一占位，
  **视图不再做顶部 44px 让位**（旧 `padding-top: var(--titlebar-h)` 一律删除）。
- 标题栏区域 `-webkit-app-region: drag`，其内每个可交互元素必须 `no-drag`
  （drag/no-drag 配对）。
- 内容：chat 视图 = 面板开关 + 会话标题；其他视图 = 视图标题
  （`cc-contextbar__title`，`--heading-sm` semibold）。各视图自有操作放在内容区，
  不塞进标题栏。
- **setup 是唯一 fullpage 视图**：无 rail、无上下文栏。

### 4.4 z-index 三层契约（硬性）

视图内菜单/气泡 **≤60**；标题栏/上下文栏 **100**；modal/toast/确认框 **≥1000**
（`cc-dialog-overlay` = 1000，`global-toast` = 10001）。禁止出现其他值。

### 4.5 窗口行为（`src/window-bounds.ts`）

- 首次启动默认尺寸 = 主屏工作区的 **80%**；最小约束 **800×600**
  （`src/constants.ts`）。
- 用户调整后的 bounds 持久化到 `userData/window-bounds.json`，下次启动优先恢复；
  恢复前校验：尺寸 ≥ 最小约束，且与任一显示器工作区有足够重叠（≥160px 宽、
  ≥48px 高），防止拔掉外接屏后窗口恢复到不可见区域，校验失败回退默认尺寸。

## 5. 组件规范

### 5.1 按钮（`.btn` 三级体系，`primitives.css`）

2026.9 起 `.btn` 体系在 `primitives.css` 定义（旧 sidebar.css 的胶囊化 `!important`
全局覆盖已删除）。统一规格：**高 32、radius-8、字重 500、内置图标 16px**；
focus-visible = `--focus-ring`；disabled = opacity 0.5。

| 类 | 层级 | 外观 |
|---|---|---|
| `.btn.primary` | 主操作（每屏至多一个） | `--accent` 实心 + `--text-on-accent`，hover `--accent-hover` |
| `.btn`（默认） | 次操作 | `--bg-elevated` + hairline 描边 |
| `.btn.danger` | 破坏性操作 | R85 起：`color-mix(destructive 10%)` 底 + `28%` 语义描边 + `--danger` 文字（旧版 8% 无边框太浅）；hover 加深至 16%/38% |

修饰：`.btn--sm`（高 28、padding 10、字号 `--text-sm`）。
（R75：零引用的 `cc-btn` kit 与 `.btn.secondary`/`.btn.ghost` 已从 primitives.css 删除。）
（R85 教训：CSS 块注释结尾禁止多写斜杠——游离 `/` 会污染下一条选择器被浏览器静默丢弃，构建期校验 `assertCssSelectorsValid` + `css-syntax-qa.test.ts` 双防线拦截，详见 gotchas #105。）

### 5.2 表单控件

表单控件走各组件私有类 + `components.css` 的 `.field` 体系：
**32px 高、`--bg-input` 底、hairline 描边、radius-8**；focus = `--border-focus` + `--focus-ring`；
placeholder/disabled 用 `--text-muted`。`.field` = label（`--text-sm` medium muted）+ 控件的 grid 组合。
对话输入卡是刻意例外：使用 42% accent 混合的 1px 边与 2px `--accent-subtle` 状态光，避免粗重双层蓝框；不得因此移除可辨识的聚焦反馈。
（R75：零引用的 `cc-input`/`cc-select`/`cc-textarea` 已删除。）

### 5.3 卡片（`.card`）

`--card` 底 + hairline 描边 + **radius-12** + `--shadow-xs` + padding-20；
`.card` 带 rise 入场动画，hover 边框加深 + `--shadow-sm`。
（R75：零引用的 `cc-card` 已删除；可点卡片用组件私有类。）

### 5.4 对话框（`cc-dialog` 弹窗契约）

`cc-dialog-overlay`（fixed 全屏、`--overlay` 遮罩、z-index 1000、居中、
padding-24）+ `cc-dialog`（`--popover` 底、hairline、**radius-16**、`--shadow-xl`、
max-width 520）。内部分区：`__head`（`__title` = `--heading-sm` semibold +
`__close` 32×32 图标按钮）/ `__body`（`--text-secondary`）/ `__foot`
（按钮右对齐、gap-8）。

### 5.5 全局 toast（`global-toast`）

**底部居中、按输入区实际高度动态避让**：`fixed; bottom: calc(24px + var(--chat-compose-clearance, 0px)); left: 50%`，`--bg-elevated` 底 +
hairline + radius-12 + `--shadow-lg`，`--text-sm` medium，z-index 10001，
`--duration-normal` 上浮入场，输入区高度变化时连续调整位置。默认 `pointer-events: auto` 自动消失；
`global-toast--action` 变体（如「重启更新」）不自动消失，
右侧附 accent 描边小按钮 `global-toast__action`。

### 5.6 其他原语速查

| 类 | 说明 | 变体 / 要点 |
|---|---|---|
| `cc-tag` | 徽章，高 22，pill 圆角 | `--brand`（subtle 底 + 品牌文字） |
| `cc-alert` | 警告条，左侧 3px 语义条 | `--warn` / `--error` |
| `.callout` | 提示块（subtle 底） | `.danger` / `.info` |
| `.code-block` | 代码块 | `--mono` + `--bg-muted` + radius-8 |
| `.compaction-indicator` | 消息流压缩指示胶囊 | `--active` / `--complete` / `--fallback` |

开关（Switch）不在 primitives：用 `<oc-toggle-switch>` 组件
（`ui/components/toggle-switch.ts`，iOS 风格，滑块钮双主题恒为白色）。

## 6. 图标系统（CryoIcons 自绘体系）

2026.9 R2 起应用图标**全部为本项目自绘**（`chat-ui/ui/src/ui/icons.ts` + 文件卡片
图标 `chat-ui/ui/src/ui/chat/media-enhance.ts`），零第三方图标库依赖。

### 6.1 绘制规范（硬性）

- **画布**：`viewBox="0 0 24 24"`，内容安全区约 2.5–21.5。
- **描边**：`stroke="currentColor"`、`stroke-width="1.75"`、`stroke-linecap="round"`、
  `stroke-linejoin="round"`、`fill="none"`；颜色永远继承文字色，不上色。
- **造型语言**：纯几何构造——直线、圆/圆弧、圆角矩形（rx 1.2–2）；
  不用填充色块堆叠、不用渐变、不用投影。
- **唯二填充例外**：`moreHorizontal` 三点（`fill="currentColor"` 小圆点）与
  `pinActive` 置顶激活态（整形填充，作为「激活」的唯一视觉差异）。
- **语义优先于象形复杂度**：宁可简洁几何（如 settings = 中心圆 + 8 辐齿），
  不追求繁复写实；16–20px 显示尺寸下必须清晰可辨。
- 坐标取 0.5 步进（像素对齐友好），同族图标共享视觉重心与笔画密度。

### 6.2 使用与扩展

- 视图一律经 `icon(name)` / `icons.<name>` 引用（`icons.ts` 导出 `IconName` 类型，
  键名即契约，禁止内联临时 SVG）。
- 文件卡片图标按扩展名类别取 `ICON_BY_CATEGORY`（media-enhance.ts），与
  `icons.ts` 同一规范。
- 新增图标：按 6.1 规范绘制 → 加入 `icons.ts` → 跑 chat-ui 测试
  （`grouped-render.test.ts` 审计 unsafeSVG 仅限静态图标）。
- 图标默认尺寸走 `--icon-size-*` 阶梯（16/20 为主），不在图标内写死尺寸。

## 7. 样式组织

- **hub `chat-ui/ui/src/styles.css` 只做 `@import`，层叠顺序敏感，禁止随意调序**：
  design-tokens → tokens-ext → base → **primitives** → **utilities** → **shell** →
  **session-panel** → chat / components / panels / skills / compose / workspace /
  cron / chat-misc / tasks-misc / settings-misc / panel / plan →（末尾）
  **settings → setup**。
- 2026.9 起旧 `sidebar.css` 拆为 `shell.css`（壳/图标轨/上下文栏/调宽手柄）+
  `session-panel.css`（会话面板）；`shell.css` / `session-panel.css` /
  `design-tokens.css` / `tokens-ext.css` / `base.css` 归主代理维护，视图任务不碰。
- `styles/settings.css`（设置页）与 `styles/setup.css`（Setup 向导）抽取自视图 TS
  原 adoptedStyleSheets 注入样式；原注入优先级高于 document 样式表，故必须
  保持在 import 列表**最末**。
- 视图样式可覆盖 primitives（primitives 在 base 之后、各视图之前，是有意设计）。
- 新样式：先找 token + 现有原语能否组合出来；必须新增时写进对应分块文件，
  新颜色/圆角/间距先进 `design-tokens.css`。
- 独立页面（`setup/webbridge-enable-guide.html` 等）同样 `@import`
  shared/design-tokens.css，双通道主题自动生效。

## 8. 布局约定

- 标题栏 44px 由壳层统一占位（见 4.3）；浮层定位以 `--titlebar-h` 为锚
  （如 `top: calc(var(--titlebar-h) + var(--spacer-12))`）。
- 居中列约束（R84 流式）：消息流/compose 用 `--chat-column`（min(92%, 1000px)），扩展视图内容列用
  `--ext-column`（960px）。
- 窄窗（≤900px / ≤720px）有会话面板宽度 media query 适配（见 4.2）。
- grid 容器防溢出：`grid-template-columns: minmax(0,1fr)` + 子项 `min-width: 0`。

## 9. 可访问性

### 聚焦系统（2026.10.30 统一）

聚焦语言只有一句：**一条主色边 + 一层极淡光晕，不用硬描边**。全部令牌在 `styles/tokens-ext.css`，按「元素与背景的关系」三档选用，不按页面各写一套：

| 令牌 | 用在哪 | 形态 |
|---|---|---|
| `--focus-field-color` + `--focus-field` | 文本类输入控件本体（input / textarea / select / 搜索框 / 内联重命名） | 边框染成 `accent 45%` 与 border 的混色 + 3px `--accent-subtle` 柔光 |
| `--focus-ring` | 紧凑控件：按钮、图标钮、菜单项、chip、卡片入口 | 内 2px `accent-subtle` + 外 3px `--ring` 收边 |
| `--focus-ring-inset` | 密集列表/表格内的行（会话条目等） | `inset` 内描边，不溢出到相邻行、不撑开布局 |

- 对话输入卡（`.chat-compose__field:focus-within`）是**参照实现**，且已改为直接引用 `--focus-field-color` / `--focus-field`：改令牌时它跟着变，不再各写一份数值。
- 禁止再用 `outline: 2px solid <色>` 做聚焦（outline 不跟随 `border-radius`，圆角控件会露方角）；全局 `:focus-visible` 基线在 `base.css`，`outline: none` + `box-shadow: var(--focus-ring)`。
- 指针聚焦不显示环（`:focus:not(:focus-visible)` 清空阴影）；键盘与程序聚焦才显示。
- 颜色/换环过渡统一走 `--focus-transition`（`--duration-fast` + `--ease-standard`），不要各写 `--ease-out`。
- 只有「选中态」「编辑态标记」可以用实色 outline（看板编辑中选中卡片/元素），那是选择语义不是聚焦，不属本规则；回归用例按选择器区分这两类。
- 回归：`chat-ui/ui/src/ui/focus-system.test.ts` 钉住令牌齐备、无残留硬描边、输入控件接入 `--focus-field`、密集列表用内描边。

- **focus-ring 统一**：全局 `:focus-visible { box-shadow: var(--focus-ring) }`
  （base.css），控件各自重复声明同 token；不要写自定义 outline 样式，
  不要移除 focus 样式而不给替代。
- **`prefers-reduced-motion`**：base.css 已全局把动画/过渡收敛到瞬时
  （0.01ms + 单次迭代），主题切换 view-transition 同步关闭；组件级
  （骨架屏扫光、loading 转环、调宽手柄指示条）另有各自的红运动停动画块，
  新动画需在同类块中登记。
- 动效时长约定：hover/press 用 `--duration-fast`，面板开合/入场用
  `--duration-normal`，统一走 `--ease-standard`（规范推荐值，存量
  `--ease-out` 不再新增）；pulse/spin/shimmer 等无限循环动画一律
  `--duration-loop`；popover/dialog 的 scale 入场用 `--ease-spring`
  （popover 入场时长沿用 `--duration-fast`：目标小、距离短，fast 档已够，
  属有意豁免）。
- **一镜到底（2026.10 动效定型原则）**：元素不瞬现瞬消——入场沿锚定边缘
  滑入（底部 toast 自下、顶部 toast 自上、抽屉自右），退场沿来路返回
  （退场需「leaving class + 延迟移除 DOM」两段式，参照 app-toast.ts 的
  TOAST_EXIT_MS 模式）；状态翻转（spinner→✓）用 scale 轻弹衔接
  （`oc-status-pop`）而非硬切；流式光标用平滑呼吸（ocStreamCaret 走
  `--ease-in-out` 令牌，循环动画一律不写字面 easing），不用硬闪烁。新增按压反馈（transform scale）必须在
  base.css 的 reduced-motion 块显式登记 `transform: none`（全局 0.01ms
  收敛会把回缩变成瞬跳）。
- 拖拽区分工：壳层大面积 `-webkit-app-region: drag` 保证窗口可拖动，所有可交互
  元素必须配 `no-drag`，保证键盘/鼠标可达。

### 项目动效准则（2026.10.23）

动效要精美、自然，覆盖必要的过渡、打断、入场与出场。正常模式保留完整动效，**不以减少动画数量换取流畅度**；通过合成层、可见性调度和减少无效重绘获得流畅。可以少，但必须精，服务于用户体验和视觉阅读，**流畅优先于装饰数量**。
- `prefers-reduced-motion` 仅是用户主动选择的无障碍偏好，不是默认性能策略；正常模式的动画不得因性能优化被静默删减。

- 同一交互保持同一元素和连续状态。展开、收起或反向操作从当前视觉位置接续；取消旧动画时保留当前几何，不闪回起点，不重载 iframe。
- 移动与淡入优先使用 compositor 的 transform/opacity；避免每帧修改布局、重建 Canvas 位图、存储状态或调用模型。拖动按帧合并，松手前提交最后一个坐标。
- 入场说明来源，退出保留去向；不让多个循环同时抢阅读。常驻背景应弱、慢，离屏和窗口隐藏时停止工作。
- 减少动态效果时直接呈现稳定终态，内容、键盘焦点和操作仍完整；动画不得成为功能的前置条件。
- 验收包括中途反向、连续点击、缩放、低帧率、隐藏后恢复、键盘与减少动态效果；不能只检查首次播放。

### 浮层返回准则（2026.10.30）

浮层（popover / 下拉菜单 / 悬浮面板 / 弹窗）统一遵循「从哪来就从哪去，一镜到底，原路返回，自然流畅」：

- **可逆**：打开浮层的触发器再次触发必须关闭同一个浮层；反复点击在「开 / 关」之间对称切换，任何入口都不得只能开不能关。原生 `popover="auto"` 用 `popovertarget` 声明式 invoker 绑定触发器（invoker 不受 light dismiss 影响）；不要在 click 里手写 `showPopover()/hidePopover()` 开关——pointerdown 的 light dismiss 会先关闭，随后的 click 又把它打开，表现为关不掉。
- **原路返回**：退场是入场的反向（同一锚定边、同一方向、同一距离）。用 leaving 类 + 延迟移除 DOM 播放退场帧，或 `display` / `overlay` 的 `allow-discrete` 过渡；`transform-origin` 落在锚定角上，向上展开的浮层从下沿滑入、退出沿原路收起。
- **锚定自适应**：浮层相对触发器定位，在视口内翻转 / 夹取，放不下时换边而不是溢出窗口；不得遮挡自己的触发器，并尽量不遮挡触发器邻接的主操作（例如面板头部的「新建对话」）。定位统一走 `utils/popover-placement.ts` 的 `placePopover()`，不要各处硬编码 `left/bottom`。
- **单一关闭路径**：Esc、点击外部、选中条目三条路径共用同一条退场与收尾；关闭后焦点回到触发器（或触发前的焦点元素），`aria-expanded` 同步复位，退场期间重开要从当前几何接续。
- **验收**：连续点击、中途改向、窗口最小化后再开、键盘（Tab / Enter / Esc / 方向键）、减少动态效果各走一遍；`npm run test:chat` 必须有「二次点击关闭」与「视口边缘夹取」用例，不能只测首次打开。

**例外登记**：以下浮层是有意不按本条实现的，改动时必须保持它们各自的既有语义——
- 会话信息面板（`views/conversation-info.ts`）是 contextbar 的**停靠式**面板，不锚定触发按钮；它已具备 Esc、点外部、X 三条同源关闭路径与回焦。
- 看板展开卡（`oc-dashboard.ts` 的 `popover="manual"`）与全局 toast 不是点击开合，不受①约束，但仍有反向 morph / 退场帧。
- 原生 `<dialog>`（provider 编辑抽屉、看板详情）自带 Esc/backdrop/初始焦点，只需按 `skills.css` 的 `cc-dialog-out` 契约补退场，不再自写开关。

## 10. Tooltip

- **禁止 CSS `::after` 伪元素 tooltip**（`overflow` 容器内必被裁切）。统一用全局
  `position: fixed` 的 `.fixed-tooltip` 元素 + `data-tooltip="文案"` 属性；
  `data-tooltip-pos="bottom"` 控制向下弹出；宽文案用 `.fixed-tooltip--wide`。
- **Tooltip 仅用于纯图标按钮**（图标轨各项即典型场景）；有文字标签的按钮/菜单项
  不加 tooltip。

## 独立看板工作台

- 标签右键菜单固定为“编辑看板详情”和“删除看板”；标题与说明在详情中编辑，模型读取当前说明。移除重复的整栏元信息。
- 常驻悬浮铅笔统一制作、布局与内容编辑；再次点击退出，保留草稿。工具条随输入框实际高度平滑上移，输入框不提供单独退出按钮。更多菜单承载添加模块。
- 小组件使用真实宽高，响应式重排与连续尺寸调节共存；手动宽度保留free标记。整理保持阅读顺序和全宽分区，平衡每行尺寸并提供布局撤销。
- 展开使用浏览器顶层，保持同一iframe及其输入、计时和本机状态；专注模式避让原生标题栏。外层卡片不响应hover位移、放大或聚焦，反馈留在组件内部与明确的操作按钮。
- 模板预览使用独立HTTP沙箱及明确的示例数据，不触网、不写正式状态、不发送模型请求。紧凑/宽屏切换保留预览状态。
- 任意元素微调必须先选择所属卡片内的目标；选中期间拦截原控件动作和输入。动效暂停离屏工作，尊重减少动态效果，禁止每帧读布局或写存储。
