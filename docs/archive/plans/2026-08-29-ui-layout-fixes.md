# UI 布局修复批次（R43）— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 6 项用户反馈的 UI 问题：「更多」菜单层级遮挡、fullpage 视图顶部与窗口控件重叠、新整合视图桌面布局优化、侧边栏拖拽调宽、全页面自适应、全局布局 QA。

**Architecture:** 纯 chat-ui 改动（主进程零改动；`titleBarOverlay` 高度 32 为既有主进程事实）。统一层叠契约（菜单 ≥60 / titlebar 100 / 全局浮层 ≥1000）；fullpage 视图标题栏让位统一到 shell 层（token `--titlebar-h: 44px`）；侧边栏宽度走 `UiSettings.sidebarWidth` 持久化 + 边缘拖拽；响应式断点补全。

**Tech Stack:** TypeScript 5 + Lit + 既有 CSS 分块（sidebar/misc/workspace/skills/settings.css）+ R38 design token；测试为 node:test 源码审计。

**项目硬约定（每个任务都适用）：**
- 测试：`node scripts/run-chat-ui-tests.js`（chat-ui 全量）；`npx tsc --noEmit` 类型检查
- 源码审计测试模式参照 `cc-sidebar.test.ts`（CRLF 跨行正则用 `\s/[\s\S]`，负向断言剥注释）
- 样式禁止硬编码 hex（#fff 等用 `--text-on-accent`/`--popover` 等既有 token 替代）；transition 用具体属性；`prefers-reduced-motion` 尊重
- 侧边栏整体是 `-webkit-app-region: drag`（标题栏拖拽区），新增交互元素必须 `-webkit-app-region: no-drag`
- 严禁 `git add -A`，逐文件提交；并发编辑共享文件前必须重新 Read

---

### Task 1: 「更多」菜单层级修复（问题 1）

**背景：** `.cryoclaw-sidebar__more-menu` z-index:30（sidebar.css L219），低于会话菜单 `__session-menu` 的 60（L838），在特定布局下被会话区遮挡。用户要求最高层。

**Files:**
- Modify: `chat-ui/ui/src/styles/sidebar.css`（more-menu 层级）
- Modify: `chat-ui/ui/src/ui/components/cc-sidebar.test.ts`（断言）

- [ ] **Step 1: 修复**：`.cryoclaw-sidebar__more-menu` 的 `z-index: 30` → `z-index: 60`（与会话菜单同级最高；注释说明层叠契约：菜单层 60 > titlebar 100 之下 > 普通内容）。同时给 `.cryoclaw-sidebar__more-wrap` 显式 `z-index: 1`（确保定位上下文稳定）。

- [ ] **Step 2: 测试**：`cc-sidebar.test.ts` 追加（读 `styles/sidebar.css`——注意该测试文件的 `src()` 指向 `src/ui/`，样式文件需用独立读取函数 `readFileSync(new URL("../../../../src/styles/sidebar.css", import.meta.url))`）：

```ts
test("sidebar.css：更多菜单与会话菜单同处最高菜单层（z-index 60）", () => {
  const css = readFileSync(new URL("../../../../src/styles/sidebar.css", import.meta.url), "utf8");
  const moreMenu = css.match(/\.cryoclaw-sidebar__more-menu\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(moreMenu, /z-index:\s*60/, "更多菜单应为菜单最高层 60");
});
```

- [ ] **Step 3: 验证**：`node scripts/run-chat-ui-tests.js` 0 fail + `npx tsc --noEmit`。

- [ ] **Step 4: Commit**：`git commit -m "fix(chat-ui): 「更多」菜单层级提升至菜单最高层（R43）"`

---

### Task 2: fullpage 视图标题栏让位统一（问题 2）

**背景：** Windows `titleBarOverlay` 高度 32、标题栏 drag 区 44px。`.ext-tabs`（extensions 页）与 `.wk-layout`（workspace 页）贴窗口顶部，顶部内容与「- □ ×」窗口控件及 drag 区重叠导致无法点击。tasks（ts-layout padding-top 48）与 settings（已有让位）是先例。

