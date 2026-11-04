import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import { icons } from "../icons.ts";
import { t } from "../i18n.ts";
import { positionAnchorPanel } from "../utils/anchor-panel.ts";
import { showToastGlobal } from "../app-toast.ts";

export type FileOpenTarget = "vscode" | "explorer" | "terminal" | "git-bash";

@customElement("oc-file-open-menu")
export class OcFileOpenMenu extends LitElement {
  static properties = {
    path: { attribute: false },
    menuId: { attribute: false },
  };

  path = "";
  menuId = `file-open-${Math.random().toString(36).slice(2, 9)}`;

  createRenderRoot() {
    return this;
  }

  private async open(target: FileOpenTarget) {
    this.closeMenu();
    if (!this.path) return;
    try {
      const result = await window.cryoclaw?.workspaceOpenWith?.({ path: this.path, target });
      if (!result?.success) throw new Error(result?.message || t("workspace.openWith.failed"));
    } catch (error) {
      showToastGlobal(`${t("workspace.openWith.failed")}: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  private async copyPath() {
    this.closeMenu();
    try {
      await navigator.clipboard.writeText(this.path);
    } catch {
      // 主按钮与菜单仍保持可用，剪贴板失败不阻断其他打开方式。
    }
  }

  private closeMenu() {
    this.querySelector<HTMLElement>(":popover-open")?.hidePopover();
  }

  private positionMenu = () => {
    const menu = this.querySelector<HTMLElement>(".file-open-menu__popover");
    const trigger = this.querySelector<HTMLElement>(".file-open-menu__split");
    if (!menu?.matches(":popover-open") || !trigger) return;
    const position = positionAnchorPanel(menu,trigger);
    menu.dataset.side = position.side;
  };

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("resize", this.positionMenu);
    window.addEventListener("scroll", this.positionMenu, true);
  }

  disconnectedCallback() {
    window.removeEventListener("resize", this.positionMenu);
    window.removeEventListener("scroll", this.positionMenu, true);
    super.disconnectedCallback();
  }

  render() {
    return html`<span class="file-open-menu">
      <span class="file-open-menu__split">
        <button class="file-open-menu__default" type="button" title=${t("workspace.openWith.default")}
          aria-label=${t("workspace.openWith.default")} @click=${() => void this.open("vscode")}>${icons.externalLink}</button>
        <button class="file-open-menu__toggle" type="button" popovertarget=${this.menuId}
          title=${t("workspace.openWith.more")} aria-label=${t("workspace.openWith.more")}>${icons.chevronDown}</button>
      </span>
      <span class="file-open-menu__popover" id=${this.menuId} popover="auto" @toggle=${this.positionMenu}>
        <button type="button" @click=${() => void this.open("vscode")}>${icons.externalLink}<span>VS Code</span></button>
        <button type="button" @click=${() => void this.open("explorer")}>${icons.folderOpen}<span>${t("workspace.openWith.explorer")}</span></button>
        <button type="button" @click=${() => void this.open("terminal")}>${icons.terminal}<span>${t("workspace.openWith.terminal")}</span></button>
        <button type="button" @click=${() => void this.open("git-bash")}>${icons.diff}<span>Git Bash</span></button>
        <button type="button" @click=${() => void this.copyPath()}>${icons.copy}<span>${t("workspace.openWith.copyPath")}</span></button>
      </span>
    </span>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "oc-file-open-menu": OcFileOpenMenu;
  }
}
