/**
 * Settings constants — tab definitions, channel platform config.
 */
import {html,type TemplateResult} from "lit";
import {icons} from "../../icons.ts";

export interface ChannelPlatform {
  id: string;
  labelKey: string;
  descKey: string;
}

export const CHANNEL_PLATFORMS: ChannelPlatform[] = [
  { id: "weixin", labelKey: "settings.channels.weixin", descKey: "settings.channels.weixin.desc" },
  { id: "feishu", labelKey: "settings.channels.feishu", descKey: "settings.channels.feishu.desc" },
  { id: "wecom", labelKey: "settings.channels.wecom", descKey: "settings.channels.wecom.desc" },
  { id: "dingtalk", labelKey: "settings.channels.dingtalk", descKey: "settings.channels.dingtalk.desc" },
  { id: "qqbot", labelKey: "settings.channels.qqbot", descKey: "settings.channels.qqbot.desc" },
];

export interface SettingsTab {
  id: string;
  labelKey: string;
  group?: "channels" | "models" | "system";
}

export const SETTINGS_TABS: SettingsTab[] = [
  { id: "channels", labelKey: "settings.nav.channels", group: "channels" },
  { id: "provider", labelKey: "settings.nav.provider", group: "models" },
  { id: "search", labelKey: "settings.nav.search", group: "models" },
  { id: "memory", labelKey: "settings.nav.memory", group: "models" },
  { id: "voice", labelKey: "settings.nav.voice", group: "models" },
  { id: "usage", labelKey: "settings.nav.usage", group: "models" },
  { id: "mcp-hooks", labelKey: "settings.nav.mcpHooks", group: "models" },
  { id: "overview", labelKey: "settings.nav.overview", group: "system" },
  { id: "appearance", labelKey: "settings.nav.appearance", group: "system" },
  { id: "advanced", labelKey: "settings.nav.advanced", group: "system" },
  { id: "approvals", labelKey: "settings.nav.approvals", group: "system" },
  { id: "backup", labelKey: "settings.nav.backup", group: "system" },
  { id: "about", labelKey: "settings.nav.about", group: "system" },
];

/* One glyph family across navigation, actions and editor controls. */
const TAB_ICONS:Record<string,TemplateResult>={
  channels:icons.messagePlus,provider:icons.cpu,search:icons.search,memory:icons.brain,
  appearance:icons.palette,voice:icons.mic,advanced:icons.sliders,usage:icons.activity,
  "mcp-hooks":icons.plug,approvals:icons.shieldCheck,backup:icons.archiveRestore,
  about:icons.info,overview:icons.gauge,
};

export function getTabIcon(id: string): TemplateResult | typeof import("lit").nothing {
  return TAB_ICONS[id] ?? html``;
}
