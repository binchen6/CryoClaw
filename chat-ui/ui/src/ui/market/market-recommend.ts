/**
 * 市场（插件 + 技能）统一推荐与发现算法库（R91）。
 *
 * 设计约束：
 * - 纯函数、无 lit / DOM 依赖，可在 Node 下直接单测；
 * - 确定性：时间一律经 now 参数注入，同输入必同输出（默认值仅为缺省兜底）；
 * - 数据契约：对齐插件市场条目（tab-plugins.lib.ts 的 MarketPluginView）与
 *   技能商店条目（skill-store-view.ts 的 SkillItem，经 skillToMarketItem 映射），
 *   两类条目归一到 MarketItemCore 后共用同一套分类/评分/排序/多样化逻辑。
 *
 * 评分权重理由（安全第一）：
 * - trust 0.40（最高）：市场条目来源不可控，装错插件的安全代价最大，
 *   官方 / 已验证来源必须优先于人气；
 * - popularity 0.35：下载量是质量的社会化信号，但可被刷量且头部效应强，
 *   用 log10 压缩长尾并封顶，防止单靠下载量霸榜；
 * - freshness 0.25（最低）：更新时间戳噪声大（重新打包/重发都会刷新），
 *   只做轻量的时效惩罚，缺时间戳给中性值而非惩罚。
 */

/** 市场类目：渠道 > 供应商 > 记忆 > 搜索 > 语音 > 安全 > 工具 > 其他（优先级从高到低） */
export type MarketCategory =
  | "channel"
  | "provider"
  | "tool"
  | "memory"
  | "search"
  | "voice"
  | "security"
  | "other";

/** 统一市场条目：插件市场条目直接满足；技能条目经 skillToMarketItem 映射 */
export type MarketItemCore = {
  /** 唯一标识：插件用包名，技能用 slug */
  name: string;
  displayName?: string;
  summary?: string;
  downloads?: number;
  /** ISO 时间字符串；缺失/不可解析时评分取中性值 */
  updatedAt?: string;
  isOfficial?: boolean;
  channel?: string;
  verificationTier?: string;
  latestVersion?: string;
  ownerHandle?: string;
  family?: string;
  /** 来源侧透传的类目标签，仅供 UI 展示；分类推断统一走关键词口径，避免双来源打架 */
  categories?: string[];
};

/** 评分明细：total 为加权总分（个性化加权后 total 会大于分量加权和） */
export type ScoreBreakdown = { total: number; popularity: number; freshness: number; trust: number };

