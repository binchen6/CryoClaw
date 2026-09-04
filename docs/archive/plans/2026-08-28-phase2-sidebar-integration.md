# 第二期：侧边栏重组 + 三组模块整合 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 侧边栏重组为「会话列表最大化 + 底部 5 图标轨 + 「更多」菜单」；任务/定时、技能/插件、工作区/Worktrees/Git 三组模块整合为三个双功能视图；删除 `cron`/`worktrees`/`git`/`skills` 四个视图 id。

**Architecture:** 纯 chat-ui 改动（主进程/内核零改动）。三组整合视图先行（各自独立可发），随后重写 `<cc-sidebar>` 组件（R41 产物上叠加），最后一次性收敛视图 id 与全局接线。新视图沿用既有范式：`views/*.ts` 纯渲染 + `app-*.ts` 入口/props 组装 + `controllers/*.ts` 状态编排；模块级 UI 状态（tab/菜单开关）对齐 app-skills 的 `skillsSubTab` 模式。

**Tech Stack:** TypeScript 5 + Lit（LitElement 子组件 + shouldUpdate props 浅比较）+ node:test 源码审计测试；样式走既有 CSS 分块（sidebar.css/misc.css/workspace.css/settings.css）+ design token。

**设计文档：** `docs/specs/2026-08-28-stream-flow-and-sidebar-design.md`（第二期 = 2.1–2.7 节）

**项目硬约定（每个任务都适用）：**
- 测试命令：`npm test`（全量）；chat-ui 单测快速验证：chat-ui 测试走 node:test，编译后由 `scripts/run-chat-ui-tests.js` 递归收集 `.test-dist/**/*.test.js` 运行（新增/改名 `.test.ts` 自动发现）；快速跑单个：`npx tsc -p chat-ui/tsconfig.test.json && node --test chat-ui/ui/.test-dist/ui/src/ui/<path>.test.js`（产物 ESM，需 `.test-dist/package.json` 标 `type:module`——脚本已写）
- 源码审计测试（钉 UI 接线）参照 `git-ui.test.ts` / `cc-sidebar.test.ts` 模式：`readFileSync` 读源码 + 正则断言；跨行正则用 `\s/[\s\S]`（源文件 CRLF）；负向断言先剥注释
- 视图接线点（gotchas #49）：registry（id+meta+INJECTABLE_VIEWS）+ app-render renderActiveView + app-render sidebar props，三处同步
- 不主动 `git commit`，除非到达任务内的提交步骤（用户已授权本计划内的提交）
- 样式禁止硬编码 hex；transition 用具体属性；`prefers-reduced-motion` 尊重；按钮右对齐；token 名以 `shared/design-tokens.css` + `styles/tokens-ext.css` 现行名为准（R38 体系：`--hairline`/`--radius-*`/`--shadow-*`/`--ease-standard`）

---

## 任务顺序与依赖

```
Task 1（任务双 tab） ─┐
Task 2（扩展双 tab）  ─┼─→ Task 4（侧边栏图标轨）─→ Task 5（视图 id 收敛）─→ Task 6（验证+审查+发版）
Task 3（工作区融合）  ─┘
```

Task 1–3 互不依赖、可并行；Task 4 依赖前三者的新入口函数（`openTasksView(state,"cron")` / `openExtensionsView` / `openWorkspaceView(state,"git")`）；Task 5 删除 Task 4 后已无入口的死视图 id。每个任务结束：全量测试 0 fail + 独立 commit。

---

### Task 1: 任务页双 tab（运行记录 / 定时任务）

**背景：** 任务与定时任务是两个 fullpage 视图（`tasks`/`cron`）。整合为单视图双 tab：顶层 tab 栏「运行记录 / 定时任务」，`cron` 视图内容整体作为定时 tab 内容；任务卡（`runtime==="cron"`）显示来源并可跳定时 tab；定时任务详情「最近运行」链回运行记录 tab。「启用中定时任务数」徽标从侧边栏降为定时 tab 内徽标（侧边栏徽标随 Task 4 一并移除）。

**Files:**
- Modify: `chat-ui/ui/src/ui/views/tasks.ts`（tab 栏 + props 扩展 + 任务卡联动）
- Modify: `chat-ui/ui/src/ui/app-tasks.ts`（tab 模块态 + cronSlot 组装）
- Modify: `chat-ui/ui/src/ui/app-cron.ts`（`renderCronView` 透传 `onOpenRunsTab`）
- Modify: `chat-ui/ui/src/ui/views/cron-manage.ts`（详情 run 卡「在运行记录中查看」链接）
- Modify: `chat-ui/ui/src/ui/app-render.ts`（`onOpenCron` 改路由到任务页定时 tab）
- Create: `chat-ui/ui/src/ui/tasks-view.test.ts`（源码审计）

- [ ] **Step 1: 写失败测试（源码审计）**

新建 `chat-ui/ui/src/ui/tasks-view.test.ts`（node:test + `readFileSync`，模式同 `git-ui.test.ts`）：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function src(rel: string): string {
  return readFileSync(new URL(`../../../../src/ui/${rel}`, import.meta.url), "utf8");
}

test("views/tasks.ts：顶层双 tab 栏（运行记录/定时任务）", () => {
  const s = src("views/tasks.ts");
  assert.match(s, /"tasks\.runsTab"/, "缺少运行记录 tab 文案");
  assert.match(s, /"tasks\.cronTab"/, "缺少定时任务 tab 文案");
  assert.match(s, /props\.tab === "cron" \? props\.cronSlot/, "定时 tab 应渲染 cronSlot");
  assert.match(s, /props\.cronJobCount > 0/, "定时 tab 应有启用中任务数徽标");
});

test("views/tasks.ts：runtime==='cron' 任务卡显示来源并可跳定时 tab", () => {
  const s = src("views/tasks.ts");
  assert.match(s, /task\.runtime === "cron"/, "缺少 cron 运行时分支");
  assert.match(s, /props\.onOpenCronTab\(\)/, "任务卡缺少跳定时 tab 的点击接线");
  assert.match(s, /"tasks\.viewCronJob"/, "缺少「查看定时任务」文案");
});

test("app-tasks.ts：openTasksView 支持 tab 参数并预拉对应数据", () => {
  const s = src("app-tasks.ts");
  assert.match(s, /export function openTasksView\(state: AppViewState, tab: TasksViewTab = "runs"\)/, "openTasksView 应带 tab 参数");
  assert.match(s, /tab === "cron"/, "定时 tab 应预拉 loadCronJobs");
  assert.match(s, /loadCronJobs\(state\)/, "缺少 loadCronJobs 调用");
});

test("app-render.ts：onOpenCron 路由到任务页定时 tab", () => {
  const s = src("app-render.ts");
  assert.match(s, /onOpenCron: \(\) => openTasksView\(state, "cron"\)/, "onOpenCron 应打开任务页定时 tab");
});

test("cron-manage：详情「最近运行」链回运行记录 tab", () => {
  const s = src("views/cron-manage.ts");
  assert.match(s, /onOpenRunsTab\?: \(\) => void/, "CronManageProps 应有 onOpenRunsTab");
  assert.match(s, /props\.onOpenRunsTab\(\)/, "run 卡缺少跳运行记录 tab 接线");
  assert.match(s, /"cron\.viewRuns"/, "缺少「在运行记录中查看」文案");
});

