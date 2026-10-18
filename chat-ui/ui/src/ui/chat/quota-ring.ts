/**
 * 输入框额度圆环的纯计算层：不触 DOM、不读 locale 状态。
 *
 * 两类数据共用一套 22px 圆环：
 * - 余额型（按量付费 provider）：弧长 = 余额充裕度（按币种上限的对数刻度），
 *   不是限额百分比；颜色用绝对阈值分级，避免把 ¥8.63 伪造成「8.63%」。
 * - 额度窗口型（订阅类 provider）：弧长 = 剩余百分比，颜色按剩余档位分级。
 *
 * aria 文案由调用方注入翻译函数（组件传 t()，单测传字典查表），
 * 保证展示语义与 i18n 字典同源。
 */
export type QuotaRingTone = "accent" | "warn" | "danger";
export type QuotaComfort = "ok" | "warn" | "danger";
export type QuotaTranslator = (key: string) => string;

/** 币种上限决定余额弧长归一到哪里；ceiling=null 表示该币种不归一化。 */
export interface QuotaCurrencyProfile {
  currency: string;
  symbol: string;
  ceiling: number | null;
  warnBelow: number | null;
  dangerBelow: number | null;
}

// 余额再高也不再增加弧长（对数刻度天然收敛），CNY/USD 各取一个「算充裕」的参考值。
const CURRENCY_PROFILES: Record<string, Omit<QuotaCurrencyProfile, "currency">> = {
  CNY: {symbol: "¥", ceiling: 100, warnBelow: 30, dangerBelow: 10},
  USD: {symbol: "$", ceiling: 20, warnBelow: 6, dangerBelow: 2},
};

/** 未识别币种用国际货币符号 ¤，并放弃归一化（圆环恒满）。 */
export function quotaCurrencyProfile(currency?: string | null): QuotaCurrencyProfile {
  const code = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  const known = CURRENCY_PROFILES[code];
  return known ? {currency: code, ...known} : {currency: code, symbol: "¤", ceiling: null, warnBelow: null, dangerBelow: null};
}

/** 余额接口返回字符串金额（可能带空串/空格），只有有限数才算已知余额。 */
export function parseBalanceAmount(available: unknown): number | null {
  if (typeof available === "number") return Number.isFinite(available) ? available : null;
  if (typeof available !== "string") return null;
  const text = available.trim();
  if (!text) return null;
  const amount = Number(text);
  return Number.isFinite(amount) ? amount : null;
}

/** 绝对阈值分级：CNY <10 / <30，USD <2 / <6；其他币种不伪造紧张度。 */
export function balanceComfort(amount: number, currency?: string | null): QuotaComfort {
  if (!Number.isFinite(amount)) return "ok";
  const {warnBelow, dangerBelow} = quotaCurrencyProfile(currency);
  if (dangerBelow !== null && amount < dangerBelow) return "danger";
  if (warnBelow !== null && amount < warnBelow) return "warn";
  return "ok";
}

/**
 * 余额充裕度：log10(1+balance)/log10(1+ceiling)，clamp [0.04, 1]。
 * 0 余额必须空环；>0 至少留 4% 起弧，避免「有余额却看不见」。
 */
export function balanceRatio(amount: number, currency?: string | null): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const {ceiling} = quotaCurrencyProfile(currency);
  if (ceiling === null || ceiling <= 0) return 1;
  const ratio = Math.log10(1 + amount) / Math.log10(1 + ceiling);
  return Math.max(0.04, Math.min(1, ratio));
}

export function comfortTone(comfort: QuotaComfort): QuotaRingTone {
  return comfort === "ok" ? "accent" : comfort;
}

export function quotaRatio(remaining: number | null): number {
  if (remaining === null || !Number.isFinite(remaining)) return 0;
  return Math.max(0, Math.min(1, remaining / 100));
}

/** 剩余 <8% 红、<20% 琥珀；未知不参与分级。 */
export function quotaComfort(remaining: number | null): QuotaComfort {
  if (remaining === null || !Number.isFinite(remaining)) return "ok";
  if (remaining < 8) return "danger";
  if (remaining < 20) return "warn";
  return "ok";
}

export function formatQuotaAmount(amount: number): string {
  return amount.toLocaleString("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

export interface BalanceRingView {
  kind: "balance";
  currency: string;
  symbol: string;
  amount: number;
  amountText: string;
  display: string;
  ratio: number;
  tone: QuotaRingTone;
  comfort: QuotaComfort;
}

export interface QuotaRingView {
  kind: "quota";
  ratio: number;
  percent: number;
  tone: QuotaRingTone;
  comfort: QuotaComfort;
}

export function balanceRingView(balance?: {available?: unknown; currency?: unknown} | null): BalanceRingView | null {
  const amount = parseBalanceAmount(balance?.available);
  if (amount === null) return null;
  const currency = typeof balance?.currency === "string" ? balance.currency : undefined;
  const profile = quotaCurrencyProfile(currency);
  const comfort = balanceComfort(amount, currency);
  const amountText = formatQuotaAmount(amount);
  return {kind: "balance", currency: profile.currency, symbol: profile.symbol, amount, amountText,
    display: `${profile.symbol}${amountText}`, ratio: balanceRatio(amount, currency), tone: comfortTone(comfort), comfort};
}

export function quotaRingView(remaining: number | null): QuotaRingView | null {
  if (remaining === null || !Number.isFinite(remaining)) return null;
  const clamped = Math.max(0, Math.min(100, remaining));
  const comfort = quotaComfort(clamped);
  return {kind: "quota", ratio: quotaRatio(clamped), percent: Math.round(clamped), tone: comfortTone(comfort), comfort};
}

export function levelKey(comfort: QuotaComfort): string {
  return comfort === "ok" ? "quota.level.ok" : comfort === "warn" ? "quota.level.warn" : "quota.level.danger";
}

export function currencyKey(currency?: string | null): string {
  const code = quotaCurrencyProfile(currency).currency;
  if (code === "CNY") return "quota.currency.cny";
  if (code === "USD") return "quota.currency.usd";
  return code ? "quota.currency.other" : "quota.currency.unknown";
}

/** 「可用余额 ¥8.63 · 偏低」/「Available balance ¥8.63 · Low」；充裕时不加档位词。 */
export function balanceAriaLabel(view: BalanceRingView, tr: QuotaTranslator): string {
  const suffix = view.comfort === "ok" ? "" : ` · ${tr(levelKey(view.comfort))}`;
  return `${tr("quota.availableBalance")} ${view.display}${suffix}`;
}

/** 「额度剩余 48%」/「Remaining 48% · Low」；剩余值本身始终准确显示。 */
export function quotaAriaLabel(remaining: number | null, tr: QuotaTranslator): string {
  const view = quotaRingView(remaining);
  if (!view) return tr("quota.ariaUnknown");
  const suffix = view.comfort === "ok" ? "" : ` · ${tr(levelKey(view.comfort))}`;
  return `${tr("quota.remainingLabel")} ${view.percent}%${suffix}`;
}
