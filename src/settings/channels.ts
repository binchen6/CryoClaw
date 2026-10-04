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
import { isFeishuPluginBundled } from "../feishu-config";
import {
  ensureWeixinPluginReady,
  isWeixinPluginBundled,
  listWeixinAccountIds,
} from "../weixin-config";
import { isKimiSearchPluginBundled } from "../kimi-config";
import { reconcileExtensionsOnAppLaunch } from "../extension-mirror";
import { assertTrustedIpcSender } from "../ipc-sender-guard";

// ── 运行态查询前的 throttled reconcile（T5） ──
// wecom/weixin 的镜像副本可能在启动期 reconcile 瞬时失败（杀软锁/磁盘抖动），
// 单次失败会让整个会话的设置页误报「组件缺失」。仿 settings:ensure-weixin-plugin：
// 运行态查询前先触发一次 reconcile 自愈；每进程最短间隔节流 + 超时兜底，
// 慢速 reconcile 绝不阻塞 IPC 查询（四根判定本身还会兜底其他安装根）。
const RECONCILE_MIN_INTERVAL_MS = 60_000;
const RECONCILE_TIMEOUT_MS = 10_000;
let lastReconcileAt = 0;

async function reconcileBeforeRuntimeQuery(): Promise<void> {
  const now = Date.now();
  if (now - lastReconcileAt < RECONCILE_MIN_INTERVAL_MS) return;
  lastReconcileAt = now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      reconcileExtensionsOnAppLaunch(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("reconcile timeout")), RECONCILE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch {
    // reconcile 失败/超时不阻断查询：按当前磁盘状态如实返回，下个间隔再试
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function registerChannelsIpc(): void {
  // ── 渠道运行态（R4：openclaw.json 读写已移到前端 config.patch，主进程只保留运行态查询） ──
  ipcMain.handle("settings:get-channel-runtime-state", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:get-channel-runtime-state")) throw new Error("IPC sender not trusted");
    try {
      // bundled 判定前先自愈一次镜像目录（throttled，见文件头注释）
      await reconcileBeforeRuntimeQuery();
      const qqbotBundled = isQqbotPluginBundled();
      const dingtalkBundled = isDingtalkPluginBundled();
      const wecomBundled = isWecomPluginBundled();
      const weixinBundled = isWeixinPluginBundled();
      const feishuBundled = isFeishuPluginBundled();
      const kimiSearchBundled = isKimiSearchPluginBundled();
      return {
        success: true,
        data: {
          bundled: {
            qqbot: qqbotBundled,
            dingtalk: dingtalkBundled,
            wecom: wecomBundled,
            weixin: weixinBundled,
            feishu: feishuBundled,
            kimiSearch: kimiSearchBundled,
          },
          bundleMessages: {
            qqbot: qqbotBundled ? "" : resolveQqbotMissingMessage(),
            dingtalk: dingtalkBundled ? "" : resolveDingtalkMissingMessage(),
            wecom: wecomBundled ? "" : resolveWecomMissingMessage(),
            weixin: weixinBundled ? "" : "微信插件未安装，请重新启动 CryoClaw 或重新安装应用。",
            feishu: feishuBundled ? "" : resolveFeishuMissingMessage(),
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

  function resolveFeishuMissingMessage(): string {
    // dev 模式最常见的问题是还没执行 package:resources，把飞书插件 vendor 进 gateway dist/extensions。
    if (!app.isPackaged) {
      return `开发模式未检测到飞书插件，请先运行 npm run package:resources（当前目标：${process.platform}-${process.arch}）。`;
    }
    return "飞书组件缺失，请重新安装 CryoClaw。";
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
