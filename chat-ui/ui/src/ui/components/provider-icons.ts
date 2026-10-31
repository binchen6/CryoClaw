import { html, type TemplateResult } from "lit";
import { renderIcon } from "../icons.ts";

/** Brand-informed, single-color geometry simplified for 16px and 24px rendering. */
const PROVIDER_GLYPHS = {
  moonshot: '<path d="M3 16.5c4.2-5.2 9.4-7.8 15.8-7.8M4.5 20c3.5-4.5 8.1-6.8 13.8-6.8M6.5 10.5c2.7-3.5 6.2-5.3 10.5-5.3"/><circle cx="18.5" cy="4.5" r="1"/><circle cx="4" cy="18" r="1"/>',
  anthropic: '<path d="m4 20 6.2-16h3.6L20 20M7 14h10"/>',
  openai: '<path d="M12 3.2a4 4 0 0 1 6.8 2.9 4 4 0 0 1 2 6.8 4 4 0 0 1-3.5 6.4 4 4 0 0 1-6.8 1.5 4 4 0 0 1-6.3-3.5 4 4 0 0 1-1-7.3A4 4 0 0 1 7 4.2 4 4 0 0 1 12 3.2Z"/><path d="m8.5 8.5 3.5-2 3.5 2v4l-3.5 2-3.5-2Z"/>',
  google: '<path d="M20.5 12.2A8.4 8.4 0 1 1 17.9 5.6M12.2 11h8.3v3.3h-7.9"/>',
  minimax: '<path d="M4 9v6M8 5v14M12 8v8M16 4v16M20 9v6"/>',
  zai: '<path d="M4 4h16L4 20h16M8 12h8"/>',
  volcengine: '<path d="m5 5 6 14M11 5l6 14M17 5l3 7M3 12l3 7M9 12l3 7"/>',
  qwen: '<path d="M19.5 10A8 8 0 1 0 14 17.5L20 21M8 10a4 4 0 1 0 4-4"/><path d="M15.5 14.5 20 19"/>',
  deepseek: '<path d="M3 13c2.2-5 7-7.5 12-5.5l4-2-1 4c1.5 3.5-.5 7-4.5 8.5C8.5 20 5 17.5 3 13Z"/><path d="M3 13c3 1 5 0 6-2m5 6.5 1 3M7 9 5 6"/><circle cx="15.5" cy="10" r=".65" fill="currentColor" stroke="none"/>',
  xiaomi: '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="M7 16V8h3v8m0-5h3a2 2 0 0 1 2 2v3m2-8v8"/>',
  ollama: '<path d="M7 8 5 3l4 2m8 3 2-5-4 2M6 9a6 6 0 0 1 12 0v7a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4Z"/><path d="M9 13h.01M15 13h.01M10 16h4"/>',
  custom: '<path d="M4 6h3m4 0h9M4 12h9m4 0h3M4 18h2m4 0h10"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
} as const;

export type ProviderIconKind = keyof typeof PROVIDER_GLYPHS;

const EXACT_ALIASES: Record<string, ProviderIconKind> = {
  moonshot: "moonshot", "moonshot-cn": "moonshot", "moonshot-ai": "moonshot",
  kimi: "moonshot", "kimi-code": "moonshot", "kimi-coding": "moonshot",
  anthropic: "anthropic", openai: "openai", google: "google", gemini: "google",
  minimax: "minimax", "minimax-cn": "minimax",
  "zai-global": "zai", "zai-cn": "zai", "zai-cn-coding": "zai", zai: "zai",
  volcengine: "volcengine", "volcengine-coding": "volcengine",
  qwen: "qwen", "qwen-coding": "qwen", deepseek: "deepseek",
  xiaomi: "xiaomi", "xiaomi-coding": "xiaomi", mimo: "xiaomi",
  ollama: "ollama", custom: "custom",
};

function endpointHost(baseUrl: string): string {
  try { return new URL(baseUrl).hostname.toLowerCase(); }
  catch { return baseUrl.toLowerCase(); }
}

export function resolveProviderIcon(providerKey: string, baseUrl = ""): ProviderIconKind {
  const key = providerKey.trim().toLowerCase();
  const prefix = key.split("-")[0];
  const exact = EXACT_ALIASES[key] ?? (prefix === "custom" ? undefined : EXACT_ALIASES[prefix]);
  if (exact) return exact;
  const host = endpointHost(baseUrl);
  if (host.includes("moonshot") || host.includes("kimi.com")) return "moonshot";
  if (host.includes("anthropic")) return "anthropic";
  if (host.includes("openai")) return "openai";
  if (host.includes("googleapis") || host.includes("google")) return "google";
  if (host.includes("minimax")) return "minimax";
  if (host.includes("bigmodel") || host.includes("z.ai")) return "zai";
  if (host.includes("volces") || host.includes("volcengine")) return "volcengine";
  if (host.includes("dashscope") || host.includes("aliyuncs")) return "qwen";
  if (host.includes("deepseek")) return "deepseek";
  if (host.includes("xiaomi") || host.includes("mimo")) return "xiaomi";
  if (baseUrl.toLowerCase().includes(":11434") || key.includes("ollama")) return "ollama";
  return "custom";
}

export function providerIcon(providerKey: string, baseUrl = "", displayName = ""): TemplateResult {
  const kind = resolveProviderIcon(providerKey, baseUrl);
  if (kind === "custom" && providerKey.trim().toLowerCase() !== "custom") {
    const label = displayName.trim() || endpointHost(baseUrl) || providerKey.trim();
    const initial = Array.from(label)[0]?.toLocaleUpperCase() || "?";
    return html`<span class="oc-provider-initial">${initial}</span>`;
  }
  return renderIcon(PROVIDER_GLYPHS[kind]);
}
