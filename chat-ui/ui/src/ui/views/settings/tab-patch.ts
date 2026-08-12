/**
 * Settings 各 tab 统一的 config.patch 执行助手（R4）。
 * 封装：client 检查 → patchConfig → 错误/热应用提示映射 → 快照刷新。
 */
import type { AppViewState } from "../../app-view-state.ts";
import { t } from "../../i18n.ts";
import { patchConfig, getConfigSnapshot } from "../../controllers/config.ts";

export interface ConfigPatchOutcome {
  ok: boolean;
  /** 失败时的中文错误（已映射） */
  error?: string;
  /** 成功后的热应用/重启提示（noop 时为 null） */
  hint?: string | null;
}

/**
 * 执行一次 config.patch。成功后强制刷新快照（供下次读取拿到最新 hash），
 * 并按内核结果给出「已热应用 / gateway 将平滑重启 / 重启后生效」提示。
 */
export async function runConfigPatch(
  state: AppViewState,
  mutator: (draft: Record<string, unknown>) => void,
  opts?: { replacePaths?: string[] },
): Promise<ConfigPatchOutcome> {
  if (!state.client) {
    return { ok: false, error: t("settings.error.saveFailed") };
  }
  const result = await patchConfig(state.client, mutator, opts);
  if (!result.ok) {
    return { ok: false, error: result.error ?? t("settings.error.saveFailed") };
  }
  if (state.client) {
    try { await getConfigSnapshot(state.client, { force: true }); } catch {}
  }
  const hint = result.restartScheduled
    ? t("settings.patch.restartScheduled")
    : result.requiresRestart
      ? t("settings.patch.restartRequired")
      : !result.noop
        ? t("settings.patch.appliedHot")
        : null;
  return { ok: true, hint };
}
