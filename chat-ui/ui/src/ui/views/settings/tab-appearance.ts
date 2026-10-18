/**
 * Settings: Appearance Tab — theme and show thinking toggle.
 * Directly writes to Chat UI state (no IPC for appearance).
 */
import { html } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { t } from "../../i18n.ts";
import {getLocale} from "../../i18n.ts";
import {icons} from "../../icons.ts";
import {buildThemeDesignPrompt,prepareThemeDesignSkill} from "../../theme-agent.ts";
import {setCryoClawView} from "../../app-view-switch.ts";
import {transitionView} from "../../utils/view-transition.ts";
import {showToast} from "../../app-toast.ts";
import {normalizeAppearance,applyAppearance,exportAppearance,getAppliedAppearance,withAppearanceMode} from "../../appearance-profile.ts";
import {startThemeEditor,hasThemePreview,updateActiveThemePreview,previewImportedTheme,endThemePreview} from "../../theme-live.ts";
import {BUILTIN_THEMES,readThemeLibrary,saveThemeToLibrary,deleteSavedTheme,importThemeToLibrary,themeVariantColors,themeVariantModes} from "../../theme-library.ts";
import "../../components/range-control.ts";
import {scheduleAppearancePreview,cancelAppearancePreview} from "../../appearance-preview-scheduler.ts";
import "../../components/toggle-switch.ts";
import "../../components/message-box.ts";

// Appearance 页状态必须跟当前 app settings 同步，不能复用上次未保存的本地草稿。
function createAppearanceState() {
  return {
    theme: "light" as "system" | "light" | "dark",
    showThinking: false,
    successMsg: null as string | null,
    initialized: false,
    profile:normalizeAppearance(undefined),
    owner:null as AppViewState|null,
    error:"",
    committed:undefined as AppViewState["settings"]["appearance"],
    schemeName:"",
    activeThemeId:null as string|null,
    agentRequest:"",
    agentMode:"current" as "current"|"light"|"dark"|"system",
    agentPreserveLayout:true,
    agentBusy:false,
    agentProgress:"",
    agentError:"",
    previewPending:false,
    hadThemePreview:false,
  };
}

const s = createAppearanceState();

// 离开 Settings 时把 Appearance 页恢复到未初始化状态。
function resetAppearanceState() {
  if(s.owner)cancelAppearancePreview(s.owner);
  if(s.owner && !hasThemePreview(s.owner))applyAppearance({...normalizeAppearance(s.owner.settings.appearance),mode:s.owner.settings.theme});
  Object.assign(s, createAppearanceState());
}

function init(state: AppViewState) {
  if (s.initialized) return;
  s.initialized = true;
  s.owner=state;s.profile=normalizeAppearance({...state.settings.appearance,mode:state.settings.theme});
  s.committed=state.settings.appearance;
  s.theme = (state.settings?.theme as any) ?? "light";
  s.showThinking = state.settings?.chatShowThinking ?? false;
}

function handleSave(state: AppViewState) {
  state.applySettings({
    ...state.settings,
    theme: s.theme,
    chatShowThinking: s.showThinking,
    appearance:normalizeAppearance(s.profile),
  });
  if(hasThemePreview(state))endThemePreview(state);
  s.successMsg = t("settings.saved");
  state.requestUpdate();
}

export function resetAppearanceTab() { resetAppearanceState(); }

async function generateTheme(state:AppViewState){
  if(s.agentBusy || !state.client || !state.connected || !s.agentRequest.trim())return;
  const client=state.client,sessionKey=state.sessionKey;
  const prompt=buildThemeDesignPrompt({request:s.agentRequest,mode:s.agentMode==="current"?s.theme:s.agentMode,preserveLayout:s.agentPreserveLayout,locale:getLocale()},s.profile);
  s.agentBusy=true;s.agentError="";state.requestUpdate();
  try{
    const recovery=await prepareThemeDesignSkill(client,{canContinue:()=>state.client===client && state.connected && state.sessionKey===sessionKey && s.owner===state && !!document.querySelector('[data-settings-tab="appearance"]'),onProgress:progress=>{s.agentProgress=getLocale().startsWith("zh")?progress.phase==="enabling"?"正在恢复主题技能…":progress.phase==="retrying"?`正在自动恢复（${progress.attempt}/3）…`:"正在检查主题技能…":progress.phase==="enabling"?"Enabling theme skill…":progress.phase==="retrying"?`Recovering (${progress.attempt}/3)…`:"Checking theme skill…";state.requestUpdate();}});
    if(state.client!==client || !state.connected || state.sessionKey!==sessionKey)throw new Error(getLocale().startsWith("zh")?"对话或连接已变化，请重新点击生成。":"The conversation or connection changed. Try again.");
    if(s.owner!==state || !document.querySelector('[data-settings-tab="appearance"]'))return;
    if(recovery.recovered)showToast(state,getLocale().startsWith("zh")?"主题技能已自动恢复":"Theme skill recovered automatically");
    if(hasThemePreview(state))endThemePreview(state,false,false);
    transitionView(()=>setCryoClawView(state,"chat"));
    await state.handleSendChat(prompt,{attachments:[]});
  }catch(error){if(s.owner===state)s.agentError=error instanceof Error?error.message:String(error);}
  finally{if(s.owner===state){s.agentBusy=false;state.requestUpdate();}}
}

