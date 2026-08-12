/**
 * Settings: 高级配置（R4 后只剩本地字段：浏览器模式 / 开机自启 / ClawHub registry /
 * docker 检测；热应用模式、执行权限、沙箱、iMessage 已由前端走 config.patch）。
 */
import { app, ipcMain } from "electron";
import * as fs from "fs";
import {
  resolveWebbridgeBinaryPath,
  readWebbridgeExtensionId,
} from "../constants";
import {
  applyBrowserModeConfig,
  coerceBrowserMode,
  DEFAULT_PROCESS_EXEC,
  detectBrowserMode,
  getDefaultBrowser,
  getExtensionStates,
} from "../browser";
import {
  migrateBrowserProfileForCurrentGateway,
  normalizeRequestedBrowserProfileForSave,
} from "../browser-profile-config";
import { getWebbridgePrecheck } from "../webbridge";
import { readUserConfig, writeUserConfig } from "../provider-config";
import { readSkillStoreRegistry, writeSkillStoreRegistry } from "../skill-store";
import { checkDockerAvailable } from "../docker-check";
import { getLaunchAtLoginState, setLaunchAtLoginEnabled } from "../launch-at-login";
import { assertTrustedIpcSender } from "../ipc-sender-guard";
import { runTrackedSettingsAction } from "./tracked";
import { readKimiWebbridgeSkillEnabled, getCurrentBrowserMode, specFromExtId } from "./webbridge";
import type { SettingsIpcOptions } from "./types";

export function registerAdvancedIpc(opts: SettingsIpcOptions): void {
  // ── 读取高级配置（R4 后只含本地字段；openclaw.json 侧字段由前端走 config 快照） ──
  ipcMain.handle("settings:get-advanced", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:get-advanced")) throw new Error("IPC sender not trusted");
    try {
      const config = readUserConfig();
      const launchAtLoginState = getLaunchAtLoginState(app);
      // 沙盒前置检测（结果缓存 60s）：UI 据此禁用沙盒选项并显示中文引导
      const dockerAvailable = await checkDockerAvailable();
      return {
        success: true,
        data: {
          // 新字段：Settings UI 的三选 radio 用
          browserMode: detectBrowserMode(config),
          // 旧字段：向后兼容（值是 gateway defaultProfile，非 UI mode）
          // 注意 webbridge 模式下也保留底层 profile 值（plugin disabled 决定模式而不是 profile）
          browserProfile:
            (typeof config?.browser?.defaultProfile === "string"
              ? config.browser.defaultProfile
              : "") || "openclaw",
          launchAtLoginSupported: launchAtLoginState.supported,
          launchAtLogin: launchAtLoginState.enabled,
          clawHubRegistry: readSkillStoreRegistry(),
          dockerAvailable,
        },
      };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  });

  // ── 保存高级配置（R4 后只收本地字段：browserMode/launchAtLogin/clawHubRegistry；
  //    热应用模式/执行权限/沙箱/iMessage 已由前端走 config.patch） ──
  ipcMain.handle("settings:save-advanced", async (_event, params) => {
    if (!assertTrustedIpcSender(_event, "settings:save-advanced")) throw new Error("IPC sender not trusted");
    const { browserProfile, browserMode } = params;
    const launchAtLogin = typeof params?.launchAtLogin === "boolean" ? params.launchAtLogin : undefined;
    const clawHubRegistry = typeof params?.clawHubRegistry === "string" ? params.clawHubRegistry.trim() : undefined;
    return runTrackedSettingsAction(
      "save_advanced",
      {
        browser_mode: browserMode ?? null,
        browser_profile: browserProfile ?? null,
        launch_at_login: launchAtLogin,
      },
      async () => {
        try {
          const config = readUserConfig();

          // 优先 browserMode（新前端）；回退 browserProfile（老前端兼容）
          // coerce 顺手吃下早期分支的 alias —— browserMode === "chrome" 自动归一化成 "user"
          const coercedMode = coerceBrowserMode(browserMode);
          if (coercedMode) {
            // webbridge 模式服务端兜底：三项都过才能切（防前端被绕过 / 条件在选中到保存之间变化）
            if (coercedMode === "webbridge") {
              const def = await getDefaultBrowser();
              const pre = await getWebbridgePrecheck({
                binaryPath: resolveWebbridgeBinaryPath(),
                extensionId: readWebbridgeExtensionId(),
                fileExists: fs.existsSync,
                readExtensionStates: (extId) =>
                  getExtensionStates(specFromExtId(extId), {
                    processExec: DEFAULT_PROCESS_EXEC,
                    processCheckBrowserId: def?.target.id,
                  }),
                getDefaultBrowser,
                readSkillEnabled: readKimiWebbridgeSkillEnabled,
                currentBrowserMode: getCurrentBrowserMode(),
              });
              if (!pre.ok) {
                return {
                  success: false,
                  code: pre.defaultUnsupported
                    ? "DEFAULT_BROWSER_UNSUPPORTED"
                    : "WEBBRIDGE_PRECHECK_FAILED",
                  missing: pre.missing,
                  defaultBrowser: pre.defaultBrowser,
                  defaultUnsupported: pre.defaultUnsupported,
                  message: "WebBridge 条件未满足；请先点[修复并启用]",
                };
              }
            }
            Object.assign(config, applyBrowserModeConfig(config, coercedMode));
          } else if (typeof browserProfile === "string" && browserProfile) {
            // 老前端兼容：直接传 profile 名（"openclaw" / "user" / "chrome" / 自定义）。
            // 走 main 分支的 normalize：旧名 "chrome" → "user"，并清掉 driver:"extension" 残留。
            config.browser ??= {};
            config.browser.defaultProfile = normalizeRequestedBrowserProfileForSave(
              config,
              browserProfile,
            );
            migrateBrowserProfileForCurrentGateway(config);
          }

          if (typeof launchAtLogin === "boolean") {
            setLaunchAtLoginEnabled(app, launchAtLogin);
          }

          // ClawHub Registry URL 写入独立文件（不污染 gateway config）
          if (clawHubRegistry !== undefined) {
            writeSkillStoreRegistry(clawHubRegistry);
          }

          writeUserConfig(config);
          opts.requestGatewayRestart?.();
          return { success: true };
        } catch (err: any) {
          return { success: false, message: err.message || String(err) };
        }
      }
    );
  });

}