/** 技能商店条目（skill-store-view.ts SkillItem 的可映射子集；highlighted 无对应字段，映射时丢弃） */
export type SkillStoreItem = {
  slug: string;
  name: string;
  description: string;
  version: string;
  downloads: number;
  updatedAt: string;
  author?: string;
  highlighted?: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

// ===== 评分常量 =====
/** 人气封顶下载量：达到 5 万即视为满人气 */
const POPULARITY_CEILING = 50000;
const POPULARITY_WEIGHT = 0.35;
const FRESHNESS_WEIGHT = 0.25;
const TRUST_WEIGHT = 0.4;
/** 缺/坏 updatedAt 时的中性新鲜度：既不奖励也不重罚 */
const FRESHNESS_NEUTRAL = 0.3;
/** 新鲜度衰减尺度：30 天前的条目 freshness ≈ exp(-1) ≈ 0.37 */
const FRESHNESS_DECAY_DAYS = 30;
/** 个性化命中已启用生态（渠道/供应商）时的加成系数 */
const PERSONALIZE_BOOST = 1.35;

// ===== 类目关键词规则 =====
/**
 * 数组顺序即命中优先级：channel > provider > memory > search > voice > security > tool。
 * 渠道放最前：渠道（消息发到哪）是最能区分市场的维度，且渠道名（feishu/wecom…）
 * 经常和"模型/工具"字样同时出现，需靠优先级裁决。
 */
const CATEGORY_RULES: ReadonlyArray<{ category: MarketCategory; keywords: readonly string[] }> = [
  {
    category: "channel",
    keywords: [
      "feishu", "飞书", "lark", "wecom", "企业微信", "企微", "wechat", "微信",
      "dingtalk", "钉钉", "telegram", "电报", "slack", "discord", "whatsapp",
      "channel", "渠道", "connector", "连接器",
    ],
  },
  {
    category: "provider",
    keywords: [
      "provider", "providers", "供应商", "model", "models", "模型", "大模型", "llm",
      "openai", "chatgpt", "gpt", "anthropic", "claude", "gemini", "deepseek",
      "qwen", "通义", "kimi", "moonshot", "zhipu", "智谱", "glm", "ollama",
      "openrouter", "llama", "mistral", "groq", "azure", "bedrock",
    ],
  },
  {
    category: "memory",
    keywords: ["memory", "记忆", "knowledge", "知识库", "vector", "向量", "embedding", "嵌入"],
  },
  {
    category: "search",
    keywords: ["search", "搜索", "检索", "grep", "index", "索引", "rag"],
  },
  {
    category: "voice",
    keywords: ["voice", "语音", "tts", "stt", "asr", "speech", "朗读", "audio", "音频"],
  },
  {
    category: "security",
    keywords: [
      "security", "安全", "认证", "授权", "权限", "permission",
      "audit", "审计", "加密", "encrypt", "sandbox", "沙箱",
    ],
  },
  {
    category: "tool",
    keywords: ["tool", "tools", "工具", "mcp"],
  },
];

/** 正则元字符转义（hints/关键词可能含 c++ 之类字面量） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 关键词命中判定（对已小写文本）：
 * - 纯 ASCII 关键词按词边界匹配，防 "storage" 误中 "rag"、"research" 误中 "search"；
 * - 含非 ASCII（中文）关键词直接子串匹配（中文无词边界概念）。
 */
function keywordHit(lowerText: string, keyword: string): boolean {
  if (!/^[\x00-\x7f]+$/.test(keyword)) {
    return lowerText.includes(keyword);
  }
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(keyword)}([^a-z0-9]|$)`).test(lowerText);
}

/** name + displayName + summary 拼接为小写检索文本 */
function searchableText(item: MarketItemCore): string {
  return `${item.name} ${item.displayName ?? ""} ${item.summary ?? ""}`.toLowerCase();
}

// ===== 1. 分类推断 =====

/**
 * 类目推断：对 name+displayName+summary 做小写关键词规则匹配（中英文），
 * 多类命中取优先级最高的类目；无命中时 family 含 "plugin" 或名含
 * tool/plugin/agent 归 tool，否则 other。确定性、无副作用。
 */
export function inferCategory(item: MarketItemCore): MarketCategory {
  const text = searchableText(item);
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((kw) => keywordHit(text, kw))) {
      return rule.category;
    }
  }
  const nameLower = item.name.toLowerCase();
  const familyLower = typeof item.family === "string" ? item.family.toLowerCase() : "";
  if (
    familyLower.includes("plugin") ||
    nameLower.includes("tool") ||
    nameLower.includes("plugin") ||
    nameLower.includes("agent")
  ) {
    return "tool";
  }
  return "other";
}

// ===== 2. 综合评分 =====

/**
 * 综合评分（0~1）：
 * - popularity = log10(1+downloads) / log10(1+50000)，截断到 1（log 压缩长尾 + 封顶防垄断）；
 * - freshness = updatedAt 可解析 ? exp(-ageDays/30)（未来时间截为 1）: 0.3（中性，缺字段不惩罚）；
 * - trust = isOfficial ? 1 : tier 含 verified ? 0.7 : tier 含 known ? 0.4 : 0.15（安全第一，权重最高）。
 */
export function computeMarketScore(item: MarketItemCore, now: number = Date.now()): ScoreBreakdown {
  const downloads =
    typeof item.downloads === "number" && Number.isFinite(item.downloads) && item.downloads > 0
      ? item.downloads
      : 0;
  const popularity = Math.min(1, Math.log10(1 + downloads) / Math.log10(1 + POPULARITY_CEILING));

  let freshness = FRESHNESS_NEUTRAL;
  if (typeof item.updatedAt === "string" && item.updatedAt.length > 0) {
    const updated = Date.parse(item.updatedAt);
    if (!Number.isNaN(updated)) {
      const ageDays = (now - updated) / DAY_MS;
      // 未来时间（时钟偏移/预发布）不奖励超过"刚刚更新"，截断为 1
      freshness = ageDays <= 0 ? 1 : Math.exp(-ageDays / FRESHNESS_DECAY_DAYS);
    }
  }

  const tier =
    typeof item.verificationTier === "string" ? item.verificationTier.toLowerCase() : "";
  const trust =
    item.isOfficial === true
      ? 1
      : tier.includes("verified")
        ? 0.7
        : tier.includes("known")
          ? 0.4
          : 0.15;

  const total =
    POPULARITY_WEIGHT * popularity + FRESHNESS_WEIGHT * freshness + TRUST_WEIGHT * trust;
  return { total, popularity, freshness, trust };
}

/** 排序比较器：total 降序，同分按 name 字典序（UTF-16 码元序，不依赖 locale，保证确定性） */
function compareScored(
  a: { name: string; score: ScoreBreakdown },
  b: { name: string; score: ScoreBreakdown },
): number {
  if (a.score.total !== b.score.total) return b.score.total - a.score.total;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return 0; // 完全同分同名：依赖 sort 稳定性保持输入顺序
}

// ===== 3. 排序 =====

/** 排序：total 降序，同分按 name 字典序稳定；返回新数组并为每个条目附加 score，不改入参 */
export function rankMarket<T extends MarketItemCore>(
  items: readonly T[],
  now: number = Date.now(),
): Array<T & { score: ScoreBreakdown }> {
  return items
    .map((item) => ({ ...item, score: computeMarketScore(item, now) }))
    .sort(compareScored);
}

// ===== 4. 类目多样化 =====

/**
 * 类目多样性（蛇形交错）：
 * - 目标形态是"每轮每类取 1 个"的轮转交错（均衡输入下输出恰为 A B C A B C …）；
 * - 实现取"剩余条目最多的类目优先、并列时强类目（首条排名更靠前）优先"的贪心，
 *   这等价于均衡场景的轮转，且能在某类目数量占优时自动以 2 条为一段摊开，
 *   保证单一类目不连续超过 2 条（除非剩余条目全部同类，数学上无法交错）；
 * - 不改类目内相对顺序（同类目间保持传入的排名顺序）。
 */
export function diversifyByCategory<T extends MarketItemCore>(ranked: readonly T[]): T[] {
  if (ranked.length === 0) return [];

  // 按类目分桶（桶内保持传入顺序）；Map 保持插入序 → 桶序 = 桶内首条目的排名序
  const buckets = new Map<MarketCategory, T[]>();
  for (const item of ranked) {
    const cat = inferCategory(item);
    const list = buckets.get(cat);
    if (list) {
      list.push(item);
    } else {
      buckets.set(cat, [item]);
    }
  }
  const queues = [...buckets.entries()].map(([category, items]) => ({ category, items }));

  const out: T[] = [];
  // 最近发出的两个类目：用于三连守卫（保证 ≤ 连续 2 条同类）
  let last1: MarketCategory | null = null;
  let last2: MarketCategory | null = null;
  let remaining = ranked.length;

  while (remaining > 0) {
    // 选桶：跳过会形成三连同类的桶，其余取剩余最多（并列取先出现，即强类目）
    let pick = -1;
    for (let i = 0; i < queues.length; i++) {
      const q = queues[i];
      if (q.items.length === 0) continue;
      if (q.category === last1 && q.category === last2) continue; // 三连守卫
      if (pick === -1 || q.items.length > queues[pick].items.length) pick = i;
    }
    if (pick === -1) {
      // 所有非空桶都被守卫拦住：只剩单一类目，连排不可避免（无可交错者）
      for (let i = 0; i < queues.length; i++) {
        if (queues[i].items.length > 0 && (pick === -1 || queues[i].items.length > queues[pick].items.length)) {
          pick = i;
        }
      }
    }
    const q = queues[pick];
    out.push(q.items.shift() as T);
    last2 = last1;
    last1 = q.category;
    remaining -= 1;
  }
  return out;
}

// ===== 5. 个性化 =====

/**
 * 个性化：排除 excludeNames（已装条目）；文本（name+displayName+summary 小写）与
 * hints token 有词边界命中的条目 score.total 乘 1.35（hints 来自已启用渠道/供应商，
 * 如 ["feishu","wecom","kimi"]——用户已在该生态里，配套条目更可能被需要）。
 * 注意：加权后 total 不再等于分量加权和，分量值保留原样供 UI 展示归因。
 */
export function personalizeMarket<T extends MarketItemCore>(
  items: readonly T[],
  opts: { excludeNames?: ReadonlySet<string>; hints?: readonly string[]; now?: number },
): Array<T & { score: ScoreBreakdown }> {
  const now = opts.now ?? Date.now();
  const exclude = opts.excludeNames;
  // hints 归一化：去空白、小写、去重，剔除空串
  const tokens = [
    ...new Set(
      (opts.hints ?? [])
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h.length > 0),
    ),
  ];

  const out: Array<T & { score: ScoreBreakdown }> = [];
  for (const item of items) {
    if (exclude && exclude.has(item.name)) continue;
    let score = computeMarketScore(item, now);
    if (tokens.length > 0) {
      const text = searchableText(item);
      if (tokens.some((tok) => keywordHit(text, tok))) {
        score = { ...score, total: score.total * PERSONALIZE_BOOST };
      }
    }
    out.push({ ...item, score });
  }
  return out;
}

// ===== 6. 编排入口 =====

/**
 * 推荐编排：pool → 过滤已装 → 个性化加权 → 排序 → 类目多样化 → 截 limit。
 * 排序复用 compareScored（total 降序 + name 字典序），尊重 personalize 已加权的 total；
 * limit 缺省返回全部。
 */
export function buildRecommendations<T extends MarketItemCore>(
  pool: readonly T[],
  opts: { excludeNames?: ReadonlySet<string>; hints?: readonly string[]; limit?: number; now?: number },
): Array<T & { score: ScoreBreakdown }> {
  const personalized = personalizeMarket(pool, opts);
  const ranked = [...personalized].sort(compareScored);
  const diversified = diversifyByCategory(ranked);
  return typeof opts.limit === "number" && opts.limit >= 0 ? diversified.slice(0, opts.limit) : diversified;
}

// ===== 7. 技能映射 =====

/**
 * 技能商店条目 → 统一市场条目：
 * slug→name（技能唯一标识是 slug，市场侧统一用 name 承载）、name→displayName、
 * description→summary、version→latestVersion；downloads/updatedAt/author 原位透传，
 * 使技能直接进入统一评分口径。highlighted 无对应字段，交给统一评分处理。
 */
export function skillToMarketItem(skill: SkillStoreItem): MarketItemCore {
  return {
    name: skill.slug,
    displayName: skill.name,
    summary: skill.description,
    latestVersion: skill.version,
    downloads: skill.downloads,
    updatedAt: skill.updatedAt,
    ownerHandle: skill.author,
  };
}
