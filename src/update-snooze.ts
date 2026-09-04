/**
 * update-snooze.ts — App 更新提示暂缓持久化
 *
 * 用户在更新弹窗选「暂缓」后，期内启动不再自动检查更新（手动检查不受影响）。
 * 存储：userData/app-update-snooze.json → { until: number | "forever", setAt: number }
 * until 为 epoch ms；"forever" 表示永久暂缓（仅手动检查可见更新）。
 *
 * 纯逻辑（parseSnooze / isSnoozeActive）不依赖 electron，可独立单测。
 */

import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

export type SnoozeUntil = number | "forever";
export type SnoozeState = { until: SnoozeUntil; setAt: number };

/** 宽容解析存储内容；任何不合法返回 null（视为未暂缓）。 */
export function parseSnooze(raw: unknown): SnoozeState | null {
  if (!raw || typeof raw !== "object") return null;
  const until = (raw as any).until;
  if (until === "forever") return { until, setAt: Number((raw as any).setAt) || 0 };
  if (typeof until === "number" && Number.isFinite(until) && until > 0) {
    return { until, setAt: Number((raw as any).setAt) || 0 };
  }
  return null;
}

/** 暂缓是否生效：forever 恒 true；时间戳未到期 true。 */
export function isSnoozeActive(snooze: SnoozeState | null, now: number): boolean {
  if (!snooze) return false;
  if (snooze.until === "forever") return true;
  return snooze.until > now;
}

function snoozeFilePath(): string {
  return path.join(app.getPath("userData"), "app-update-snooze.json");
}

export function readSnooze(): SnoozeState | null {
  try {
    return parseSnooze(JSON.parse(fs.readFileSync(snoozeFilePath(), "utf-8")));
  } catch {
    return null;
  }
}

export function isUpdateSnoozed(now = Date.now()): boolean {
  return isSnoozeActive(readSnooze(), now);
}

export function writeSnooze(until: SnoozeUntil): void {
  const state: SnoozeState = { until, setAt: Date.now() };
  fs.writeFileSync(snoozeFilePath(), JSON.stringify(state, null, 2), "utf-8");
}

export function clearSnooze(): void {
  try {
    fs.rmSync(snoozeFilePath(), { force: true });
  } catch {}
}
