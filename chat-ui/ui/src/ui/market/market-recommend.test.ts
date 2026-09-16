import test from "node:test";
import assert from "node:assert/strict";

import {
  inferCategory,
  computeMarketScore,
  rankMarket,
  diversifyByCategory,
  personalizeMarket,
  buildRecommendations,
  skillToMarketItem,
} from "./market-recommend.ts";
import type { MarketCategory, MarketItemCore } from "./market-recommend.ts";

// 固定参考时间：2026-09-16T04:00:00.000Z（UTC 构造，测试与本地时区无关）
const NOW = Date.UTC(2026, 8, 16, 4, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
/** 相对 NOW 偏移 days 天的 ISO 时间串（正数=未来，负数=过去） */
const iso = (days: number) => new Date(NOW + days * DAY_MS).toISOString();

function longestSameCategoryRun(items: readonly MarketItemCore[]): number {
  let best = 0;
  let cur = 0;
  let prev: MarketCategory | null = null;
  for (const it of items) {
    const c = inferCategory(it);
    cur = c === prev ? cur + 1 : 1;
    prev = c;
    best = Math.max(best, cur);
  }
  return best;
}

// ===== 1. 分类推断 =====

test("inferCategory：中文关键词命中（记忆优先于检索）", () => {
  assert.equal(inferCategory({ name: "mem-cn", summary: "长期记忆与知识库检索" }), "memory");
  assert.equal(inferCategory({ name: "cn-voice", summary: "语音合成与朗读" }), "voice");
  assert.equal(inferCategory({ name: "cn-sec", summary: "安全审计与权限" }), "security");
});

test("inferCategory：英文关键词命中（词边界）", () => {
  assert.equal(inferCategory({ name: "clawhub/feishu", summary: "messaging entry" }), "channel");
  assert.equal(inferCategory({ name: "openai-compat", displayName: "OpenAI Provider", summary: "llm model gateway" }), "provider");
  assert.equal(inferCategory({ name: "telegram-relay-bot", summary: "relay" }), "channel");
  assert.equal(inferCategory({ name: "dev-tools-pack", summary: "packed" }), "tool");
  // 词边界：storage 不得误中 rag（子串包含但无边界），research 不得误中 search
  assert.equal(inferCategory({ name: "storage-adapter", summary: "kv store" }), "other");
  assert.equal(inferCategory({ name: "research-assistant", summary: "deep research helper" }), "other");
  // 正向 rag：作为独立词出现时归 search
  assert.equal(inferCategory({ name: "rag-pipeline", summary: "retrieval augmented" }), "search");
});

test("inferCategory：多类命中取优先级最高（channel > provider，memory > search）", () => {
  assert.equal(inferCategory({ name: "wecom-llm", summary: "企业微信渠道接入大模型" }), "channel");
  assert.equal(inferCategory({ name: "qwen-relay", summary: "通义模型转发渠道" }), "channel");
});

test("inferCategory：无命中走兜底（family 含 plugin 或名含 tool/plugin/agent → tool，否则 other）", () => {
  assert.equal(inferCategory({ name: "misc-x", family: "plugin-utils", summary: "" }), "tool");
  assert.equal(inferCategory({ name: "agent-hub", summary: "misc helper" }), "tool");
  assert.equal(inferCategory({ name: "wallpaper-random", summary: "random fun" }), "other");
});

test("inferCategory：categories 透传字段不参与推断（统一走关键词口径）", () => {
  assert.equal(inferCategory({ name: "x-1", summary: "记忆增强", categories: ["search"] }), "memory");
});

// ===== 2. 评分 =====

test("computeMarketScore：ordering 官方+新+高下载 > 官方+旧 > verified > unknown", () => {
  const a = computeMarketScore({ name: "a", isOfficial: true, downloads: 50000, updatedAt: iso(0) }, NOW);
  const b = computeMarketScore({ name: "b", isOfficial: true, downloads: 50000, updatedAt: iso(-365) }, NOW);
  const c = computeMarketScore({ name: "c", verificationTier: "Verified", downloads: 50000, updatedAt: iso(-365) }, NOW);
  const d = computeMarketScore({ name: "d", downloads: 50000, updatedAt: iso(-365) }, NOW);

  assert.ok(a.total > b.total, `a(${a.total}) 应大于 b(${b.total})`);
  assert.ok(b.total > c.total, `b(${b.total}) 应大于 c(${c.total})`);
  assert.ok(c.total > d.total, `c(${c.total}) 应大于 d(${d.total})`);

  // 分量精确值
  assert.equal(a.popularity, 1);
  assert.equal(a.freshness, 1);
  assert.equal(a.trust, 1);
  assert.equal(b.trust, 1);
  assert.equal(c.trust, 0.7);
  assert.equal(d.trust, 0.15);
  assert.ok(a.total > 0.999 && a.total <= 1, "满分条目 total 应逼近 1");
});

test("computeMarketScore：缺字段取中性值（无下载/无时间/无凭证）", () => {
  const s = computeMarketScore({ name: "bare" }, NOW);
  assert.equal(s.popularity, 0);
  assert.equal(s.freshness, 0.3);
  assert.equal(s.trust, 0.15);
  // total = 0.25*0.3 + 0.40*0.15 = 0.135
  assert.ok(Math.abs(s.total - 0.135) < 1e-12);
});

test("computeMarketScore：不可解析 updatedAt 按中性 0.3 处理", () => {
  const s = computeMarketScore({ name: "bad-ts", updatedAt: "not-a-date" }, NOW);
  assert.equal(s.freshness, 0.3);
});

test("computeMarketScore：未来 updatedAt 截断为 1，不奖励超量新鲜度", () => {
  const s = computeMarketScore({ name: "future", updatedAt: iso(30) }, NOW);
  assert.equal(s.freshness, 1);
});

test("computeMarketScore：下载量超封顶后 popularity 截断到 1", () => {
  const s = computeMarketScore({ name: "viral", downloads: 10_000_000, updatedAt: iso(0) }, NOW);
  assert.equal(s.popularity, 1);
  assert.ok(s.total <= 1);
});

test("computeMarketScore：tier 子串规则（verified/known 大小写不敏感）", () => {
  assert.equal(computeMarketScore({ name: "t1", verificationTier: "verified publisher" }, NOW).trust, 0.7);
  assert.equal(computeMarketScore({ name: "t2", verificationTier: "Well-Known" }, NOW).trust, 0.4);
  assert.equal(computeMarketScore({ name: "t3", verificationTier: "community" }, NOW).trust, 0.15);
});

// ===== 3. 排序 =====

test("rankMarket：total 降序，同分按 name 字典序稳定", () => {
  const hi = { name: "zzz-top", isOfficial: true, downloads: 50000, updatedAt: iso(0) };
  const lo = { name: "aaa-low", downloads: 1, updatedAt: iso(-365) };
  const tieA = { name: "aaa-tie", verificationTier: "verified", downloads: 100, updatedAt: iso(-3) };
  const tieZ = { name: "zzz-tie", verificationTier: "verified", downloads: 100, updatedAt: iso(-3) };
  const ranked = rankMarket([lo, tieZ, hi, tieA], NOW);

  assert.deepEqual(ranked.map((r) => r.name), ["zzz-top", "aaa-tie", "zzz-tie", "aaa-low"]);
  assert.equal(ranked[1].score.total, ranked[2].score.total);
});

test("rankMarket：不改入参（原数组顺序与原对象均无 score）", () => {
  const items = [
    { name: "b", downloads: 10 },
    { name: "a", downloads: 10 },
  ];
  const snapshot = items.map((i) => ({ ...i }));
  rankMarket(items, NOW);
  assert.deepEqual(items, snapshot);
  assert.ok(!("score" in items[0]));
});

// ===== 4. 类目多样化 =====

test("diversifyByCategory：占优类目蛇形摊开（6 同类 + 2 + 1 无 3 连同类）", () => {
  const ranked = [
    { name: "p1", summary: "大模型 provider gateway" },
    { name: "p2", summary: "大模型 provider gateway" },
    { name: "p3", summary: "大模型 provider gateway" },
    { name: "p4", summary: "大模型 provider gateway" },
    { name: "p5", summary: "大模型 provider gateway" },
    { name: "p6", summary: "大模型 provider gateway" },
    { name: "c1", summary: "feishu 渠道接入" },
    { name: "c2", summary: "feishu 渠道接入" },
    { name: "m1", summary: "会话记忆" },
  ];
  const out = diversifyByCategory(ranked);

  assert.deepEqual(
    out.map((o) => o.name),
    ["p1", "p2", "c1", "p3", "p4", "c2", "p5", "p6", "m1"],
  );
  assert.ok(longestSameCategoryRun(out) <= 2, "不应出现 3 连同类");
});

test("diversifyByCategory：均衡输入为标准轮转（每轮每类取 1 个）", () => {
  const ranked = [
    { name: "a1", summary: "大模型" },
    { name: "b1", summary: "feishu 渠道" },
    { name: "m1", summary: "记忆" },
    { name: "a2", summary: "大模型" },
    { name: "b2", summary: "feishu 渠道" },
    { name: "m2", summary: "记忆" },
    { name: "a3", summary: "大模型" },
    { name: "b3", summary: "feishu 渠道" },
    { name: "m3", summary: "记忆" },
  ];
  const out = diversifyByCategory(ranked);
  assert.deepEqual(
    out.map((o) => o.name),
    ["a1", "b1", "m1", "a2", "b2", "m2", "a3", "b3", "m3"],
  );
});

test("diversifyByCategory：不改类目内相对顺序，队首仍是全场第一名", () => {
  const ranked = [
    { name: "p1" }, { name: "p2" }, { name: "p3" }, { name: "p4" },
    { name: "c1", summary: "渠道 channel" }, { name: "c2", summary: "渠道 channel" },
  ];
  const out = diversifyByCategory(ranked);
  assert.equal(out[0].name, "p1");
  const pOrder = out.map((o, i) => (o.name.startsWith("p") ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(pOrder, [...pOrder].sort((x, y) => x - y), "p1..p4 相对顺序应保持");
  const cOrder = out.map((o, i) => (o.name.startsWith("c") ? i : -1)).filter((i) => i >= 0);
  assert.ok(cOrder[0] < cOrder[1], "c1 应在 c2 前");
  assert.ok(longestSameCategoryRun(out) <= 2);
});

test("diversifyByCategory：单一类目无法交错，按原序连排", () => {
  const ranked = [{ name: "p1" }, { name: "p2" }, { name: "p3" }];
  assert.deepEqual(diversifyByCategory(ranked).map((o) => o.name), ["p1", "p2", "p3"]);
});

test("diversifyByCategory：空输入返回空数组", () => {
  assert.deepEqual(diversifyByCategory([]), []);
});

// ===== 5. 个性化 =====

test("personalizeMarket：排除 excludeNames 且保持剩余顺序", () => {
  const items = [
    { name: "a", downloads: 5 },
    { name: "b", downloads: 5 },
    { name: "c", downloads: 5 },
  ];
  const out = personalizeMarket(items, { excludeNames: new Set(["b"]), now: NOW });
  assert.deepEqual(out.map((o) => o.name), ["a", "c"]);
});

test("personalizeMarket：hints 词边界命中加成 1.35，未命中原分", () => {
  const plain = { name: "y-plain-bot", summary: "generic helper robot", isOfficial: true, downloads: 1000, updatedAt: iso(-10) };
  const hit = { name: "x-feishu-bot", summary: "feishu 渠道机器人", isOfficial: true, downloads: 1000, updatedAt: iso(-10) };
  const out = personalizeMarket([plain, hit], { hints: ["feishu"], now: NOW });

  const plainScored = out.find((o) => o.name === "y-plain-bot")!;
  const hitScored = out.find((o) => o.name === "x-feishu-bot")!;
  assert.equal(hitScored.score.total, plainScored.score.total * 1.35, "命中条目 total 应为原分 ×1.35");
  assert.equal(hitScored.score.trust, plainScored.score.trust, "trust 分量不受加成影响");

  // 词边界：research 不因包含 search 子串而命中 hint "search"
  const research = { name: "research-assistant", summary: "deep research helper", downloads: 100 };
  const [r] = personalizeMarket([research], { hints: ["search"], now: NOW });
  assert.equal(r.score.total, computeMarketScore(research, NOW).total);

  // 中文 hint 走子串匹配
  const cn = { name: "doc-sync", summary: "飞书文档同步", downloads: 100 };
  const [c] = personalizeMarket([cn], { hints: ["飞书"], now: NOW });
  assert.equal(c.score.total, computeMarketScore(cn, NOW).total * 1.35);
});

test("personalizeMarket：加权后排在同分未加权之前（经 buildRecommendations 编排）", () => {
  const plain = { name: "y-plain-bot", summary: "generic helper robot", isOfficial: true, downloads: 1000, updatedAt: iso(-10) };
  const hit = { name: "x-feishu-bot", summary: "feishu 渠道机器人", isOfficial: true, downloads: 1000, updatedAt: iso(-10) };
  // 故意让未加权条目排前面，验证加权把它压下去
  const out = buildRecommendations([plain, hit], { hints: ["feishu"], limit: 2, now: NOW });
  assert.deepEqual(out.map((o) => o.name), ["x-feishu-bot", "y-plain-bot"]);
});

test("personalizeMarket：不改入参对象", () => {
  const items = [{ name: "a", summary: "feishu 渠道" }];
  personalizeMarket(items, { hints: ["feishu"], now: NOW });
  assert.ok(!("score" in items[0]));
});

// ===== 6. 编排入口 =====

test("buildRecommendations：过滤已装 → 加权 → 排序 → 多样化 → 截 limit 端到端", () => {
  const pool = [
    { name: "installed-x", summary: "feishu 渠道", isOfficial: true, downloads: 99999, updatedAt: iso(0) },
    { name: "top-feishu", summary: "feishu 渠道机器人", isOfficial: true, downloads: 50000, updatedAt: iso(0) },
    { name: "prov-old", summary: "大模型网关", isOfficial: true, downloads: 50000, updatedAt: iso(-365) },
    { name: "mem-verified", summary: "长期记忆", verificationTier: "verified", downloads: 8000, updatedAt: iso(-10) },
    { name: "search-verified", summary: "网页搜索", verificationTier: "verified", downloads: 8000, updatedAt: iso(-10) },
    { name: "voice-unknown", summary: "语音转写", downloads: 2000, updatedAt: iso(-30) },
    { name: "sec-unknown", summary: "安全审计", downloads: 2000, updatedAt: iso(-30) },
    { name: "tool-unknown", summary: "mcp 工具箱", downloads: 500, updatedAt: iso(-60) },
  ];
  const out = buildRecommendations(pool, {
    excludeNames: new Set(["installed-x"]),
    hints: ["feishu"],
    limit: 5,
    now: NOW,
  });

  assert.equal(out.length, 5, "应截取 limit=5");
  assert.ok(!out.some((o) => o.name === "installed-x"), "已装条目应被排除");
  assert.equal(out[0].name, "top-feishu", "高分+加权条目应居首");
  assert.ok(out[0].score.total > 1, "加权条目 total 应超过 1（1.35 加成）");
  assert.ok(longestSameCategoryRun(out) <= 2, "输出不应有 3 连同类");

  // limit 超过总量：返回全部未排除条目
  const all = buildRecommendations(pool, { excludeNames: new Set(["installed-x"]), limit: 100, now: NOW });
  assert.equal(all.length, 7);
  // 不传 limit：不截断
  const noLimit = buildRecommendations(pool, { excludeNames: new Set(["installed-x"]), now: NOW });
  assert.equal(noLimit.length, 7);
});

test("buildRecommendations：同参数多次调用结果一致（确定性）", () => {
  const pool = [
    { name: "a", summary: "记忆", downloads: 10, updatedAt: iso(-1) },
    { name: "b", summary: "搜索", downloads: 20, updatedAt: iso(-2) },
    { name: "c", summary: "feishu 渠道", downloads: 30, updatedAt: iso(-3) },
  ];
  const r1 = buildRecommendations(pool, { hints: ["feishu"], now: NOW });
  const r2 = buildRecommendations(pool, { hints: ["feishu"], now: NOW });
  assert.deepEqual(r1, r2);
});

// ===== 7. 技能映射 =====

test("skillToMarketItem：字段映射（slug→name、name→displayName、description→summary、version→latestVersion）", () => {
  const mapped = skillToMarketItem({
    slug: "pdf-export",
    name: "PDF 导出",
    description: "把会话导出为 PDF 文件",
    version: "1.2.0",
    downloads: 1234,
    updatedAt: iso(-3),
    author: "claw",
  });
  assert.equal(mapped.name, "pdf-export");
  assert.equal(mapped.displayName, "PDF 导出");
  assert.equal(mapped.summary, "把会话导出为 PDF 文件");
  assert.equal(mapped.latestVersion, "1.2.0");
  assert.equal(mapped.downloads, 1234);
  assert.equal(mapped.updatedAt, iso(-3));
  assert.equal(mapped.ownerHandle, "claw");
  assert.equal(mapped.isOfficial, undefined);

  // 映射后可直接进入统一评分口径
  const s = computeMarketScore(mapped, NOW);
  assert.ok(Math.abs(s.popularity - Math.log10(1235) / Math.log10(50001)) < 1e-12);
  assert.ok(Math.abs(s.freshness - Math.exp(-3 / 30)) < 1e-12);
});

test("skillToMarketItem：author 可选，缺失时不设置 ownerHandle", () => {
  const mapped = skillToMarketItem({
    slug: "s",
    name: "S",
    description: "d",
    version: "0.0.1",
    downloads: 0,
    updatedAt: iso(0),
  });
  assert.equal(mapped.ownerHandle, undefined);
});
