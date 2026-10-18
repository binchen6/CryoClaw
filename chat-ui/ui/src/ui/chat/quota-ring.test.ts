import test from "node:test";
import assert from "node:assert/strict";
import {zhDict} from "../i18n/zh.ts";
import {enDict} from "../i18n/en.ts";
import {
  balanceAriaLabel, balanceComfort, balanceRatio, balanceRingView, comfortTone, currencyKey,
  formatQuotaAmount, parseBalanceAmount, quotaAriaLabel, quotaComfort, quotaCurrencyProfile,
  quotaRatio, quotaRingView,
} from "./quota-ring.ts";

const zh = (key: string): string => zhDict[key] ?? key;
const en = (key: string): string => enDict[key] ?? key;
const close = (actual: number, expected: number): void =>
  assert.ok(Math.abs(actual - expected) < 0.001, `${actual} 应接近 ${expected}`);

// ── 币种档案：上限与绝对阈值 ──

test("quota ring：CNY/USD 各有上限与分级阈值，未知币种不归一化", () => {
  assert.deepEqual(quotaCurrencyProfile("CNY"), {currency: "CNY", symbol: "¥", ceiling: 100, warnBelow: 30, dangerBelow: 10});
  assert.deepEqual(quotaCurrencyProfile("usd"), {currency: "USD", symbol: "$", ceiling: 20, warnBelow: 6, dangerBelow: 2});
  for (const unknown of ["JPY", "", undefined, null]) {
    const profile = quotaCurrencyProfile(unknown);
    assert.equal(profile.symbol, "¤");
    assert.equal(profile.ceiling, null, `${String(unknown)} 不应归一化`);
    assert.equal(profile.warnBelow, null);
    assert.equal(profile.dangerBelow, null);
  }
  assert.equal(quotaCurrencyProfile(" eur ").currency, "EUR", "大小写与空格归一");
});

// ── 余额解析与分级 ──

test("quota ring：只有有限数才算已知余额，零余额是已知值", () => {
  assert.equal(parseBalanceAmount(undefined), null);
  assert.equal(parseBalanceAmount(null), null);
  assert.equal(parseBalanceAmount(""), null);
  assert.equal(parseBalanceAmount("   "), null);
  assert.equal(parseBalanceAmount("abc"), null);
  assert.equal(parseBalanceAmount(Number.POSITIVE_INFINITY), null);
  assert.equal(parseBalanceAmount("8.63"), 8.63);
  assert.equal(parseBalanceAmount("0"), 0);
  assert.equal(parseBalanceAmount(0), 0);
});

test("quota ring：CNY 绝对阈值 <10 红 / <30 琥珀 / 其余强调色", () => {
  assert.equal(balanceComfort(9.99, "CNY"), "danger");
  assert.equal(balanceComfort(10, "CNY"), "warn");
  assert.equal(balanceComfort(29.99, "CNY"), "warn");
  assert.equal(balanceComfort(30, "CNY"), "ok");
  assert.equal(balanceComfort(0, "CNY"), "danger");
  assert.equal(comfortTone(balanceComfort(0, "CNY")), "danger");
});

test("quota ring：USD 绝对阈值 <2 红 / <6 琥珀 / 其余强调色", () => {
  assert.equal(balanceComfort(1.99, "USD"), "danger");
  assert.equal(balanceComfort(2, "USD"), "warn");
  assert.equal(balanceComfort(5.99, "USD"), "warn");
  assert.equal(balanceComfort(6, "USD"), "ok");
  assert.equal(balanceComfort(0, "usd"), "danger");
});

test("quota ring：其他币种不伪造紧张度，始终强调色", () => {
  assert.equal(balanceComfort(0.5, "JPY"), "ok");
  assert.equal(balanceComfort(0, "JPY"), "ok");
  assert.equal(balanceComfort(1, undefined), "ok");
  assert.equal(balanceComfort(1, ""), "ok");
});

// ── 余额充裕度弧长 ──

test("quota ring：余额充裕度按对数刻度归一到币种上限", () => {
  assert.equal(balanceRatio(0, "CNY"), 0, "0 余额必须空环");
  assert.equal(balanceRatio(-5, "CNY"), 0);
  assert.equal(balanceRatio(100, "CNY"), 1);
  assert.equal(balanceRatio(1000, "CNY"), 1, "超过上限截到满环");
  assert.equal(balanceRatio(20, "USD"), 1);
  close(balanceRatio(8.63, "CNY"), Math.log10(9.63) / Math.log10(101));
  close(balanceRatio(10, "USD"), Math.log10(11) / Math.log10(21));
  assert.equal(balanceRatio(0.01, "CNY"), 0.04, ">0 至少 4% 起弧");
  assert.equal(balanceRatio(1, "JPY"), 1, "其他币种不归一化，满环");
});

// ── 余额视图：展示串 / 中心符号 / 零余额 ──

test("quota ring：余额视图给出符号 + 两位小数金额与语义色", () => {
  const view = balanceRingView({available: "8.63", currency: "CNY"});
  assert.ok(view);
  assert.equal(view.symbol, "¥");
  assert.equal(view.amountText, "8.63");
  assert.equal(view.display, "¥8.63");
  assert.equal(view.tone, "danger");
  assert.equal(view.comfort, "danger");
  close(view.ratio, Math.log10(9.63) / Math.log10(101));
  assert.equal(balanceRingView({available: "25", currency: "USD"})?.display, "$25.00");
  assert.equal(balanceRingView({available: "25", currency: "USD"})?.tone, "accent");
});

