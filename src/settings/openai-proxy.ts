import { ipcMain } from "electron";
import * as http from "node:http";
import * as https from "node:https";
import { assertTrustedIpcSender } from "../ipc-sender-guard";
import { readCryoclawConfig, writeCryoclawConfig } from "../cryoclaw-config";
import type { SettingsIpcOptions } from "./types";
const { normalizeProxyConfig } = require("../../shared/openai-proxy.cjs");

export function registerOpenAIProxyIpc(opts: SettingsIpcOptions): void {
  for (const action of ["get", "save", "test"] as const) {
    const channel = `settings:openai-proxy-${action}`;
    ipcMain.handle(channel, async (event, input) => {
      if (!assertTrustedIpcSender(event, channel)) throw new Error("IPC sender not trusted");
      try {
        if (action === "get") return {success:true, data:normalizeProxyConfig(readCryoclawConfig()?.openaiProxy)};
        const config = normalizeProxyConfig(input);
        if (action === "save") {
          writeCryoclawConfig({...readCryoclawConfig(), openaiProxy:config});
          opts.requestGatewayRestart?.();
          return {success:true, data:config};
        }
        if (config.mode !== "custom") throw new Error("请先选择自定义代理并填写地址");
        const proxy = new URL(config.url);
        await new Promise<void>((resolve, reject) => {
          const request = (proxy.protocol === "https:" ? https : http).request({hostname:proxy.hostname.replace(/^\[|\]$/g,""), port:proxy.port || (proxy.protocol === "https:" ? 443 : 80), method:"CONNECT", path:"auth.openai.com:443", headers:{Host:"auth.openai.com:443"}});
          const timeout = setTimeout(() => request.destroy(new Error("代理连接超时")), 8000);
          request.once("close", () => clearTimeout(timeout));
          request.once("error", reject);
          request.once("connect", (response, socket) => { socket.destroy(); response.statusCode === 200 ? resolve() : reject(new Error(`代理拒绝连接 (HTTP ${response.statusCode})`)); });
          request.once("response", response => { response.resume(); reject(new Error(`代理不支持 CONNECT (HTTP ${response.statusCode})`)); });
          request.end();
        });
        return {success:true, data:{ok:true}};
      } catch (error) { return {success:false, message:error instanceof Error ? error.message : String(error)}; }
    });
  }
}
