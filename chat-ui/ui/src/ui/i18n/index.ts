/**
 * Locale state and synchronous translation API.
 *
 * Only the active dictionary enters the initial module graph. The dictionaries have
 * identical key sets (enforced by i18n.test.ts), so a missing key falls back to its
 * stable key instead of eagerly loading the other 1,779-entry dictionary.
 */

export type Locale = "zh" | "en";

const dictionaries: Partial<Record<Locale, Record<string, string>>> = {};
let currentLocale: Locale = detectLocale();

async function loadDictionary(locale: Locale): Promise<Record<string, string>> {
  const cached = dictionaries[locale];
  if (cached) return cached;
  const dictionary = locale === "zh"
    ? (await import("./zh.ts")).zhDict
    : (await import("./en.ts")).enDict;
  dictionaries[locale] = dictionary;
  return dictionary;
}

// Browser startup loads one dictionary. The Node test runner keeps both available
// so the existing synchronous setLocale contract can be exercised without a DOM.
if (typeof window === "undefined") {
  await Promise.all([loadDictionary("zh"), loadDictionary("en")]);
} else {
  await loadDictionary(currentLocale);
}

function detectLocale(): Locale {
  if (typeof window !== "undefined" && window.location?.search) {
    const params = new URLSearchParams(window.location.search);
    const lang = params.get("lang");
    if (lang?.startsWith("zh")) return "zh";
    if (lang?.startsWith("en")) return "en";
  }
  if (typeof navigator !== "undefined") {
    const lang = navigator.language || "";
    if (lang.startsWith("zh")) return "zh";
  }
  return "en";
}

export function t(key: string): string {
  return dictionaries[currentLocale]?.[key] ?? key;
}

export function tWithDetail(key: string, detail?: string | null): string {
  const prefix = t(key);
  const message = detail?.trim();
  if (!message) return prefix;
  return currentLocale === "zh" ? `${prefix}：${message}` : `${prefix}: ${message}`;
}

export function getLocale(): Locale {
  return currentLocale;
}

export async function loadLocale(locale: Locale): Promise<void> {
  await loadDictionary(locale);
}

export function setLocale(locale: Locale): void {
  if (!dictionaries[locale]) throw new Error(`Locale is not loaded: ${locale}; call loadLocale first`);
  currentLocale = locale;
}
