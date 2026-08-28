/**
 * CryoClaw 视图注册表 —— 视图 id 的唯一事实来源。
 *
 * 新增视图接线点（共 3 处）：
 *   1. 本文件：CRYOCLAW_VIEW_IDS / CRYOCLAW_VIEW_META 各加一条
 *   2. storage.ts：无（union 从本文件导入，自动生效；若允许 URL 注入需加 INJECTABLE_VIEWS）
 *   3. app-render.ts：renderActiveView 的 switch 加渲染分支
 * （gotchas #49 的历史"4+1 处"已收敛到这里。）
 */

export const CRYOCLAW_VIEW_IDS = [
  "chat",
  "setup",
  "settings",
  "skills",
  "workspace",
  "cron",
  "tasks",
  "worktrees",
  "git",
] as const;

export type CryoClawViewId = (typeof CRYOCLAW_VIEW_IDS)[number];

export type CryoClawViewMeta = {
  id: CryoClawViewId;
  /**
   * 全页视图：隐藏侧边栏（cryoclaw-shell--fullpage），标题栏显示「返回对话」浮动按钮。
   * chat 为主视图；setup 是全屏向导（无返回按钮）。
   */
  fullpage: boolean;
  /** 标题栏是否显示「返回对话」浮动按钮（仅 fullpage 视图有意义） */
  titlebarBack: boolean;
};

export const CRYOCLAW_VIEW_META: Record<CryoClawViewId, CryoClawViewMeta> = {
  chat: { id: "chat", fullpage: false, titlebarBack: false },
  setup: { id: "setup", fullpage: true, titlebarBack: false },
  settings: { id: "settings", fullpage: true, titlebarBack: true },
  skills: { id: "skills", fullpage: true, titlebarBack: true },
  workspace: { id: "workspace", fullpage: true, titlebarBack: true },
  cron: { id: "cron", fullpage: true, titlebarBack: true },
  tasks: { id: "tasks", fullpage: true, titlebarBack: true },
  worktrees: { id: "worktrees", fullpage: true, titlebarBack: true },
  git: { id: "git", fullpage: true, titlebarBack: true },
};

export function isCryoClawViewId(value: string): value is CryoClawViewId {
  return (CRYOCLAW_VIEW_IDS as readonly string[]).includes(value);
}

/**
 * 允许经 URL query/hash（?view=）注入的视图白名单。
 * 仅 file:// 受信启动参数使用；tasks 等敏感/临时视图不开放注入
 * （与 storage.ts / app-settings.ts 的历史行为一致）。
 */
export const INJECTABLE_VIEWS: readonly CryoClawViewId[] = [
  "chat",
  "setup",
  "settings",
  "skills",
  "workspace",
  "cron",
];

export function isInjectableViewId(value: string): value is CryoClawViewId {
  return (INJECTABLE_VIEWS as readonly string[]).includes(value);
}
