/**
 * 模型下拉选项的共享渲染：有自定义分组时按 optgroup 分桶（R9 联动），
 * 无分组/全部未分组时退化为扁平 option 列表（与旧行为完全一致）。
 */
import { html, type TemplateResult } from "lit";
import { t } from "../i18n.ts";
import { bucketModelsByOrg, type ModelOrgState } from "../views/settings/model-org.lib.ts";
import type { ConfiguredModel } from "../ui-types.ts";

export interface ModelOptionItem {
  key: string;
  name: string;
  isDefault?: boolean;
}

/**
 * 渲染模型 <option> 序列。
 * markDefault=true 时在默认模型名称后追加「· 默认」后缀（compose 选择器用）。
 */
export function renderModelOptionsGrouped(
  models: ModelOptionItem[],
  org: ModelOrgState,
  selectedKey: string | undefined,
  markDefault = false,
): TemplateResult[] {
  const option = (m: ModelOptionItem) => html`
    <option value=${m.key} ?selected=${m.key === selectedKey}>
      ${markDefault && m.isDefault ? `${m.name} · ${t("settings.provider.badge.default")}` : m.name}
    </option>
  `;
  if (org.groups.length === 0) return models.map(option);
  const buckets = bucketModelsByOrg(models, org);
  // 全部未分组时不出 optgroup 壳，保持旧观感
  if (buckets.length === 1 && buckets[0].group === null) return buckets[0].models.map(option);
  return buckets.map(bucket => html`
    <optgroup label=${bucket.group ? bucket.group.name : t("settings.provider.customGroups.ungrouped")}>
      ${bucket.models.map(option)}
    </optgroup>
  `);
}

/** compose/cron 专用便捷入口：直接吃 ConfiguredModel */
export function renderConfiguredModelOptions(
  models: ConfiguredModel[],
  org: ModelOrgState,
  selectedKey: string | undefined,
  markDefault = false,
): TemplateResult[] {
  return renderModelOptionsGrouped(models, org, selectedKey, markDefault);
}
