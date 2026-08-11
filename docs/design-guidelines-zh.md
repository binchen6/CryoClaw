# CryoClaw 设计规范（R3E 重写版）

CryoClaw 的设计语言 = **TraeWork token 体系 + 冰蓝（ice-blue）配色**。浅色为默认主题，
暗色通过 token 层双通道切换。本文档与代码现状对齐；唯一事实来源是
`shared/design-tokens.css` 与 `chat-ui/ui/src/styles/primitives.css`，冲突时以代码为准。

## 1. 总则

1. **一律走 design token，禁止硬编码 hex**（如 `color: #fff`）、禁止硬编码
   `border-radius` / 间距数值、禁止 `transition: all`（必须列具体属性）。
2. **浅色是默认主题**；暗色样式不得写在视图层 —— 正确使用 token 后双主题自动适配
   （`[data-theme=dark]` 由 Chat UI 设置，`prefers-color-scheme` 兜底 Setup 等独立页面）。
3. **组件优先复用 `cc-*` 原语**（见第 4 节），不要新造按钮/卡片/弹窗样式。
4. **不 `text-transform: uppercase`**：label 按原文显示，尊重品牌名大小写与 CJK 文本。
   唯一例外是 `cc-table` 表头沿用 TraeWork 组件契约的 uppercase 样式。
5. **布尔设置一律 iOS 风格 Switch**（`<oc-toggle-switch>`，label 左、开关右），
   不用 radio / checkbox。
6. **默认操作按钮右对齐**：弹窗底部与设置页按钮行 `justify-content: flex-end`
   （`cc-dialog__foot` 已内置）；仅列表内联局部操作可例外。
7. **元信息一律等宽小字**：模型标签、工具名、token 用量、时间戳、路径、状态行使用
   `var(--font-meta)` + `var(--font-size-meta)`（11px），弱化色用
   `var(--text-muted)` / `var(--text-faint)`。信息层级靠灰阶 + 字重，不靠卡片堆砌。

## 2. Token 体系（`shared/design-tokens.css`）

### 2.1 静态 token（主题无关）

- **radius 数值阶梯**：`--radius-2/4/6/8/10/12/16/20/24/32`；
  兼容别名 `--radius-xs/sm/md/lg/xl`（= 4/8/12/16/20）、`--radius-pill`（999px）。
- **spacer 数值阶梯**：`--spacer-2/3/4/6/8/10/12/16/20/24/32/40/48/64`。
- **icon 尺寸**：`--icon-size-12/14/16/20/24`。
- **字体栈**：`--font-body`（SF Pro Text + PingFang SC 回退）、`--font-display`、`--mono`
  （JetBrains Mono 系）、`--font-meta` = `--mono`；`--font-size-meta: 11px`、
  `--font-size-body: 14px`。
- **字号阶梯**：正文 `--text-2xs/xs/sm/base/lg`（10/11/12/14/18），
  标题 `--heading-xs/sm/md/lg/xl/2xl/3xl`（13/16/20/22/24/28/32）。
- **动效**：`--ease-out/--ease-in-out/--ease-spring`，
  `--duration-fast/normal/slow`（0.12/0.2/0.35s），`--transition: 180ms ease`。

### 2.2 色板

- **brand 冰蓝色阶**：`--brand-50 … --brand-950`，主色 **`--brand-500: #0EA5E9`**。
- **冷灰阶**（微蓝相）：`--grey-50 … --grey-950`。
- 语义色：`--ok`、`--destructive`、`--warn`、`--info`（= brand），各配
  `-muted` / `-subtle` 变体。

### 2.3 主题变量（浅色默认 / 暗色覆盖）

- 背景：`--bg`、`--bg-secondary`、`--bg-elevated`、`--bg-hover`、`--bg-input`、`--bg-muted`。
- 文字：`--text`、`--text-strong`、`--text-secondary`、`--text-muted`、`--text-faint`、
  `--text-on-accent`。
- 边框：`--border`、`--border-strong`、`--border-hover`、`--border-focus`。
- 强调：`--accent`（浅色 = brand-500，暗色提亮 = brand-400）、`--accent-hover`、
  `--accent-subtle`、`--accent-glow`。
- 遮罩/玻璃：`--overlay(-heavy)`、`--glass-xs/sm/md/lg`、`--glass-border`。
- 阴影：`--shadow-sm/md/lg/xl`。
- 暗色定义两处：`:root[data-theme=dark]`（Chat UI）与
  `@media (prefers-color-scheme: dark)`（独立页面兜底），变量集完全一致。

