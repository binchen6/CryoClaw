// 守护回归（源码审计，同 cc-chat-stream.test.ts / cc-chat-history.test.ts 模式，R41 Task 12）：
// 抽取 <cc-sidebar> 组件隔离侧边栏重渲染是结构性优化——回退（把侧边栏模板塞回
// renderApp 直接求值、或让回调/每帧新字面量进比较清单）会让流式帧等高频更新重新
// 全量重求值整棵侧边栏模板树（会话列表 + 主导航 + 底部区），必须钉住。
// 组件本体依赖 lit + customElements（node 下直接导入意义不大），故用源码断言。
// 注意：源文件在 Windows 上是 CRLF 换行，所有跨行正则用 \s/[\s\S] 而非裸 \n；
// 负向断言先剥注释，避免注释里出现的字段名误匹配（Task 10/11 踩过的坑）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readSrc(rel: string): string {
  return readFileSync(new URL(`../../../../../src/ui/${rel}`, import.meta.url), "utf8");
}

const componentSrc = readSrc("components/cc-sidebar.ts");
const appRenderSrc = readSrc("app-render.ts");

// 剥掉块注释与行注释：负向断言只针对真实代码，防注释中的字样误匹配
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

test("cc-sidebar：无 shadow DOM（createRenderRoot 返回 this，复用全局样式）", () => {
  assert.match(
    componentSrc,
    /createRenderRoot\(\)\s*\{\s*return this;/,
    "必须 createRenderRoot() { return this; }，否则全局 sidebar.css 与会话菜单 document 级测量/外部关闭失效",
  );
});

test("cc-sidebar：注册为 cc-sidebar 自定义元素", () => {
  assert.match(
    componentSrc,
    /customElement\("cc-sidebar"\)|customElements\.define\("cc-sidebar"/,
    "组件必须以 cc-sidebar 标签名注册",
  );
});

test("cc-sidebar：单属性整体传入（40+ 字段不做逐属性声明）", () => {
  assert.match(componentSrc, /static properties\s*=/, "缺少静态属性声明");
  assert.match(
    componentSrc,
    /props:\s*\{\s*attribute:\s*false\s*\}/,
    "应以单个 props 属性（attribute: false）整体接收 SidebarProps",
  );
  assert.match(
    componentSrc,
    /props:\s*SidebarProps\s*\|\s*null/,
    "props 字段类型应为 SidebarProps | null",
  );
});

test("cc-sidebar：shouldUpdate 比较清单只含数据字段，排除全部回调", () => {
  const code = stripComments(componentSrc);
  assert.match(code, /shouldUpdate\(/, "缺少 shouldUpdate 门控");
  const list = code.match(/DATA_FIELDS\s*=\s*\[[\s\S]*?\]/)?.[0] ?? "";
  assert.ok(list, "缺少数据字段比较清单（DATA_FIELDS）");
  // 布尔/数字/字符串按值、数组按引用（装配层 memo / 内容比较）的数据字段必须齐全
  for (const name of [
    "connected",
    "currentSessionKey",
    "mainSessionKey",
    "sessionOptions",
    "sessionSearch",
    "showArchived",
    "settingsActive",
    "tasksActive",
    "tasksRunningCount",
    "extensionsActive",
    "workspaceActive",
    "cronActive",
    "cronJobCount",
    "worktreesActive",
    "gitPanelActive",
    "gitAvailable",
    "webbridgeRepairVisible",
    "webbridgeRepairBrowserName",
    "webbridgeRepairChecking",
    "settingsBadge",
    "settingsUpdateBadge",
    "errors",
  ]) {
    assert.ok(list.includes(`"${name}"`), `比较清单缺数据字段 ${name}`);
  }
  // 回调每帧新闭包（renderApp 字面量），进比较清单会导致每次根渲染都重求值侧边栏子树
  assert.ok(!/\bon[A-Z][\w]*"/.test(list), "比较清单不得含任何 on* 回调字段名");
  for (const name of ["isDeletingSession", "requestUpdate"]) {
    assert.ok(
      !list.includes(`"${name}"`),
      `函数字段 ${name} 不得进比较清单（每帧新闭包会让优化失效）`,
    );
  }
});

test("cc-sidebar：errors 按内容比较（根渲染每帧新建数组，按引用比较会恒真）", () => {
  assert.match(
    componentSrc,
    /errorsEqual\(/,
    "errors 必须按内容比较（[chatDisabledReason, lastError].filter 每次都是新数组引用）",
  );
});

test("cc-sidebar：会话菜单模块态与辅助函数随迁（开关态 + document 级外部关闭注册/注销）", () => {
  assert.match(componentSrc, /let sessionMenuKey: string \| null = null;/, "sessionMenuKey 应位于组件文件");
  assert.match(componentSrc, /let sessionMenuOutsideCloser/, "sessionMenuOutsideCloser 应位于组件文件");
  assert.match(componentSrc, /function openSessionMenu\(/, "openSessionMenu 应迁入组件文件");
  assert.match(componentSrc, /function closeSessionMenu\(/, "closeSessionMenu 应迁入组件文件");
  assert.match(componentSrc, /function startInlineRename\(/, "startInlineRename 应迁入组件文件");
  // document 级点击外部关闭：注册/注销语义不变
  assert.match(componentSrc, /document\.addEventListener\("click", sessionMenuOutsideCloser\)/, "缺少外部关闭监听注册");
  assert.match(componentSrc, /document\.removeEventListener\("click", sessionMenuOutsideCloser\)/, "缺少外部关闭监听注销");
  // 打开后一帧测量翻转（距底部不足向上展开）依赖扁平 DOM 全局查询
  assert.match(componentSrc, /document\.querySelector\("\.cryoclaw-sidebar__session-menu"\)/, "缺少菜单翻转测量");
});

test("cc-sidebar：模板等价搬迁关键接线（导航/徽标/搜索/折叠/断连/内联重命名）", () => {
  assert.match(componentSrc, /props\.onOpenWorktrees/, "导航项未接 onOpenWorktrees");
  assert.match(componentSrc, /props\.gitAvailable === true/, "无 git 时新建入口应隐藏（降级）");
  assert.match(componentSrc, /props\.onOpenGit/, "导航项未接 onOpenGit");
  assert.match(componentSrc, /gitPanelActive \? "active"/, "git 导航项未接 active 态");
  assert.match(componentSrc, /cryoclaw-sidebar__session-worktree/, "缺少会话 worktree 徽标");
  assert.match(componentSrc, /props\.onSessionSearchChange/, "搜索输入未接 onSessionSearchChange");
  assert.match(componentSrc, /props\.onToggleSidebar/, "折叠按钮未接 onToggleSidebar");
  assert.match(componentSrc, /props\.onReconnect/, "断连态未接 onReconnect");
  assert.match(componentSrc, /startInlineRename\(span, s\.key, s\.label, props\.onRenameSession, props\.requestUpdate\)/, "内联重命名结束后仍应触发根组件 requestUpdate（模板重新接管）");
  assert.match(componentSrc, /groupSidebarSessions\(props\.sessionOptions\)/, "正常视图应继续用置顶+时间分组");
  assert.match(componentSrc, /repeat\(/, "会话列表应继续用 lit repeat（keyed 复用）");
});

test("app-render：装配 <cc-sidebar .props=...> 且引入组件模块", () => {
  assert.match(appRenderSrc, /<cc-sidebar\s/, "renderApp 应装配 <cc-sidebar>");
  assert.match(appRenderSrc, /\.props=\$\{\{/, "应以单属性整体传入 props 字面量");
  assert.match(appRenderSrc, /import "\.\/components\/cc-sidebar\.ts"/, "缺少组件注册副作用导入");
  assert.ok(!/renderSidebar\(/.test(appRenderSrc), "renderApp 不应再直接调用 renderSidebar");
});

test("app-render：sessionOptions 按五个数据源 memo（根渲染每帧重建数组，不 memo 则隔离失效）", () => {
  assert.match(
    appRenderSrc,
    /resolveSessionOptionsMemo\(state\)/,
    "sessionOptions 应经 memo 包装（数据源不变时保持同一引用）",
  );
  const code = stripComments(appRenderSrc);
  const memoBlock = code.slice(code.indexOf("sessionOptionsMemo"), code.indexOf("resolveSessionOptionsMemo(state)"));
  for (const dep of ["sessionsResult", "worktrees", "sessionKey", "sessionsIncludeArchived", "sidebarSessionSearch"]) {
    assert.ok(memoBlock.includes(dep), `sessionOptions memo 缺数据源 ${dep}`);
  }
});
