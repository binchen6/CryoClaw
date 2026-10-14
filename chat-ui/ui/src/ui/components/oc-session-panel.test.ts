// 守护回归（源码审计，2026.9 提案 A 重写版；前身 cc-sidebar.test.ts）：
// 旧 280px 侧边栏拆分为 <oc-rail>（图标轨，常驻导航）+ <oc-session-panel>
// （chat 视图会话面板）两个独立组件。抽取组件隔离重渲染是结构性优化——
// 回退（把模板塞回 renderApp 直接求值、或让回调/每帧新字面量进比较清单）
// 会让流式帧等高频更新重新全量重求值，必须钉住。
// 组件本体依赖 lit + customElements（node 下直接导入意义不大），故用源码断言。
// 注意：源文件在 Windows 上是 CRLF 换行，所有跨行正则用 \s/[\s\S] 而非裸 \n；
// 负向断言先剥注释，避免注释里出现的字段名误匹配。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readSrc(rel: string): string {
  return readFileSync(new URL(`../../../../../src/ui/${rel}`, import.meta.url), "utf8");
}

const panelSrc = readSrc("components/oc-session-panel.ts");
const railSrc = readSrc("components/oc-rail.ts");
const appRenderSrc = readSrc("app-render.ts");

// 剥掉块注释与行注释：负向断言只针对真实代码，防注释中的字样误匹配
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// ── 共同契约（两组件同构）────────────────────────────────────

