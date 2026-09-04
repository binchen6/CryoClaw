/**
 * CryoClaw 视图注册表 —— 视图 id 的唯一事实来源。
 *
 * 新增视图接线点（共 3 处）：
 *   1. 本文件：CRYOCLAW_VIEW_IDS / CRYOCLAW_VIEW_META 各加一条
 *   2. storage.ts：无（union 从本文件导入，自动生效；若允许 URL 注入需加 INJECTABLE_VIEWS）
 *   3. app-render.ts：renderActiveView 的 switch 加渲染分支
 *
 * 2026.9 提案 A 重写：图标轨（cc-rail）常驻所有视图（setup 除外），
 * 原「全页视图隐藏侧边栏 + 标题栏返回按钮」模型废弃（titlebarBack 删除），
 * meta 只保留 fullpage（仅 setup 全屏向导）与上下文栏标题 key。
 */

export const CRYOCLAW_VIEW_IDS = [
  "chat",
  "setup",
  "settings",
  "workspace",
  "tasks",
  "extensions",
] as const;

export type CryoClawViewId = (typeof CRYOCLAW_VIEW_IDS)[number];

export type CryoClawViewMeta = {
  id: CryoClawViewId;
  /**
   * 全屏视图：隐藏图标轨与会话面板（cryoclaw-shell--fullpage），无上下文栏。
   * 仅 setup（首启向导）为 fullpage；chat 为主视图。
   */
  fullpage: boolean;
  /** 上下文栏标题的 i18n key（chat 视图显示会话名，不用此字段） */
  titleKey: string;
};

export const CRYOCLAW_VIEW_META: Record<CryoClawViewId, CryoClawViewMeta> = {
  chat: { id: "chat", fullpage: false, titleKey: "sidebar.agent" },
  setup: { id: "setup", fullpage: true, titleKey: "setup.welcome.title" },
  settings: { id: "settings", fullpage: false, titleKey: "sidebar.settings" },
  workspace: { id: "workspace", fullpage: false, titleKey: "sidebar.workspace" },
  tasks: { id: "tasks", fullpage: false, titleKey: "sidebar.tasks" },
  extensions: { id: "extensions", fullpage: false, titleKey: "sidebar.extensions" },
};

/**
 * 允许经 URL query/hash（?view=）注入的视图白名单。
 * 仅 file:// 受信启动参数使用；tasks 等敏感/临时视图不开放注入
 * （与 storage.ts / app-settings.ts 的历史行为一致）。
 */
export const INJECTABLE_VIEWS: readonly CryoClawViewId[] = [
  "chat",
  "setup",
  "settings",
  "workspace",
  "extensions",
];

export function isInjectableViewId(value: string): value is CryoClawViewId {
  return (INJECTABLE_VIEWS as readonly string[]).includes(value);
}
