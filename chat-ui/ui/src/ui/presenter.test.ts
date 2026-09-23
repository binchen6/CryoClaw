// formatCronSchedule 本地化与人性化回归：历史版本只输出英文 "Every 3h" /
// 裸 cron 表达式（"Cron 0 3 * * *"），中文界面割裂且普通用户读不懂。
import test from "node:test";
import assert from "node:assert/strict";
import { formatCronSchedule } from "./presenter.ts";
import { getLocale, setLocale } from "./i18n.ts";
import type { CronJob } from "./types.ts";

function job(schedule: CronJob["schedule"]): CronJob {
  return { id: "j1", schedule, payload: { kind: "systemEvent" } };
}

const originalLocale = getLocale();

test("formatCronSchedule：zh —— 每天/每周/每 N 分钟/every/at", () => {
  setLocale("zh");
  try {
    assert.equal(formatCronSchedule(job({ kind: "cron", expr: "0 3 * * *" })), "每天 03:00");
    assert.equal(formatCronSchedule(job({ kind: "cron", expr: "30 9 * * 1" })), "每周一 09:30");
    assert.equal(formatCronSchedule(job({ kind: "cron", expr: "*/5 * * * *" })), "每 5 分钟");
    assert.equal(
      formatCronSchedule(job({ kind: "cron", expr: "0 3 * * *", tz: "Asia/Shanghai" })),
      "每天 03:00（Asia/Shanghai）",
    );
    assert.equal(formatCronSchedule(job({ kind: "every", everyMs: 3 * 3600_000 })), "每 3 小时");
    assert.equal(formatCronSchedule(job({ kind: "every", everyMs: 7 * 86400_000 })), "每 7 天");
    assert.match(formatCronSchedule(job({ kind: "at", at: "2026-09-24T08:00:00Z" })), /^单次 /);
    // 认不出的表达式保留原文
    assert.equal(formatCronSchedule(job({ kind: "cron", expr: "15 2 1 * *" })), "Cron 15 2 1 * *");
  } finally {
    setLocale(originalLocale);
  }
});

test("formatCronSchedule：en —— Daily/Weekly/Every/Once", () => {
  setLocale("en");
  try {
    assert.equal(formatCronSchedule(job({ kind: "cron", expr: "0 3 * * *" })), "Daily 03:00");
    assert.equal(formatCronSchedule(job({ kind: "cron", expr: "30 9 * * 5" })), "Weekly Fri 09:30");
    assert.equal(formatCronSchedule(job({ kind: "cron", expr: "*/5 * * * *" })), "Every 5 min");
    assert.equal(
      formatCronSchedule(job({ kind: "cron", expr: "0 3 * * *", tz: "UTC" })),
      "Daily 03:00 (UTC)",
    );
    assert.equal(formatCronSchedule(job({ kind: "every", everyMs: 3 * 3600_000 })), "Every 3h");
    assert.match(formatCronSchedule(job({ kind: "at", at: "2026-09-24T08:00:00Z" })), /^Once /);
    assert.equal(formatCronSchedule(job({ kind: "cron", expr: "15 2 1 * *" })), "Cron 15 2 1 * *");
  } finally {
    setLocale(originalLocale);
  }
});
