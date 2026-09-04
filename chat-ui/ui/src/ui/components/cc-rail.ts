import { LitElement, html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { t } from "../i18n.ts";
import { icons } from "../icons.ts";
import type { CryoClawViewId } from "../views/registry.ts";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";

// 品牌标：与 chat-ui favicon 同源（assets/cryoclaw-favicon.svg），内联避免资产
// URL 导入（测试 tsconfig 不含 vite/client 类型；file:// 打包也无额外请求）。
const BRAND_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 120 120"><defs><linearGradient id="cc-rail-brand-g" x1="0%" x2="100%" y1="0%" y2="100%"><stop offset="0%" stop-color="#ff4d4d"/><stop offset="100%" stop-color="#991b1b"/></linearGradient></defs><path fill="url(#cc-rail-brand-g)" d="M60 10c-30 0-45 25-45 45s15 40 30 45v10h10v-10s5 2 10 0v10h10v-10c15-5 30-25 30-45S90 10 60 10"/><path fill="url(#cc-rail-brand-g)" d="M20 45C5 40 0 50 5 60s15 5 20-5c3-7 0-10-5-10"/><path fill="url(#cc-rail-brand-g)" d="M100 45c15-5 20 5 15 15s-15 5-20-5c-3-7 0-10 5-10"/><path stroke="#ff4d4d" stroke-linecap="round" stroke-width="3" d="M45 15Q35 5 30 8m45 7Q85 5 90 8"/><circle cx="45" cy="35" r="6" fill="#050810"/><circle cx="75" cy="35" r="6" fill="#050810"/><circle cx="46" cy="34" r="2.5" fill="#00e5cc"/><circle cx="76" cy="34" r="2.5" fill="#00e5cc"/></svg>`;

// CryoClaw 图标轨组件（2026.9 提案 A 重写）。
// 取代旧 cc-sidebar 底部图标轨 + 品牌区：60px 窄轨常驻所有视图（setup 向导除外），
// 承担全局视图导航（chat/tasks/workspace/extensions/settings）与状态入口
// （webbridge 修复、完整版网页/重连 + 错误徽标、设置角标）。
//
// 契约（与 cc-session-panel 相同）：
// - 全部业务状态归 OpenClawApp，本组件只接单属性 props、无自有业务状态；
// - 回调每帧新闭包（renderApp 字面量构造），不得进 shouldUpdate 比较清单，
//   事件触发经 this.props 拿最新对象；
// - 无 shadow DOM：全局样式（styles/shell.css）与 tooltip/徽标定位依赖扁平 DOM。
@customElement("cc-rail")
export class CcRail extends LitElement {
  static properties = {
    props: { attribute: false },
  };

  props: RailProps | null = null;

  createRenderRoot() {
    return this;
  }

  shouldUpdate(changed: Map<PropertyKey, unknown>): boolean {
    if (!changed.has("props")) return false;
    const prev = changed.get("props") as RailProps | null | undefined;
    const next = this.props;
    if (!prev || !next) return true;
    let changedFlag = false;
    for (const name of DATA_FIELDS) {
      if (name === "errors") continue;
      if (prev[name] !== next[name]) {
        changedFlag = true;
        break;
      }
    }
    if (!changedFlag) changedFlag = !errorsEqual(prev.errors, next.errors);
    return changedFlag;
  }

  render() {
    const props = this.props;
    if (!props) return nothing;
    return renderRailInner(props);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cc-rail": CcRail;
  }
}

export type RailProps = {
  /** 当前视图 id（chat/tasks/workspace/extensions/settings/setup） */
  activeView: CryoClawViewId;
  tasksRunningCount: number;
  connected: boolean;
  errors: string[];
  // webbridge 模式但浏览器扩展未启用 → 显示修复入口（wrench 图标，accent 高亮）
  webbridgeRepairVisible: boolean;
  webbridgeRepairChecking: boolean;
  onWebbridgeRepairClick: () => void;
  // 设置角标：微信新功能徽标 / App 更新徽标（并列，互不影响）
  settingsBadge: boolean;
  settingsUpdateBadge: boolean;
  onOpenChat: () => void;
  onOpenTasks: () => void;
  onOpenWorkspace: () => void;
  onOpenExtensions: () => void;
  onOpenSettings: () => void;
  onOpenWebUI: () => void;
  onReconnect: () => void;
};

// shouldUpdate 数据字段比较清单：布尔/数字/字符串按值、数组按引用。
// 全部回调一律排除（每帧新闭包，引用比较恒变会让隔离失效）。
const DATA_FIELDS = [
  "activeView",
  "tasksRunningCount",
  "connected",
  "webbridgeRepairVisible",
  "webbridgeRepairChecking",
  "settingsBadge",
  "settingsUpdateBadge",
  "errors",
] as const;

function errorsEqual(a: string[], b: string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function railItem(
  props: RailProps,
  opts: {
    view?: CryoClawViewId;
    label: string;
    icon: unknown;
    onClick: () => void;
    badge?: unknown;
    extraClass?: string;
  },
) {
  const active = opts.view != null && props.activeView === opts.view;
  return html`
    <button
      class="cc-rail__item ${active ? "active" : ""} ${opts.extraClass ?? ""}"
      type="button"
      @click=${opts.onClick}
      aria-current=${active ? "page" : nothing}
      data-tooltip=${opts.label}
      data-tooltip-pos="right"
      aria-label=${opts.label}
    >
      ${opts.icon}
      ${opts.badge ?? nothing}
    </button>
  `;
}

function renderRailInner(props: RailProps) {
  const hasErrors = props.errors.length > 0;
  const errorBadge = hasErrors
    ? html`<span class="cc-rail__badge" title=${props.errors.join("\n")}>${props.errors.length}</span>`
    : nothing;
  const settingsTooltip = props.settingsUpdateBadge
    ? t("sidebar.updateBadgeTooltip")
    : props.settingsBadge
      ? t("sidebar.weixinBadgeTooltip")
      : t("sidebar.settings");

  return html`
    <nav class="cc-rail" aria-label=${t("rail.nav")}>
      <div class="cc-rail__brand" aria-hidden="true">
        <span class="cc-rail__brand-mark">${unsafeSVG(BRAND_MARK_SVG)}</span>
      </div>

      <div class="cc-rail__nav">
        ${railItem(props, {
          view: "chat",
          label: t("rail.chat"),
          icon: icons.messagePlus,
          onClick: () => props.onOpenChat(),
        })}
        ${railItem(props, {
          view: "tasks",
          label: t("sidebar.tasks"),
          icon: icons.activity,
          onClick: () => props.onOpenTasks(),
          badge:
            props.tasksRunningCount > 0
              ? html`<span class="cc-rail__badge">${props.tasksRunningCount}</span>`
              : nothing,
        })}
        ${railItem(props, {
          view: "workspace",
          label: t("sidebar.workspace"),
          icon: icons.folder,
          onClick: () => props.onOpenWorkspace(),
        })}
        ${railItem(props, {
          view: "extensions",
          label: t("sidebar.extensions"),
          icon: icons.puzzle,
          onClick: () => props.onOpenExtensions(),
        })}
      </div>

      <span class="cc-rail__spacer"></span>

      <div class="cc-rail__footer">
        ${props.webbridgeRepairVisible
          ? railItem(props, {
              label: t("sidebar.webbridgeRepairNeeded"),
              icon: props.webbridgeRepairChecking ? icons.loader : icons.wrench,
              onClick: () => props.onWebbridgeRepairClick(),
              extraClass: "cc-rail__item--webbridge-repair",
            })
          : nothing}
        <span class="cc-rail__error-wrap">
          ${props.connected
            ? railItem(props, {
                label: t("sidebar.fullUI"),
                icon: icons.externalLink,
                onClick: () => props.onOpenWebUI(),
                badge: errorBadge,
              })
            : railItem(props, {
                label: t("sidebar.reconnect"),
                icon: icons.refreshCw,
                onClick: () => props.onReconnect(),
                badge: errorBadge,
                extraClass: "cc-rail__item--disconnected",
              })}
          ${hasErrors
            ? html`<div class="cc-rail__error-popup">
                ${props.errors.map((msg) => html`<div class="cc-rail__error-item">${msg}</div>`)}
              </div>`
            : nothing}
        </span>
        ${railItem(props, {
          view: "settings",
          label: settingsTooltip,
          icon: icons.settings,
          onClick: () => props.onOpenSettings(),
          badge:
            props.settingsBadge || props.settingsUpdateBadge
              ? html`<span class="cc-rail__dot"></span>`
              : nothing,
        })}
      </div>
    </nav>
  `;
}