**Files:**
- Modify: `chat-ui/ui/src/styles/tokens-ext.css`（新增 `--titlebar-h: 44px` token，:root 与 [data-theme=dark] 双处若有主题块需同步——实际为布局 token 放 :root 即可）
- Modify: `chat-ui/ui/src/styles/skills.css`（ext-tabs 让位）
- Modify: `chat-ui/ui/src/styles/workspace.css`（wk-layout 让位）
- Modify: `chat-ui/ui/src/styles/misc.css`（ts-layout 改用 token）
- Create: `chat-ui/ui/src/ui/layout-fix.test.ts`（审计）

- [ ] **Step 1: 写失败测试**：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function css(rel: string): string {
  return readFileSync(new URL(`../../../../src/styles/${rel}`, import.meta.url), "utf8");
}

test("tokens-ext：--titlebar-h 布局 token 存在", () => {
  assert.match(css("tokens-ext.css"), /--titlebar-h:\s*44px/, "缺标题栏让位 token");
});

test("fullpage 视图顶部让位沉浸式标题栏（不再与窗口控件重叠）", () => {
  const skills = css("skills.css");
  const extTabs = skills.match(/\.ext-tabs\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(extTabs, /padding-top:\s*var\(--titlebar-h\)/, "ext-tabs 缺标题栏让位");
  const wk = css("workspace.css");
  const wkLayout = wk.match(/\.wk-layout\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(wkLayout, /padding-top:\s*var\(--titlebar-h\)/, "wk-layout 缺标题栏让位");
});

test("ts-layout 顶部让位统一走 token", () => {
  const misc = css("misc.css");
  const tsLayout = misc.match(/\.ts-layout\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(tsLayout, /var\(--titlebar-h\)/, "ts-layout 应改用 --titlebar-h");
});
```

- [ ] **Step 2: 运行确认失败**。

- [ ] **Step 3: 实现**：
  - `tokens-ext.css` :root 加 `--titlebar-h: 44px;`（注释：沉浸式标题栏高度，与主进程 titleBarOverlay 32 + drag 区协同，fullpage 视图内容让位基准）
  - `skills.css` `.ext-tabs`：`padding: var(--spacer-12) var(--spacer-20);` → `padding: var(--titlebar-h) var(--spacer-20) var(--spacer-12);`（顶部让位 44，其余保持）
  - `workspace.css` `.wk-layout`：加 `padding-top: var(--titlebar-h);`
  - `misc.css` `.ts-layout`：`padding: 48px 24px 48px;` → `padding: calc(var(--titlebar-h) + 4px) 24px 48px;`（保持原 48 视觉）
  - **复核**（实施时逐一检查并补齐，全部加 `padding-top: var(--titlebar-h)`）：`settings.css` 的 `.oc-settings-nav`（若顶部贴边）、`cron.css` 的 `.cm-layout`/`.cm-list`（定时 tab 内容，若贴边）、`chat.css` 对话页顶部（已有让位则不动）

- [ ] **Step 4: 运行确认通过** + `npx tsc --noEmit`。

- [ ] **Step 5: Commit**：`git commit -m "fix(chat-ui): fullpage 视图标题栏让位统一（--titlebar-h token）（R43）"`

---

### Task 3: 侧边栏拖拽调宽（问题 4）

**背景：** 侧边栏宽度固定 `var(--sidebar-width)`（280px）。支持右边缘拖拽调宽（220–420px），持久化。既有 `resizable-divider` 组件（chat 分栏）可参考其拖拽模式（buttons===0 补偿、窗口外释放）。

**Files:**
- Modify: `chat-ui/ui/src/ui/storage.ts`（UiSettings 加 `sidebarWidth`）
- Modify: `chat-ui/ui/src/ui/app-render.ts`（sidebar 后插入拖拽条 + 内联宽度）
- Modify: `chat-ui/ui/src/styles/sidebar.css`（resize-handle 样式 + 宽度变量化）
- Create: `chat-ui/ui/src/ui/sidebar-resize.test.ts`（审计）

- [ ] **Step 1: 写失败测试**：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function src(rel: string): string {
  return readFileSync(new URL(`../../../../src/ui/${rel}`, import.meta.url), "utf8");
}

test("storage：UiSettings 持久化 sidebarWidth（范围 220-420）", () => {
  const s = src("storage.ts");
  assert.match(s, /sidebarWidth:\s*number/, "UiSettings 缺 sidebarWidth");
  assert.match(s, /220/, "缺最小宽约束");
  assert.match(s, /420/, "缺最大宽约束");
});

test("app-render：侧边栏后渲染拖拽条且宽度内联生效", () => {
  const s = src("app-render.ts");
  assert.match(s, /cryoclaw-sidebar__resize-handle/, "缺拖拽条元素");
  assert.match(s, /sidebarWidth/, "宽度未接线");
});
```

- [ ] **Step 2: 运行确认失败**。

- [ ] **Step 3: 实现**。
  1. `storage.ts`：`UiSettings` 加 `sidebarWidth: number;`；`parseUiSettings` defaults 加 `sidebarWidth: 280`，解析：`typeof parsed.sidebarWidth === "number" ? Math.min(420, Math.max(220, Math.round(parsed.sidebarWidth))) : defaults.sidebarWidth`
  2. `app-render.ts`：
     - 顶部加模块级拖拽状态（不进 Lit 响应式，拖拽高频不触发根重渲染——宽度经 style 直写 + 结束时 applySettings 持久化）：

```ts
// 侧边栏拖拽调宽（R43）：mousemove 高频期直写 DOM 宽度，松手才持久化，
// 避免每帧 applySettings → saveSettings（localStorage 写）
let sidebarDragStartX = 0;
let sidebarDragStartW = 0;

function attachSidebarResize(handle: HTMLElement, state: AppViewState) {
  handle.onmousedown = (e: MouseEvent) => {
    e.preventDefault();
    sidebarDragStartX = e.clientX;
    sidebarDragStartW = state.settings.sidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      // 窗口外释放补偿（同 resizable-divider 模式）
      if (ev.buttons === 0) { onUp(); return; }
      const w = Math.min(420, Math.max(220, sidebarDragStartW + (ev.clientX - sidebarDragStartX)));
      const sidebar = document.querySelector(".cryoclaw-sidebar") as HTMLElement | null;
      if (sidebar) sidebar.style.width = `${w}px`;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const sidebar = document.querySelector(".cryoclaw-sidebar") as HTMLElement | null;
      const w = sidebar ? Math.min(420, Math.max(220, sidebar.getBoundingClientRect().width)) : sidebarDragStartW;
      state.applySettings({ ...state.settings, sidebarWidth: Math.round(w) });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
}
```

     - `renderApp` 中 `<cc-sidebar …>` 之后（`!chatFocus && !sidebarCollapsed && !meta.fullpage` 分支内）追加：

```html
<div class="cryoclaw-sidebar__resize-handle"
  @mousedown=${(e: MouseEvent) => attachSidebarResize(e.currentTarget as HTMLElement, state)}></div>
```

     - `<cc-sidebar>` 装配处内联初始宽度：`.props` 字面量不变，给 `<cc-sidebar>` 外层包不住宽度——直接给 aside？cc-sidebar 是自定义元素渲染 aside。方案：`<cc-sidebar style="width: ${state.settings.sidebarWidth}px" .props=…>`（自定义元素宿主宽度传导给内部 aside 需 CSS `.cryoclaw-sidebar { width: 100% }` 改造——见 Step 3.3）
  3. `sidebar.css`：
     - `.cryoclaw-sidebar`：`width: var(--sidebar-width);` → `width: 100%; max-width: 100%;`（宽度由宿主 cc-sidebar 内联控制，保留 `--sidebar-width` 作为折叠/媒体查询回退——实际实施时核对 900/720px 媒体查询仍生效：宿主无内联宽度时才用 `var(--sidebar-width)`。实现：`cc-sidebar { width: var(--sidebar-width); flex-shrink: 0; }`，内联 style 覆盖宿主宽度；`__sidebar` 保持 `width: 100%`）
     - 新增：

```css
cc-sidebar { width: var(--sidebar-width); flex-shrink: 0; display: block; }
.cryoclaw-sidebar { width: 100%; }

/* 侧边栏右缘拖拽条（R43）：6px 命中区 + hover 可视反馈 */
.cryoclaw-sidebar__resize-handle {
  width: 6px;
  flex-shrink: 0;
  cursor: col-resize;
  position: relative;
  -webkit-app-region: no-drag;
}
.cryoclaw-sidebar__resize-handle::after {
  content: "";
  position: absolute;
  top: 0; bottom: 0; left: 2px;
  width: 2px;
  border-radius: var(--radius-full);
  background: transparent;
  transition: background var(--duration-fast) var(--ease-standard);
}
.cryoclaw-sidebar__resize-handle:hover::after,
.cryoclaw-sidebar__resize-handle:active::after {
  background: var(--accent);
}
.cryoclaw-shell--sidebar-collapsed .cryoclaw-sidebar__resize-handle,
.cryoclaw-shell--focus .cryoclaw-sidebar__resize-handle { display: none; }
@media (prefers-reduced-motion: reduce) {
  .cryoclaw-sidebar__resize-handle::after { transition: none; }
}
```

- [ ] **Step 4: 运行确认通过** + `npx tsc --noEmit`。手工验证（`npm run dev` 或真机）：拖拽平滑、松手持久化、刷新后保持、窄媒体查询不破。

- [ ] **Step 5: Commit**：`git commit -m "feat(chat-ui): 侧边栏右缘拖拽调宽（220-420 持久化）（R43）"`

---

### Task 4: 新整合视图桌面布局优化 + 响应式（问题 3/5）

**背景：** extensions/workspace 页在宽屏缺内容收束（过散）、窄屏无断点适配。补齐：内容最大宽度居中 + 窄窗断点。

**Files:**
- Modify: `chat-ui/ui/src/styles/skills.css`（ext 内容收束 + 断点）
- Modify: `chat-ui/ui/src/styles/workspace.css`（wk 窄窗断点）
- Modify: `chat-ui/ui/src/styles/misc.css`（ts/cm 断点复核）
- Modify: `chat-ui/ui/src/styles/settings.css`（settings 窄窗断点复核）
- Modify: `chat-ui/ui/src/ui/layout-fix.test.ts`（追加断言）

- [ ] **Step 1: 实现**（先读各样式文件现状再改）：
  1. **扩展页收束**：`.ext-layout > .oc-settings__section` 与 `.ext-layout > .skills-scroll` 追加 `max-width: 980px; margin-left: auto; margin-right: auto; width: 100%;`（宽屏内容居中不过散；窄屏占满）
  2. **断点系统**（各文件追加 `@media`，与既有 900/720 断点协同）：
     - `workspace.css`：`@media (max-width: 860px) { .wk-layout { grid-template-columns: minmax(0, 200px) minmax(0, 1fr); } .wk-nav { padding: var(--spacer-6); } }`；`@media (max-width: 768px) { .wk-layout { grid-template-columns: minmax(0, 168px) minmax(0, 1fr); } }`
     - `skills.css`：`@media (max-width: 768px) { .ext-tabs { padding-left: var(--spacer-12); padding-right: var(--spacer-12); } }`
     - `misc.css`：ts-layout 窄窗 `padding: calc(var(--titlebar-h) + 4px) var(--spacer-12) var(--spacer-24);`（≤720px）
     - `settings.css`：`@media (max-width: 768px) { .oc-settings-nav { width: 200px; } }`（核对现状后调整）
  3. **视觉清晰化**（问题 3）：`.wk-nav__section-title`/`.wk-nav__node` 字重与颜色层次复核（标题 `--text-muted` 小字、节点 `--text` 正文）；`.ext-tabs` 加 `position: sticky; top: 0; z-index: 5; background: var(--bg);`（内容滚动时 tab 栏不随之消失——先核对滚动容器再决定）
  4. 全部样式走 token；`prefers-reduced-motion` 若有 transition 补禁用

- [ ] **Step 2: 测试**：`layout-fix.test.ts` 追加断言（ext 内容 max-width 存在；workspace/skills/misc 各有 ≥1 个 `@media` 断点）。

- [ ] **Step 3: 运行确认通过** + 手工验证：1920/1440/1280/1024/800 宽各视图截图核对（真机或 `npm run dev`）。

- [ ] **Step 4: Commit**：`git commit -m "feat(chat-ui): 新整合视图桌面布局优化 + 响应式断点（R43）"`

---

### Task 5: 全局布局 QA（问题 6）

**背景：** 对全部页面做布局审计：顶部让位、溢出、窄窗、暗色主题、按钮右对齐、滚动容器唯一性、drag 区误伤（交互元素被 -webkit-app-region: drag 吞掉无法点击）。

**Files:**
- Create: `chat-ui/ui/src/ui/layout-qa.test.ts`（审计清单）+ 审计发现的样式修复（按发现落到对应样式文件）

- [ ] **Step 1: 审计清单（逐项检查并修复发现）**：
  1. **所有 fullpage 视图根元素**有标题栏让位（tasks/cron tab/extensions/workspace/settings/setup）——grep `padding-top` 与 `--titlebar-h` 消费
  2. **所有交互元素**在 drag 区内有 `no-drag`（sidebar 全体、fullpage 浮动按钮、标题栏内任何可点元素）——grep `-webkit-app-region` 配对
  3. **滚动容器唯一性**：每个视图只有一个主滚动容器（`overflow-y: auto` 不嵌套冲突）——抽查 ts-layout/cm-layout/wk-layout/ext-layout/oc-settings-container/chat-thread
  4. **z-index 契约**：菜单 60 / titlebar 100 / 弹窗浮层 ≥1000——全量 grep 核对无越界
  5. **窗口最小尺寸 800×600**：各视图无横向溢出（`min-width: 0` 在 grid/flex 子项齐全）
  6. **暗色主题**：新样式无写死浅色值（grep `background: #|color: #` 在新增规则中为零）
  7. **按钮右对齐约定**：表单/对话框按钮区右对齐（抽查 cron 表单、git 提交框、扩展页操作区）

- [ ] **Step 2: 审计测试**：`layout-qa.test.ts` 把上述可自动化项写成断言（样式文件读取 + 正则）；不可自动化项记入报告由 CDP/真机冒烟覆盖。

- [ ] **Step 3: 修复发现**（每个修复独立说明；预期发现数 0-5 项，超出则报告 BLOCKED 拆分）。

- [ ] **Step 4: 运行确认通过**。

- [ ] **Step 5: Commit**：`git commit -m "fix(chat-ui): 全局布局 QA 修复（R43）"`

---

### Task 6: 全量验证 + 代码审查 + 发版

- [ ] **Step 1:** `npm test` 0 fail + `npm run build` + `npm run dupcheck`（不回退）
- [ ] **Step 2:** CDP 真机冒烟：更多菜单层级、工作区/扩展页顶部可点（窗口控件区避让）、侧边栏拖拽调宽（含持久化）、1920/1280/1024/800 宽 × light/dark × 六视图截图核对（无遮挡/无溢出/无裸 i18n 键）
- [ ] **Step 3:** CodeReview 代理终审，处理 blocker/major
- [ ] **Step 4:** 发版：`package.json` → `2026.829.1`（或当日序号）+ `release-notes.json` 条目 + website 徽章（工作区同步）+ `docs/OPTIMIZATION-PROGRESS.md` `### R43` 小节；`git add -A && git commit && git push`；`npm run dist:win` → 产物断言 → 启动验证 → `gh release create`（三件套）；发版后 `npm run dupcheck`

---

## 自审记录

1. **需求覆盖**：问题 1→T1；问题 2→T2；问题 4→T3；问题 3+5→T4；问题 6→T5；发版→T6。✔
2. **占位符**：T4 的 settings 断点标注「核对现状后调整」是取证依赖；T5 修复项数以审计结果为准（上限 5，超出拆分）——均为显式边界而非悬空占位。✔
3. **类型一致**：`sidebarWidth`（T3）storage/app-render/样式三处命名一致；`--titlebar-h`（T2）被 T4/T5 消费。✔
4. **约束核对**：主进程零改动（全部 chat-ui）；drag 区语义在 T3 样式中显式 no-drag；无硬编码 hex 要求逐任务声明。✔
