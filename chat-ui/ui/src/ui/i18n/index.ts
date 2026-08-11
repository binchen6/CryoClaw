/**
 * Minimal i18n module for CryoClaw Chat UI.
 * ~25 string keys, Chinese / English.
 * Language detection: navigator.language or ?lang= URL param.
 *
 * 阶段 16：字典拆分为 ./zh.ts、./en.ts，本文件保留 locale 状态与 API 实现。
 */

import { zhDict } from "./zh.ts";
import { enDict } from "./en.ts";

export type Locale = "zh" | "en";

const dict: Record<Locale, Record<string, string>> = {
  zh: zhDict,
  en: enDict,
};

let currentLocale: Locale = detectLocale();

function detectLocale(): Locale {
  // URL param takes priority
  if (typeof window !== "undefined" && window.location?.search) {
    const params = new URLSearchParams(window.location.search);
    const lang = params.get("lang");
    if (lang?.startsWith("zh")) return "zh";
    if (lang?.startsWith("en")) return "en";
  }
  // Browser language
  if (typeof navigator !== "undefined") {
    const lang = navigator.language || "";
    if (lang.startsWith("zh")) return "zh";
  }
  return "en";
}

/**
 * Translate a key to the current locale.
 * Falls back to English, then to the key itself.
 */
export function t(key: string): string {
  return dict[currentLocale]?.[key] ?? dict.en[key] ?? key;
}

// 本地化错误前缀优先展示给用户，再按原样拼接底层错误详情。
export function tWithDetail(key: string, detail?: string | null): string {
  const prefix = t(key);
  const message = detail?.trim();
  if (!message) {
    return prefix;
  }
  return currentLocale === "zh" ? `${prefix}：${message}` : `${prefix}: ${message}`;
}

/** Get the current locale. */
export function getLocale(): Locale {
  return currentLocale;
}

/** Set the locale explicitly. */
export function setLocale(locale: Locale): void {
  currentLocale = locale;
}
