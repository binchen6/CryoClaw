/**
 * 主窗口尺寸：默认约占主屏工作区 80%，用户调整后的 bounds 持久化恢复。
 * 纯函数部分（默认尺寸计算 / bounds 可用性校验）独立可测。
 */
import { app, screen } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT } from "./constants";

export type WindowBounds = {
  x?: number;
  y?: number;
  width: number;
  height: number;
};

type Size = { width: number; height: number };

/** 首次启动默认尺寸：工作区的 80%，不低于最小约束 */
export function defaultWindowSize(workArea: Size): Size {
  return {
    width: Math.max(WINDOW_MIN_WIDTH, Math.round(workArea.width * 0.8)),
    height: Math.max(WINDOW_MIN_HEIGHT, Math.round(workArea.height * 0.8)),
  };
}

/**
 * 持久化 bounds 是否可用：尺寸合法（≥最小约束）且窗口与任一显示器
 * 工作区有足够重叠（≥160px 见宽、≥48px 见高），防止拔掉外接屏后
 * 窗口恢复到不可见区域。
 */
export function isBoundsUsable(
  bounds: WindowBounds,
  workAreas: readonly (Size & { x: number; y: number })[],
): boolean {
  if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return false;
  if (bounds.width < WINDOW_MIN_WIDTH || bounds.height < WINDOW_MIN_HEIGHT) return false;
  const bx = bounds.x ?? 0;
  const by = bounds.y ?? 0;
  for (const wa of workAreas) {
    const overlapX = Math.min(bx + bounds.width, wa.x + wa.width) - Math.max(bx, wa.x);
    const overlapY = Math.min(by + bounds.height, wa.y + wa.height) - Math.max(by, wa.y);
    if (overlapX >= 160 && overlapY >= 48) return true;
  }
  return false;
}

function boundsFilePath(): string {
  return path.join(app.getPath("userData"), "window-bounds.json");
}

/** 读取持久化 bounds；缺失/损坏/不可见时返回 null（走默认尺寸） */
export function loadPersistedBounds(): WindowBounds | null {
  try {
    const raw = fs.readFileSync(boundsFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<WindowBounds>;
    if (typeof parsed.width !== "number" || typeof parsed.height !== "number") return null;
    const bounds: WindowBounds = {
      x: typeof parsed.x === "number" ? parsed.x : undefined,
      y: typeof parsed.y === "number" ? parsed.y : undefined,
      width: parsed.width,
      height: parsed.height,
    };
    const workAreas = screen.getAllDisplays().map((d) => d.workArea);
    return isBoundsUsable(bounds, workAreas) ? bounds : null;
  } catch {
    return null;
  }
}

/** 持久化 bounds（同步写，量小；调用方负责节流） */
export function persistBounds(bounds: WindowBounds): void {
  try {
    fs.writeFileSync(boundsFilePath(), JSON.stringify(bounds), "utf8");
  } catch {
    // 持久化失败不阻断窗口行为
  }
}

/** 解析创建窗口用的初始 bounds：持久化优先，否则主屏工作区 80% */
export function resolveInitialBounds(): WindowBounds {
  const persisted = loadPersistedBounds();
  if (persisted) return persisted;
  return defaultWindowSize(screen.getPrimaryDisplay().workAreaSize);
}
