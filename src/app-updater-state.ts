/**
 * app-updater-state.ts — App 自动更新（electron-updater）状态机纯逻辑。
 *
 * 不依赖 electron，可独立单测；Electron 事件接线见 app-updater.ts。
 * 状态流转：idle → checking → available → downloading → downloaded
 *                        ↘ not-available   ↘ error（任意阶段失败，可重新 check 重试）
 */

export type AppUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "not-available"
  | "error";

export type AppUpdateProgress = {
  /** 0-100，已钳制 */
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
};

export type AppUpdateState = {
  /** false = dev/未打包环境，前端据此渲染「不支持」 */
  supported: boolean;
  status: AppUpdateStatus;
  currentVersion: string;
  /** 可用新版本号（available/downloading/downloaded 时有值） */
  version: string | null;
  /** 新版本的更新说明（release-notes.json 按版本号匹配，可能缺失） */
  releaseNotes: { zh?: string; en?: string } | null;
  progress: AppUpdateProgress | null;
  error: string | null;
  /** 更新提示暂缓到的时刻（epoch ms）或 "forever"；null = 未暂缓。
   * 非状态机字段：由 app-updater 在 publish/getState 时合并（见 update-snooze.ts） */
  snoozedUntil?: number | "forever" | null;
};

export type AppUpdateEvent =
  | { type: "checking" }
  | { type: "available"; version: string; releaseNotes?: { zh?: string; en?: string } | null }
  | { type: "not-available" }
  | { type: "progress"; percent: number; bytesPerSecond: number; transferred: number; total: number }
  | { type: "downloaded" }
  | { type: "error"; message: string };

export function createInitialAppUpdateState(supported: boolean, currentVersion: string): AppUpdateState {
  return {
    supported,
    status: "idle",
    currentVersion,
    version: null,
    releaseNotes: null,
    progress: null,
    error: null,
    snoozedUntil: null,
  };
}

export function reduceAppUpdateState(state: AppUpdateState, event: AppUpdateEvent): AppUpdateState {
  switch (event.type) {
    case "checking":
      // 重新检查：清空上一轮的版本/错误/进度，回到 checking（error 态由此复位可重试）
      return { ...state, status: "checking", version: null, releaseNotes: null, progress: null, error: null };
    case "available":
      return {
        ...state,
        status: "available",
        version: event.version,
        releaseNotes: event.releaseNotes ?? null,
        progress: null,
        error: null,
      };
    case "not-available":
      return { ...state, status: "not-available", version: null, releaseNotes: null, progress: null, error: null };
    case "progress": {
      // autoDownload=true 时 available 后随即开始下载；其他状态下忽略游离进度事件
      if (state.status !== "available" && state.status !== "downloading") return state;
      const percent = Number.isFinite(event.percent) ? Math.max(0, Math.min(100, event.percent)) : 0;
      return {
        ...state,
        status: "downloading",
        progress: {
          percent,
          bytesPerSecond: event.bytesPerSecond,
          transferred: event.transferred,
          total: event.total,
        },
      };
    }
    case "downloaded":
      return { ...state, status: "downloaded", progress: null, error: null };
    case "error":
      // 保留 version 便于 UI 提示「下载 xxx 失败」；progress 清空，error 文案供设置页静默展示
      return { ...state, status: "error", progress: null, error: event.message };
  }
}