### 2.4 Chat UI 扩展别名（`styles/tokens-ext.css`）

`--card`、`--popover`、`--panel`、`--ring`、`--focus-ring`、`--danger(-muted/-subtle)`、
`--accent-2`、`--primary`、`--secondary` 等兼容别名，均映射到上述 token。新代码优先用
第 2.3 节的语义变量；别名层为存量兼容，勿再扩张。

## 3. 主题与配色使用

- 强调色永远是冰蓝 `--accent`；红/绿/黄只属于语义状态（error/ok/warn），不得当主题色。
- 大面积留白 + 微小明暗对比分区，不用生硬分割线；hover 反馈 = 底色微调 + 边框加深。
- 旧「主题红 `#c0392b`」规范已废弃（R2 起由冰蓝取代），不要再引用。

## 4. 组件原语（`styles/primitives.css`，`cc-` 前缀）

| 类 | 说明 | 变体 / 要点 |
|---|---|---|
| `cc-btn` | 按钮，默认高 28、radius-8、字重 500 | `--primary` / `--secondary` / `--ghost` / `--danger`；`--sm`（高 24）；`--loading`（前置转环）；`--disabled` |
| `cc-input` / `cc-select` / `cc-textarea` | 表单控件 | min-height 32，focus 时 `--border-focus` + `--focus-ring` |
| `cc-card` | 卡片 | radius-12、padding-20；`--interactive`（hover 浮起） |
| `cc-dialog` | 对话框 | 配 `cc-dialog-overlay`；max-width 520；`__head/__title/__close/__body/__foot`（foot 按钮右对齐） |
| `cc-tag` | 标签，高 22 | `--brand` / `--success` / `--warn` / `--error` |
| `cc-menu` / `cc-menu-item` | 弹出菜单 | item min-height 32 |
| `cc-alert` | 警告条，左侧 3px 语义条 | `--info` / `--success` / `--warn` / `--error` |
| `cc-skeleton` | 骨架屏 | 渐变扫光；`prefers-reduced-motion` 下停动画 |
| `cc-table` | 表格 | 表头小字弱化，行 `--border` 分隔，行 hover 底色 |
| `cc-tabs` / `cc-tab` | 页签 | 下划线指示，`--active` |
| `cc-chip` | 胶囊（可选中） | `--selected` = accent 描边 + subtle 底 |

开关（Switch）不在 primitives：用 `<oc-toggle-switch>` 组件
（`components/toggle-switch.ts`，iOS 风格）。

## 5. 样式组织

- **hub `chat-ui/ui/src/styles.css` 只做 `@import`，层叠顺序敏感，禁止随意调序**：
  design-tokens → tokens-ext → base → **primitives** → chat / components / panels /
  sidebar / skills / compose / workspace / cron / misc / panel / plan →（末尾）
  **settings → setup**。
- `styles/settings.css`（设置页）与 `styles/setup.css`（Setup 向导）是 R3B 从视图 TS
  内嵌 CSS（adoptedStyleSheets）抽取而来；原注入优先级高于 document 样式表，故必须
  保持在 import 列表**最末**。
- 视图样式可覆盖 primitives（primitives 在 base 之后、各视图之前，是有意设计）。
- `components/` 下 Lit 组件的 Shadow DOM 局部样式是合理例外，不进分块文件。
- 新样式：先找 token + cc-* 原语能否组合出来；必须新增时写进对应分块文件，
  新颜色/圆角/间距先进 `design-tokens.css`。
- 独立页面（`setup/webbridge-enable-guide.html` 等）同样 `@import` shared/design-tokens.css。

## 6. 布局约定

- 顶部沉浸式 titlebar 高 44px；**顶部浮层 `top ≥ 56px` 避让**（计划面板 / toast / 错误条）。
- 极窄窗（≤768px）有 media query 适配。
- grid 容器防溢出：`grid-template-columns: minmax(0,1fr)` + 子项 `min-width: 0`。

## 7. Tooltip

- **禁止 CSS `::after` 伪元素 tooltip**（`overflow` 容器内必被裁切）。统一用全局
  `position: fixed` 的 `.fixed-tooltip` 元素 + `data-tooltip="文案"` 属性；
  `data-tooltip-pos="bottom"` 控制向下弹出。
- **Tooltip 仅用于纯图标按钮**；有文字标签的按钮/菜单项不加 tooltip。
