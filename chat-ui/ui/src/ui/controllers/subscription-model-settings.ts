import type { GatewayModelEntry } from "./models.ts";

export const isSubscriptionProvider = (provider: string) => /^(openai|openai-codex)$/.test(provider);

/** Built-in account models keep their transport and capabilities in the kernel. */
export function configureSubscriptionModel(draft: Record<string, any>, model: GatewayModelEntry,
  settings: {alias: string; streaming: boolean; params: Record<string, unknown>; primary: boolean}) {
  if (!isSubscriptionProvider(model.provider) || !model.id) throw new Error("Invalid account model");
  const key = `${model.provider}/${model.id}`;
  const defaults = (draft.agents ??= {}).defaults ??= {};
  const models = defaults.models ??= {};
  models[key] = {...models[key], alias:settings.alias.trim(), streaming:settings.streaming, params:settings.params};
  // Preserve an existing ceiling; allow only the newly selected exact model.
  const allow = defaults.modelPolicy?.allow;
  if (Array.isArray(allow) && allow.length && !allow.some((ref: string) =>
    ref === key || ref === settings.alias.trim() || (ref.endsWith("*") && key.startsWith(ref.slice(0,-1))))) allow.push(key);
  if (settings.primary) {
    const previous = defaults.model;
    defaults.model = {...(typeof previous === "object" && previous ? previous : {}), primary:key};
  }
}

export function parseSubscriptionParams(value: string): Record<string, unknown> {
  const params: unknown = JSON.parse(value || "{}");
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Model parameters must be a JSON object");
  return params as Record<string, unknown>;
}
