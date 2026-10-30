/**
 * Settings: Appearance Tab — theme and show thinking toggle.
 * Directly writes to Chat UI state (no IPC for appearance).
 */
import { html } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { t } from "../../i18n.ts";
import {getLocale} from "../../i18n.ts";
import {icons} from "../../icons.ts";
import {buildThemeDesignPrompt,cleanThemeFields,EMPTY_THEME_FIELDS,prepareThemeDesignSkill,themeFieldsError,type ThemeDesignFields} from "../../theme-agent.ts";
import {setCryoClawView} from "../../app-view-switch.ts";
import {transitionView} from "../../utils/view-transition.ts";
import {showToast} from "../../app-toast.ts";
import {normalizeAppearance,applyAppearance,exportAppearance,themeFileName,getAppliedAppearance,withAppearanceMode} from "../../appearance-profile.ts";
import {startThemeEditor,hasThemePreview,updateActiveThemePreview,previewImportedTheme,endThemePreview} from "../../theme-live.ts";
import {showConfirm} from "../confirm-dialog.ts";
import {BUILTIN_THEMES,readThemeLibrary,saveThemeToLibrary,deleteSavedTheme,importThemeToLibrary,themeVariantColors,themeVariantModes} from "../../theme-library.ts";
import "../../components/range-control.ts";
import {scheduleAppearancePreview,cancelAppearancePreview} from "../../appearance-preview-scheduler.ts";
import "../../components/toggle-switch.ts";
import "../../components/message-box.ts";
import type {ChatAttachment} from "../../ui-types.ts";
import {appearanceContrastIssues} from "../../appearance-contrast.ts";

const MAX_THEME_PACKAGE_BYTES=65536;
const MAX_THEME_REFERENCES=4;
const MAX_THEME_REFERENCE_BYTES=4*1024*1024;
const tr=(cn:string,en:string)=>getLocale().startsWith("zh")?cn:en;

type ThemeReferenceImage={id:string;dataUrl:string;mimeType:string;name?:string};
type ThemePreset={nameCn:string;nameEn:string;mode?:"dark";fields:ThemeDesignFields};
/** One-click presets only fill the template; the user can still edit every field before generating. */
const THEME_PRESETS:ThemePreset[]=[
  {nameCn:"清爽蓝绿",nameEn:"Airy blue & green",fields:{style:"清爽蓝白配色，少量叶绿色点缀，通透面板与清晰层次，深色版本柔和耐看。",primary:"#1a6fd0",secondary:"#33745c",appearance:"浅色为主，深色协调",corners:"适中圆角",typography:"保留现有字体与字号，正文清晰，标题稍紧凑",keep:"保留现有字体与布局、关键按钮和输入框可见",avoid:"高饱和撞色、大面积渐变与刺眼高光",extra:"两个版本都要保持 4.5:1 以上的正文对比度"}},
  {nameCn:"温润石墨",nameEn:"Soft graphite",fields:{style:"克制的暖灰石墨配色，低彩度蓝色强调，细腻的面板层次，适合长时间专注工作。",primary:"#526b90",secondary:"#577c6b",appearance:"跟随系统，两版同等重要",corners:"直角或很小的圆角",typography:"保留现有字体，正文行高宽松易读",keep:"保留现有字体与布局、弹层和恢复入口",avoid:"高明度纯白大面积铺底与荧光色",extra:"面板与背景要有清晰但克制的层次"}},
  {nameCn:"柔和深色",nameEn:"Soft dark",mode:"dark",fields:{style:"柔和的深色主题，减少刺眼高光，适量蓝绿点缀，确保正文和次要文字清晰，同时提供协调浅色版本。",primary:"#8fc9ff",secondary:"#82cbb6",appearance:"深色为主，浅色协调",corners:"适中圆角",typography:"保留现有字体，正文与次要文字对比清晰",keep:"保留现有字体与布局，控件焦点可见",avoid:"纯黑背景、过深的阴影与高饱和霓虹色",extra:"深色下阴影和边框不要压过内容"}},
];

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
    themeDescription:"",
    activeThemeId:null as string|null,
    agentFields:{...EMPTY_THEME_FIELDS} as ThemeDesignFields,
    agentMode:"current" as "current"|"light"|"dark"|"system",
    agentPreserveLayout:true,
    agentBusy:false,
    agentProgress:"",
    agentError:"",
    agentImages:[] as ThemeReferenceImage[],
    agentImageDrag:false,
    themeDropActive:false,
    previewPending:false,
    hadThemePreview:false,
  };
}

const s = createAppearanceState();
const agentDrafts=new WeakMap<AppViewState,{fields:ThemeDesignFields;mode:typeof s.agentMode;preserveLayout:boolean;images:ThemeReferenceImage[]}>();

// 离开 Settings 时把 Appearance 页恢复到未初始化状态。
function resetAppearanceState() {
  if(s.owner)agentDrafts.set(s.owner,{fields:{...s.agentFields},mode:s.agentMode,preserveLayout:s.agentPreserveLayout,images:[...s.agentImages]});
  if(s.owner)cancelAppearancePreview(s.owner);
  if(s.owner && !hasThemePreview(s.owner))applyAppearance({...normalizeAppearance(s.owner.settings.appearance),mode:s.owner.settings.theme});
  Object.assign(s, createAppearanceState());
}

