/**
 * 扩展视图（R42 第二期）—— 技能（网关 skills.* + clawhub 商店）与插件
 * （主进程 IPC + config.patch）双 tab 的统一视图。承接原 skills 视图与
 * 设置页 plugins tab 的入口职责；插件 tab 状态复位由 leave hook 接管
 * （原 cleanupSettingsView 的 resetPluginsTab 语义迁移）。
 */
import { html } from "lit";
import type { AppViewState } from "./app-view-state.ts";
import { renderSkillsView } from "./app-skills.ts";
import {
  renderPluginsView,
  resetPluginsView,
} from "./views/settings/tab-plugins.ts";
import { registerViewLeaveHook, setCryoClawView } from "./app-view-switch.ts";
import { loadSkills } from "./controllers/skills.ts";
import { t } from "./i18n.ts";

export type ExtensionsViewTab = "skills" | "plugins";

// tab 模块态（对齐 app-skills 的 skillsSubTab 模式）
let extensionsViewTab: ExtensionsViewTab = "skills";

// 离开扩展视图复位插件 tab 状态：下次打开重新拉取（与 settings 页离开复位语义一致）
registerViewLeaveHook("extensions", () => resetPluginsView());

// 打开扩展视图（tab 缺省 skills；skills 时预拉已安装列表）
export function openExtensionsView(state: AppViewState, tab: ExtensionsViewTab = "skills") {
  extensionsViewTab = tab;
  setCryoClawView(state, "extensions");
  if (tab === "skills") {
    void loadSkills(state);
  }
}

export function renderExtensionsView(state: AppViewState) {
  return html`
    <div class="ext-layout">
      <div class="ext-tabs" role="tablist">
        <button
          class="ext-tab ${extensionsViewTab === "skills" ? "active" : ""}"
          type="button"
          role="tab"
          aria-selected=${extensionsViewTab === "skills" ? "true" : "false"}
          @click=${() => {
            extensionsViewTab = "skills";
            void loadSkills(state);
            state.requestUpdate();
          }}
        >${t("extensions.tabSkills")}</button>
        <button
          class="ext-tab ${extensionsViewTab === "plugins" ? "active" : ""}"
          type="button"
          role="tab"
          aria-selected=${extensionsViewTab === "plugins" ? "true" : "false"}
          @click=${() => {
            extensionsViewTab = "plugins";
            state.requestUpdate();
          }}
        >${t("extensions.tabPlugins")}</button>
      </div>
      ${extensionsViewTab === "skills" ? renderSkillsView(state) : renderPluginsView(state)}
    </div>
  `;
}
