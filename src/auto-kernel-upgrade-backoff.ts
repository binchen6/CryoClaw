/**
 * auto-kernel-upgrade-backoff.ts — 自动内核升级失败退避持久化
 *
 * 启动后自动升级（main.ts scheduleAutoKernelUpgradeIfNeeded）失败后，
 * 24h 内启动不再自动重试（手动升级不受影响），避免每次启动都重复失败换装。
 * 存储：userData/auto-kernel-upgrade-state.json → { lastFailedAt, lastFailedFromVersion }
 * 升级成功后清除记录。
 *
 * 纯逻辑（parseBackoffState / isBackoffActive）不依赖 electron，可独立单测
 * （模式同 update-snooze.ts）。
 */

import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

export type AutoKernelUpgradeBackoffState = {
  lastFailedAt: number;
  lastFailedFromVersion: string | null;
};

// 退避窗口：距上次失败不足此时长则跳过自动升级
export const AUTO_KERNEL_UPGRADE_BACKOFF_MS = 24 * 60 * 60 * 1000;

/** 宽容解析存储内容；任何不合法返回 null（视为无失败记录）。 */
export function parseBackoffState(raw: unknown): AutoKernelUpgradeBackoffState | null {
  if (!raw || typeof raw !== "object") return null;
  const lastFailedAt = (raw as any).lastFailedAt;
  if (typeof lastFailedAt !== "number" || !Number.isFinite(lastFailedAt) || lastFailedAt <= 0) {
    return null;
  }
  const fromVersion = (raw as any).lastFailedFromVersion;
  return {
    lastFailedAt,
    lastFailedFromVersion: typeof fromVersion === "string" && fromVersion ? fromVersion : null,
  };
}

/** 距上次失败未超出退避窗口则生效。 */
export function isBackoffActive(
  state: AutoKernelUpgradeBackoffState | null,
  now: number,
  backoffMs: number = AUTO_KERNEL_UPGRADE_BACKOFF_MS,
): boolean {
  if (!state) return false;
  return now - state.lastFailedAt < backoffMs;
}

function stateFilePath(): string {
  return path.join(app.getPath("userData"), "auto-kernel-upgrade-state.json");
}

export function readBackoffState(): AutoKernelUpgradeBackoffState | null {
  try {
    return parseBackoffState(JSON.parse(fs.readFileSync(stateFilePath(), "utf-8")));
  } catch {
    return null;
  }
}

export function isAutoKernelUpgradeBackoffActive(now = Date.now()): boolean {
  return isBackoffActive(readBackoffState(), now);
}

export function recordAutoKernelUpgradeFailure(fromVersion: string | null): void {
  const state: AutoKernelUpgradeBackoffState = { lastFailedAt: Date.now(), lastFailedFromVersion: fromVersion };
  try {
    fs.writeFileSync(stateFilePath(), JSON.stringify(state, null, 2), "utf-8");
  } catch {}
}

export function clearAutoKernelUpgradeBackoff(): void {
  try {
    fs.rmSync(stateFilePath(), { force: true });
  } catch {}
}
