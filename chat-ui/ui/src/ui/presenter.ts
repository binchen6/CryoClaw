import type { CronJob } from "./types.ts";
import { formatDurationHuman, formatMs } from "./format.ts";

export function isExpiredOneShot(job: CronJob): boolean {
  return job.schedule.kind === "at" && typeof job.state?.lastRunAtMs === "number";
}

export function formatCronSchedule(job: CronJob) {
  const s = job.schedule;
  if (s.kind === "at") {
    const atMs = s.at ? Date.parse(s.at) : NaN;
    return Number.isFinite(atMs) ? `At ${formatMs(atMs)}` : `At ${s.at}`;
  }
  if (s.kind === "every") {
    return `Every ${formatDurationHuman(s.everyMs)}`;
  }
  return `Cron ${s.expr}${s.tz ? ` (${s.tz})` : ""}`;
}