export function renderTabAppearance(state: AppViewState) {
  init(state);
  if(s.committed!==state.settings.appearance){s.profile=normalizeAppearance(state.settings.appearance);s.committed=state.settings.appearance;}
  const activePreview=hasThemePreview(state);
  if((activePreview || s.hadThemePreview) && !s.previewPending)s.profile=getAppliedAppearance();
  s.hadThemePreview=activePreview;
  if(s.profile.mode)s.theme=s.profile.mode;
  if(s.profile.palettes)s.profile=withAppearanceMode(s.profile,s.theme,window.matchMedia("(prefers-color-scheme: dark)").matches);
  const text=(cn:string,en:string)=>getLocale().startsWith("zh")?cn:en;
  const themes=[...BUILTIN_THEMES,...readThemeLibrary()];
  const themeKey=(profile:typeof s.profile)=>JSON.stringify([themeVariantColors(profile,"light"),themeVariantColors(profile,"dark"),profile.radius]);
  const selectedThemeId=themes.find(theme=>theme.id===s.activeThemeId && themeKey(theme.appearance)===themeKey(s.profile))?.id??themes.find(theme=>themeKey(theme.appearance)===themeKey(s.profile))?.id;

  const preview=(inFrame=false,preserveComponents=true)=>{s.successMsg=null;s.previewPending=true;const apply=()=>{if(!updateActiveThemePreview(state,s.profile,preserveComponents))applyAppearance(s.profile);s.previewPending=false;state.requestUpdate();};if(inFrame){cancelAppearancePreview(state);apply();}else scheduleAppearancePreview(state,apply);};

  return html`
    <div class="oc-settings__section">
      <h2 class="oc-settings__section-title">${t("settings.appearance.title")}</h2>
      <p class="oc-settings__page-desc">${t("settings.appearance.desc")}</p>

      <section class="oc-appearance-editor oc-theme-module"><h3>${text("主题", "Theme")}</h3>
        <p class="oc-settings__hint">${text("每套主题包含浅色与深色外观。选好主题后，可跟随系统自动切换，也可分别微调两种外观。旧主题缺少的外观使用默认配色。", "Each theme pairs light and dark appearances. Follow your system or customize each appearance separately. Missing variants use default colors.")}</p>
        <div class="oc-theme-modes" role="group" aria-label=${text("外观模式", "Appearance mode")}>
          ${(["light","dark","system"] as const).map(mode=>html`<button class="btn" data-mode=${mode} aria-pressed=${s.theme===mode} @click=${()=>{s.theme=mode;s.profile=withAppearanceMode(s.profile,mode,window.matchMedia("(prefers-color-scheme: dark)").matches);preview();}}>${t(`theme.${mode}`)}</button>`)}
        </div>
        <div class="oc-theme-grid oc-theme-grid--library">
        ${themes.map(scheme=>html`<div class="oc-theme-library-item"><button type="button" class="oc-theme-card" title=${scheme.name} aria-pressed=${selectedThemeId===scheme.id} @click=${()=>{const custom=!BUILTIN_THEMES.some(builtin=>builtin.id===scheme.id);s.activeThemeId=scheme.id;s.schemeName=custom?scheme.name:scheme.name+text(" · 自定义"," · Custom");s.profile=withAppearanceMode(custom?scheme.appearance:{...s.profile,colors:scheme.appearance.colors,palettes:scheme.appearance.palettes,paletteMode:scheme.appearance.paletteMode,mode:scheme.appearance.mode,radius:scheme.appearance.radius},s.theme,window.matchMedia("(prefers-color-scheme: dark)").matches);preview();}}>
          <span class="oc-theme-pair" aria-hidden="true">${(["light","dark"] as const).map(mode=>{const colors=themeVariantColors(scheme.appearance,mode);return html`<span class="oc-theme-card__preview" data-mode=${mode} style=${`background:${colors.background??(mode==="dark"?"#15191f":"#ffffff")};--preview-surface:${colors.surface??(mode==="dark"?"#191e29":"#f7f8fc")};--preview-accent:${colors.accent??"#1a6fd0"};--preview-secondary:${colors.secondary??(mode==="dark"?"#71c6a3":"#218363")};--preview-text:${colors.text??(mode==="dark"?"#e5eaf0":"#323b49")}`}><i></i><span><b></b><b></b><b></b></span></span>`;})}</span><strong dir="auto">${scheme.name}</strong>${scheme.description?html`<small class="oc-theme-card__description">${text(scheme.description,scheme.id==="glacier"?"Airy blue · open and clear":scheme.id==="graphite"?"Soft graphite · quiet focus":scheme.id==="tundra"?"Botanical green · calm space":"Clean blue · light and familiar")}</small>`:""}${scheme.source?html`<small class="oc-theme-card__imported">${scheme.source==="agent"?text("Agent 设计", "Agent design"):text("已导入", "Imported")}</small>${themeVariantModes(scheme.appearance).length<2?html`<small class="oc-theme-card__fallback">${themeVariantModes(scheme.appearance).length===0?text("使用默认深浅配色", "Default light and dark colors"):themeVariantModes(scheme.appearance)[0]==="light"?text("深色使用默认配色", "Dark uses default colors"):text("浅色使用默认配色", "Light uses default colors")}</small>`:""}`:""}</button>
          ${!BUILTIN_THEMES.some(builtin=>builtin.id===scheme.id)?html`<button class="btn btn--sm" @click=${()=>{deleteSavedTheme(scheme.id);if(s.activeThemeId===scheme.id)s.activeThemeId=null;state.requestUpdate();}}>${text("删除主题", "Delete theme")}</button>`:""}</div>`)}</div>
        <details class="oc-theme-agent">
          <summary><span class="oc-theme-agent__icon">${icons.palette}</span><span><strong>${text("让 Agent 设计主题", "Let your agent design a theme")}</strong><small>${text("描述风格 → 对话生成 → 软件中预览", "Describe a style → generate in chat → preview in the app")}</small></span>${icons.chevronDown}</summary>
          <div class="oc-theme-agent__body">
            <p class="oc-settings__hint">${text("由当前对话中的 Agent 使用内置主题技能完成。生成后会出现可撤销预览条，满意后点击“保留主题”。现有对话草稿与附件会保留。", "The agent in your current conversation uses the built-in theme skill. A reversible preview appears in the app; choose Keep theme when satisfied. Existing chat drafts and attachments are preserved.")}</p>
            <label>${text("你希望什么样的界面？", "What should the interface feel like?")}<textarea class="oc-settings__input oc-theme-agent__request" rows="3" maxlength="1200" ?disabled=${s.agentBusy} .value=${s.agentRequest} placeholder=${text("例如：清爽的蓝白配色，少量绿色点缀，保留 MiSans 字体，让深色界面更柔和。", "For example: airy blue and white, subtle green accents, preserve MiSans, and make dark mode feel softer.")} @input=${(event:Event)=>{s.agentRequest=(event.target as HTMLTextAreaElement).value;s.agentError="";state.requestUpdate();}}></textarea></label>
            <div class="oc-theme-agent__presets">${[
              {name:text("清爽蓝绿", "Airy blue & green"),request:text("清爽蓝白配色，少量叶绿色点缀，通透面板与清晰层次，深色版本柔和耐看。", "Airy blue and white with subtle leafy green accents, clear surface hierarchy, and a soft readable dark variant."),mode:"current"},
              {name:text("温润石墨", "Soft graphite"),request:text("克制的暖灰石墨配色，低彩度蓝色强调，细腻的面板层次，适合长时间专注工作。", "Restrained warm graphite, muted blue accents and gentle surface hierarchy for focused work."),mode:"current"},
              {name:text("柔和深色", "Soft dark"),request:text("柔和的深色主题，减少刺眼高光，适量蓝绿点缀，确保正文和次要文字清晰，同时提供协调浅色版本。", "Soft dark mode with gentle highlights, restrained blue-green accents, readable text and a coordinated light variant."),mode:"dark"},
            ].map(preset=>html`<button class="btn btn--sm" type="button" ?disabled=${s.agentBusy} @click=${()=>{s.agentRequest=preset.request;s.agentMode=preset.mode as typeof s.agentMode;s.agentError="";state.requestUpdate();}}>${preset.name}</button>`)}</div>
            <label class="oc-theme-agent__mode"><span>${text("预览方式", "Preview mode")}</span><select class="oc-settings__select" .value=${s.agentMode} ?disabled=${s.agentBusy} @change=${(event:Event)=>{s.agentMode=(event.target as HTMLSelectElement).value as typeof s.agentMode;state.requestUpdate();}}><option value="current">${text("沿用当前外观", "Keep current appearance mode")}</option>${(["light","dark","system"] as const).map(mode=>html`<option value=${mode}>${t(`theme.${mode}`)}</option>`)}</select></label>
            <oc-toggle-switch .checked=${s.agentPreserveLayout} .disabled=${s.agentBusy} .label=${text("保留现有字体与布局", "Preserve existing typography and layout")} @change=${(event:CustomEvent)=>{s.agentPreserveLayout=!!event.detail.checked;state.requestUpdate();}}></oc-toggle-switch>
            ${!state.connected?html`<p class="oc-settings__hint" role="status">${text("连接网关后即可生成主题。", "Connect to the gateway to generate a theme.")}</p>`:state.chatSending || state.chatRunId?html`<p class="oc-settings__hint">${text("当前对话正在执行任务，主题设计请求会加入队列。", "Your current conversation is busy; the theme request will be queued.")}</p>`:""}
            ${s.agentError?html`<p class="oc-text-danger" role="alert">${s.agentError}</p>`:""}
            <div class="btn-row"><button class="btn primary oc-theme-agent__generate" type="button" aria-busy=${s.agentBusy} ?disabled=${s.agentBusy || !state.connected || !state.client || !s.agentRequest.trim()} @click=${()=>void generateTheme(state)}>${s.agentBusy?s.agentProgress||text("正在准备…", "Preparing…"):s.agentError?text("重试并生成", "Retry and generate"):text("让 Agent 生成并预览", "Generate and preview with agent")}</button></div>
          </div>
        </details>
        <details class="oc-theme-customize"><summary>${text("微调当前主题", "Customize this theme")} · ${s.theme==="system"?t(window.matchMedia("(prefers-color-scheme: dark)").matches?"theme.dark":"theme.light")+" · "+t("theme.system"):t(`theme.${s.theme}`)}</summary>
        <button class="btn" @click=${()=>startThemeEditor(state,s.profile,text("可视化主题编辑", "Visual theme editor"),false)}>${text("在软件中点选并调整元素", "Pick and adjust elements in the app")}</button>
        <div class="oc-appearance-colors">${([{key:"accent",token:"--accent",name:text("强调色", "Accent")},{key:"secondary",token:"--accent-2",name:text("辅助色", "Secondary")},{key:"background",token:"--bg",name:text("背景", "Background")},{key:"surface",token:"--bg-secondary",name:text("面板", "Surface")},{key:"text",token:"--text",name:text("正文", "Text")},{key:"muted",token:"--text-muted",name:text("次要文字", "Muted text")}] as const).map(control=>html`<label>${control.name}<input type="color" .value=${s.profile.colors[control.key]??getComputedStyle(document.documentElement).getPropertyValue(control.token).trim()} @input=${(event:Event)=>{s.profile.colors[control.key]=(event.target as HTMLInputElement).value;if(s.profile.palettes && s.profile.paletteMode)s.profile.palettes[s.profile.paletteMode]={...s.profile.colors};preview();}} /></label>`)}</div>
        <oc-range-control .label=${text("圆角", "Corners")} unit="px" .min=${0} .max=${48} .value=${s.profile.radius} @value-change=${(event:CustomEvent)=>{s.profile.radius=event.detail.value;preview(event.detail.frame);}}></oc-range-control>
        <div class="btn-row"><label class="btn">${text("导入主题包", "Import theme")}<input type="file" accept=".json,application/json" hidden @change=${async(event:Event)=>{const input=event.target as HTMLInputElement;try{const file=input.files?.[0];if(!file)return;if(file.size>65536)throw new Error(text("主题包不能超过 64 KiB", "Theme package exceeds 64 KiB"));const imported=importThemeToLibrary(await file.text(),text("导入的主题", "Imported theme"));s.profile=withAppearanceMode(imported.appearance,s.theme,window.matchMedia("(prefers-color-scheme: dark)").matches);s.activeThemeId=imported.id;s.schemeName=imported.name;s.error="";previewImportedTheme(state,s.profile,imported.name);s.successMsg=text("主题已加入主题库，当前正在预览；点击保存后应用。", "Theme added to the library and previewed. Save settings to apply it.");}catch(error){s.successMsg=null;s.error=String(error);state.requestUpdate();}finally{input.value="";}}} /></label>
          <button class="btn" @click=${()=>{const url=URL.createObjectURL(new Blob([exportAppearance(s.profile,s.schemeName||"My theme")],{type:"application/json"}));const link=document.createElement("a");link.href=url;link.download="cryoclaw-theme.json";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}>${text("导出主题包", "Export theme")}</button>
          <button class="btn" @click=${()=>{s.activeThemeId=null;s.profile=withAppearanceMode(undefined,s.theme,window.matchMedia("(prefers-color-scheme: dark)").matches);preview(false,false);}}>${text("重置主题设置", "Reset customization")}</button></div>

        </details>
        <div class="oc-theme-save"><label>${text("主题名称", "Theme name")}<input class="oc-settings__input" maxlength="80" .value=${s.schemeName} @input=${(event:Event)=>{s.schemeName=(event.target as HTMLInputElement).value;}} placeholder=${text("为你的主题命名", "Name your theme")} /></label><button class="btn" @click=${()=>{try{s.activeThemeId=saveThemeToLibrary(s.schemeName,s.profile).id;s.error="";s.successMsg=text("主题已保存到主题库", "Theme saved to library");}catch(error){s.successMsg=null;s.error=String(error);}state.requestUpdate();}}>${text("保存到主题库", "Save to library")}</button></div>
        ${s.error?html`<p role="alert">${s.error}</p>`:""}
      </section>

      <section class="oc-appearance-editor"><h3>${text("字体与排版", "Typography")}</h3>
        <p class="oc-settings__hint">${text("界面使用 Inter 与 MiSans，代码使用 JetBrains Mono。调整会实时预览；保存后保留，离开前未保存的预览会撤销。", "Inter and MiSans for the interface; JetBrains Mono for code. Changes preview immediately. Save to keep them; leaving discards unsaved previews.")}</p>
        <label class="setting-row"><span>${text("字体方案", "Font family")}</span><select class="oc-settings__select" .value=${s.profile.font} @change=${(event:Event)=>{s.profile.font=(event.target as HTMLSelectElement).value as "studio"|"system";preview();}}><option value="studio">${text("精选字体（离线可用）", "Curated fonts (offline)")}</option><option value="system">${text("系统默认字体", "System default")}</option></select></label>
        ${([{key:"size",name:text("字号", "Font size"),min:12,max:22,fine:.1},{key:"weight",name:text("字重（连续）", "Weight (continuous)"),min:100,max:900,fine:.1},{key:"lineHeight",name:text("行高", "Line height"),min:1.3,max:2,fine:.01}] as const).map(control=>html`<oc-range-control .label=${control.name} .min=${control.min} .max=${control.max} .fineStep=${control.fine} .precision=${control.key==="lineHeight"?3:2} .value=${s.profile[control.key]} @value-change=${(event:CustomEvent)=>{s.profile[control.key]=event.detail.value;preview(event.detail.frame);}}></oc-range-control>`)}
        <oc-toggle-switch .checked=${s.profile.italic} .label=${text("正文斜体", "Italic body text")} @change=${(event:CustomEvent)=>{s.profile.italic=!!event.detail.checked;preview();}}></oc-toggle-switch>
        <div class="oc-appearance-sample"><strong>${text("清晰的界面，专注的工作", "A clear interface for focused work")}</strong><p>${text("你好，CryoClaw。让每一段文字都易读。", "Hello, CryoClaw. Make every line easy to read.")}</p><code>const answer = 42; // code preview</code></div>
        <div class="btn-row"><button class="btn" @click=${()=>{s.profile={...s.profile,font:"system",size:14,weight:400,italic:false,lineHeight:1.55};preview();}}>${text("恢复系统字体与默认排版", "Restore system typography")}</button></div>
      </section>



      <div class="setting-row">
        <div class="setting-row__text">
          <div class="setting-row__label">${t("settings.appearance.showThinking")}</div>
        </div>
        <div class="setting-row__control">
          <oc-toggle-switch .checked=${s.showThinking}
            aria-label=${t("settings.appearance.showThinking")}
            @change=${(e: CustomEvent) => { s.showThinking = e.detail.checked; state.requestUpdate(); }}
          ></oc-toggle-switch>
        </div>
      </div>

      <oc-message-box .message=${s.successMsg ?? ""} .type=${"success"} .visible=${!!s.successMsg}></oc-message-box>

      <div class="btn-row">
        <button class="btn primary" @click=${() => handleSave(state)}>${t("settings.save")}</button>
      </div>
    </div>
  `;
}
