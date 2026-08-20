/**
 * 思考强度档位解析（纯函数，供 app 状态层与渲染层共用，可单测）。
 *
 * 档位来源优先级（内核取证：session-utils 行内 thinkingLevels/thinkingDefault）：
 * 1. 内核 sessions.list 行下发的 thinkingLevels（当前模型实际支持的档位，
 *    含 id+label；Kimi 二元模型只会出现 off/on，Claude 新模型会多出 adaptive/max）
 * 2. 本地 provider 硬编码回退（会话行尚未加载/字段缺失时兜底）
 *
 * 档位合法性由内核 sessions.patch 校验，UI 只渲染内核/回退列表中的值，天然规避非法值。
 */

export type ThinkingCapabilities = {
  /** 可选档位（含 "off"，off 恒在首位） */
  levels: string[];
  /** 二元模型（仅 off/on），UI 用开关而非档位选择 */
  isBinary: boolean;
  /** 智能默认档（从 off 切到开时使用）：内核 thinkingDefault 优先，否则 provider 推荐档 */
  defaultLevel: string;
};

export type ThinkingCapabilityParams = {
  /** 当前模型 provider（小写） */
  provider?: string;
  /** 当前模型 key（"provider/model-id"），用于模型名正则 */
  modelKey?: string | null;
  /** 内核会话行 thinkingLevels：[{id,label}] 或 string[] */
  sessionThinkingLevels?: unknown;
  /** 内核会话行 thinkingDefault */
  sessionThinkingDefault?: unknown;
  /** models.list 目录条目的 compat（含 supportedReasoningEfforts），无会话行时的精确回退 */
  catalogCompat?: unknown;
};

function normalizeProvider(provider?: string): string {
  const p = provider?.toLowerCase() ?? "";
  if (p === "z.ai" || p === "z-ai") return "zai";
  // kimi 插件对内 kernel 侧 aliases：kimi / kimi-code / kimi-coding 同一 provider
  if (p === "kimi" || p === "kimi-code") return "kimi-coding";
  return p;
}

/** 从模型目录条目 compat.supportedReasoningEfforts 提取档位（内核补丁后同一数据源） */
export function extractSupportedReasoningEfforts(compat: unknown): string[] {
  if (!compat || typeof compat !== "object") {
    return [];
  }
  const efforts = (compat as Record<string, unknown>).supportedReasoningEfforts;
  if (!Array.isArray(efforts)) {
    return [];
  }
  return [
    ...new Set(
      efforts.filter((e): e is string => typeof e === "string" && Boolean(e.trim()) && e !== "off"),
    ),
  ];
}

/** 从内核 thinkingLevels 字段提取档位 id 列表（兼容 [{id}] 与 string[] 两种形状） */
export function extractKernelThinkingLevelIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      ids.push(item.trim());
    } else if (item && typeof item === "object") {
      const id = (item as Record<string, unknown>).id;
      if (typeof id === "string" && id.trim()) {
        ids.push(id.trim());
      }
    }
  }
  return [...new Set(ids)];
}

/** provider 硬编码回退档位（无内核数据时） */
function fallbackLevels(provider: string, modelId: string): string[] {
  if (provider === "zai" || provider === "zai-cn" || provider === "zai-cn-coding") {
    // GLM 系列：官方 thinking:{type:"enabled|disabled"}，二值开关
    return ["off", "on"];
  }
  if (provider === "kimi-coding") {
    // kimi K3 仅支持 3 档思考（low/high/max）+ off
    return ["off", "low", "high", "max"];
  }
  if (provider === "deepseek") {
    // DeepSeek v4：官方 reasoning_effort 支持 low/medium/high/max
    return ["off", "low", "medium", "high", "max"];
  }
  // 保守默认级别，不包含 xhigh（需要模型明确支持）
  const levels = ["off", "low", "medium", "high"];
  if (/claude-(opus|sonnet)-4/.test(modelId)) {
    levels.push("adaptive");
  }
  return levels;
}

/** provider 推荐默认档（无内核 thinkingDefault 时） */
function fallbackDefaultLevel(provider: string, modelId: string): string {
  if (provider === "zai" || provider === "zai-cn" || provider === "zai-cn-coding") {
    return "on";
  }
  if (provider === "kimi-coding" || provider === "deepseek") {
    return "high";
  }
  if (/claude-(opus|sonnet)-4/.test(modelId)) {
    return "adaptive";
  }
  return "medium";
}

export function resolveThinkingCapabilities(
  params: ThinkingCapabilityParams,
): ThinkingCapabilities {
  const provider = normalizeProvider(params.provider);
  const modelId = params.modelKey?.split("/").pop() ?? "";

  const kernelIds = extractKernelThinkingLevelIds(params.sessionThinkingLevels);
  const catalogEfforts = extractSupportedReasoningEfforts(params.catalogCompat);
  let levels: string[];
  if (kernelIds.length > 0) {
    // 内核下发为准；确保 off 可选（部分 provider 列表不含 off）
    levels = kernelIds.includes("off") ? kernelIds : ["off", ...kernelIds];
  } else if (catalogEfforts.length > 0) {
    // 模型目录声明了 supportedReasoningEfforts（与内核补丁同源），off 恒在首位
    levels = ["off", ...catalogEfforts];
  } else if (!params.provider && !params.modelKey) {
    levels = [];
  } else {
    levels = fallbackLevels(provider, modelId);
  }

  const onLevels = levels.filter((l) => l !== "off");
  const isBinary = onLevels.length === 1 && onLevels[0] === "on";

  const kernelDefault =
    typeof params.sessionThinkingDefault === "string" && params.sessionThinkingDefault.trim()
      ? params.sessionThinkingDefault.trim()
      : null;
  const fallbackDefault = fallbackDefaultLevel(provider, modelId);
  const defaultLevel =
    kernelDefault && levels.includes(kernelDefault)
      ? kernelDefault
      : levels.includes(fallbackDefault)
        ? fallbackDefault
        : (onLevels[0] ?? "off");

  return { levels, isBinary, defaultLevel };
}

/** 已知档位的 i18n key 后缀（渲染层据此拼接 chat.thinkLevel.*） */
export const KNOWN_THINKING_LEVELS = [
  "off",
  "on",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "adaptive",
] as const;