function init(state: AppViewState) {
  if (s.initialized) return;
  s.initialized = true;
  s.owner=state;s.profile=normalizeAppearance({...state.settings.appearance,mode:state.settings.theme});
  const draft=agentDrafts.get(state);
  if(draft){s.agentFields={...draft.fields};s.agentMode=draft.mode;s.agentPreserveLayout=draft.preserveLayout;s.agentImages=[...draft.images];}
  s.committed=state.settings.appearance;
  s.theme = (state.settings?.theme as any) ?? "light";
  s.showThinking = state.settings?.chatShowThinking ?? false;
}

function handleSave(state: AppViewState) {
  cancelAppearancePreview(state);
  if(hasThemePreview(state)){
    updateActiveThemePreview(state,s.profile,false);
    endThemePreview(state,true);
  }
  state.applySettings({
    ...state.settings,
    theme: s.theme,
    chatShowThinking: s.showThinking,
    appearance:normalizeAppearance(s.profile),
  });
  s.successMsg = t("settings.saved");
  state.requestUpdate();
}

export function resetAppearanceTab() { resetAppearanceState(); }

function readImageFile(file:File):Promise<string> {
  return new Promise((resolve,reject)=>{
    const readFailed=()=>new Error(t("settings.appearance.themeAgent.referenceReadFailed"));
    const reader=new FileReader();
    reader.onerror=()=>reject(readFailed());
    reader.onload=()=>typeof reader.result==="string"?resolve(reader.result):reject(readFailed());
    reader.readAsDataURL(file);
  });
}

async function addThemeReferences(state:AppViewState,files:File[]) {
  if(s.agentBusy)return;
  for(const file of files){
    if(s.agentImages.length>=MAX_THEME_REFERENCES){s.agentError=t("settings.appearance.themeAgent.referenceLimit").replace("{count}",String(MAX_THEME_REFERENCES));break;}
    if(!file.type.startsWith("image/")){s.agentError=t("settings.appearance.themeAgent.referenceType");continue;}
    if(file.size>MAX_THEME_REFERENCE_BYTES){s.agentError=t("settings.appearance.themeAgent.referenceSize");continue;}
    try{const dataUrl=await readImageFile(file);s.agentImages=[...s.agentImages,{id:crypto.randomUUID(),dataUrl,mimeType:file.type||"image/png",name:file.name.slice(0,80)}];s.agentError="";}
    catch(error){s.agentError=error instanceof Error?error.message:String(error);}
  }
  state.requestUpdate();
}

async function importThemeFile(state:AppViewState,file:File) {
  try{
    if(!/\.json$/i.test(file.name) && file.type!=="application/json")throw new Error(tr("请选择 .json 主题包。","Choose a .json theme package."));
    if(file.size>MAX_THEME_PACKAGE_BYTES)throw new Error(tr("主题包不能超过 64 KiB；当前主题未改变。","Theme package exceeds 64 KiB; the current theme is unchanged."));
    const imported=importThemeToLibrary(await file.text(),tr("导入的主题","Imported theme"));
    s.profile=withAppearanceMode(imported.appearance,s.theme,window.matchMedia("(prefers-color-scheme: dark)").matches);
    s.activeThemeId=imported.id;s.schemeName=imported.name;s.themeDescription=imported.description??"";
    s.error="";s.successMsg=tr("主题已加入主题库，当前正在预览；点击保存后应用。","Theme added to the library and previewed. Save settings to apply it.");
    previewImportedTheme(state,s.profile,imported.name,imported.description??"");
    showToast(state,tr(`已导入「${imported.name}」并开始预览。`,`Imported “${imported.name}” and started the preview.`),undefined,"success");
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    s.successMsg=null;s.error=message;
    showToast(state,message,undefined,"error");
  }
  state.requestUpdate();
}

function exportCurrentTheme(state:AppViewState) {
  try{
    const name=s.schemeName||tr("我的主题","My theme");
    const url=URL.createObjectURL(new Blob([exportAppearance(s.profile,name,s.themeDescription)],{type:"application/json"}));
    const link=document.createElement("a");link.href=url;link.download=themeFileName(name);link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    showToast(state,tr("已导出主题包。","Theme package exported."),undefined,"success");
  }catch{
    showToast(state,tr("导出主题包失败，请重试。","Exporting the theme package failed; try again."),undefined,"error");
  }
}

