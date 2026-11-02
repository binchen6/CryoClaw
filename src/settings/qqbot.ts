import { ipcMain } from "electron";
import { readUserConfigForWrite, writeUserConfig } from "../provider-config";
import { resolveQqbotPluginDir } from "../qqbot-config";
import { createQqbotLoginService, loadOfficialQqbotBoundary } from "../qqbot-login";
import { assertTrustedIpcSender } from "../ipc-sender-guard";
import type { SettingsIpcOptions } from "./types";

export function registerQqbotIpc(opts: SettingsIpcOptions): void {
  let boundary: ReturnType<typeof loadOfficialQqbotBoundary> | undefined;
  const official = () => boundary ??= loadOfficialQqbotBoundary(resolveQqbotPluginDir());
  let baseSnapshot: any;
  const service = createQqbotLoginService({
    startQrConnect: (callbacks, options) => official().startQrConnect(callbacks, options),
    renderQr: url => official().renderQr(url),
    readConfig: () => { const current = readUserConfigForWrite(); baseSnapshot = current.baseSnapshot; return current.config; },
    writeConfig: config => writeUserConfig(config, { baseSnapshot }),
    restart: () => opts.requestGatewayRestart?.(),
  });
  ipcMain.handle("settings:qqbot-login-start", async event => {
    if (!assertTrustedIpcSender(event, "settings:qqbot-login-start")) throw new Error("IPC sender not trusted");
    return service.start(event.sender);
  });
  ipcMain.handle("settings:qqbot-login-wait", async (event, params) => {
    if (!assertTrustedIpcSender(event, "settings:qqbot-login-wait")) throw new Error("IPC sender not trusted");
    return service.wait(event.sender, params?.attemptId);
  });
  ipcMain.handle("settings:qqbot-login-cancel", async (event, params) => {
    if (!assertTrustedIpcSender(event, "settings:qqbot-login-cancel")) throw new Error("IPC sender not trusted");
    return service.cancel(event.sender, params?.attemptId);
  });
}
