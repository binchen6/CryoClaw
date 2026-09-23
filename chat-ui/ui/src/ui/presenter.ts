import type { CronJob } from "./types.ts";
import { formatDurationHuman, formatMs } from "./format.ts";
import { getLocale } from "./i18n.ts";

export function isExpiredOneShot(job: CronJob): boolean {
  return job.schedule.kind === "at" && typeof job.state?.lastRunAtMs === "number";
}

const ZH_WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const EN_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// formatDurationHuman 产出 "500ms"/"30m"/"3h"/"7d"，按当前 locale 本地化为中文单位
function localizeDuration(human: string, zh: boolean): string {
  if (!zh) return human;
  const m = human.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!m) return human;
  const unit = { ms: "毫秒", s: "秒", m: "分钟", h: "小时", d: "天" }[m[2]] ?? m[2];
  return `${m[1]} ${unit}`;
}

function pad2(n: string): string {
  return n.padStart(2, "0");
}

// 常见 cron 表达式人性化（每天/每周/每 N 分钟），认不出的保留原始表达式
function humanizeCronExpr(expr: string, tz: string | undefined, zh: boolean): string {
  const tzSuffix = tz ? (zh ? `（${tz}）` : ` (${tz})`) : "";
  const fields = expr.trim().split(/\s+/);
  if (fields.length === 5) {
    const [min, hour, dom, mon, dow] = fields;
    const time = /^\d{1,2}$/.test(min) && /^\d{1,2}$/.test(hour) ? `${pad2(hour)}:${pad2(min)}` : null;
    if (time && dom === "*" && mon === "*") {
      if (dow === "*") return zh ? `每天 ${time}${tzSuffix}` : `Daily ${time}${tzSuffix}`;
      // cron 里 0 和 7 都是周日：允许 0-7，按 %7 归一取星期名
      if (/^[0-7]$/.test(dow)) {
        const day = Number(dow) % 7;
        return zh
          ? `每周${ZH_WEEKDAYS[day]} ${time}${tzSuffix}`
          : `Weekly ${EN_WEEKDAYS[day]} ${time}${tzSuffix}`;
      }
    }
    const everyMin = hour === "*" && dom === "*" && mon === "*" && dow === "*" && min.match(/^\*\/(\d+)$/);
    if (everyMin) return zh ? `每 ${everyMin[1]} 分钟${tzSuffix}` : `Every ${everyMin[1]} min${tzSuffix}`;
  }
  return `Cron ${expr}${tzSuffix}`;
}

export function formatCronSchedule(job: CronJob) {
  const s = job.schedule;
  const zh = getLocale() === "zh";
  if (s.kind === "at") {
    const atMs = s.at ? Date.parse(s.at) : NaN;
    const time = Number.isFinite(atMs) ? formatMs(atMs) : String(s.at);
    return zh ? `单次 ${time}` : `Once ${time}`;
  }
  if (s.kind === "every") {
    const duration = localizeDuration(formatDurationHuman(s.everyMs), zh);
    return zh ? `每 ${duration}` : `Every ${duration}`;
  }
  return humanizeCronExpr(s.expr ?? "", s.tz, zh);
}
