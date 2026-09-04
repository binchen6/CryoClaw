// 守护回归（源码审计，2026.9 提案 A 重写版；前身 cc-sidebar.test.ts）：
// 旧 280px 侧边栏拆分为 <cc-rail>（图标轨，常驻导航）+ <cc-session-panel>
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

const panelSrc = readSrc("components/cc-session-panel.ts");
const railSrc = readSrc("components/cc-rail.ts");
const appRenderSrc = readSrc("app-render.ts");

// 剥掉块注释与行注释：负向断言只针对真实代码，防注释中的字样误匹配
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// ── 共同契约（两组件同构）────────────────────────────────────

for (const [name, src, tag] of [
  ["cc-session-panel", panelSrc, "cc-session-panel"],
  ["cc-rail", railSrc, "cc-rail"],
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

// ── cc-session-panel 专属 ────────────────────────────────────

test("cc-session-panel：会话菜单模块态与辅助函数随迁（开关态 + document 级外部关闭注册/注销）", () => {
  assert.match(panelSrc, /let sessionMenuKey/, "缺会话菜单模块态");
  assert.match(panelSrc, /document\.addEventListener\("click", sessionMenuOutsideCloser\)/, "缺外部关闭注册");
  assert.match(panelSrc, /document\.removeEventListener\("click", sessionMenuOutsideCloser\)/, "缺外部关闭注销");
  assert.match(panelSrc, /let moreMenuOpen/, "缺「更多」菜单模块态");
  assert.match(panelSrc, /bump\s*=\s*\(\)/, "缺组件级 bump 刷新触发器");
});

test("cc-session-panel：模板关键接线（搜索/归档/新会话/更多菜单/内联重命名/分组）", () => {
  assert.match(panelSrc, /onSessionSearchChange/, "缺搜索接线");
  assert.match(panelSrc, /onToggleArchived/, "缺归档切换接线");
  assert.match(panelSrc, /props\.onNewChat/, "缺新会话接线");
  assert.match(panelSrc, /toggleMoreMenu/, "缺「更多」菜单开关");
  assert.match(panelSrc, /startInlineRename/, "缺内联重命名");
  assert.match(panelSrc, /groupSidebarSessions/, "缺置顶+时间分组");
  assert.match(panelSrc, /cc-panel__session-edit/, "内联重命名输入框类名");
});

test("cc-session-panel：disconnectedCallback 清菜单模块态", () => {
  assert.match(panelSrc, /disconnectedCallback\(\)[\s\S]{0,200}?resetMenuState\(\)/, "卸载应清菜单模块态与 document 级监听");
});

test("cc-session-panel：无 git 时「更多」菜单按钮整体隐藏（gitAvailable === true 门控）", () => {
  assert.match(panelSrc, /props\.gitAvailable === true\s*\?\s*html`/, "「更多」菜单应按 gitAvailable === true 门控");
});

// ── cc-rail 专属 ─────────────────────────────────────────────

test("cc-rail：五个导航入口 + 状态入口接线", () => {
  for (const cb of ["onOpenChat", "onOpenTasks", "onOpenWorkspace", "onOpenExtensions", "onOpenSettings", "onOpenWebUI", "onReconnect", "onWebbridgeRepairClick"]) {
    assert.match(railSrc, new RegExp(`props\\.${cb}\\(`), `缺 ${cb} 接线`);
  }
  assert.match(railSrc, /tasksRunningCount > 0/, "任务运行徽标门控");
  assert.match(railSrc, /webbridgeRepairVisible/, "webbridge 修复入口门控");
  assert.match(railSrc, /props\.connected\s*\?/, "连接态分流（完整版网页 / 重连）");
});

test("cc-rail：errors 按内容比较（根渲染每帧新建数组，按引用比较会恒真）", () => {
  assert.match(railSrc, /function errorsEqual\(/, "缺 errorsEqual 内容比较");
  assert.match(railSrc, /errorsEqual\(prev\.errors, next\.errors\)/, "shouldUpdate 应使用 errorsEqual");
});

// ── 装配层（app-render）──────────────────────────────────────

test("app-render：装配 <cc-session-panel .props=...> 与 <cc-rail .props=...>", () => {
  assert.match(appRenderSrc, /<cc-session-panel\s/, "renderApp 应装配 <cc-session-panel>");
  assert.match(appRenderSrc, /<cc-rail\s/, "renderApp 应装配 <cc-rail>");
  assert.match(appRenderSrc, /import "\.\/components\/cc-session-panel\.ts"/, "缺少面板注册副作用导入");
  assert.match(appRenderSrc, /import "\.\/components\/cc-rail\.ts"/, "缺少图标轨注册副作用导入");
});

test("app-render：sessionOptions memo 引用稳定（防每帧新引用击穿面板隔离）", () => {
  assert.match(appRenderSrc, /sessionOptionsMemo/, "装配层应 memo sessionOptions");
  assert.match(appRenderSrc, /resolveSessionOptionsMemo\(state\)/, "renderApp 应走 memo 版");
});

test("app-render：fullpage（setup）隐藏 rail 与面板", () => {
  assert.match(appRenderSrc, /chatFocus \|\| meta\.fullpage/, "fullpage/focus 应隐藏 rail 与面板");
});