test("i18n：新 key 双区齐全", () => {
  const zh = src("i18n/zh.ts");
  const en = src("i18n/en.ts");
  for (const key of ['"tasks.runsTab"', '"tasks.cronTab"', '"tasks.viewCronJob"', '"cron.viewRuns"']) {
    assert.ok(zh.includes(key), `zh.ts 缺少 ${key}`);
    assert.ok(en.includes(key), `en.ts 缺少 ${key}`);
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx tsc -p chat-ui/tsconfig.test.json && node --test chat-ui/ui/.test-dist/ui/src/ui/tasks-view.test.js`
Expected: FAIL（结构尚不存在）

- [ ] **Step 3: i18n 新键（zh/en）**

`chat-ui/ui/src/ui/i18n/zh.ts` 与 `en.ts` 各追加（分区位置不限，键集合一致性由 i18n.test.ts 守护）：

```ts
"tasks.runsTab": "运行记录",          // en: "Runs"
"tasks.cronTab": "定时任务",          // en: "Scheduled"
"tasks.viewCronJob": "查看定时任务",   // en: "View schedule"
"cron.viewRuns": "在运行记录中查看",   // en: "View in runs"
```

- [ ] **Step 4: views/tasks.ts 改造**

1. 类型追加：

```ts
export type TasksViewTab = "runs" | "cron";

export type TasksProps = {
  // ……既有字段全部保留……
  tab: TasksViewTab;
  /** 定时 tab 内容（由装配层组装 renderCronView，避免 views 层反向依赖 app-cron） */
  cronSlot: TemplateResult;
  /** 启用中定时任务数（定时 tab 徽标） */
  cronJobCount: number;
  onTabChange: (tab: TasksViewTab) => void;
  /** runtime === "cron" 任务卡「查看定时任务」→ 切定时 tab */
  onOpenCronTab: () => void;
};
```

（顶部 `import { html, nothing } from "lit";` 改为 `import { html, nothing, type TemplateResult } from "lit";`）

2. `renderTasks` 外层加 tab 栏、cron tab 渲染 slot；原内容整体下移为私有函数 `renderTasksRuns(props)`（**原样搬迁，不改逻辑**）：

```ts
export function renderTasks(props: TasksProps) {
  return html`
    <div class="ts-layout panel">
      <div class="ts-tabs" role="tablist">
        <button
          class="ts-tab ${props.tab === "runs" ? "ts-tab--active" : ""}"
          type="button"
          role="tab"
          aria-selected=${props.tab === "runs" ? "true" : "false"}
          @click=${() => props.onTabChange("runs")}
        >${t("tasks.runsTab")}</button>
        <button
          class="ts-tab ${props.tab === "cron" ? "ts-tab--active" : ""}"
          type="button"
          role="tab"
          aria-selected=${props.tab === "cron" ? "true" : "false"}
          @click=${() => props.onTabChange("cron")}
        >${t("tasks.cronTab")}${props.cronJobCount > 0
          ? html`<span class="ts-tab__badge">${props.cronJobCount}</span>`
          : nothing}</button>
      </div>
      ${props.tab === "cron" ? props.cronSlot : renderTasksRuns(props)}
    </div>
  `;
}
```

3. `renderTaskCard` 的 `ts-card__meta` 区，在 `sessionKey` 按钮旁追加：

```ts
        ${task.runtime === "cron"
          ? html`<button
              class="btn btn--sm"
              type="button"
              @click=${() => props.onOpenCronTab()}
            >
              ${t("tasks.viewCronJob")}
            </button>`
          : nothing}
```

4. tab 栏样式进 `styles/misc.css` 末尾（`ts-*` 系列所在分块，全 token）：

```css
/* 任务页顶层双 tab（R42） */
.ts-tabs { display: flex; gap: var(--spacer, 8px); padding: 12px 16px 0; }
.ts-tab { padding: 6px 12px; border: none; background: transparent; border-radius: var(--radius-md, 8px); color: var(--text-secondary); font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.ts-tab:hover { background: var(--surface-hover); color: var(--text-primary); }
.ts-tab--active { color: var(--brand-500); background: var(--brand-soft, rgba(14, 165, 233, 0.1)); }
.ts-tab__badge { min-width: 18px; height: 18px; padding: 0 5px; border-radius: var(--radius-full, 999px); background: var(--brand-500); color: #fff; font-size: 11px; line-height: 18px; text-align: center; }
```

（实现时以 tokens-ext.css 现行 token 名为准，缺 `--surface-hover`/`--brand-soft` 时用既有等价 token 或 `--brand-500` 加 alpha 的既有 token；**禁止硬编码 hex**，`#fff` 若项目有 `--text-on-accent` 或 `--white` 则用之。）

- [ ] **Step 5: app-tasks.ts 改造**

```ts
import { renderTasks, type TasksViewTab } from "./views/tasks.ts";
import { renderCronView } from "./app-cron.ts";
import { loadCronJobs } from "./controllers/cron.ts";
import { isExpiredOneShot } from "./presenter.ts";
// ……既有 import 保留……

// 任务页 tab 模块态（对齐 app-skills 的 skillsSubTab 模式；视图切走不重置，
// 下次打开保留上次 tab——与官方行为一致）
let tasksViewTab: TasksViewTab = "runs";

// 打开任务实时视图（tab 缺省 runs；cron 时预拉定时任务列表）
export function openTasksView(state: AppViewState, tab: TasksViewTab = "runs") {
  tasksViewTab = tab;
  setCryoClawView(state, "tasks");
  void loadTasks(state);
  if (tab === "cron") {
    void loadCronJobs(state);
  }
}

export function renderTasksView(state: AppViewState) {
  return renderTasks({
    // ……既有 props 不变……
    tab: tasksViewTab,
    cronJobCount: state.cronJobs.filter((j) => j.enabled !== false && !isExpiredOneShot(j)).length,
    // 仅定时 tab 活跃时才构建 cron 内容（runs tab 每帧渲染不白花成本）
    cronSlot: tasksViewTab === "cron"
      ? renderCronView(state, {
          onOpenRunsTab: () => {
            tasksViewTab = "runs";
            state.requestUpdate();
          },
        })
      : html``,
    onTabChange: (tab) => {
      tasksViewTab = tab;
      if (tab === "cron") {
        void loadCronJobs(state);
      }
      state.requestUpdate();
    },
    onOpenCronTab: () => {
      tasksViewTab = "cron";
      void loadCronJobs(state);
      state.requestUpdate();
    },
  });
}
```

（顶部追加 `import { html } from "lit";`）

- [ ] **Step 6: app-cron.ts + cron-manage.ts 透传**

`app-cron.ts` `renderCronView` 签名与调用：

```ts
export function renderCronView(
  state: AppViewState,
  opts?: { onOpenRunsTab?: () => void },
) {
  return renderCronManage({
    // ……既有 props 不变……
    onOpenRunsTab: opts?.onOpenRunsTab ?? (() => {}),
  });
}
```

`views/cron-manage.ts` `CronManageProps` 追加字段，`renderDetail` 的 run 卡（`cm-detail__run` 行，`openChat` 按钮旁）追加：

```ts
  onOpenRunsTab?: () => void;
```

```ts
                      ${props.onOpenRunsTab
                        ? html`<button class="cm-detail__run-link" type="button"
                          @click=${() => props.onOpenRunsTab!()}>${t("cron.viewRuns")}</button>`
                        : nothing}
```

- [ ] **Step 7: app-render.ts 路由改线**

`app-render.ts` 中：

```ts
onOpenCron: () => setCryoClawView(state, "cron"),
```

改为：

```ts
onOpenCron: () => openTasksView(state, "cron"),
```

（`openTasksView` 已导入；`cronActive: cryoclawView === "cron"` 暂保留——`cron` 视图 id 直到 Task 5 才删除，此间无 UI 入口能到达）

- [ ] **Step 8: 运行确认通过**

Run: `npx tsc -p chat-ui/tsconfig.test.json && node --test chat-ui/ui/.test-dist/ui/src/ui/tasks-view.test.js`
Expected: 全 PASS

再跑全量：`npm test`
Expected: 0 fail（既有 716 全绿 + 新增审计）

- [ ] **Step 9: Commit**

```bash
git add chat-ui/ui/src/ui/views/tasks.ts chat-ui/ui/src/ui/app-tasks.ts chat-ui/ui/src/ui/app-cron.ts chat-ui/ui/src/ui/views/cron-manage.ts chat-ui/ui/src/ui/app-render.ts chat-ui/ui/src/ui/tasks-view.test.ts chat-ui/ui/src/ui/i18n/zh.ts chat-ui/ui/src/ui/i18n/en.ts chat-ui/ui/src/styles/misc.css
git commit -m "feat(chat-ui): 任务页整合为运行记录/定时任务双 tab（R42 第二期 T1）"
```

---

### Task 2: 扩展视图（技能 / 插件双 tab）

**背景：** 技能视图（`skills`，网关 skills.* + clawhub 商店）与设置页插件 tab（主进程 IPC + config.patch）整合为新视图 `extensions`；插件从设置页迁出（settings 的 `extensions` 分组随之删除）；插件 tab 状态复位从 `cleanupSettingsView` 迁为 `extensions` 视图 leave hook。

**Files:**
- Create: `chat-ui/ui/src/ui/app-extensions.ts`
- Modify: `chat-ui/ui/src/ui/app-skills.ts`（删 `openSkillsView`，`renderSkillsView` 保留）
- Modify: `chat-ui/ui/src/ui/views/settings/tab-plugins.ts`（导出更名 `renderPluginsView`/`resetPluginsView`）
- Modify: `chat-ui/ui/src/ui/views/settings/settings-view.ts`（删 plugins tab 分支；`invalidateAllSettings` 保留 `resetPluginsView`）
- Modify: `chat-ui/ui/src/ui/views/settings/settings-constants.ts`（删 plugins 条目）
- Modify: `chat-ui/ui/src/ui/views/registry.ts`（加 `extensions`）
- Modify: `chat-ui/ui/src/ui/app-render.ts`（renderActiveView 分支 + sidebar props 更名）
- Modify: `chat-ui/ui/src/ui/components/cc-sidebar.ts`（props 更名）
- Modify: `chat-ui/ui/src/ui/components/cc-sidebar.test.ts`（DATA_FIELDS 清单同步）
- Create: `chat-ui/ui/src/ui/extensions-ui.test.ts`（源码审计）
- Modify: `chat-ui/ui/src/ui/i18n/zh.ts` / `en.ts`（新键 + 删 `settings.nav.plugins`）

- [ ] **Step 1: 写失败测试（源码审计）**

新建 `chat-ui/ui/src/ui/extensions-ui.test.ts`：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function src(rel: string): string {
  return readFileSync(new URL(`../../../../src/ui/${rel}`, import.meta.url), "utf8");
}

test("registry：extensions 视图 id + fullpage meta", () => {
  const s = src("views/registry.ts");
  assert.match(s, /"extensions",/, "CRYOCLAW_VIEW_IDS 应包含 extensions");
  assert.match(s, /extensions:\s*\{\s*id: "extensions", fullpage: true, titlebarBack: true \}/, "缺少 extensions meta");
});

test("app-render：renderActiveView 分发 extensions + sidebar props 更名", () => {
  const s = src("app-render.ts");
  assert.match(s, /case "extensions":\s*\n\s*return renderExtensionsView\(state\)/, "缺少渲染分支");
  assert.match(s, /extensionsActive: cryoclawView === "extensions"/, "缺少 extensionsActive prop");
  assert.match(s, /onOpenExtensions: \(\) => openExtensionsView\(state\)/, "缺少 onOpenExtensions prop");
  assert.ok(!/skillsActive: cryoclawView === "skills"/.test(s), "skillsActive prop 应已移除");
});

test("cc-sidebar：技能导航项更名为扩展入口", () => {
  const s = src("components/cc-sidebar.ts");
  assert.match(s, /t\("sidebar\.extensions"\)/, "缺少扩展入口文案");
  assert.match(s, /props\.onOpenExtensions/, "导航项未接 onOpenExtensions");
  assert.match(s, /extensionsActive \? "active"/, "导航项未接 active 态");
});

test("settings：plugins tab 迁出（SETTINGS_TABS 无 plugins，settings-view 无渲染分支）", () => {
  const tabs = src("views/settings/settings-constants.ts");
  assert.ok(!/"plugins"/.test(tabs), "SETTINGS_TABS 不应再有 plugins");
  const view = src("views/settings/settings-view.ts");
  assert.ok(!/renderTabPlugins\(state\)/.test(view), "settings-view 不应再渲染插件 tab");
  assert.match(view, /resetPluginsView\(\);/, "invalidateAllSettings 仍应复位插件视图状态（备份恢复后新鲜度）");
});

test("扩展视图：双 tab + 离开复位（leave hook 迁移）", () => {
  const s = src("app-extensions.ts");
  assert.match(s, /registerViewLeaveHook\("extensions", \(\) => resetPluginsView\(\)\)/, "缺少离开视图复位插件状态的 hook");
  assert.match(s, /"extensions\.tabSkills"/, "缺少技能 tab 文案");
  assert.match(s, /"extensions\.tabPlugins"/, "缺少插件 tab 文案");
  assert.match(s, /renderPluginsView\(state\)/, "插件 tab 未接 renderPluginsView");
  const skills = src("app-skills.ts");
  assert.ok(!/setCryoClawView\(state, "skills"\)/.test(skills), "app-skills 不应再切换 skills 视图");
});

test("i18n：新键双区齐全，settings.nav.plugins 已删", () => {
  const zh = src("i18n/zh.ts");
  const en = src("i18n/en.ts");
  for (const key of ['"sidebar.extensions"', '"extensions.tabSkills"', '"extensions.tabPlugins"']) {
    assert.ok(zh.includes(key), `zh.ts 缺少 ${key}`);
    assert.ok(en.includes(key), `en.ts 缺少 ${key}`);
  }
  assert.ok(!zh.includes('"settings.nav.plugins"'), "zh.ts 应删除 settings.nav.plugins");
  assert.ok(!en.includes('"settings.nav.plugins"'), "en.ts 应删除 settings.nav.plugins");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx tsc -p chat-ui/tsconfig.test.json && node --test chat-ui/ui/.test-dist/ui/src/ui/extensions-ui.test.js`
Expected: FAIL（结构尚不存在）

- [ ] **Step 3: i18n 新键（zh/en）**

`zh.ts` / `en.ts` 各追加：`"sidebar.extensions": "扩展" / "Extensions"`、`"extensions.tabSkills": "技能" / "Skills"`、`"extensions.tabPlugins": "插件" / "Plugins"`；删除 `"settings.nav.plugins"`（zh/en 同步）。

- [ ] **Step 4: 新建 app-extensions.ts（完整代码）**

```ts
/**
 * 扩展视图（R42 第二期）—— 技能（网关 skills.* + clawhub 商店）与插件
 * （主进程 IPC + config.patch）双 tab 的统一视图。承接原 skills 视图与
 * 设置页 plugins tab 的入口职责；插件 tab 状态复位由 leave hook 接管
 * （原 cleanupSettingsView 的 resetPluginsTab 语义迁移）。
 */
import { html } from "lit";
import type { AppViewState } from "./app-view-state.ts";
import { renderSkillsView } from "./app-skills.ts";
import {
  renderPluginsView,
  resetPluginsView,
} from "./views/settings/tab-plugins.ts";
import { registerViewLeaveHook, setCryoClawView } from "./app-view-switch.ts";
import { loadSkills } from "./controllers/skills.ts";
import { t } from "./i18n.ts";

export type ExtensionsViewTab = "skills" | "plugins";

// tab 模块态（对齐 app-skills 的 skillsSubTab 模式）
let extensionsViewTab: ExtensionsViewTab = "skills";

// 离开扩展视图复位插件 tab 状态：下次打开重新拉取（与 settings 页离开复位语义一致）
registerViewLeaveHook("extensions", () => resetPluginsView());

// 打开扩展视图（tab 缺省 skills；skills 时预拉已安装列表）
export function openExtensionsView(state: AppViewState, tab: ExtensionsViewTab = "skills") {
  extensionsViewTab = tab;
  setCryoClawView(state, "extensions");
  if (tab === "skills") {
    void loadSkills(state);
  }
}

export function renderExtensionsView(state: AppViewState) {
  return html`
    <div class="ext-layout">
      <div class="ext-tabs" role="tablist">
        <button
          class="ext-tab ${extensionsViewTab === "skills" ? "active" : ""}"
          type="button"
          role="tab"
          aria-selected=${extensionsViewTab === "skills" ? "true" : "false"}
          @click=${() => {
            extensionsViewTab = "skills";
            void loadSkills(state);
            state.requestUpdate();
          }}
        >${t("extensions.tabSkills")}</button>
        <button
          class="ext-tab ${extensionsViewTab === "plugins" ? "active" : ""}"
          type="button"
          role="tab"
          aria-selected=${extensionsViewTab === "plugins" ? "true" : "false"}
          @click=${() => {
            extensionsViewTab = "plugins";
            state.requestUpdate();
          }}
        >${t("extensions.tabPlugins")}</button>
      </div>
      ${extensionsViewTab === "skills" ? renderSkillsView(state) : renderPluginsView(state)}
    </div>
  `;
}
```

- [ ] **Step 5: app-skills.ts 删入口**

删除 `openSkillsView` 函数（视图切换职责移交 app-extensions）；`renderSkillsView` 与模块态（skillsSubTab/skillStoreState/商店加载）全部保留。删除后 `setCryoClawView` import 若无其他引用一并移除。

- [ ] **Step 6: tab-plugins.ts 导出更名**

`renderTabPlugins` → `renderPluginsView`、`resetPluginsTab` → `resetPluginsView`（函数体与模块态不动）；`init`/`loadInstalled` 等内部函数不变。

- [ ] **Step 7: settings-view.ts + settings-constants.ts 迁出插件**

`settings-constants.ts` `SETTINGS_TABS` 删除 `{ id: "plugins", ... }` 条目（`extensions` 分组随之消失）。
`settings-view.ts`：删 import `renderTabPlugins`（保留 `resetPluginsView` import）；`cleanupTab` 删 `case "plugins"`；`renderActiveTab` 删 `case "plugins"`；`cleanupSettingsView` 删 `resetPluginsTab()` 调用；`invalidateAllSettings` 把 `resetPluginsTab()` 改为 `resetPluginsView()`（备份恢复后插件列表新鲜度）。

- [ ] **Step 8: registry + app-render + cc-sidebar 接线**

`registry.ts`：`CRYOCLAW_VIEW_IDS` 追加 `"extensions"`；`CRYOCLAW_VIEW_META` 加 `extensions: { id: "extensions", fullpage: true, titlebarBack: true }`；`INJECTABLE_VIEWS` 追加 `"extensions"`（与 skills 同为可注入视图）。

`app-render.ts`：
- import 改：`import { openSkillsView, renderSkillsView } from "./app-skills.ts";` → `import { openExtensionsView, renderExtensionsView } from "./app-extensions.ts";`
- `renderActiveView` 加 `case "extensions": return renderExtensionsView(state);`（`case "skills"` 暂留到 Task 5）
- sidebar props：删 `skillsActive`/`onOpenSkillStore` 两字段，加：

```ts
            extensionsActive: cryoclawView === "extensions",
            onOpenExtensions: () => openExtensionsView(state),
```

`cc-sidebar.ts`：
- `SidebarProps`：`skillsActive: boolean;` → `extensionsActive: boolean;`；`onOpenSkillStore: () => void;` → `onOpenExtensions: () => void;`
- `DATA_FIELDS`：`"skillsActive"` → `"extensionsActive"`
- 模板中技能导航按钮：`${props.skillsActive ? "active" : ""}` → `${props.extensionsActive ? "active" : ""}`、`@click=${props.onOpenSkillStore}` → `@click=${props.onOpenExtensions}`、`${t("sidebar.skillStore")}` → `${t("sidebar.extensions")}`（图标 `icons.puzzle` 不变）

`cc-sidebar.test.ts`：`DATA_FIELDS` 断言清单 `"skillsActive"` → `"extensionsActive"`。

- [ ] **Step 9: 运行确认通过**

Run: 审计测试 → 全 PASS；`npm test` → 0 fail；`npm run build` + `npx tsc --noEmit` 通过。

- [ ] **Step 10: Commit**

```bash
git add chat-ui/ui/src/ui/app-extensions.ts chat-ui/ui/src/ui/app-skills.ts chat-ui/ui/src/ui/views/settings/tab-plugins.ts chat-ui/ui/src/ui/views/settings/settings-view.ts chat-ui/ui/src/ui/views/settings/settings-constants.ts chat-ui/ui/src/ui/views/registry.ts chat-ui/ui/src/ui/app-render.ts chat-ui/ui/src/ui/components/cc-sidebar.ts chat-ui/ui/src/ui/components/cc-sidebar.test.ts chat-ui/ui/src/ui/extensions-ui.test.ts chat-ui/ui/src/ui/i18n/zh.ts chat-ui/ui/src/ui/i18n/en.ts
git commit -m "feat(chat-ui): 技能/插件整合为扩展视图（R42 第二期 T2）"
```

---

### Task 3: 工作区页整合（IDE 式：文件树 + Git 变更 + Worktrees）

**背景：** `workspace`（文件浏览）/`worktrees`（管理）/`git`（索引/审查/提交）三视图融合为单一工作区页：左导航列（仓库选择 + 文件树 + 「Git 变更」固定节点 + Worktrees 区块）+ 右主区（文件预览 | Git 面板）。选中 worktree 节点自动切换仓库并刷 git 状态（补上缺失的 worktree→git 联动）；`workspaceSetRoot` 白名单注册收敛为一次（workspace 初始化注册，git 面板不再重复）；`views/workspace.ts` 内嵌加载逻辑抽入 `controllers/workspace.ts`；降级语义（无 git/断连/提交身份引导）全部保留。

**Files:**
- Modify: `chat-ui/ui/src/ui/controllers/workspace.ts`（状态与加载逻辑抽入）
- Rewrite: `chat-ui/ui/src/ui/views/workspace.ts`（左导航 + 右主区布局，纯渲染）
- Create: `chat-ui/ui/src/ui/app-workspace.ts`（open/render 组装，模式同 app-tasks）
- Modify: `chat-ui/ui/src/ui/views/worktrees.ts`（compact 变体）+ `app-worktrees.ts`（删 openWorktreesView，render 加 opts）
- Modify: `chat-ui/ui/src/ui/views/git.ts`（embedded 变体，去仓库选择）+ `app-git.ts`（删 openGitView，render 加 opts）
- Modify: `chat-ui/ui/src/ui/controllers/git.ts`（`initGitPanel` 接收 workspaceRoot，去内部 resolve+setRoot）
- Modify: `chat-ui/ui/src/ui/app-render.ts`（workspace 分支换新入口；worktrees/git 入口暂指工作区页）
- Modify: `chat-ui/ui/src/ui/app-chat-props.ts`（「在 git 中查看」→ 工作区页 git 模式）
- Modify: `chat-ui/ui/src/styles/workspace.css`（wk-* 新布局样式）
- Create: `chat-ui/ui/src/ui/workspace-ui.test.ts` + `controllers/workspace.test.ts`

- [ ] **Step 1: 写失败测试（源码审计）**

新建 `workspace-ui.test.ts`（node:test，模式同 git-ui.test.ts）：

```ts
test("app-workspace.ts：open 入口带 mode 参数 + 初始化链", () => {
  const s = src("app-workspace.ts");
  assert.match(s, /export function openWorkspaceView\(state: AppViewState, mode: "files" \| "git" = "files"\)/, "缺 mode 参数入口");
  assert.match(s, /initWorkspace\(state\)/, "应初始化 workspace（含白名单根注册）");
  assert.match(s, /initGitPanel\(state, /, "git 选项初始化应复用 workspace 根");
});

test("views/workspace.ts：左导航含 Git 变更节点 + 文件树 + Worktrees 区块", () => {
  const s = src("views/workspace.ts");
  assert.match(s, /"git\.title"/, "缺 Git 变更节点");
  assert.match(s, /"worktrees\.title"/, "缺 Worktrees 区块标题");
  assert.match(s, /worktreesSlot/, "Worktrees 区块应以 slot 注入");
  assert.match(s, /gitSlot/, "Git 面板应以 slot 注入右主区");
  assert.match(s, /gitRepoOptions/, "左导航应渲染仓库选择");
});

test("views/workspace.ts：worktree 节点选中 → 切仓库 + 右区切 git（联动补全）", () => {
  const s = src("app-workspace.ts");
  assert.match(s, /selectGitRepo\(state, repoPath\)/, "worktree 节点应切换 git 仓库上下文");
  assert.match(s, /selectWorkspaceMode\("git"\)/, "右区应切 git 面板");
});

test("controllers/git.ts：initGitPanel 不再自解析根/注册白名单（收敛为一次）", () => {
  const s = src("controllers/git.ts");
  assert.ok(!/workspaceSetRoot/.test(s), "initGitPanel 不应再调 workspaceSetRoot");
  assert.match(s, /initGitPanel\(state: GitPanelState, workspaceRoot: string \| null\)/, "应接收外部传入的 workspaceRoot");
});

test("app-chat-props.ts：文件变更「在 git 中查看」→ 工作区页 git 模式", () => {
  const s = src("app-chat-props.ts");
  assert.match(s, /onOpenGitView: \(\) => openWorkspaceView\(state, "git"\)/, "应路由到工作区页 git 模式");
});

test("app-render.ts：workspace 分支渲染新工作区视图", () => {
  const s = src("app-render.ts");
  assert.match(s, /case "workspace":\s*\n\s*return renderWorkspaceView\(state\)/, "workspace 分支应走新渲染");
});

test("views/worktrees.ts：compact 变体保留 GC/恢复/删除/打开能力", () => {
  const s = src("views/worktrees.ts");
  assert.match(s, /opts\?: \{ compact\?: boolean \}/, "缺 compact 选项");
  assert.match(s, /props\.onGc/, "compact 态仍应有 GC 入口");
  assert.match(s, /props\.onRestore/, "compact 态仍应有恢复入口");
});

test("views/git.ts：embedded 变体隐藏仓库选择、保留三分组/提交", () => {
  const s = src("views/git.ts");
  assert.match(s, /showRepoSelect/, "缺 embedded 选项");
  assert.match(s, /groupGitEntries\(props\.status\.entries\)/, "三分组应保留");
  assert.match(s, /"git\.commitTitle"/, "提交框应保留");
});
```

`controllers/workspace.test.ts`（纯函数，node:test）：

```ts
import { selectWorkspaceMode, workspaceViewState } from "./workspace.ts";

test("selectWorkspaceMode 切换右主区模式", () => {
  selectWorkspaceMode("git");
  assert.strictEqual(workspaceViewState.mode, "git");
  selectWorkspaceMode("files");
  assert.strictEqual(workspaceViewState.mode, "files");
});
```

- [ ] **Step 2: 运行确认失败** — Expected: FAIL（结构尚不存在）

- [ ] **Step 3: controllers/workspace.ts 抽取（完整代码追加）**

```ts
// ── 工作区视图状态与加载逻辑（R42 自 views/workspace.ts 抽入，对齐 controllers 范式）──

export type WorkspaceFileItem = { name: string; isDir: boolean; path: string };

export type WorkspaceViewState = {
  root: string | null;
  currentPath: string | null;
  items: WorkspaceFileItem[];
  loading: boolean;
  error: string | null;
  selectedFile: string | null;
  selectedFileName: string | null;
  fileContent: string | null;
  fileLoading: boolean;
  /** 右主区模式：files = 文件预览，git = Git 变更面板 */
  mode: "files" | "git";
};

export const workspaceViewState: WorkspaceViewState = {
  root: null,
  currentPath: null,
  items: [],
  loading: false,
  error: null,
  selectedFile: null,
  selectedFileName: null,
  fileContent: null,
  fileLoading: false,
  mode: "files",
};

// 加载序号：防止快速连点时旧响应覆盖新响应
let dirLoadSeq = 0;
let fileLoadSeq = 0;

export function selectWorkspaceMode(mode: "files" | "git") {
  workspaceViewState.mode = mode;
}
```

然后把 `views/workspace.ts` 中的 `loadDirectory`/`loadFileContent`/`initWorkspace`/`handleItemClick`/`navigateUp` 整体迁入本模块并导出（命名 `loadWorkspaceDirectory`/`loadWorkspaceFile`/`initWorkspace`/`openWorkspaceDirectory`/`navigateWorkspaceUp`；`workspaceState` 引用统一改为 `workspaceViewState`；`isTextFile`/`TEXT_EXTENSIONS` 也随迁供 view 层预览判断复用）；`initWorkspace` 的 `workspaceSetRoot` 注册保留（全应用唯一注册点）。`resolveAgentWorkspacePath` 原位保留。

- [ ] **Step 4: views/workspace.ts 重写（布局代码）**

```ts
/**
 * 工作区页（R42 第二期）—— IDE 式融合：左导航（仓库选择/文件树/Git 变更节点/
 * Worktrees 区块）+ 右主区（文件预览 | Git 面板 slot）。纯渲染，状态在
 * controllers/workspace.ts 与 app state；git/worktrees 内容以 slot 注入。
 */
import { html, nothing, type TemplateResult } from "lit";
import type { AppViewState } from "../app-view-state.ts";
import {
  isTextFile,
  navigateWorkspaceUp,
  openWorkspaceDirectory,
  workspaceViewState,
} from "../controllers/workspace.ts";
import { t, tWithDetail } from "../i18n.ts";
import { icons } from "../icons.ts";

export type WorkspaceViewOptions = {
  gitSlot: TemplateResult;
  worktreesSlot: TemplateResult;
  onSelectGitNode: () => void;
  onOpenFiles: () => void;
  onRepoChange: (path: string) => void;
  /** worktree 区块节点点击 → 切换仓库上下文 + 右区切 git */
  onSelectWorktreeRepo: (path: string) => void;
};

// 相对路径（面包屑展示）
function relativePath(root: string, current: string): string {
  if (!current.startsWith(root)) return current;
  return current.slice(root.length).replace(/^[/\\]/, "");
}

export function renderWorkspaceView(state: AppViewState, opts: WorkspaceViewOptions) {
  const ws = workspaceViewState;
  const isAtRoot = !ws.currentPath || !ws.root || ws.currentPath === ws.root;
  const relPath = ws.root && ws.selectedFile ? relativePath(ws.root, ws.selectedFile) : "";
  const rootName = ws.root?.split("/").pop() ?? "workspace";
  const breadcrumb = relPath ? `${rootName}/${relPath}` : rootName;
  const canPreview = ws.selectedFileName ? isTextFile(ws.selectedFileName) : false;

  return html`
    <div class="wk-layout">
      <aside class="wk-nav">
        <select
          class="wk-nav__repo"
          .value=${state.gitRepoPath ?? ""}
          ?disabled=${state.gitRepoOptions.length === 0}
          @change=${(e: Event) => opts.onRepoChange((e.target as HTMLSelectElement).value)}
        >
          ${state.gitRepoOptions.map((o) => html`<option value=${o.path} ?selected=${o.path === state.gitRepoPath}>
            ${o.kind === "workspace" ? t("git.repoWorkspace") : `${t("git.repoWorktree")} · ${o.branch || o.path}`}
          </option>`)}
        </select>
        <div class="wk-nav__node ${ws.mode === "files" ? "active" : ""}" @click=${opts.onOpenFiles}>
          ${icons.folder}<span>${t("workspace.files")}</span>
        </div>
        <div class="wk-nav__tree">
          ${!isAtRoot ? html`<div class="wk-nav__item wk-nav__item--back" @click=${() => navigateWorkspaceUp(state)}>..</div>` : nothing}
          ${ws.loading && ws.items.length === 0
            ? html`<div class="wk-nav__hint">${t("workspace.loading")}</div>`
            : ws.error && ws.items.length === 0
              ? html`<div class="wk-nav__hint">${ws.error}</div>`
              : ws.items.map((item) => html`
                  <div class="wk-nav__item ${item.isDir ? "wk-nav__item--dir" : ""} ${ws.selectedFile === item.path && ws.mode === "files" ? "active" : ""}"
                    @click=${() => openWorkspaceDirectory(state, item)}>
                    <span class="wk-nav__item-icon">${item.isDir ? icons.folder : icons.fileText}</span>
                    <span class="wk-nav__item-name" title=${item.name}>${item.name}</span>
                  </div>`)}
        </div>
        <div class="wk-nav__node wk-nav__node--git ${ws.mode === "git" ? "active" : ""}" @click=${opts.onSelectGitNode}>
          ${icons.diff}<span>${t("git.title")}</span>
        </div>
        <section class="wk-nav__section">
          <div class="wk-nav__section-title">${t("worktrees.title")}</div>
          ${opts.worktreesSlot}
        </section>
      </aside>
      <section class="wk-main">
        ${ws.mode === "git" ? opts.gitSlot : html`
          <div class="wk-preview">
            ${ws.selectedFile ? html`
              <div class="wk-preview__header"><span title=${ws.selectedFile}>${breadcrumb}</span></div>
              <div class="wk-preview__content">
                ${ws.fileLoading
                  ? html`<div class="wk-preview__placeholder">${t("workspace.loading")}</div>`
                  : ws.fileContent != null
                    ? html`<pre class="wk-preview__text">${ws.fileContent}</pre>`
                    : canPreview && ws.error
                      ? html`<div class="wk-preview__placeholder wk-preview__error">${tWithDetail("workspace.loadFailed", ws.error)}</div>`
                      : canPreview
                        ? html`<div class="wk-preview__placeholder">${t("workspace.loading")}</div>`
                        : html`<div class="wk-preview__placeholder">${t("workspace.noPreview")}</div>`}
              </div>`
            : html`<div class="wk-preview__empty panel__empty"><span>${t("workspace.selectFile")}</span></div>`}
          </div>`}
      </section>
    </div>
  `;
}
```

（原 `renderWorkspaceView` 的 `workspace__*` 类名弃用，样式新写 `wk-*`；面包屑/预览判定逻辑从旧实现等价迁移。）

- [ ] **Step 5: worktrees compact 变体**

`views/worktrees.ts`：`renderWorktrees(props, opts?: { compact?: boolean })`；`opts?.compact` 时卡片渲染 `wt-card--compact` 变体：名称 + branch/owner chip + 状态 chip + 图标按钮组（`onOpenChat` 会话链接 / `onOpenFolder` / `onRestore` / `onRemove`，busy 态同现有）；隐藏 `wt-card__detail`（路径）与面板级 header（标题/GC/刷新改由区块标题行承载）。**所有既有文案 key 复用**。

`app-worktrees.ts`：删 `openWorktreesView`（及 `setCryoClawView` import）；`renderWorktreesView(state, opts?: { compact?: boolean })` 透传 opts（confirm 流/onOpenChat 等 props 组装不变）。

- [ ] **Step 6: git embedded 变体**

`views/git.ts`：`renderGitPanel(props, opts?: { showRepoSelect?: boolean })`；`opts?.showRepoSelect === false` 时不渲染 `gitp-header`（标题/副标题/仓库选择）；其余（断连/无 git/非仓库/身份引导 callout、branch chips、truncated 提示、三分组、diff、提交框）全部保留。

`app-git.ts`：删 `openGitView`（及 `setCryoClawView` import）；`renderGitView(state, opts?: { showRepoSelect?: boolean })` 透传。

- [ ] **Step 7: controllers/git.ts initGitPanel 收敛**

`initGitPanel` 改为：

```ts
/** 初始化 git 面板选项：workspace 根由调用方（工作区页）解析并注册白名单一次，
 * 这里只组装仓库选项（workspace 根 + 活跃 worktree）并首刷 status。 */
export async function initGitPanel(
  state: GitPanelState,
  workspaceRoot: string | null,
): Promise<void> {
  if (state.gitAvailable === false) {
    state.gitRepoState = "no-git";
    return;
  }
  state.gitRepoOptions = buildGitRepoOptions(workspaceRoot, state.worktrees);
  const stillValid = state.gitRepoOptions.some((o) => o.path === state.gitRepoPath);
  state.gitRepoPath = stillValid ? state.gitRepoPath : (state.gitRepoOptions[0]?.path ?? null);
  await refreshGitStatus(state);
}
```

（删除函数内 `resolveAgentWorkspacePath` 调用与 `workspaceSetRoot`；`GitBridge` 类型里 `workspaceSetRoot` 成员若无其他消费一并删除。）

- [ ] **Step 8: 新建 app-workspace.ts（完整代码）**

```ts
/**
 * 工作区页入口与 props 组装（R42 第二期）。模式同 app-tasks.ts：
 * open 负责切视图 + 初始化链（workspace 根注册 → worktrees 刷新 → git 选项），
 * render 只做 slot 组装。worktree→git 联动补全：选中 worktree 节点即切换
 * 仓库上下文并刷 status。
 */
import type { AppViewState } from "./app-view-state.ts";
import { renderWorkspaceView } from "./views/workspace.ts";
import {
  initWorkspace,
  selectWorkspaceMode,
  workspaceViewState,
} from "./controllers/workspace.ts";
import { initGitPanel, selectGitRepo } from "./controllers/git.ts";
import { loadWorktrees } from "./controllers/worktrees.ts";
import { setCryoClawView } from "./app-view-switch.ts";
import { renderGitView } from "./app-git.ts";
import { renderWorktreesView } from "./app-worktrees.ts";

// 打开工作区页（mode 缺省 files；file-changes「在 git 中查看」走 git 模式）
export function openWorkspaceView(state: AppViewState, mode: "files" | "git" = "files") {
  selectWorkspaceMode(mode);
  setCryoClawView(state, "workspace");
  // 初始化链：workspace 根解析 + 白名单注册（全应用唯一注册点）→ worktrees
  // 快照刷新（git 仓库选项依赖）→ git 选项组装 + 首刷 status
  void initWorkspace(state).then(() =>
    void loadWorktrees(state).then(() => initGitPanel(state, workspaceViewState.root)),
  );
}

// worktree 节点点击：切换仓库上下文 + 右区切 git（worktree→git 联动）
export function openWorkspaceGitForRepo(state: AppViewState, repoPath: string) {
  selectWorkspaceMode("git");
  state.requestUpdate();
  void selectGitRepo(state, repoPath);
}

export function renderWorkspaceView(state: AppViewState) {
  return renderWorkspaceLayout(state, {
    gitSlot: renderGitView(state, { showRepoSelect: false }),
    worktreesSlot: renderWorktreesView(state, { compact: true }),
    onSelectGitNode: () => {
      selectWorkspaceMode("git");
      state.requestUpdate();
    },
    onOpenFiles: () => {
      selectWorkspaceMode("files");
      state.requestUpdate();
    },
    onRepoChange: (path) => {
      void selectGitRepo(state, path);
    },
    onSelectWorktreeRepo: (path) => openWorkspaceGitForRepo(state, path),
  });
}
```

（`renderWorkspaceLayout` = views/workspace.ts 的 `renderWorkspaceView`——避免命名冲突：views 层导出命名 `renderWorkspaceView`，本文件组装函数名改为 `renderWorkspaceIntegratedView`，实施时任选其一并全局一致；审计测试同步断言名。）

- [ ] **Step 9: app-render.ts + app-chat-props.ts 接线**

`app-render.ts`：
- 删本地 `openWorkspaceView` 函数；import 改从 `./app-workspace.ts` 导入 `openWorkspaceView` + views/workspace 的渲染
- `case "workspace": return renderWorkspaceView(state, ...)` → `case "workspace": return renderWorkspaceIntegratedView(state);`
- `onOpenWorktrees: () => openWorkspaceView(state)`（临时，Task 4 删入口）、`onOpenGit: () => openWorkspaceView(state, "git")`（临时）

`app-chat-props.ts`：`import { openGitView } from "./app-git.ts";` → `import { openWorkspaceView } from "./app-workspace.ts";`；`onOpenGitView: () => openGitView(state)` → `onOpenGitView: () => openWorkspaceView(state, "git")`。**实施时验证无循环依赖**（app-workspace → app-git/app-worktrees → app-session-actions → controllers，均不回头 import app-chat-props）。

- [ ] **Step 10: workspace.css 新样式**

`styles/workspace.css` 末尾追加 `wk-*` 布局（全 token，禁止硬编码 hex）：`.wk-layout`（grid 两栏：左 `minmax(0,280px)` 右 `minmax(0,1fr)`，高度撑满、窄窗 ≤768px 时左栏收窄或折叠）；`.wk-nav`（flex 列，内部滚动）；`.wk-nav__repo`/`__node`/`__node--git`/`__item`/`__item--dir`/`__section`/`__hint`；`.wk-main`（overflow auto）；`.wk-preview*`（预览头/文本 `pre` 白空预排/占位）。旧 `workspace__*` 样式若已无引用一并删除。

- [ ] **Step 11: 运行确认通过**

Run: 两个新测试文件 → 全 PASS；`npm test` → 0 fail；`npm run build` + `npx tsc --noEmit` 通过。

- [ ] **Step 12: Commit**

```bash
git add chat-ui/ui/src/ui/controllers/workspace.ts chat-ui/ui/src/ui/controllers/workspace.test.ts chat-ui/ui/src/ui/views/workspace.ts chat-ui/ui/src/ui/app-workspace.ts chat-ui/ui/src/ui/views/worktrees.ts chat-ui/ui/src/ui/app-worktrees.ts chat-ui/ui/src/ui/views/git.ts chat-ui/ui/src/ui/app-git.ts chat-ui/ui/src/ui/controllers/git.ts chat-ui/ui/src/ui/app-render.ts chat-ui/ui/src/ui/app-chat-props.ts chat-ui/ui/src/styles/workspace.css chat-ui/ui/src/ui/workspace-ui.test.ts
git commit -m "feat(chat-ui): 工作区页 IDE 式融合文件树/Git/Worktrees（R42 第二期 T3）"
```

---

### Task 4: 侧边栏图标轨重组（会话列表最大化 + 「更多」菜单）

**背景：** 主导航 6 项（任务/定时/技能/工作区/Worktrees/Git）收敛为底部 5 图标轨：`[任务(运行中徽标)] [工作区] [扩展] ──spacer── [完整版网页(错误徽标)] [设置(更新/微信徽标)]`；断连时「完整版网页」位置替换为重连入口（同现有语义）；「Worktree 新会话」次级按钮移入新会话旁的「更多」下拉菜单（仅 `gitAvailable === true` 渲染）；会话列表 flex:1 占纵向主体（≥75%）；悬浮 tooltip 显示名称。顺手项（R41 审查建议）：`disconnectedCallback` 清菜单模块态、核对 `resolveSessionOptionsMemo` 依赖。

**Files:**
- Rewrite: `chat-ui/ui/src/ui/components/cc-sidebar.ts`（模板 + SidebarProps 精简 + 更多菜单模块态）
- Modify: `chat-ui/ui/src/ui/app-render.ts`（props 接线精简）
- Modify: `chat-ui/ui/src/styles/sidebar.css`（图标轨样式 + 死样式清理）
- Modify: `chat-ui/ui/src/ui/components/cc-sidebar.test.ts`（审计更新）
- Modify: `chat-ui/ui/src/ui/git-ui.test.ts` / `worktrees-ui.test.ts`（sidebar 导航项断言更新：旧入口已删）
- Modify: `chat-ui/ui/src/ui/i18n/zh.ts` / `en.ts`（`sidebar.more` 新键）

- [ ] **Step 1: 更新审计测试（失败断言先行）**

`cc-sidebar.test.ts`：DATA_FIELDS 断言清单改为（删 `cronActive`/`cronJobCount`/`worktreesActive`/`gitPanelActive`，保留其余 + `extensionsActive`）；模板接线断言改为：

```ts
test("cc-sidebar：底部 5 图标轨 + 更多菜单（主导航 6 项已移除）", () => {
  const s = componentSrc;
  assert.match(s, /cryoclaw-sidebar__rail/, "缺图标轨容器");
  assert.match(s, /props\.onOpenTasks/, "图标轨缺任务入口");
  assert.match(s, /props\.onOpenWorkspace/, "图标轨缺工作区入口");
  assert.match(s, /props\.onOpenExtensions/, "图标轨缺扩展入口");
  assert.match(s, /props\.onOpenWebUI/, "图标轨缺完整版网页入口");
  assert.match(s, /props\.onOpenSettings/, "图标轨缺设置入口");
  assert.match(s, /props\.tasksRunningCount > 0/, "任务图标缺运行中徽标");
  assert.match(s, /t\("sidebar\.more"\)/, "缺更多菜单文案");
  assert.match(s, /props\.onNewWorktreeChat/, "更多菜单缺 Worktree 新会话");
  const code = stripComments(s);
  assert.ok(!/cryoclaw-sidebar__main-nav/.test(code), "旧主导航容器应移除");
  assert.ok(!/t\("sidebar\.cron"\)/.test(code), "定时入口应移除");
  assert.ok(!/t\("sidebar\.worktrees"\)/.test(code), "Worktrees 入口应移除");
  assert.ok(!/t\("sidebar\.git"\)/.test(code), "Git 入口应移除");
});

test("cc-sidebar：disconnectedCallback 清菜单模块态（R41 审查建议顺手项）", () => {
  const s = componentSrc;
  assert.match(s, /disconnectedCallback\(\)/, "缺 disconnectedCallback");
  assert.match(s, /resetMenuState\(\)/, "应清会话菜单与更多菜单模块态");
});
```

`git-ui.test.ts`：删除「cc-sidebar：git 面板导航项」测试，替换为断言 `components/cc-sidebar.ts` 不含 `t("sidebar.git")`（入口已并入工作区页）。`worktrees-ui.test.ts`：删除 sidebar 导航项相关断言（`worktreesActive` prop 断言一并删除），其余（registry 内 worktrees 相关 meta 断言暂保留到 Task 5）同步调整。

- [ ] **Step 2: 运行确认失败** — Expected: FAIL

- [ ] **Step 3: i18n 新键**

`zh.ts`/`en.ts` 各追加：`"sidebar.more": "更多" / "More"`。

- [ ] **Step 4: cc-sidebar.ts 重写（关键代码）**

`SidebarProps` 精简（删 `skillsActive` 已随 T2 更名；本任务删 `cronActive`/`cronJobCount`/`onOpenCron`/`worktreesActive`/`onOpenWorktrees`/`gitPanelActive`/`onOpenGit`）；`DATA_FIELDS` 同步。模板 `renderSidebarInner` 主体替换为：

```ts
  return html`
    <aside class="cryoclaw-sidebar">
      <div class="cryoclaw-sidebar__brand">…（既有，不变）…</div>

      <nav class="cryoclaw-sidebar__nav">
        <div class="cryoclaw-sidebar__top-actions">
          <button class="cryoclaw-sidebar__new-chat-btn" @click=${props.onNewChat}>
            ${icons.messagePlus} ${t("sidebar.newChat")}
          </button>
          <div class="cryoclaw-sidebar__more-wrap">
            <button
              class="cryoclaw-sidebar__more-btn ${moreMenuOpen ? "is-open" : ""}"
              type="button"
              aria-haspopup="menu"
              aria-expanded=${moreMenuOpen ? "true" : "false"}
              aria-label=${t("sidebar.more")}
              data-tooltip=${t("sidebar.more")}
              data-tooltip-pos="bottom"
              @click=${(e: Event) => {
                e.stopPropagation();
                toggleMoreMenu(host);
              }}
            >${icons.moreHorizontal}</button>
            ${moreMenuOpen
              ? html`<div class="cryoclaw-sidebar__more-menu" role="menu" @click=${(e: Event) => e.stopPropagation()}>
                  ${props.gitAvailable === true
                    ? html`<button class="cryoclaw-sidebar__more-item" type="button" role="menuitem"
                        @click=${() => { closeMoreMenu(host); props.onNewWorktreeChat(); }}>
                        ${icons.gitBranch} ${t("sidebar.newWorktreeChat")}
                      </button>`
                    : nothing}
                </div>`
              : nothing}
          </div>
        </div>

        <div class="cryoclaw-sidebar__session-header">…（既有，不变）…</div>
        <div class="cryoclaw-sidebar__session-search">…（既有，不变）…</div>
        <div class="cryoclaw-sidebar__session-list">…（既有分组/平铺列表，不变）…</div>
      </nav>

      <div class="cryoclaw-sidebar__footer">
        ${props.webbridgeRepairVisible ? …既有 pill… : nothing}
        <div class="cryoclaw-sidebar__rail">
          <button class="cryoclaw-sidebar__rail-item ${props.tasksActive ? "active" : ""}" type="button"
            @click=${props.onOpenTasks}
            data-tooltip=${t("sidebar.tasks")} data-tooltip-pos="top" aria-label=${t("sidebar.tasks")}>
            ${icons.activity}
            ${props.tasksRunningCount > 0
              ? html`<span class="cryoclaw-sidebar__rail-badge">${props.tasksRunningCount}</span>`
              : nothing}
          </button>
          <button class="cryoclaw-sidebar__rail-item ${props.workspaceActive ? "active" : ""}" type="button"
            @click=${props.onOpenWorkspace}
            data-tooltip=${t("sidebar.workspace")} data-tooltip-pos="top" aria-label=${t("sidebar.workspace")}>
            ${icons.folder}
          </button>
          <button class="cryoclaw-sidebar__rail-item ${props.extensionsActive ? "active" : ""}" type="button"
            @click=${props.onOpenExtensions}
            data-tooltip=${t("sidebar.extensions")} data-tooltip-pos="top" aria-label=${t("sidebar.extensions")}>
            ${icons.puzzle}
          </button>
          <span class="cryoclaw-sidebar__rail-spacer"></span>
          ${props.connected
            ? html`<button class="cryoclaw-sidebar__rail-item" type="button"
                @click=${props.onOpenWebUI}
                data-tooltip=${t("sidebar.fullUI")} data-tooltip-pos="top" aria-label=${t("sidebar.fullUI")}>
                ${icons.externalLink}
                ${errors.badge}
              </button>`
            : html`<button class="cryoclaw-sidebar__rail-item cryoclaw-sidebar__rail-item--disconnected" type="button"
                @click=${props.onReconnect}
                data-tooltip=${t("sidebar.reconnect")} data-tooltip-pos="top" aria-label=${t("sidebar.reconnect")}>
                ${refreshIcon}
                ${errors.badge}
              </button>`}
          <button class="cryoclaw-sidebar__rail-item ${props.settingsActive ? "active" : ""}" type="button"
            @click=${props.onOpenSettings}
            data-tooltip=${t("sidebar.settings")} data-tooltip-pos="top" aria-label=${t("sidebar.settings")}>
            ${icons.settings}
            ${props.settingsBadge || props.settingsUpdateBadge
              ? html`<span class="cryoclaw-sidebar__rail-dot"></span>`
              : nothing}
          </button>
        </div>
        ${errors.popup}
      </div>
    </aside>
  `;
```

更多菜单模块态（与会话菜单同一模式，`bump` 触发组件更新；rAF 延迟注册外部关闭防自触）：

```ts
let moreMenuOpen = false;
let moreMenuOutsideCloser: ((ev: MouseEvent) => void) | null = null;

function closeMoreMenu(requestUpdate: () => void) {
  moreMenuOpen = false;
  if (moreMenuOutsideCloser) {
    document.removeEventListener("click", moreMenuOutsideCloser);
    moreMenuOutsideCloser = null;
  }
  requestUpdate();
}

function toggleMoreMenu(host: CcSidebar) {
  if (moreMenuOpen) {
    closeMoreMenu(host.bump);
    return;
  }
  moreMenuOpen = true;
  requestAnimationFrame(() => {
    if (!moreMenuOpen || moreMenuOutsideCloser) return;
    moreMenuOutsideCloser = (ev: MouseEvent) => {
      const root = (ev.target as HTMLElement).closest?.(".cryoclaw-sidebar__more-wrap");
      if (!root) closeMoreMenu(host.bump);
    };
    document.addEventListener("click", moreMenuOutsideCloser);
  });
  host.bump();
}

// 组件卸载清掉菜单模块态与 document 级监听（R41 审查建议顺手项）
function resetMenuState() {
  sessionMenuKey = null;
  moreMenuOpen = false;
  if (sessionMenuOutsideCloser) {
    document.removeEventListener("click", sessionMenuOutsideCloser);
    sessionMenuOutsideCloser = null;
  }
  if (moreMenuOutsideCloser) {
    document.removeEventListener("click", moreMenuOutsideCloser);
    moreMenuOutsideCloser = null;
  }
}
```

`CcSidebar` 类加：

```ts
  disconnectedCallback() {
    super.disconnectedCallback();
    resetMenuState();
  }
```

`webbridge pill` 与 `errors.badge/popup` 的既有模板从原 footer 等价搬迁（标签/点击语义不变）。

- [ ] **Step 5: app-render.ts props 精简**

删 `cronActive`/`cronJobCount`/`onOpenCron`/`worktreesActive`/`onOpenWorktrees`/`gitPanelActive`/`onOpenGit` 六字段（含 `cronJobCount` 的 `isExpiredOneShot` 计算——已迁 app-tasks；`isExpiredOneShot` import 若只剩此处引用一并删除）。其余字段不变。

- [ ] **Step 6: sidebar.css 样式**

追加（全 token；token 名以 tokens-ext.css 为准，禁止硬编码 hex）：

```css
/* 底部图标轨（R42 第二期） */
.cryoclaw-sidebar__rail { display: flex; align-items: center; gap: 2px; padding: 6px 8px; border-top: 1px solid var(--border-subtle, var(--hairline)); }
.cryoclaw-sidebar__rail-item { position: relative; width: 34px; height: 34px; display: grid; place-items: center; border: none; background: transparent; border-radius: var(--radius-md, 8px); color: var(--text-secondary); cursor: pointer; }
.cryoclaw-sidebar__rail-item:hover { background: var(--surface-hover, transparent); color: var(--text-primary); }
.cryoclaw-sidebar__rail-item.active { color: var(--brand-500); background: var(--brand-soft, transparent); }
.cryoclaw-sidebar__rail-spacer { flex: 1; }
.cryoclaw-sidebar__rail-badge { position: absolute; top: 0; right: 0; min-width: 15px; height: 15px; padding: 0 3px; border-radius: var(--radius-full, 999px); background: var(--brand-500); color: var(--text-on-accent, #fff); font-size: 10px; line-height: 15px; text-align: center; }
.cryoclaw-sidebar__rail-dot { position: absolute; top: 3px; right: 3px; width: 8px; height: 8px; border-radius: 50%; background: var(--brand-500); }

/* 更多菜单 */
.cryoclaw-sidebar__top-actions { display: flex; align-items: center; gap: 8px; padding: 12px 14px 16px; }
.cryoclaw-sidebar__new-chat-btn { flex: 1; } /* 既有样式保留 */
.cryoclaw-sidebar__more-wrap { position: relative; }
.cryoclaw-sidebar__more-btn { width: 36px; height: 36px; display: grid; place-items: center; border: 1px solid var(--border-subtle, var(--hairline)); background: transparent; border-radius: var(--radius-md, 8px); color: var(--text-secondary); cursor: pointer; }
.cryoclaw-sidebar__more-btn:hover, .cryoclaw-sidebar__more-btn.is-open { color: var(--text-primary); background: var(--surface-hover, transparent); }
.cryoclaw-sidebar__more-menu { position: absolute; top: calc(100% + 4px); left: 0; z-index: 30; min-width: 180px; padding: 4px; border-radius: var(--radius-lg, 12px); background: var(--surface-raised, var(--bg)); box-shadow: var(--shadow-lg); border: 1px solid var(--border-subtle, var(--hairline)); }
.cryoclaw-sidebar__more-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; border: none; background: transparent; border-radius: var(--radius-md, 8px); color: var(--text-primary); font-size: 13px; text-align: left; cursor: pointer; }
.cryoclaw-sidebar__more-item:hover { background: var(--surface-hover, transparent); }

/* 会话列表占纵向主体（≥75%）：nav 弹性撑满，list 内部滚动 */
.cryoclaw-sidebar__nav { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.cryoclaw-sidebar__session-list { flex: 1; min-height: 0; overflow-y: auto; }
```

（若 `.cryoclaw-sidebar__nav`/`__session-list` 已有等效布局规则，就地强化而非重复；旧 `.cryoclaw-sidebar__main-nav` 样式块整段删除。实现时核对 tokens-ext.css 中 `--surface-hover`/`--brand-soft`/`--border-subtle`/`--text-on-accent` 是否存在，缺者用现行等价 token。）

- [ ] **Step 7: 运行确认通过**

Run: 审计测试全 PASS；`npm test` → 0 fail；`npm run build` + `npx tsc --noEmit` 通过。

- [ ] **Step 8: Commit**

```bash
git add chat-ui/ui/src/ui/components/cc-sidebar.ts chat-ui/ui/src/ui/components/cc-sidebar.test.ts chat-ui/ui/src/ui/app-render.ts chat-ui/ui/src/styles/sidebar.css chat-ui/ui/src/ui/git-ui.test.ts chat-ui/ui/src/ui/worktrees-ui.test.ts chat-ui/ui/src/ui/i18n/zh.ts chat-ui/ui/src/ui/i18n/en.ts
git commit -m "feat(chat-ui): 侧边栏重组为会话列表最大化 + 5 图标轨 + 更多菜单（R42 第二期 T4）"
```

---

### Task 5: 视图 id 收敛与全局接线清理

**背景：** Task 1–4 后 `cron`/`worktrees`/`git`/`skills` 四个视图 id 已无任何 UI 入口（`cron` 仅剩 URL 注入可达）。本任务一次性删除，收敛 registry 为 6 视图（chat/setup/settings/workspace/tasks/extensions），清理死分支/死导入/死 i18n 键，并把审计测试重写为最终形态。

**Files:**
- Modify: `chat-ui/ui/src/ui/views/registry.ts`
- Modify: `chat-ui/ui/src/ui/app-render.ts`
- Modify: `chat-ui/ui/src/ui/app-skills.ts` / `app-worktrees.ts` / `app-git.ts`（死入口清理已随 T2/T3 完成，本任务只清残留 import）
- Verify: `chat-ui/ui/src/ui/app-gateway.ts` / `app-view-switch.ts` / `app-lifecycle.ts`（硬编码视图 id 核对）
- Modify: `chat-ui/ui/src/ui/i18n/zh.ts` / `en.ts`（死键删除）
- Rewrite: `chat-ui/ui/src/ui/git-ui.test.ts` + `worktrees-ui.test.ts` → 合并为 `workspace-ui.test.ts`（删除两个旧文件）
- Modify: `chat-ui/ui/src/ui/tasks-view.test.ts` / `extensions-ui.test.ts`（补 registry 负向断言）

- [ ] **Step 1: 审计测试更新（失败断言先行）**

新建 `workspace-ui.test.ts` 合并旧断言（原 git-ui/worktrees-ui 中**仍有效**的主进程侧断言原样保留）：
- registry 无 `"git"`/`"worktrees"`/`"cron"`/`"skills"`（负向，剥注释后断言）；有 `"extensions"`
- app-render `renderActiveView` 无 `case "cron"`/`case "worktrees"`/`case "git"`/`case "skills"` 分支；workspace 分支走新渲染
- app.ts 的 git 面板响应式状态字段断言（原 git-ui.test.ts 该条保留不变）
- file-changes「在 git 中查看」→ `openWorkspaceView(state, "git")`（T3 已钉）
- 主进程：preload git 5 通道 + git-ipc 校验 + workspace-ipc resolveAllowedDir（原样保留）

删除 `git-ui.test.ts`、`worktrees-ui.test.ts` 两个文件（chat-ui 测试递归发现，删除后不再运行）。

`tasks-view.test.ts` 追加：`assert.ok(!/"cron",/.test(registry))`（cron 视图 id 已删）；`extensions-ui.test.ts` 追加：registry 无 `"skills"`。

- [ ] **Step 2: registry.ts 收敛**

```ts
export const CRYOCLAW_VIEW_IDS = [
  "chat",
  "setup",
  "settings",
  "workspace",
  "tasks",
  "extensions",
] as const;

// CRYOCLAW_VIEW_META 同步删除 cron/worktrees/git/skills 四条，保留其余

export const INJECTABLE_VIEWS: readonly CryoClawViewId[] = [
  "chat",
  "setup",
  "settings",
  "workspace",
  "extensions",
];
```

- [ ] **Step 3: app-render.ts 死分支清理**

`renderActiveView` 删除 `case "skills"`/`case "cron"`/`case "worktrees"`/`case "git"` 四个分支；删除对应 import（`renderCronView`/`renderWorktreesView`/`renderGitView`——若 app-render 已无消费）；`cronActive`/`cronJobCount` 等残留字段已随 T4 清除，复核无残留。

- [ ] **Step 4: 死 import 与模块清理**

- `app-cron.ts`：无改动（`renderCronView` 由 app-tasks 消费）。
- `app-worktrees.ts` / `app-git.ts`：复核无 `setCryoClawView`/registry 死 import。
- `app-gateway.ts`：第 ~629 行 `(app.settings.cryoclawView ?? "chat") === "tasks"` 语义仍有效（tasks 视图保留）；tick handler key `"cron"` 是 handler 标识而非视图 id，保留并加一行注释说明防误删。
- `app-view-switch.ts`：无对已删 id 的 hook 注册（核对通过即可，零改动）。
- `storage.ts`：union 自 registry 派生自动生效；`parseUiSettings` 不读持久化 cryoclawView（读侧硬编码丢弃），旧持久化值无需迁移——在文件头补一行注释记录此结论。

- [ ] **Step 5: i18n 死键删除**

zh/en 同步删除：`"sidebar.cron"`、`"sidebar.worktrees"`、`"sidebar.git"`、`"sidebar.skillStore"`（T2 起无引用）。**保留** `worktrees.*`/`git.*`/`cron.*` 全族（区块/面板仍渲染）。`i18n.test.ts` 自动守护键集合一致性。

- [ ] **Step 6: 运行确认通过**

Run: `npm test` → 0 fail（旧审计文件已删、新审计全 PASS）；`npm run build` + `npx tsc --noEmit` 通过。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(chat-ui): 视图 id 收敛为 6 视图并清理死接线（R42 第二期 T5）"
```

---

### Task 6: 全量验证 + 代码审查 + 发版

- [ ] **Step 1: 全量测试与构建**

```
npm test
npm run build
npm run dupcheck
```

Expected: 0 fail；重复率 ≤1.19% 不回退。

- [ ] **Step 2: CDP 真机冒烟**（`npx electron . --remote-debugging-port`；gateway 就绪留 40-50s）：
  - light/dark × 1280/800 宽：新侧边栏（会话列表占主体、图标轨 tooltip/徽标、更多菜单 Worktree 新会话、断连重连替换入口）
  - 任务页双 tab 互跳（任务卡「查看定时任务」、定时详情「在运行记录中查看」）
  - 扩展页技能/插件双 tab（插件启停/市场安装确认流）
  - 工作区页：文件树预览、Git 变更节点、worktree 节点→git 联动、提交身份引导
  - 零 renderer 异常 + 无裸 i18n 键 + 无裸 hex

- [ ] **Step 3: CodeReview 代理复审**，处理 blocker/major，修复后重跑 `npm test`。

- [ ] **Step 4: 发版**（用户已授权）：
  - `package.json` version → `2026.828.5` + `release-notes.json` 顶部条目（R42 摘要：侧边栏图标轨重组 + 任务/扩展/工作区三组模块整合）
  - 同步 `website/index.html` 版本徽章（`hero-version`/`download-version`）
  - `docs/OPTIMIZATION-PROGRESS.md` 追加 `### R42` 小节 + 头部「当前状态」更新（最新发版 v2026.828.5、第二期完成、测试基线新数）
  - `git add -A && git commit && git push`
  - `npm run dist:win` → 产物断言 → 安装验证 → `gh release create`（资产三件套：安装包 + .exe.blockmap + latest.yml）
  - 发版后 `npm run dupcheck`

- [ ] **Step 5: 记忆更新**：`task_summary_experience` 更新 R42 条目（含新架构锚点：6 视图清单、图标轨结构、工作区页模式切换语义、审计测试新文件名）。

---

## 自审记录

1. **Spec 覆盖**：2.1 图标轨 + 更多菜单 + 会话列表最大化 → Task 4（断连替换入口/徽标语义均在 Step 4 模板内）；2.2 任务双 tab + 联动 + 徽标降级 → Task 1（`onOpenCron` 路由、cron 徽标入 tab、双向跳转）；2.3 扩展双 tab + 插件迁出 + skillsActive 更名 → Task 2（leave hook 复位迁移、invalidateAllSettings 同步）；2.4 工作区融合 + worktree→git 联动 + 控制器抽取 + 白名单注册收敛 + 降级语义 → Task 3；2.5 接线表（registry/INJECTABLE_VIEWS/app-render props/app-view-switch/app-gateway/i18n/样式）→ Task 1–5 分步覆盖；2.6 测试（审计 + 纯函数 + CDP 冒烟）→ 各任务内嵌 + Task 6；2.7 不做项无任务。✔
2. **占位符**：样式 token 名（`--surface-hover` 等）标注「以 tokens-ext.css 现行名为准」——是既有代码库事实依赖而非设计占位，每个任务都有明确查证动作与禁止硬编码 hex 约束。其余步骤均有代码。✔
3. **类型一致**：`TasksViewTab` 定义于 views/tasks.ts、app-tasks/app-render 消费；`openWorkspaceView(state, mode)`（T3）被 Task 4 图标轨与 app-chat-props 消费；`openExtensionsView`（T2）被 Task 4 消费；`initGitPanel(state, workspaceRoot)`（T3）与 Task 5 审计断言一致。Task 4 依赖 T1–T3 入口，顺序已锁。✔
4. **风险核对**：视图 id 删除影响面 = registry 派生 union（storage 自动生效，cryoclawView 不持久化）→ 无持久化迁移问题；file-changes「在 git 中查看」链路在 T3 Step 9 改线并在 T5 审计钉住；`worktrees-ui.test.ts` 中 workspace-ipc 白名单根断言（主进程侧）原样保留进 workspace-ui.test.ts。✔
```