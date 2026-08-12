/**
 * Settings: 微信扫码登录（iLink HTTP API）+ 账号清除。
 */
import { ipcMain } from "electron";
import { readUserConfig, writeUserConfig } from "../provider-config";
import {
  ensureWeixinPluginReady,
  startWeixinQrLogin,
  pollWeixinQrStatus,
  persistWeixinLoginSuccess,
  clearWeixinAccounts,
} from "../weixin-config";
import { reconcileExtensionsOnAppLaunch } from "../extension-mirror";
import { assertTrustedIpcSender } from "../ipc-sender-guard";
import * as log from "../logger";
import type { SettingsIpcOptions } from "./types";

export function registerWeixinIpc(opts: SettingsIpcOptions): void {
  // ── 微信扫码登录 — 启动（直接调用 iLink HTTP API，绕过 Gateway RPC） ──
  ipcMain.handle("settings:weixin-login-start", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:weixin-login-start")) throw new Error("IPC sender not trusted");
    try {
      const result = await startWeixinQrLogin();
      return {
        success: true,
        data: {
          qrDataUrl: result.qrcodeUrl,
          qrcode: result.qrcode,
          message: result.message,
        },
      };
    } catch (err: any) {
      log.error(`[weixin] login-start error: ${err.message}`);
      return { success: false, message: err.message || String(err) };
    }
  });

  // ── 微信扫码登录 — 轮询扫码结果（直接调用 iLink HTTP API） ──
  ipcMain.handle("settings:weixin-login-wait", async (_event, params) => {
    if (!assertTrustedIpcSender(_event, "settings:weixin-login-wait")) throw new Error("IPC sender not trusted");
    try {
      const qrcode = typeof params?.qrcode === "string" ? params.qrcode : "";
      if (!qrcode) {
        return { success: false, message: "缺少 qrcode。" };
      }
      const result = await pollWeixinQrStatus(qrcode);

      // 扫码确认成功 → 保存凭据并重启 Gateway
      if (result.status === "confirmed" && result.accountId && result.botToken) {
        await ensureWeixinPluginReady(reconcileExtensionsOnAppLaunch);
        const config = readUserConfig();
        const normalizedId = persistWeixinLoginSuccess(config, result);
        writeUserConfig(config);
        opts.requestGatewayRestart?.();
        return {
          success: true,
          data: {
            connected: true,
            message: "✅ 与微信连接成功！",
            accountId: normalizedId,
          },
        };
      }

      return {
        success: true,
        data: {
          connected: false,
          status: result.status,
          message:
            result.status === "scaned" ? "已扫码，请在微信中确认…" :
            result.status === "expired" ? "二维码已过期，请重新生成。" :
            "等待扫码…",
        },
      };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // ── 清除微信账号（断开连接） ──
  ipcMain.handle("settings:weixin-clear-accounts", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:weixin-clear-accounts")) throw new Error("IPC sender not trusted");
    try {
      clearWeixinAccounts();
      opts.requestGatewayRestart?.();
      return { success: true };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

}
