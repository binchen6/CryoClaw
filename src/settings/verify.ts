/**
 * Settings: 凭据验证 + Kimi key/proxy 相关 IPC。
 * verify-key / write-kimi-api-key / get-share-copy / kimi:get-usage /
 * get|write-kimi-search-key / ensure-kimi-proxy
 */
import { ipcMain } from "electron";
import { verifyProvider, readUserConfig } from "../provider-config";
import {
  readKimiSearchDedicatedApiKey,
  writeKimiSearchDedicatedApiKey,
  writeKimiApiKey,
  readKimiApiKey,
} from "../kimi-config";
import { startAuthProxy, setProxyAccessToken, setProxySearchDedicatedKey, getProxyPort } from "../kimi-auth-proxy";
import { SHARE_COPY_PAYLOAD } from "../share-copy";
import { assertTrustedIpcSender } from "../ipc-sender-guard";
import { runTrackedSettingsAction } from "./tracked";

export function registerVerifyIpc(): void {
  // ── 验证 API Key（复用 provider-config） ──
  ipcMain.handle("settings:verify-key", async (_event, params) => {
    if (!assertTrustedIpcSender(_event, "settings:verify-key")) throw new Error("IPC sender not trusted");
    const provider = typeof params?.provider === "string" ? params.provider : "";
    // kimi-code 验证前：确保 proxy 已启动并持有最新 token
    if (params?.subPlatform === "kimi-code" && params?.apiKey) {
      if (getProxyPort() <= 0) {
        await startAuthProxy();
      }
      setProxyAccessToken(params.apiKey);
    }
    return runTrackedSettingsAction("verify_key", { provider }, async () =>
      verifyProvider({ ...params, proxyPort: getProxyPort() }));
  });

  // ── 写入 Kimi Code 手动 API Key（sidecar + 注入 auth proxy；config 只写 proxy-managed 占位符） ──
  ipcMain.handle("settings:write-kimi-api-key", async (_event, params) => {
    if (!assertTrustedIpcSender(_event, "settings:write-kimi-api-key")) throw new Error("IPC sender not trusted");
    const apiKey = typeof params?.apiKey === "string" ? params.apiKey.trim() : "";
    if (!apiKey) {
      return { success: false, message: "apiKey 不能为空" };
    }
    try {
      if (getProxyPort() <= 0) {
        await startAuthProxy();
      }
      writeKimiApiKey(apiKey);
      setProxyAccessToken(apiKey);
      return { success: true, data: { proxyPort: getProxyPort() } };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // ── 读取分享文案（内嵌，跟随客户端版本发布） ──
  ipcMain.handle("settings:get-share-copy", (event) => {
    if (!assertTrustedIpcSender(event, "settings:get-share-copy")) throw new Error("IPC sender not trusted");
    return {
      success: true,
      data: SHARE_COPY_PAYLOAD,
    };
  });

  // ── 读取 Kimi Search 专属 key（sidecar 文件，不随 openclaw.json） ──
  ipcMain.handle("settings:get-kimi-search-key", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:get-kimi-search-key")) throw new Error("IPC sender not trusted");
    try {
      return { success: true, data: { apiKey: readKimiSearchDedicatedApiKey() } };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // ── 写入 Kimi Search 专属 key（sidecar + 注入 auth proxy；不写入 openclaw.json） ──
  ipcMain.handle("settings:write-kimi-search-key", async (_event, params) => {
    if (!assertTrustedIpcSender(_event, "settings:write-kimi-search-key")) throw new Error("IPC sender not trusted");
    const apiKey = typeof params?.apiKey === "string" ? params.apiKey : "";
    try {
      writeKimiSearchDedicatedApiKey(apiKey);
      setProxySearchDedicatedKey(apiKey);
      return { success: true };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // ── 确保 auth proxy 运行（memory embedding 走本地 proxy，需拿到端口写配置） ──
  ipcMain.handle("settings:ensure-kimi-proxy", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:ensure-kimi-proxy")) throw new Error("IPC sender not trusted");
    try {
      if (getProxyPort() <= 0) {
        await startAuthProxy();
      }
      return { success: true, data: { proxyPort: getProxyPort() } };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // ── 查询 Kimi 会员用量（GET /v1/usages） ──
  ipcMain.handle("kimi:get-usage", async (event) => {
    if (!assertTrustedIpcSender(event, "kimi:get-usage")) throw new Error("IPC sender not trusted");
    try {
      const config = readUserConfig();
      // 仅要求 Kimi Code provider 已配置即可，不再绑定默认模型。
      // 允许「列表里选中 Kimi Code 但当前默认是别的模型」时也能查到用量。
      const isKimiCodeConfigured = !!(config?.models?.providers?.["kimi-coding"]?.apiKey);
      if (!isKimiCodeConfigured) {
        return { success: false, message: "Usage is only available for Kimi." };
      }
      const { loadOAuthToken, refreshOAuthToken } = await import("../kimi-oauth");
      const url = "https://api.kimi.com/coding/v1/usages";

      // 解析 API Key：优先 OAuth token，回退到配置中的 key
      const resolveApiKey = (): string => {
        const oauthToken = loadOAuthToken();
        if (oauthToken?.access_token) return oauthToken.access_token;
        return readKimiApiKey() || "";
      };

      let apiKey = resolveApiKey();
      if (!apiKey) {
        return { success: false, message: "No API key available." };
      }

      // 首次请求
      let resp = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15000),
      });

      // 401 且有 OAuth token → 尝试刷新后重试一次
      if (resp.status === 401) {
        const oauthToken = loadOAuthToken();
        if (oauthToken?.refresh_token) {
          try {
            await refreshOAuthToken(oauthToken);
            apiKey = resolveApiKey();
            resp = await fetch(url, {
              headers: { Authorization: `Bearer ${apiKey}` },
              signal: AbortSignal.timeout(15000),
            });
          } catch {
            // 刷新失败，返回原始 401
          }
        }
      }

      if (!resp.ok) {
        return { success: false, message: `HTTP ${resp.status}` };
      }
      const payload = await resp.json();
      return { success: true, data: payload };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

}
