/**
 * 模型能力编辑器（T6）：从 tab-provider.ts 的渲染函数抽为独立 LitElement。
 * 历史编辑器输入每键调 root requestUpdate → 全应用重渲染（2352 行视图 + 侧栏 +
 * 聊天壳）；组件化后按键/切档只重渲染编辑器自身子树，draft 为可变对象，
 * 保存时由调用方读取（tab-provider handleModelEditSave / handleAddSave）。
 * 光 DOM（createRenderRoot=this）复用全局 settings.css 类名。
 */
import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { t } from "../i18n.ts";

/** 能力编辑草稿（编辑既有模型与分组追加共用） */
export interface CapsDraft {
  contextWindow: string;
  contextTokens: string;
  maxTokens: string;
  image: boolean;
  video: boolean;
  audio: boolean;
  reasoning: boolean;
  thinkingLevels: string[];
}

/** 编辑器可选思考档位（off/on 为基础开关、adaptive 为 provider 专有，不暴露） */
export const EDITABLE_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

const CONTEXT_PRESETS: Array<[string, number]> = [["128K", 131072], ["256K", 262144], ["512K", 524288], ["1M", 1048576]];

@customElement("oc-caps-editor")
export class OcCapsEditor extends LitElement {
  createRenderRoot() { return this; }

  @property({ attribute: false }) draft: CapsDraft | null = null;

  private numInput(
    draft: CapsDraft,
    label: string,
    field: "contextWindow" | "contextTokens" | "maxTokens",
    placeholder: string,
  ) {
    return html`
      <div class="oc-settings__form-group">
        <label class="oc-settings__label">${label}</label>
        <input class="oc-settings__input" type="number" min="1" step="1" .value=${draft[field]}
          placeholder=${placeholder}
          @input=${(e: Event) => { draft[field] = (e.target as HTMLInputElement).value.replace(/[^\d]/g, ""); this.requestUpdate(); }} />
      </div>
    `;
  }

  private capToggle(draft: CapsDraft, label: string, field: "image" | "video" | "audio") {
    return html`
      <oc-toggle-switch .label=${label} .checked=${draft[field]}
        @change=${(e: CustomEvent) => { draft[field] = Boolean((e.detail as { checked?: boolean } | null)?.checked); this.requestUpdate(); }}
      ></oc-toggle-switch>
    `;
  }

  render() {
    const draft = this.draft;
    if (!draft) return nothing;
    return html`
      <div class="oc-caps-editor">
        ${this.numInput(draft, t("settings.provider.caps.contextWindow"), "contextWindow", t("settings.provider.caps.inheritHint"))}
        <div class="oc-caps-editor__chips">
          ${CONTEXT_PRESETS.map(([label, v]) => html`
            <button class="oc-caps-chip ${draft.contextWindow === String(v) ? "is-active" : ""}"
              @click=${() => { draft.contextWindow = String(v); this.requestUpdate(); }}>${label}</button>
          `)}
        </div>
        ${this.numInput(draft, t("settings.provider.caps.maxTokens"), "maxTokens", t("settings.provider.caps.inheritHint"))}
        <div class="oc-settings__form-group">
          <label class="oc-settings__label">${t("settings.provider.caps.modalities")}</label>
          <div class="oc-caps-editor__toggles">
            ${this.capToggle(draft, t("settings.provider.caps.image"), "image")}
            ${this.capToggle(draft, t("settings.provider.caps.video"), "video")}
            ${this.capToggle(draft, t("settings.provider.caps.audio"), "audio")}
          </div>
        </div>
        <div class="oc-settings__form-group">
          <oc-toggle-switch .label=${t("settings.provider.caps.reasoning")} .checked=${draft.reasoning}
            @change=${(e: CustomEvent) => { draft.reasoning = Boolean((e.detail as { checked?: boolean } | null)?.checked); this.requestUpdate(); }}
          ></oc-toggle-switch>
        </div>
        ${draft.reasoning ? html`
          <div class="oc-settings__form-group">
            <label class="oc-settings__label">${t("settings.provider.caps.thinkingLevels")}</label>
            <div class="oc-caps-editor__chips">
              ${EDITABLE_THINKING_LEVELS.map(lv => html`
                <button class="oc-caps-chip ${draft.thinkingLevels.includes(lv) ? "is-active" : ""}"
                  @click=${() => {
                    const i = draft.thinkingLevels.indexOf(lv);
                    if (i >= 0) draft.thinkingLevels.splice(i, 1);
                    else draft.thinkingLevels.push(lv);
                    this.requestUpdate();
                  }}>${t(`chat.thinkLevel.${lv}`)}</button>
              `)}
            </div>
            <span class="oc-provider-dynamic-hint">${t("settings.provider.caps.thinkingLevelsHint")}</span>
          </div>
        ` : nothing}
      </div>
    `;
  }
}
