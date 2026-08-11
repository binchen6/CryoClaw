/**
 * Settings: 渠道运行态查询 + 微信插件启用守卫。
 * R4 后渠道 openclaw.json 读写已移到前端 config.patch，主进程只保留：
 *   - get-channel-runtime-state：bundle 就绪状态 + 微信账号列表
 *   - ensure-weixin-plugin：启用前把 mirror reconcile 到 external plugin 目录
 */
import { app, ipcMain } from "electron";
import { isQqbotPluginBundled } from "../qqbot-config";
import { isDingtalkPluginBundled } from "../dingtalk-config";
import { isWecomPluginBundled } from "../wecom-config";
import {
  ensureWeixinPluginReady,
  isWeixinPluginBundled,
  listWeixinAccountIds,
} from "../weixin-config";
import { isKimiSearchPluginBundled } from "../kimi-config";
import { reconcileExtensionsOnAppLaunch } from "../extension-mirror";
import { assertTrustedIpcSender } from "../ipc-sender-guard";

export function registerChannelsIpc(): void {
  // ── 渠道运行态（R4：openclaw.json 读写已移到前端 config.patch，主进程只保留运行态查询） ──
  ipcMain.handle("settings:get-channel-runtime-state", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:get-channel-runtime-state")) throw new Error("IPC sender not trusted");
    try {
      const qqbotBundled = isQqbotPluginBundled();
      const dingtalkBundled = isDingtalkPluginBundled();
      const wecomBundled = isWecomPluginBundled();
      const weixinBundled = isWeixinPluginBundled();
      const kimiSearchBundled = isKimiSearchPluginBundled();
      return {
        success: true,
        data: {
          bundled: {
            qqbot: qqbotBundled,
            dingtalk: dingtalkBundled,
            wecom: wecomBundled,
            weixin: weixinBundled,
            kimiSearch: kimiSearchBundled,
          },
          bundleMessages: {
            qqbot: qqbotBundled ? "" : resolveQqbotMissingMessage(),
            dingtalk: dingtalkBundled ? "" : resolveDingtalkMissingMessage(),
            wecom: wecomBundled ? "" : resolveWecomMissingMessage(),
            weixin: weixinBundled ? "" : "微信插件未安装，请重新启动 CryoClaw 或重新安装应用。",
            kimiSearch: kimiSearchBundled ? "" : "Kimi Search 组件缺失，请重新安装 CryoClaw。",
          },
          weixinAccounts: listWeixinAccountIds(),
        },
      };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // ── 读取 QQ Bot 配置 ──
  function resolveQqbotMissingMessage(): string {
    // dev 模式最常见的问题是还没执行 package:resources，把 qqbot 插件注入目标资源目录。
    if (!app.isPackaged) {
      return `开发模式未检测到 QQ Bot 插件，请先运行 npm run package:resources（当前目标：${process.platform}-${process.arch}）。`;
    }
    return "QQ Bot 组件缺失，请重新安装 CryoClaw。";
  }

  function resolveDingtalkMissingMessage(): string {
    // dev 模式最常见的问题是还没执行 package:resources，把钉钉插件注入目标资源目录。
    if (!app.isPackaged) {
      return `开发模式未检测到钉钉连接器插件，请先运行 npm run package:resources（当前目标：${process.platform}-${process.arch}）。`;
    }
    return "钉钉连接器组件缺失，请重新安装 CryoClaw。";
  }

  function resolveWecomMissingMessage(): string {
    // dev 模式最常见的问题是还没执行 package:resources，把企业微信插件注入目标资源目录。
    if (!app.isPackaged) {
      return `开发模式未检测到企业微信插件，请先运行 npm run package:resources（当前目标：${process.platform}-${process.arch}）。`;
    }
    return "企业微信插件组件缺失，请遵循插件文档指引进行安装。";
  }

  // ── 启用微信渠道前守卫：把 mirror reconcile 到 external plugin 目录（R4 后 enabled 开关走 config.patch） ──
  ipcMain.handle("settings:ensure-weixin-plugin", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:ensure-weixin-plugin")) throw new Error("IPC sender not trusted");
    try {
      await ensureWeixinPluginReady(reconcileExtensionsOnAppLaunch);
      return { success: true, data: { ok: true } };
    } catch (err: any) {
      return { success: true, data: { ok: false, message: err.message || String(err) } };
    }
  });

}
