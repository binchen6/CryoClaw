import { formatDurationHuman } from "../../../src/infra/format-time/format-duration.ts";
import { formatRelativeTimestamp } from "../../../src/infra/format-time/format-relative.ts";
import { stripReasoningTagsFromText } from "../../../src/shared/text/reasoning-tags.js";

export { formatRelativeTimestamp, formatDurationHuman };

export function formatMs(ms?: number | null): string {
  if (!ms && ms !== 0) {
    return "n/a";
  }
  return new Date(ms).toLocaleString();
}

export function truncateText(
  value: string,
  max: number,
): {
  text: string;
  truncated: boolean;
  total: number;
} {
  if (value.length <= max) {
    return { text: value, truncated: false, total: value.length };
  }
  return {
    text: value.slice(0, Math.max(0, max)),
    truncated: true,
    total: value.length,
  };
}

export function toNumber(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function stripThinkingTags(value: string): string {
  return stripReasoningTagsFromText(value, { mode: "preserve", trim: "start" });
}