async function generateTheme(state:AppViewState){
  if(s.agentBusy || !state.client || !state.connected)return;
  const fields=cleanThemeFields(s.agentFields);
  if(themeFieldsError(fields,getLocale()))return;
  const client=state.client,sessionKey=state.sessionKey;
  const attachments:ChatAttachment[]=s.agentImages.map(image=>({id:image.id,dataUrl:image.dataUrl,mimeType:image.mimeType,name:image.name}));
  let prompt:string;
  try{prompt=buildThemeDesignPrompt({...fields,mode:s.agentMode==="current"?s.theme:s.agentMode,preserveLayout:s.agentPreserveLayout,locale:getLocale(),referenceImages:attachments.length},s.profile);}
  catch(error){s.agentError=error instanceof Error?error.message:String(error);state.requestUpdate();return;}
  s.agentBusy=true;s.agentError="";state.requestUpdate();
  try{
    const recovery=await prepareThemeDesignSkill(client,{canContinue:()=>state.client===client && state.connected && state.sessionKey===sessionKey && s.owner===state && !!document.querySelector('[data-settings-tab="appearance"]'),onProgress:progress=>{s.agentProgress=getLocale().startsWith("zh")?progress.phase==="enabling"?"正在恢复主题技能…":progress.phase==="retrying"?`正在自动恢复（${progress.attempt}/3）…`:"正在检查主题技能…":progress.phase==="enabling"?"Enabling theme skill…":progress.phase==="retrying"?`Recovering (${progress.attempt}/3)…`:"Checking theme skill…";state.requestUpdate();}});
    if(state.client!==client || !state.connected || state.sessionKey!==sessionKey)throw new Error(getLocale().startsWith("zh")?"对话或连接已变化，请重新点击生成。":"The conversation or connection changed. Try again.");
    if(s.owner!==state || !document.querySelector('[data-settings-tab="appearance"]'))return;
    if(recovery.recovered)showToast(state,getLocale().startsWith("zh")?"主题技能已自动恢复":"Theme skill recovered automatically");
    if(hasThemePreview(state))endThemePreview(state,false,false);
    transitionView(()=>setCryoClawView(state,"chat"));
    // messageOverride keeps the existing chat draft and attachments; reference images ride along only when present.
    await state.handleSendChat(prompt,attachments.length?{attachments}:{});
  }catch(error){const message=error instanceof Error?error.message:String(error);if(s.owner===state)s.agentError=message;else showToast(state,message,undefined,"error");}
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
  const themeKey=(profile:typeof s.profile)=>JSON.stringify([themeVariantColors(profile,"light"),themeVariantColors(profile,"dark"),profile.radius,profile.density??1,profile.shadow??"default",profile.borderWidth??1]);
  const selectedThemeId=themes.find(theme=>theme.id===s.activeThemeId && themeKey(theme.appearance)===themeKey(s.profile))?.id??themes.find(theme=>themeKey(theme.appearance)===themeKey(s.profile))?.id;
  const maxReferences=MAX_THEME_REFERENCES;
  const contrastIssues=appearanceContrastIssues(s.profile);

  const preview=(inFrame=false,preserveComponents=true)=>{s.successMsg=null;s.previewPending=true;const apply=()=>{if(!updateActiveThemePreview(state,s.profile,preserveComponents))applyAppearance(s.profile);s.previewPending=false;state.requestUpdate();};if(inFrame){cancelAppearancePreview(state);apply();}else scheduleAppearancePreview(state,apply);};
  const briefFields=cleanThemeFields(s.agentFields);
  const briefError=themeFieldsError(briefFields,getLocale());
  const briefStarted=Object.values(briefFields).some(value=>!!value);
  const applyPreset=(preset:ThemePreset)=>{s.agentFields={...EMPTY_THEME_FIELDS,...preset.fields};if(preset.mode)s.agentMode=preset.mode;s.agentError="";state.requestUpdate();};

  return html`
    <div class="oc-settings__section" data-page-id="settings:appearance" data-load-state=${"ready"} aria-busy=${false}>
      <h2 class="oc-settings__section-title">${t("settings.appearance.title")}</h2>
      <p class="oc-settings__page-desc">${t("settings.appearance.desc")}</p>
      ${contrastIssues.length?html`<p class="oc-theme-contrast" role="status">${text("文字对比度偏低，建议达到 4.5:1：","Text contrast is low; aim for 4.5:1:")} ${contrastIssues.map(issue=>`${issue.mode} · ${issue.role} ${issue.ratio.toFixed(2)}:1`).join(" · ")}</p>`:""}

      <section class="oc-appearance-editor oc-theme-module ${s.themeDropActive?"oc-theme-module--drop":""}" @dragover=${(event:DragEvent)=>{const transfer=event.dataTransfer;if(!transfer || !Array.from(transfer.types??[]).includes("Files"))return;event.preventDefault();transfer.dropEffect="copy";if(!s.themeDropActive){s.themeDropActive=true;state.requestUpdate();}}} @dragleave=${(event:DragEvent)=>{const current=event.currentTarget as HTMLElement;if(event.relatedTarget instanceof Node && current.contains(event.relatedTarget))return;s.themeDropActive=false;state.requestUpdate();}} @drop=${(event:DragEvent)=>{event.preventDefault();s.themeDropActive=false;const files=Array.from(event.dataTransfer?.files??[]);/* 纯图片落到参考图区以外（或参考图区漏拦冒泡上来）时静默忽略，不弹「请选择 .json 主题包」错误 */if(files.length&&files.every(file=>file.type.startsWith("image/"))){state.requestUpdate();return;}const file=files[0];if(file)void importThemeFile(state,file);state.requestUpdate();}}><h3>${text("主题", "Theme")}</h3>
        ${s.themeDropActive?html`<div class="oc-theme-drop-hint" role="status">${text("松手导入 .json 主题包", "Drop to import a .json theme package")}</div>`:""}
        <p class="oc-settings__hint">${text("每套主题包含浅色与深色外观。选好主题后，可跟随系统自动切换，也可分别微调两种外观。旧主题缺少的外观使用默认配色。可把 .json 主题包直接拖到本模块导入。", "Each theme pairs light and dark appearances. Follow your system or customize each appearance separately. Missing variants use default colors. Drop a .json theme package anywhere in this module to import it.")}</p>
        <div class="oc-theme-modes" role="group" aria-label=${text("外观模式", "Appearance mode")}>
          ${(["light","dark","system"] as const).map(mode=>html`<button class="btn" data-mode=${mode} aria-pressed=${s.theme===mode} @click=${()=>{s.theme=mode;s.profile=withAppearanceMode(s.profile,mode,window.matchMedia("(prefers-color-scheme: dark)").matches);preview();}}>${t(`theme.${mode}`)}</button>`)}
        </div>
        <div class="oc-theme-grid oc-theme-grid--library">
        ${themes.map(scheme=>html`<div class="oc-theme-library-item"><button type="button" class="oc-theme-card" title=${scheme.name} aria-pressed=${selectedThemeId===scheme.id} @click=${()=>{const custom=!BUILTIN_THEMES.some(builtin=>builtin.id===scheme.id);s.activeThemeId=scheme.id;s.schemeName=custom?scheme.name:scheme.name+text(" · 自定义"," · Custom");s.themeDescription=scheme.description??"";s.profile=withAppearanceMode(custom?scheme.appearance:{...s.profile,colors:scheme.appearance.colors,palettes:scheme.appearance.palettes,paletteMode:scheme.appearance.paletteMode,mode:scheme.appearance.mode,radius:scheme.appearance.radius,density:scheme.appearance.density,shadow:scheme.appearance.shadow,borderWidth:scheme.appearance.borderWidth},s.theme,window.matchMedia("(prefers-color-scheme: dark)").matches);preview();}}>
          <span class="oc-theme-pair" aria-hidden="true">${(["light","dark"] as const).map(mode=>{const colors=themeVariantColors(scheme.appearance,mode);return html`<span class="oc-theme-card__preview" data-mode=${mode} style=${`background:${colors.background??(mode==="dark"?"#15191f":"#ffffff")};--preview-surface:${colors.surface??(mode==="dark"?"#191e29":"#f7f8fc")};--preview-accent:${colors.accent??"#1a6fd0"};--preview-secondary:${colors.secondary??(mode==="dark"?"#71c6a3":"#218363")};--preview-text:${colors.text??(mode==="dark"?"#e5eaf0":"#323b49")}`}><i></i><span><b></b><b></b><b></b></span></span>`;})}</span><strong dir="auto">${scheme.name}</strong>${scheme.description?html`<small class="oc-theme-card__description">${scheme.id==="glacier"||scheme.id==="graphite"||scheme.id==="tundra"?text(scheme.description,scheme.id==="glacier"?"Airy blue · open and clear":scheme.id==="graphite"?"Soft graphite · quiet focus":"Botanical green · calm space"):scheme.description}</small>`:""}${scheme.source?html`<small class="oc-theme-card__imported">${scheme.source==="agent"?text("Agent 设计", "Agent design"):text("已导入", "Imported")}</small>${themeVariantModes(scheme.appearance).length<2?html`<small class="oc-theme-card__fallback">${themeVariantModes(scheme.appearance).length===0?text("使用默认深浅配色", "Default light and dark colors"):themeVariantModes(scheme.appearance)[0]==="light"?text("深色使用默认配色", "Dark uses default colors"):text("浅色使用默认配色", "Light uses default colors")}</small>`:""}`:""}</button>
          ${!BUILTIN_THEMES.some(builtin=>builtin.id===scheme.id)?html`<button class="btn btn--sm" @click=${async()=>{if(!(await showConfirm(state,t("settings.appearance.deleteThemeConfirm").replace("{name}",scheme.name),{danger:true})))return;deleteSavedTheme(scheme.id);if(s.activeThemeId===scheme.id)s.activeThemeId=null;showToast(state,t("settings.appearance.themeDeleted").replace("{name}",scheme.name),undefined,"success");state.requestUpdate();}}>${t("settings.appearance.deleteTheme")}</button>`:""}</div>`)}</div>
        <details class="oc-theme-agent">
          <summary><span class="oc-theme-agent__icon">${icons.palette}</span><span><strong>${text("让 Agent 设计主题", "Let your agent design a theme")}</strong><small>${text("描述你想要的感觉，生成可撤销的实时预览", "Describe the feeling. Try a reversible live preview.")}</small></span>${icons.chevronDown}</summary>
          <div class="oc-theme-agent__body">
            <div class="oc-theme-agent__intro"><div><h3>${text("让每天使用的界面，更合你意", "Make your everyday workspace feel right")}</h3><p>${text("用自己的话描述，或从一个方向开始。当前对话的 Agent 会设计浅色与深色两版；现有对话草稿与附件会保留。", "Describe it in your own words or choose a starting point. Your current agent creates light and dark variants while preserving your chat draft and attachments.")}</p></div><span class="oc-tag oc-tag--muted">${text("可撤销预览", "Reversible preview")}</span></div>
            <div class="oc-theme-agent__workspace">
              <section class="oc-theme-agent__canvas"><div class="oc-theme-brief oc-theme-brief--main"><label class="oc-theme-brief__wide"><span class="oc-theme-field__label"><span>${text("风格意象", "Visual direction")}</span><i class="oc-theme-field__required" aria-hidden="true">*</i></span><textarea data-theme-field="style" class="oc-settings__input oc-theme-brief__textarea" rows="4" maxlength="300" aria-required="true" ?disabled=${s.agentBusy} .value=${s.agentFields.style} placeholder=${text("例如：清爽蓝白，少量叶绿点缀，通透面板与清晰层次。", "For example: airy blue and white, subtle leafy green, clear surface hierarchy.")} @input=${(event:Event)=>{s.agentFields.style=(event.target as HTMLTextAreaElement).value;state.requestUpdate();}}></textarea></label></div>
                            <div class="oc-theme-agent__presets">${THEME_PRESETS.map(preset=>html`<button class="oc-theme-direction" type="button" ?disabled=${s.agentBusy} aria-pressed=${s.agentFields.style===preset.fields.style} @click=${()=>applyPreset(preset)}><span class="oc-theme-direction__swatch" aria-hidden="true" style=${`--brief-primary:${preset.fields.primary};--brief-secondary:${preset.fields.secondary}`}><i></i><i></i><i></i></span><span><strong>${text(preset.nameCn,preset.nameEn)}</strong><small>${text(preset.mode?"深色为主，柔和耐看":preset.nameEn.startsWith("Airy")?"明亮、轻盈、清晰":"低彩度，适合专注",preset.mode?"Soft depth, dark first":preset.nameEn.startsWith("Airy")?"Light, airy and clear":"Quiet tones for focus")}</small></span></button>`)}</div>

                <details class="oc-theme-agent__advanced"><summary>${text("精细设置", "Fine-tune the brief")}<span>${text("配色、排版与保留项 · 可选", "Colors, typography and constraints · optional")}</span>${icons.chevronDown}</summary><p class="oc-settings__hint">${text("留空的项目沿用当前设置。要调整排版，请关闭“保留现有字体与布局”。", "Blank fields keep your current settings. To change typography, turn off Preserve existing typography and layout.")}</p><div class="oc-theme-brief">
              <label>${text("主色", "Primary color")}<input data-theme-field="primary" class="oc-settings__input" maxlength="120" ?disabled=${s.agentBusy} .value=${s.agentFields.primary} placeholder=${text("#1a6fd0 或 雾蓝", "#1a6fd0 or misty blue")} @input=${(event:Event)=>{s.agentFields.primary=(event.target as HTMLInputElement).value;state.requestUpdate();}} /></label>
              <label>${text("辅色", "Secondary color")}<input data-theme-field="secondary" class="oc-settings__input" maxlength="120" ?disabled=${s.agentBusy} .value=${s.agentFields.secondary} placeholder=${text("#33745c 或 叶绿", "#33745c or leaf green")} @input=${(event:Event)=>{s.agentFields.secondary=(event.target as HTMLInputElement).value;state.requestUpdate();}} /></label>
              <label>${text("明暗偏好", "Light/dark preference")}<select data-theme-field="appearance" class="oc-settings__select" ?disabled=${s.agentBusy} .value=${s.agentFields.appearance} @change=${(event:Event)=>{s.agentFields.appearance=(event.target as HTMLSelectElement).value;state.requestUpdate();}}><option value="">${text("未指定", "Not specified")}</option><option value="浅色为主，深色协调">${text("浅色为主", "Mainly light")}</option><option value="深色为主，浅色协调">${text("深色为主", "Mainly dark")}</option><option value="跟随系统，两版同等重要">${text("跟随系统", "Follow system")}</option></select></label>
              <label>${text("圆角倾向", "Corner tendency")}<select data-theme-field="corners" class="oc-settings__select" ?disabled=${s.agentBusy} .value=${s.agentFields.corners} @change=${(event:Event)=>{s.agentFields.corners=(event.target as HTMLSelectElement).value;state.requestUpdate();}}><option value="">${text("未指定", "Not specified")}</option><option value="直角或很小的圆角">${text("直角 / 小圆角", "Square / small")}</option><option value="适中圆角">${text("适中", "Medium")}</option><option value="明显的大圆角">${text("大圆角", "Large")}</option></select></label>
              <label class="oc-theme-brief__wide">${text("排版偏好", "Typography preference")}<input data-theme-field="typography" class="oc-settings__input" maxlength="200" ?disabled=${s.agentBusy || s.agentPreserveLayout} .value=${s.agentFields.typography} placeholder=${text("例如：保留现有字体，正文行高更宽松。", "For example: keep the current fonts, looser body line-height.")} @input=${(event:Event)=>{s.agentFields.typography=(event.target as HTMLInputElement).value;state.requestUpdate();}} /></label>
              <label class="oc-theme-brief__wide">${text("必须保留", "Must keep")}<input data-theme-field="keep" class="oc-settings__input" maxlength="200" ?disabled=${s.agentBusy} .value=${s.agentFields.keep} placeholder=${text("例如：保留现有字体与布局、输入框可见。", "For example: keep the current fonts and layout, visible composer.")} @input=${(event:Event)=>{s.agentFields.keep=(event.target as HTMLInputElement).value;state.requestUpdate();}} /></label>
              <label class="oc-theme-brief__wide">${text("希望避免", "Avoid")}<input data-theme-field="avoid" class="oc-settings__input" maxlength="200" ?disabled=${s.agentBusy} .value=${s.agentFields.avoid} placeholder=${text("例如：避免高饱和撞色与大面积渐变。", "For example: avoid saturated clashes and large gradients.")} @input=${(event:Event)=>{s.agentFields.avoid=(event.target as HTMLInputElement).value;state.requestUpdate();}} /></label>
              <label class="oc-theme-brief__wide">${text("补充要求", "Extra requirements")}<textarea data-theme-field="extra" class="oc-settings__input oc-theme-brief__textarea" rows="2" maxlength="400" ?disabled=${s.agentBusy} .value=${s.agentFields.extra} placeholder=${text("还有其他想强调的细节。", "Anything else to emphasise.")} @input=${(event:Event)=>{s.agentFields.extra=(event.target as HTMLTextAreaElement).value;state.requestUpdate();}}></textarea></label>
            </div></details>
              </section>
              <aside class="oc-theme-agent__guide">
                            <div class="oc-theme-refs-block">
              <span class="oc-theme-refs-label">${text("参考图（可选，最多 4 张，每张 ≤4 MB）", "Reference images (optional, up to 4, ≤4 MB each)")}</span>
              <div class="oc-theme-refs ${s.agentImageDrag?"oc-theme-refs--drop":""}" @dragover=${(event:DragEvent)=>{const transfer=event.dataTransfer;if(!transfer || !Array.from(transfer.types??[]).includes("Files"))return;event.preventDefault();event.stopPropagation();transfer.dropEffect="copy";/* 悬停进参考图区时熄灭外层主题模块高亮，避免两处 drop 提示并存且行为相反 */if(s.themeDropActive){s.themeDropActive=false;state.requestUpdate();}if(!s.agentImageDrag){s.agentImageDrag=true;state.requestUpdate();}}} @dragleave=${(event:DragEvent)=>{const current=event.currentTarget as HTMLElement;if(event.relatedTarget instanceof Node && current.contains(event.relatedTarget))return;s.agentImageDrag=false;state.requestUpdate();}} @drop=${(event:DragEvent)=>{/* 先无条件收尾：阻止冒泡到外层主题模块被当成主题包导入，并复位高亮，再过滤图片 */event.preventDefault();event.stopPropagation();s.agentImageDrag=false;const files=Array.from(event.dataTransfer?.files??[]).filter(file=>file.type.startsWith("image/"));if(!files.length){s.agentError=t("settings.appearance.themeAgent.referenceType");state.requestUpdate();return;}void addThemeReferences(state,files);state.requestUpdate();}}>
                ${s.agentImages.map(image=>html`<span class="oc-theme-ref"><img src=${image.dataUrl} alt=${image.name??text("参考图","Reference image")} title=${image.name??""} /><button class="icon-btn oc-theme-ref__remove" type="button" ?disabled=${s.agentBusy} aria-label=${text("移除参考图","Remove reference image")} title=${text("移除参考图","Remove reference image")} @click=${()=>{s.agentImages=s.agentImages.filter(item=>item.id!==image.id);state.requestUpdate();}}>${icons.x}</button></span>`)}
                ${s.agentImages.length<maxReferences?html`<label class="oc-theme-ref-add" role="button" tabindex=${s.agentBusy?-1:0} aria-disabled=${s.agentBusy} @keydown=${(event:KeyboardEvent)=>{if(!s.agentBusy && (event.key==="Enter" || event.key===" ")){event.preventDefault();(event.currentTarget as HTMLElement).querySelector<HTMLInputElement>("input")?.click();}}} title=${text("点击选择图片，或把图片拖到这里","Choose images or drop them here")}><input type="file" accept="image/*" multiple hidden ?disabled=${s.agentBusy} @change=${(event:Event)=>{const input=event.target as HTMLInputElement;const files=Array.from(input.files??[]);input.value="";if(files.length)void addThemeReferences(state,files);}} />${icons.image}<span>${text("点击或拖入图片","Choose or drop images")}</span></label>`:""}
              </div>
              <p class="oc-settings__hint">${text("参考图只用于提取配色、明暗层次与质感，不复制其中的文字、品牌或布局；随消息发送，不写入主题包。", "Reference images only guide palette, depth and texture — never copied text, branding or layout. They are sent with the message and never stored in the theme package.")}</p>
            </div>
            <label class="oc-theme-agent__mode"><span>${text("预览方式", "Preview mode")}</span><select class="oc-settings__select" .value=${s.agentMode} ?disabled=${s.agentBusy} @change=${(event:Event)=>{s.agentMode=(event.target as HTMLSelectElement).value as typeof s.agentMode;state.requestUpdate();}}><option value="current">${text("沿用当前外观", "Keep current appearance mode")}</option>${(["light","dark","system"] as const).map(mode=>html`<option value=${mode}>${t(`theme.${mode}`)}</option>`)}</select></label>
            <oc-toggle-switch .checked=${s.agentPreserveLayout} .disabled=${s.agentBusy} .label=${text("保留现有字体与布局", "Preserve existing typography and layout")} @change=${(event:CustomEvent)=>{s.agentPreserveLayout=!!event.detail.checked;state.requestUpdate();}}></oc-toggle-switch>

                <ol class="oc-theme-agent__steps"><li><strong>${text("描述与参考", "Brief & references")}</strong><span>${text("文字为主，图片帮助表达配色与质感。", "Words set the direction; images guide palette and texture.")}</span></li><li><strong>${text("交给当前 Agent", "Design in your conversation")}</strong><span>${text("自动检查主题技能，保留当前对话内容。", "Checks the theme skill and keeps your conversation intact.")}</span></li><li><strong>${text("预览后决定", "Preview, then decide")}</strong><span>${text("60 秒后自动恢复，也可点击保留或撤销。", "Restores after 60 seconds. Keep it or revert at any time.")}</span></li></ol>
              </aside>
            </div>
                        ${briefStarted && briefError?html`<p class="oc-settings__hint oc-theme-brief__error" role="status">${briefError}</p>`:""}
            ${!state.connected?html`<p class="oc-settings__hint" role="status">${text("连接网关后即可生成主题。", "Connect to the gateway to generate a theme.")}</p>`:state.chatSending || state.chatRunId?html`<p class="oc-settings__hint">${text("当前对话正在执行任务，主题设计请求会加入队列。", "Your current conversation is busy; the theme request will be queued.")}</p>`:""}
            ${s.agentError?html`<p class="oc-theme-agent__error" role="alert">${s.agentError}</p>`:""}
            <div class="oc-theme-agent__actions"><button class="btn btn--sm" type="button" ?disabled=${s.agentBusy} @click=${()=>{s.agentFields={...EMPTY_THEME_FIELDS};s.agentImages=[];s.agentError="";state.requestUpdate();}}>${text("清空设计要求", "Clear brief")}</button><span class="oc-theme-agent__status" role="status" aria-live="polite">${s.agentBusy?s.agentProgress:text("仅调整外观 · 预览后由你确认", "Appearance only · Review the preview before keeping")}</span><button class="btn primary oc-theme-agent__generate" type="button" aria-busy=${s.agentBusy} ?disabled=${s.agentBusy || !state.connected || !state.client || !!briefError} @click=${()=>void generateTheme(state)}>${s.agentBusy?s.agentProgress||text("正在准备…", "Preparing…"):s.agentError?text("重试并生成", "Retry and generate"):text("让 Agent 生成并预览", "Generate and preview with agent")}</button></div>

          </div>
        </details>
        <details class="oc-theme-customize"><summary>${text("微调当前主题", "Customize this theme")} · ${s.theme==="system"?t(window.matchMedia("(prefers-color-scheme: dark)").matches?"theme.dark":"theme.light")+" · "+t("theme.system"):t(`theme.${s.theme}`)}</summary>
        <button class="btn" @click=${()=>startThemeEditor(state,s.profile,text("可视化主题编辑", "Visual theme editor"),false)}>${text("在软件中点选并调整元素", "Pick and adjust elements in the app")}</button>
        <div class="oc-appearance-colors">${([{key:"accent",token:"--accent",name:text("强调色", "Accent")},{key:"secondary",token:"--accent-2",name:text("辅助色", "Secondary")},{key:"background",token:"--bg",name:text("背景", "Background")},{key:"surface",token:"--bg-secondary",name:text("面板", "Surface")},{key:"text",token:"--text",name:text("正文", "Text")},{key:"muted",token:"--text-muted",name:text("次要文字", "Muted text")}] as const).map(control=>html`<label>${control.name}<input type="color" .value=${s.profile.colors[control.key]??getComputedStyle(document.documentElement).getPropertyValue(control.token).trim()} @input=${(event:Event)=>{s.profile.colors[control.key]=(event.target as HTMLInputElement).value;if(s.profile.palettes && s.profile.paletteMode)s.profile.palettes[s.profile.paletteMode]={...s.profile.colors};preview();}} /></label>`)}</div>
          <details class="oc-theme-component-colors"><summary>${text("对话与控件配色", "Chat and control colors")}</summary><p class="oc-settings__hint">${text("为当前深浅外观分别设置，影响所有会话。单个控件可在实时编辑器中继续微调。", "Set each appearance independently across all sessions. Fine-tune individual controls in the live editor.")}</p><div class="oc-appearance-colors">${([['userBubble','用户气泡','User bubble'],['assistantBubble','助手气泡','Assistant bubble'],['userText','用户文字','User text'],['assistantText','助手文字','Assistant text'],['composer','输入卡片','Composer'],['input','输入框','Input'],['icon','图标','Icons'],['border','控件边框','Control borders']] as const).map(([key,cn,en])=>html`<label>${text(cn,en)}<input type="color" .value=${s.profile.colors[key]??'#ffffff'} @input=${(event:Event)=>{s.profile.colors[key]=(event.target as HTMLInputElement).value;if(s.profile.palettes && s.profile.paletteMode)s.profile.palettes[s.profile.paletteMode]={...s.profile.colors};preview();}}/><button class="btn btn--sm" @click=${()=>{delete s.profile.colors[key];if(s.profile.palettes && s.profile.paletteMode)s.profile.palettes[s.profile.paletteMode]={...s.profile.colors};preview();}}>${text("继承", "Inherit")}</button></label>`)}</div></details>
          <oc-range-control .label=${text("圆角", "Corners")} unit="px" .min=${0} .max=${48} .value=${s.profile.radius} @value-change=${(event:CustomEvent)=>{s.profile.radius=event.detail.value;preview(event.detail.frame);}}></oc-range-control>
          <div class="oc-theme-package">
            <label class="oc-theme-package__description">${text("主题描述（随主题包导出，最多 120 字）", "Theme description (exported with the package, ≤120 characters)")}<input class="oc-settings__input" maxlength="120" .value=${s.themeDescription} placeholder=${text("一句话描述这套主题的气质。", "One line on this theme's character.")} @input=${(event:Event)=>{s.themeDescription=(event.target as HTMLInputElement).value;state.requestUpdate();}} /></label>
            <oc-range-control .label=${text("间距密度", "Spacing density")} .min=${0.9} .max=${1.1} .precision=${2} .fineStep=${.01} .value=${s.profile.density??1} @value-change=${(event:CustomEvent)=>{const value=Number(event.detail.value);if(Math.abs(value-1)<.005)delete s.profile.density;else s.profile.density=Math.round(value*100)/100;preview(event.detail.frame);}}></oc-range-control>
            <label class="oc-theme-package__shadow">${text("阴影强度", "Shadow intensity")}<select class="oc-settings__select" .value=${s.profile.shadow??"default"} @change=${(event:Event)=>{const value=(event.target as HTMLSelectElement).value;if(value==="default")delete s.profile.shadow;else s.profile.shadow=value as typeof s.profile.shadow;preview();}}><option value="none">${text("无阴影", "None")}</option><option value="soft">${text("轻柔", "Soft")}</option><option value="default">${text("默认", "Default")}</option><option value="strong">${text("明显", "Strong")}</option></select></label>
            <oc-range-control .label=${text("边框粗细", "Border width")} unit="px" .min=${0} .max=${2} .precision=${1} .fineStep=${.1} .value=${s.profile.borderWidth??1} @value-change=${(event:CustomEvent)=>{const value=Number(event.detail.value);if(Math.abs(value-1)<.01)delete s.profile.borderWidth;else s.profile.borderWidth=Math.round(value*100)/100;preview(event.detail.frame);}}></oc-range-control>
          </div>
        <div class="btn-row"><label class="btn">${text("导入主题包", "Import theme")}<input type="file" accept=".json,application/json" hidden @change=${async(event:Event)=>{const input=event.target as HTMLInputElement;const file=input.files?.[0];input.value="";if(file)await importThemeFile(state,file);}} /></label>
          <button class="btn" @click=${()=>exportCurrentTheme(state)}>${text("导出主题包", "Export theme")}</button>
          <button class="btn" @click=${()=>{s.activeThemeId=null;s.themeDescription="";s.profile=withAppearanceMode(undefined,s.theme,window.matchMedia("(prefers-color-scheme: dark)").matches);preview(false,false);}}>${text("重置主题设置", "Reset customization")}</button></div>

        </details>
        <div class="oc-theme-save"><label>${text("主题名称", "Theme name")}<input class="oc-settings__input" maxlength="80" .value=${s.schemeName} @input=${(event:Event)=>{s.schemeName=(event.target as HTMLInputElement).value;}} placeholder=${text("为你的主题命名", "Name your theme")} /></label><button class="btn" @click=${()=>{try{s.activeThemeId=saveThemeToLibrary(s.schemeName,s.profile,s.themeDescription).id;s.error="";s.successMsg=text("主题已保存到主题库", "Theme saved to library");}catch(error){s.successMsg=null;s.error=String(error);}state.requestUpdate();}}>${text("保存到主题库", "Save to library")}</button></div>
        <oc-message-box .visible=${!!s.error} .message=${s.error} type="error"></oc-message-box>
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
