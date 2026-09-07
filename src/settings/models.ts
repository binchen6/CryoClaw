/**
 * Settings: 模型域在线能力 IPC（R58）。
 * settings:fetch-provider-models — 从提供商 /models 端点拉实时模型列表
 * settings:get-provider-usage   — 订阅套餐用量 / 账户余额查询
 * 实现在 provider-live.ts；凭据只在主进程读取（渲染层 config 快照是脱敏的）。
 */
import { ipcMain } from "electron";
import { fetchProviderModels, fetchProviderUsage } from "../provider-live";
import { assertTrustedIpcSender } from "../ipc-sender-guard";
import { runTrackedSettingsAction } from "./tracked";

function readProviderKey(params: unknown): string {
  return typeof (params as { providerKey?: unknown })?.providerKey === "string"
    ? (params as { providerKey: string }).providerKey.trim()
    : "";
}

export function registerModelsIpc(): void {
  ipcMain.handle("settings:fetch-provider-models", async (event, params) => {
    if (!assertTrustedIpcSender(event, "settings:fetch-provider-models")) throw new Error("IPC sender not trusted");
    const providerKey = readProviderKey(params);
    return runTrackedSettingsAction("fetch_provider_models", { providerKey }, async () => {
      try {
        const models = await fetchProviderModels(params ?? {});
        return { success: true, data: { models } };
      } catch (err: any) {
        return { success: false, message: err.message || String(err) };
      }
    });
  });

  ipcMain.handle("settings:get-provider-usage", async (event, params) => {
    if (!assertTrustedIpcSender(event, "settings:get-provider-usage")) throw new Error("IPC sender not trusted");
    const providerKey = readProviderKey(params);
    return runTrackedSettingsAction("get_provider_usage", { providerKey }, async () => {
      try {
        const usage = await fetchProviderUsage(providerKey);
        if (!usage.supported) {
          return { success: false, unsupported: true };
        }
        return { success: true, data: usage };
      } catch (err: any) {
        return { success: false, message: err.message || String(err) };
      }
    });
  });
}