for (const [name, src, tag] of [
  ["oc-session-panel", panelSrc, "oc-session-panel"],
  ["oc-rail", railSrc, "oc-rail"],
] as const) {
  test(`${name}：无 shadow DOM（createRenderRoot 返回 this，复用全局样式）`, () => {
    assert.match(
      src,
      /createRenderRoot\(\)\s*\{\s*return this;/,
      "必须 createRenderRoot() { return this; }，否则全局样式与 document 级菜单测量/外部关闭失效",
    );
  });

  test(`${name}：注册为 ${tag} 自定义元素`, () => {
    assert.match(
      src,
      new RegExp(`customElement\\("${tag}"\\)|customElements\\.define\\("${tag}"`),
      `组件必须以 ${tag} 标签名注册`,
    );
  });

  test(`${name}：单属性整体传入（不做逐属性声明）`, () => {
    assert.match(src, /props:\s*\{\s*attribute:\s*false\s*\}/, "应以单个 props 属性（attribute: false）整体接收");
  });

  test(`${name}：shouldUpdate 比较清单只含数据字段，排除全部回调`, () => {
    const m = src.match(/const DATA_FIELDS\s*=\s*\[([\s\S]*?)\] as const/);
    assert.ok(m, `${name} 缺少 DATA_FIELDS 比较清单`);
    const fields = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    assert.ok(fields.length > 0, "DATA_FIELDS 为空");
    for (const f of fields) {
      assert.ok(!f.startsWith("on"), `回调字段 ${f} 不得进比较清单（每帧新闭包，引用比较恒变）`);
    }
    assert.ok(!fields.includes("isDeletingSession"), "isDeletingSession 为函数，不得进比较清单");
    assert.ok(!fields.includes("requestUpdate"), "requestUpdate 为函数，不得进比较清单");
  });
}

// ── oc-session-panel 专属 ────────────────────────────────────

test("oc-session-panel：会话菜单模块态与辅助函数随迁（开关态 + document 级外部关闭注册/注销）", () => {
  assert.match(panelSrc, /let sessionMenuKey/, "缺会话菜单模块态");
  assert.match(panelSrc, /document\.addEventListener\("click", sessionMenuOutsideCloser\)/, "缺外部关闭注册");
  assert.match(panelSrc, /document\.removeEventListener\("click", sessionMenuOutsideCloser\)/, "缺外部关闭注销");
  assert.match(panelSrc, /let moreMenuOpen/, "缺「更多」菜单模块态");
  assert.match(panelSrc, /bump\s*=\s*\(\)/, "缺组件级 bump 刷新触发器");
});

test("oc-session-panel：模板关键接线（搜索/归档/新会话/更多菜单/内联重命名/分组）", () => {
  assert.match(panelSrc, /onSessionSearchChange/, "缺搜索接线");
  assert.match(panelSrc, /onToggleArchived/, "缺归档切换接线");
  assert.match(panelSrc, /props\.onNewChat/, "缺新会话接线");
  assert.match(panelSrc, /toggleMoreMenu/, "缺「更多」菜单开关");
  assert.match(panelSrc, /startInlineRename/, "缺内联重命名");
  assert.match(panelSrc, /groupSidebarSessions/, "缺置顶+时间分组");
  assert.match(panelSrc, /oc-panel__session-edit/, "内联重命名输入框类名");
});

test("oc-session-panel：disconnectedCallback 清菜单模块态", () => {
  assert.match(panelSrc, /disconnectedCallback\(\)[\s\S]{0,200}?resetMenuState\(\)/, "卸载应清菜单模块态与 document 级监听");
});

test("oc-session-panel：菜单退场两段式（runExitAnimation + epoch 防误关重开）", () => {
  assert.match(panelSrc, /runExitAnimation\(document\.querySelector\("\.oc-panel__session-menu"\)/, "会话菜单缺退场两段式");
  assert.match(panelSrc, /runExitAnimation\(document\.querySelector\("\.oc-panel__more-menu"\)/, "「更多」菜单缺退场两段式");
  assert.match(panelSrc, /sessionMenuEpoch\+\+/, "会话菜单缺 epoch 防误关");
  assert.match(panelSrc, /moreMenuEpoch\+\+/, "「更多」菜单缺 epoch 防误关");
  // CSS 侧退场规则（styles 与 src/ui 平级，需 ../ 跳出）
  const css = readSrc("../styles/session-panel.css");
  assert.match(css, /\.oc-panel__session-menu\.cc-leaving[\s\S]{0,120}?chat-popover-out/, "会话菜单缺 cc-leaving 退场规则");
});

test("oc-session-panel：「更多」菜单常驻（新建工作区入口），worktree 项仍按 gitAvailable === true 门控", () => {
  // 阶段5 起「更多」菜单承载「新建工作区」，不再整体随 git 可用性隐藏；
  // git 门控收缩到 worktree 新建单项
  assert.match(panelSrc, /props\.gitAvailable === true[\s\S]{0,500}?onNewWorktreeChat/, "worktree 新建项应按 gitAvailable === true 门控");
  assert.match(panelSrc, /workspace\.create/, "「更多」菜单缺新建工作区入口");
});

// ── 固定工作区（阶段5）──────────────────────────────────────

test("oc-session-panel：工作区分组渲染（splitSessionsByWorkspace + 快速新建/移除按钮）", () => {
  assert.match(panelSrc, /splitSessionsByWorkspace\(props\.sessionOptions/, "正常视图应按工作区切分会话");
  assert.match(panelSrc, /oc-panel__workspace-label/, "缺工作区分组头");
  assert.match(panelSrc, /onNewChatInWorkspace\(section\.workspace\.id\)/, "缺工作区快速新建接线");
  assert.match(panelSrc, /onRemoveWorkspace\(section\.workspace\.id\)/, "缺工作区移除接线");
  // 归档/搜索态平铺：分组只在正常视图生效
  assert.match(panelSrc, /showGrouped/, "归档/搜索态应绕过工作区分组");
});

test("oc-session-panel：会话菜单「指定工作区」二级模式", () => {
  assert.match(panelSrc, /sessionMenuMode = "workspace"/, "缺菜单二级模式切换");
  assert.match(panelSrc, /renderWorkspacePicker\(host, props, s\)/, "缺工作区选择列表渲染");
  assert.match(panelSrc, /onBindSessionWorkspace\(s\.key, workspaceId\)/, "缺绑定回调接线");
  assert.match(panelSrc, /workspace\.none/, "缺「无工作区」解绑项");
});

test("oc-session-panel：新建工作区对话框（名称/图标/路径 + 主进程目录选择）", () => {
  assert.match(panelSrc, /renderWorkspaceDialog\(host, props\)/, "缺对话框渲染接线");
  assert.match(panelSrc, /selectDirectory/, "缺目录选择桥调用");
  assert.match(panelSrc, /onCreateWorkspace\(\{/, "缺创建回调接线");
  const css = readSrc("../styles/session-panel.css");
  assert.match(css, /\.oc-panel__ws-dialog-backdrop/, "缺对话框浮层样式");
  assert.match(css, /\.oc-panel__workspace-action/, "缺工作区操作按钮样式");
});

test("oc-session-panel：工作区数据字段进 shouldUpdate 比较清单", () => {
  assert.match(panelSrc, /"pinnedWorkspaces"/, "pinnedWorkspaces 缺比较清单登记");
  assert.match(panelSrc, /"sessionWorkspaceMap"/, "sessionWorkspaceMap 缺比较清单登记");
});

test("app-render：工作区 props 装配（数据 + 四回调）", () => {
  assert.match(appRenderSrc, /pinnedWorkspaces: state\.settings\.pinnedWorkspaces/, "缺 pinnedWorkspaces 装配");
  assert.match(appRenderSrc, /sessionWorkspaceMap: state\.settings\.sessionWorkspaceMap/, "缺 sessionWorkspaceMap 装配");
  for (const cb of ["onNewChatInWorkspace", "onBindSessionWorkspace", "onCreateWorkspace", "onRemoveWorkspace"]) {
    assert.match(appRenderSrc, new RegExp(`${cb}:`), `缺 ${cb} 装配`);
  }
});

test("app-session-actions：工作区动作函数（新建会话绑定/绑定解绑/创建/移除）", () => {
  const actionsSrc = readSrc("app-session-actions.ts");
  for (const fn of ["createNewSessionInWorkspace", "bindSessionWorkspace", "createPinnedWorkspace", "removePinnedWorkspace"]) {
    assert.match(actionsSrc, new RegExp(`export function ${fn}\\(`), `缺 ${fn}`);
  }
  // 在工作区新建会话必须先 adoptNewSession 再写绑定（绑定表按 newKey 落）
  assert.match(actionsSrc, /adoptNewSession\(state, newKey\);\s*\n\s*state\.applySettings\(\{[\s\S]{0,200}?sessionWorkspaceMap/, "新建会话后应立即绑定工作区");
});

test("主进程/preload：dialog:select-directory 通道（工作区路径选择）", () => {
  // 注意：编译后测试在 chat-ui/ui/.test-dist/ 下运行，回仓库根需 7 级 ..
  const mainSrc = readFileSync(new URL("../../../../../../../src/main.ts", import.meta.url), "utf8");
  assert.match(mainSrc, /ipcMain\.handle\("dialog:select-directory"/, "主进程缺目录选择 handler");
  assert.match(mainSrc, /assertTrustedIpcSender\(event, "dialog:select-directory"\)/, "目录选择缺 IPC 信任校验");
  const preloadSrc = readFileSync(new URL("../../../../../../../src/preload.ts", import.meta.url), "utf8");
  assert.match(preloadSrc, /selectDirectory[\s\S]{0,80}dialog:select-directory/, "preload 缺 selectDirectory 桥");
});

// ── oc-rail 专属 ─────────────────────────────────────────────

test("oc-rail：五个导航入口 + 状态入口接线", () => {
  for (const cb of ["onOpenChat", "onOpenTasks", "onOpenWorkspace", "onOpenExtensions", "onOpenSettings", "onOpenWebUI", "onReconnect", "onWebbridgeRepairClick"]) {
    assert.match(railSrc, new RegExp(`props\\.${cb}\\(`), `缺 ${cb} 接线`);
  }
  assert.match(railSrc, /tasksRunningCount > 0/, "任务运行徽标门控");
  assert.match(railSrc, /webbridgeRepairVisible/, "webbridge 修复入口门控");
  assert.match(railSrc, /props\.connected\s*\?/, "连接态分流（完整版网页 / 重连）");
});

test("oc-rail：errors 按内容比较（根渲染每帧新建数组，按引用比较会恒真）", () => {
  assert.match(railSrc, /function errorsEqual\(/, "缺 errorsEqual 内容比较");
  assert.match(railSrc, /errorsEqual\(prev\.errors, next\.errors\)/, "shouldUpdate 应使用 errorsEqual");
});

// ── 装配层（app-render）──────────────────────────────────────

test("app-render：装配 <oc-session-panel .props=...> 与 <oc-rail .props=...>", () => {
  assert.match(appRenderSrc, /<oc-session-panel\s/, "renderApp 应装配 <oc-session-panel>");
  assert.match(appRenderSrc, /<oc-rail\s/, "renderApp 应装配 <oc-rail>");
  assert.match(appRenderSrc, /import "\.\/components\/oc-session-panel\.ts"/, "缺少面板注册副作用导入");
  assert.match(appRenderSrc, /import "\.\/components\/oc-rail\.ts"/, "缺少图标轨注册副作用导入");
});

test("app-render：sessionOptions memo 引用稳定（防每帧新引用击穿面板隔离）", () => {
  assert.match(appRenderSrc, /sessionOptionsMemo/, "装配层应 memo sessionOptions");
  assert.match(appRenderSrc, /resolveSessionOptionsMemo\(state\)/, "renderApp 应走 memo 版");
});

test("app-render：fullpage（setup）隐藏 rail 与面板", () => {
  assert.match(appRenderSrc, /chatFocus \|\| meta\.fullpage/, "fullpage/focus 应隐藏 rail 与面板");
});
