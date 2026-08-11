/**
 * Settings IPC 薄入口：只做聚合注册。
 * 各域实现见 src/settings/ 目录：
 *   verify.ts     凭据验证 / Kimi key & proxy / 分享文案 / 会员用量
 *   channels.ts   渠道运行态 / 微信插件启用守卫
 *   weixin.ts     微信扫码登录 / 账号清除
 *   pairing.ts    飞书 & 企业微信 pairing（sidecar store 属主进程职责）
 *   webbridge.ts  WebBridge 安装 / 修复 / 默认浏览器
 *   advanced.ts   高级配置本地字段（浏览器模式 / 开机自启 / ClawHub registry）
 *   cli.ts        openclaw CLI 集成
 *   backup.ts     配置备份 / 状态导入导出 / 恢复出厂
 *   about.ts      版本 / 环境信息
 */
import type { SettingsIpcOptions } from "./settings/types";
import { registerVerifyIpc } from "./settings/verify";
import { registerChannelsIpc } from "./settings/channels";
import { registerWeixinIpc } from "./settings/weixin";
import { registerPairingIpc } from "./settings/pairing";
import { registerWebbridgeIpc } from "./settings/webbridge";
import { registerAdvancedIpc } from "./settings/advanced";
import { registerCliIpc } from "./settings/cli";
import { registerBackupIpc } from "./settings/backup";
import { registerAboutIpc } from "./settings/about";

export type { SettingsIpcOptions } from "./settings/types";

// 注册 Settings 相关 IPC
export function registerSettingsIpc(opts: SettingsIpcOptions): void {
  registerVerifyIpc();
  registerChannelsIpc();
  registerWeixinIpc(opts);
  registerPairingIpc(opts);
  registerWebbridgeIpc(opts);
  registerAdvancedIpc(opts);
  registerCliIpc();
  registerBackupIpc(opts);
  registerAboutIpc();
}