test("quota ring：零余额保持正常显示（空环 + 语义色），不当作未知", () => {
  const view = balanceRingView({available: "0", currency: "CNY"});
  assert.ok(view);
  assert.equal(view.amount, 0);
  assert.equal(view.ratio, 0);
  assert.equal(view.display, "¥0.00");
  assert.equal(view.tone, "danger");
  assert.equal(balanceAriaLabel(view, zh), "可用余额 ¥0.00 · 偏低");
});

test("quota ring：缺失/非法金额不生成余额视图", () => {
  assert.equal(balanceRingView(null), null);
  assert.equal(balanceRingView({}), null);
  assert.equal(balanceRingView({available: "", currency: "CNY"}), null);
  assert.equal(balanceRingView({available: "unknown", currency: "USD"}), null);
});

test("quota ring：其他币种用 ¤ 符号、满环、强调色，不显示档位词", () => {
  const view = balanceRingView({available: "500", currency: "JPY"});
  assert.ok(view);
  assert.equal(view.currency, "JPY");
  assert.equal(view.symbol, "¤");
  assert.equal(view.display, "¤500.00");
  assert.equal(view.ratio, 1);
  assert.equal(view.tone, "accent");
  assert.equal(balanceAriaLabel(view, zh), "可用余额 ¤500.00");
  assert.equal(balanceAriaLabel(view, en), "Available balance ¤500.00");
  assert.equal(currencyKey("JPY"), "quota.currency.other");
  assert.equal(currencyKey(undefined), "quota.currency.unknown");
});

test("quota ring：金额千分位与两位小数稳定输出", () => {
  assert.equal(formatQuotaAmount(8.63), "8.63");
  assert.equal(formatQuotaAmount(0), "0.00");
  assert.equal(formatQuotaAmount(1234.5), "1,234.50");
  assert.equal(formatQuotaAmount(0.5), "0.50");
});

// ── 额度窗口：百分比弧长与色阶 ──

test("quota ring：窗口剩余百分比弧长与色阶（<20% 琥珀、<8% 红）", () => {
  assert.equal(quotaComfort(100), "ok");
  assert.equal(quotaComfort(42), "ok");
  assert.equal(quotaComfort(20), "ok");
  assert.equal(quotaComfort(19.99), "warn");
  assert.equal(quotaComfort(8), "warn");
  assert.equal(quotaComfort(7.99), "danger");
  assert.equal(quotaComfort(0), "danger");
  assert.equal(quotaComfort(null), "ok", "未知不参与分级");
  assert.equal(quotaRatio(48), 0.48);
  assert.equal(quotaRatio(120), 1, "异常数据截到满环");
  assert.equal(quotaRatio(-5), 0);
  assert.equal(quotaRingView(null), null);
  assert.equal(quotaRingView(47.6)?.percent, 48);
  assert.equal(quotaRingView(0)?.tone, "danger");
});

// ── aria / title 文案（中英字典同源） ──

test("quota ring：余额 aria 文案中英一致，低余额带档位词", () => {
  const view = balanceRingView({available: "8.63", currency: "CNY"});
  assert.ok(view);
  assert.equal(balanceAriaLabel(view, zh), "可用余额 ¥8.63 · 偏低");
  assert.equal(balanceAriaLabel(view, en), "Available balance ¥8.63 · Low");
  const warn = balanceRingView({available: "12.4", currency: "CNY"});
  assert.ok(warn);
  assert.equal(balanceAriaLabel(warn, zh), "可用余额 ¥12.40 · 偏少");
  assert.equal(balanceAriaLabel(warn, en), "Available balance ¥12.40 · Getting low");
  const ok = balanceRingView({available: "50", currency: "CNY"});
  assert.ok(ok);
  assert.equal(balanceAriaLabel(ok, zh), "可用余额 ¥50.00");
  assert.equal(balanceAriaLabel(ok, en), "Available balance ¥50.00");
});

test("quota ring：窗口 aria 文案保留准确百分比并说明紧张程度", () => {
  assert.equal(quotaAriaLabel(48, zh), "额度剩余 48%");
  assert.equal(quotaAriaLabel(48, en), "Remaining 48%");
  assert.equal(quotaAriaLabel(12.6, zh), "额度剩余 13% · 偏少");
  assert.equal(quotaAriaLabel(7.9, zh), "额度剩余 8% · 偏低");
  assert.equal(quotaAriaLabel(7.9, en), "Remaining 8% · Low");
  assert.equal(quotaAriaLabel(null, zh), "额度未知，点击查看详情");
  assert.equal(quotaAriaLabel(null, en), "Quota unknown; view details");
});

test("quota ring：中英字典包含圆环所需键，避免裸键回退", () => {
  const keys = ["quota.availableBalance", "quota.remainingLabel", "quota.level.ok", "quota.level.warn",
    "quota.level.danger", "quota.currency.cny", "quota.currency.usd", "quota.currency.other",
    "quota.currency.unknown", "quota.ariaUnknown", "quota.legend.title", "quota.legend.other",
    "quota.legend.fullRing", "quota.details.balance", "quota.details.limits", "quota.details.refresh",
    "quota.details.loading", "quota.details.syncing", "quota.details.keyLimitUnset", "quota.details.noLimits",
    "quota.details.synced", "quota.details.scopeKey", "quota.details.scopeAccount", "quota.details.scopeBalance",
    "quota.details.stale", "quota.details.lowBalance", "quota.details.lowBalanceWarn",
    "quota.window.remaining", "quota.window.unknown", "quota.window.reset", "quota.window.requests"];
  for (const key of keys) {
    assert.notEqual(zhDict[key], undefined, `zh 缺少 ${key}`);
    assert.notEqual(enDict[key], undefined, `en 缺少 ${key}`);
  }
});
