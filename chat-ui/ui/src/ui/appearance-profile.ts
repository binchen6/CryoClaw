export interface AppearanceProfile {
  mode?:"light"|"dark"|"system";
  font:"studio"|"system";size:number;weight:number;italic:boolean;lineHeight:number;
  colors:Partial<Record<"accent"|"secondary"|"background"|"surface"|"text"|"muted"|"userBubble"|"assistantBubble"|"userText"|"assistantText"|"composer"|"input"|"icon"|"border",string>>;
  palettes?:Partial<Record<"light"|"dark",AppearanceProfile["colors"]>>;
  paletteMode?:"light"|"dark";
  radius:number;
  components?:Record<string,ComponentAppearance>;
}
export interface ComponentAppearance {x:number;y:number;radius:number;background?:string;color?:string;width?:number;height?:number;padding?:number;opacity?:number;borderWidth?:number;borderColor?:string;fontSize?:number;fontWeight?:number;zIndex?:number;gap?:number;margin?:number;strokeWidth?:number;iconSize?:number;borderStyle?:"solid"|"dashed"|"none";fontStyle?:"normal"|"italic";textAlign?:"left"|"center"|"right"}
export const COMPONENT_SELECTORS={composer:".chat-compose",navigation:"oc-rail",sessions:"oc-session-panel",toolbar:".chat-compose__toolbar",card:".oc-settings__card",input:".oc-settings__input",button:".btn",workspaceTree:".wk-nav",workspacePreview:".wk-main",heading:".oc-settings__section-title,.cryoclaw-titlebar",badge:".cc-tag",rangeControl:"oc-range-control",control:"button,input,select,textarea",panel:".oc-settings__section,.wk-layout",code:"pre",userBubble:".chat-group.user .chat-bubble",assistantBubble:".chat-group.assistant .chat-bubble",composerField:".chat-compose__field",messageText:".chat-text",icon:"svg.cryo-icon,.chat-compose svg,.oc-rail__item svg"} as const;
export const DEFAULT_APPEARANCE:AppearanceProfile={font:"studio",size:14,weight:400,italic:false,lineHeight:1.55,colors:{},radius:12,components:{}};
const bounded=(value:unknown,fallback:number,min:number,max:number)=>typeof value==="number" && Number.isFinite(value)?Math.min(max,Math.max(min,value)):fallback;
export function normalizeAppearance(raw:unknown):AppearanceProfile {
  const value=raw && typeof raw==="object"?raw as Record<string,unknown>:{};
  const colors:AppearanceProfile["colors"]={};
  const components:Record<string,ComponentAppearance>={};
  if(value.components && typeof value.components==="object")for(const [id,rawComponent] of Object.entries(value.components).slice(0,100)) {
    const match=/^(chat|tasks|workspace|extensions|settings(?:-[a-z-]+)?)\/([a-zA-Z]+)\/(\d{1,2})$/.exec(id);
    if(!match || !Object.hasOwn(COMPONENT_SELECTORS,match[2]) || !rawComponent || typeof rawComponent!=="object")continue;
    const part=rawComponent as Record<string,unknown>;
    components[id]={x:bounded(part.x,0,-600,600),y:bounded(part.y,0,-600,600),radius:bounded(part.radius,12,0,96)};
    for(const [key,min,max] of [["width",24,3200],["height",20,1600],["padding",0,96],["opacity",0,1],["borderWidth",0,12],["fontSize",10,72],["fontWeight",100,900],["zIndex",0,100],["gap",0,96],["margin",0,96],["strokeWidth",0,6],["iconSize",8,96]] as const)if(typeof part[key]==="number" && Number.isFinite(part[key]))components[id][key]=bounded(part[key],min,min,max);
    if(part.borderStyle==="solid" || part.borderStyle==="dashed" || part.borderStyle==="none")components[id].borderStyle=part.borderStyle;
    if(components[id].zIndex!==undefined)components[id].zIndex=Math.round(components[id].zIndex!);
    if(part.fontStyle==="normal" || part.fontStyle==="italic")components[id].fontStyle=part.fontStyle;
    if(part.textAlign==="left" || part.textAlign==="center" || part.textAlign==="right")components[id].textAlign=part.textAlign;
    for(const key of ["background","color","borderColor"] as const)if(typeof part[key]==="string" && /^#[a-f\d]{6}$/i.test(part[key] as string))components[id][key]=part[key] as string;
  }
  for(const key of Object.keys(COLOR_TOKENS) as Array<keyof AppearanceProfile["colors"]>) {
    const color=(value.colors as Record<string,unknown>|undefined)?.[key];
    if(typeof color==="string" && /^#[a-f\d]{6}$/i.test(color))colors[key]=color;
  }
  const palettes:NonNullable<AppearanceProfile["palettes"]>={};
  if(value.palettes && typeof value.palettes==="object")for(const mode of ["light","dark"] as const){
    const candidate=(value.palettes as Record<string,unknown>)[mode];
    if(candidate && typeof candidate==="object"){
      palettes[mode]={};for(const key of Object.keys(COLOR_TOKENS) as Array<keyof AppearanceProfile["colors"]>){const color=(candidate as Record<string,unknown>)[key];if(typeof color==="string" && /^#[a-f\d]{6}$/i.test(color))palettes[mode]![key]=color;}
    }
  }
  const paletteMode=value.paletteMode==="dark" || value.paletteMode!=="light" && value.mode==="dark"?"dark":"light";
  if((!value.colors || typeof value.colors!=="object" || Array.isArray(value.colors)) && palettes[paletteMode])Object.assign(colors,palettes[paletteMode]);
  if(value.mode==="system" && !Object.keys(palettes).length && Object.keys(colors).length)palettes.light={...colors};
  return {font:value.font==="system"?"system":"studio",size:bounded(value.size,14,12,22),weight:bounded(value.weight,400,100,900),
    ...(Object.keys(palettes).length?{palettes,paletteMode}:{}),
    ...(value.mode==="light" || value.mode==="dark" || value.mode==="system"?{mode:value.mode}:{}),
    italic:value.italic===true,lineHeight:bounded(value.lineHeight,1.55,1.3,2),radius:bounded(value.radius,12,0,48),colors,components};
}
export const COLOR_TOKENS={accent:"--accent",secondary:"--accent-2",background:"--bg",surface:"--bg-secondary",text:"--text",muted:"--text-muted",userBubble:"--theme-user-bubble",assistantBubble:"--theme-assistant-bubble",userText:"--theme-user-text",assistantText:"--theme-assistant-text",composer:"--theme-composer",input:"--theme-input",icon:"--theme-icon",border:"--theme-border"} as const;
export function accentForeground(color:string):string {
  const linear=(hex:string)=>{const channels=[1,3,5].map(offset=>parseInt(hex.slice(offset,offset+2),16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;};
  const luminance=linear(color),ink="#081524",dark=linear(ink);
  const lightContrast=1.05/(luminance+.05),darkContrast=(luminance+.05)/(dark+.05);
  return darkContrast>=lightContrast && darkContrast>=4.5?ink:lightContrast>=4.5?"#ffffff":"#000000";
}
export function appearanceColors(profile:AppearanceProfile,dark=false):AppearanceProfile["colors"] {
  const mode=profile.mode==="system"?(dark?"dark":"light"):profile.mode??"light";
  return !profile.palettes || profile.paletteMode===mode?profile.colors:profile.palettes[mode]??{};
}
/** Preserve each variant when switching; a missing counterpart uses system defaults. */
export function withAppearanceMode(raw:unknown,mode:"light"|"dark"|"system",dark=false):AppearanceProfile {
  const profile=normalizeAppearance(raw),previous=profile.paletteMode??(profile.mode==="dark"?"dark":"light");
  const palettes={...profile.palettes,[previous]:{...profile.colors}};
  const target=mode==="system"?(dark?"dark":"light"):mode;
  return {...profile,mode,palettes,paletteMode:target,colors:{...palettes[target]}};
}
const appliedProfiles=new WeakMap<HTMLElement,string>();
export function applyAppearance(raw:unknown,root:HTMLElement=document.documentElement):void {
  const profile=normalizeAppearance(raw);
  const dark=typeof window!=="undefined" && typeof window.matchMedia==="function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const colors=appearanceColors(profile,dark);
  const key=JSON.stringify([profile,profile.mode==="system"?dark:null]);if(appliedProfiles.get(root)===key)return;appliedProfiles.set(root,key);
  if(profile.mode){const mode=profile.mode==="system"?(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):profile.mode;root.dataset.theme=mode;root.style.colorScheme=mode;}
  const body=profile.font==="system"?'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif':'"Cryo Inter", "Cryo MiSans", system-ui, sans-serif';
  root.style.setProperty("--font-body",body);root.style.setProperty("--font-display",body);
  root.style.setProperty("--mono",profile.font==="system"?'ui-monospace, Consolas, monospace':'"Cryo JetBrains Mono", "Cryo MiSans", ui-monospace, Consolas, monospace');
  root.style.setProperty("--appearance-weight",String(profile.weight));root.style.setProperty("--appearance-style",profile.italic?"italic":"normal");
  root.style.setProperty("--appearance-variation",profile.font==="studio"?`"wght" ${profile.weight}`:"normal");
  root.style.setProperty("--appearance-line-height",String(profile.lineHeight));
  for(const [token,size] of Object.entries({"--font-size-body":14,"--font-size-meta":11,"--text-2xs":10,"--text-xs":11,"--text-sm":12.5,"--text-base":14,"--text-lg":18,"--heading-xs":13,"--heading-sm":15,"--heading-md":18,"--heading-lg":24,"--heading-xl":32}))root.style.setProperty(token,`${size*profile.size/14}px`);
  for(const [key,token] of Object.entries(COLOR_TOKENS)) {
    const color=colors[key as keyof typeof COLOR_TOKENS];
    if(color)root.style.setProperty(token,color);else root.style.removeProperty(token);
  }
  for(const [token,amount] of [["--accent-subtle",8],["--accent-glow",16]] as const)colors.accent?root.style.setProperty(token,`color-mix(in srgb, ${colors.accent} ${amount}%, transparent)`):root.style.removeProperty(token);
  if(colors.accent)root.style.setProperty("--accent-hover",`color-mix(in srgb, ${colors.accent} 88%, black)`);else root.style.removeProperty("--accent-hover");
  // Derive the rest of the interface from the selected palette, including popovers
  // and borders; otherwise a forest theme would still have slate-blue dialogs.
  const surface=colors.surface??colors.background;
  const derived:Record<string,string|undefined>={
    "--text-on-accent":colors.accent?accentForeground(colors.accent):undefined,
    "--accent-2-subtle":colors.secondary?`color-mix(in srgb, ${colors.secondary} 12%, transparent)`:undefined,
    "--accent-2-muted":colors.secondary?`color-mix(in srgb, ${colors.secondary} 75%, transparent)`:undefined,
    "--bg-content":colors.background,"--bg-accent":surface,"--bg-muted":surface,
    "--bg-elevated":surface && colors.background?`color-mix(in srgb, ${surface} 70%, ${colors.background})`:surface,
    "--bg-input":surface && colors.background?`color-mix(in srgb, ${surface} 55%, ${colors.background})`:surface,
    "--bg-hover":surface && colors.text?`color-mix(in srgb, ${surface} 92%, ${colors.text})`:undefined,
    "--text-strong":colors.text,"--text-secondary":colors.muted,
    "--text-faint":colors.muted && colors.background?`color-mix(in srgb, ${colors.muted} 65%, ${colors.background})`:undefined,
    "--border":surface && colors.text?`color-mix(in srgb, ${surface} 85%, ${colors.text})`:undefined,
    "--border-strong":surface && colors.text?`color-mix(in srgb, ${surface} 72%, ${colors.text})`:undefined,
    "--chrome":colors.background?`color-mix(in srgb, ${colors.background} 94%, transparent)`:undefined,
  };
  for(const [token,value] of Object.entries(derived))value?root.style.setProperty(token,value):root.style.removeProperty(token);
  for(const size of [4,6,8,10,12,16,20,24,32])root.style.setProperty(`--radius-${size}`,`${Math.round(size*profile.radius/12)}px`);
  applyComponentAppearance(profile,root);
}

const componentBindings=new WeakMap<HTMLElement,{profile:AppearanceProfile;observer:MutationObserver;touched:Map<HTMLElement,Record<string,string>>;frame:number|null}>();
export function getAppliedAppearance(root:HTMLElement=document.documentElement):AppearanceProfile {
  return normalizeAppearance(componentBindings.get(root)?.profile);
}
export function themeElementId(element:HTMLElement):string|null {return element.dataset.themeNode??null;}
function applyComponentAppearance(profile:AppearanceProfile,root:HTMLElement):void {
  let binding=componentBindings.get(root);
  if(!binding) {
    binding={profile,frame:null,observer:new MutationObserver(records=>{
      const current=componentBindings.get(root);if(!current || current.frame!==null)return;
      const structural=records.some(record=>Array.from(record.addedNodes).concat(Array.from(record.removedNodes)).some(node=>node.nodeType===1) && !((record.target instanceof Element?record.target:record.target.parentElement)?.closest(".theme-editor,.theme-preview-banner,oc-range-control")));
      if(structural)current.frame=requestAnimationFrame(()=>{current.frame=null;update();});
    }),touched:new Map()};componentBindings.set(root,binding);
    const shell=root.querySelector("openclaw-app");if(shell)binding.observer.observe(shell,{childList:true,subtree:true});
  }
  binding.profile=profile;
  function update(){
    const current=componentBindings.get(root);if(!current)return;
    for(const [element,original] of current.touched)if(!element.isConnected){current.touched.delete(element);}else for(const [property,value] of Object.entries(original))value?element.style.setProperty(property,value):element.style.removeProperty(property);
    current.touched.clear();
    const app=root.querySelector("openclaw-app") as any;
    let view=app?.settings?.cryoclawView??"chat";
    if(view==="settings")view+=`-${root.querySelector<HTMLElement>("[data-settings-tab]")?.dataset.settingsTab??"appearance"}`;
    const assigned=new Set<HTMLElement>();
    for(const [kind,selector] of Object.entries(COMPONENT_SELECTORS))Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(element=>!element.closest(".theme-editor,.theme-preview-banner") && (kind==="rangeControl" || !element.closest("oc-range-control"))).slice(0,100).forEach((element,index)=>{
      if(assigned.has(element))return;assigned.add(element);
      const id=`${view}/${kind}/${index}`;element.dataset.themeNode=id;
      const part=current.profile.components?.[id];if(!part)return;
      const properties:Record<string,string>={translate:`${part.x}px ${part.y}px`,"border-radius":`${part.radius}px`,...(part.background?{"background-color":part.background}:{}),...(part.color?{color:part.color}:{})};
      for(const [key,css,unit] of [["width","width","px"],["height","height","px"],["padding","padding","px"],["opacity","opacity",""],["borderWidth","border-width","px"],["fontSize","font-size","px"],["fontWeight","font-weight",""],["zIndex","z-index",""]] as const)if(part[key]!==undefined)properties[css]=`${part[key]}${unit}`;
      if(part.zIndex!==undefined)properties.position="relative";
      if(part.fontStyle)properties["font-style"]=part.fontStyle;if(part.textAlign)properties["text-align"]=part.textAlign;
      if(part.fontWeight!==undefined)properties["font-variation-settings"]=`"wght" ${part.fontWeight}`;
      if(part.borderColor)properties["border-color"]=part.borderColor;
      if(part.borderWidth)properties["border-style"]="solid";
      if(part.borderStyle)properties["border-style"]=part.borderStyle;
      if(part.gap!==undefined)properties.gap=`${part.gap}px`;
      if(part.margin!==undefined)properties.margin=`${part.margin}px`;
      if(part.strokeWidth!==undefined)properties["stroke-width"]=String(part.strokeWidth);
      if(part.iconSize!==undefined){properties.width=`${part.iconSize}px`;properties.height=`${part.iconSize}px`;}
      const original:Record<string,string>={};for(const [property,value] of Object.entries(properties)){original[property]=element.style.getPropertyValue(property);element.style.setProperty(property,value);}current.touched.set(element,original);
    });
  }
  update();
}
export function exportAppearance(profile:unknown,name="My theme"):string {
  return JSON.stringify({format:"cryoclaw-theme",version:1,name:cleanThemeName(name),appearance:normalizeAppearance(profile)},null,2);
}
export function importAppearance(text:string):AppearanceProfile {
  return readAppearancePackage(text).appearance;
}
export function cleanThemeName(name:string):string {return Array.from(name.replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim()).slice(0,80).join("");}
export function readAppearancePackage(text:string):{name:string;appearance:AppearanceProfile} {
  if(new TextEncoder().encode(text).length>65536)throw new Error("主题包不能超过 64 KiB / Theme package exceeds 64 KiB");
  let data;try{data=JSON.parse(text.replace(/^\uFEFF/,""));}catch{throw new Error("主题包不是有效的 JSON，请重新导出 / Invalid JSON theme package");}
  if(data?.format!=="cryoclaw-theme" || data.version!==1 || !data.appearance || typeof data.appearance!=="object" || Array.isArray(data.appearance))throw new Error("无效或不支持的主题包 / Invalid or unsupported theme package");
  return {name:typeof data.name==="string"?cleanThemeName(data.name):"",appearance:normalizeAppearance(data.appearance)};
}
