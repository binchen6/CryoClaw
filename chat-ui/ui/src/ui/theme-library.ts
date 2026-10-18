import {normalizeAppearance,readAppearancePackage,cleanThemeName,type AppearanceProfile} from "./appearance-profile.ts";
export type SavedTheme={id:string;name:string;description?:string;source?:"imported"|"agent";appearance:AppearanceProfile};
const KEY="cryoclaw.theme-library.v1";
export const MAX_SAVED_THEMES=20;
type ThemeColors=AppearanceProfile["colors"];
function pairedTheme(id:string,name:string,description:string,radius:number,light:ThemeColors,dark:ThemeColors):SavedTheme {
  return {id,name,description,appearance:normalizeAppearance({mode:"light",paletteMode:"light",radius,colors:light,palettes:{light,dark}})};
}
export const BUILTIN_THEMES:SavedTheme[]=[
  {id:"default",name:"默认 · Default",description:"纯白蓝绿 · 清晰而耐看",appearance:normalizeAppearance({mode:"light",paletteMode:"light",colors:{},palettes:{light:{},dark:{}}})},
  pairedTheme("glacier","冰川 · Glacier","通透冰蓝 · 开阔与清晰",14,
    {accent:"#1a6fd0",secondary:"#29836e",background:"#f5f9ff",surface:"#eaf2fc",text:"#263e59",muted:"#60758a"},
    {accent:"#8fc9ff",secondary:"#82cbb6",background:"#101c2b",surface:"#1a2c40",text:"#dceaf8",muted:"#a1b5ce"}),
  pairedTheme("graphite","石墨 · Graphite","柔灰石墨 · 克制与专注",8,
    {accent:"#526b90",secondary:"#577c6b",background:"#f5f4f2",surface:"#ebe9e5",text:"#393b40",muted:"#6a6b70"},
    {accent:"#a9bfdc",secondary:"#a3c1ae",background:"#181a1e",surface:"#24272d",text:"#e8e9ed",muted:"#a8adb8"}),
  pairedTheme("tundra","苔原 · Tundra","草木浅绿 · 自然与舒展",16,
    {accent:"#33745c",secondary:"#657e3e",background:"#f6f9f4",surface:"#eaf1e6",text:"#2c4336",muted:"#5e7466"},
    {accent:"#9ed5b3",secondary:"#c3cf97",background:"#14231d",surface:"#21372b",text:"#e4efe7",muted:"#a3bdab"}),
];
export function readThemeLibrary(strict=false):SavedTheme[] {
  try {const stored=localStorage.getItem(KEY)??"[]";if(stored.length>2*1024*1024)throw Error("Theme library too large");const raw=JSON.parse(stored);if(!Array.isArray(raw))throw Error("Invalid theme library");
    return raw.slice(0,MAX_SAVED_THEMES).filter(item=>item && typeof item.id==="string" && typeof item.name==="string").map(item=>({id:item.id.slice(0,80),name:cleanThemeName(item.name),...(item.source==="imported" || item.source==="agent"?{source:item.source as "imported"|"agent"}:{}),appearance:normalizeAppearance(item.appearance)}));
  } catch{if(strict)throw new Error("无法读取主题库，已保留原数据 / Theme library could not be read; existing data preserved");return [];}
}
function requireLibrarySpace(themes:SavedTheme[]){if(themes.length>=MAX_SAVED_THEMES)throw new Error("主题库已满（20 个），请先删除不需要的主题 / Theme library is full (20); remove an unused theme first");}
export function saveThemeToLibrary(name:string,appearance:unknown):SavedTheme {
  const themes=readThemeLibrary(true),cleanName=cleanThemeName(name);if(!cleanName)throw new Error("请填写主题名称 / Enter a theme name");
  const prior=themes.find(theme=>theme.name===cleanName);if(!prior)requireLibrarySpace(themes);
  const value:SavedTheme={id:prior?.id??crypto.randomUUID(),name:cleanName,...(prior?.source?{source:prior.source}:{}),appearance:normalizeAppearance(appearance)};
  localStorage.setItem(KEY,JSON.stringify([...themes.filter(theme=>theme.id!==value.id),value]));return value;
}
export function deleteSavedTheme(id:string):void {localStorage.setItem(KEY,JSON.stringify(readThemeLibrary().filter(theme=>theme.id!==id)));}
function appendTheme(name:string,appearance:AppearanceProfile,source:"imported"|"agent"):SavedTheme {
  const themes=readThemeLibrary(true);requireLibrarySpace(themes);
  const base=cleanThemeName(name)||"My theme",names=new Set([...BUILTIN_THEMES,...themes].map(theme=>theme.name.toLowerCase()));
  let uniqueName=base,index=2;while(names.has(uniqueName.toLowerCase())){const suffix=` · ${index++}`;uniqueName=Array.from(base).slice(0,80-suffix.length).join("")+suffix;}
  const theme:SavedTheme={id:crypto.randomUUID(),name:uniqueName,source,appearance:normalizeAppearance(appearance)};
  localStorage.setItem(KEY,JSON.stringify([...themes,theme]));return theme;
}
export function importThemeToLibrary(text:string,fallbackName="Imported theme"):SavedTheme {
  const data=readAppearancePackage(text);return appendTheme(data.name||cleanThemeName(fallbackName)||"Imported theme",data.appearance,"imported");
}
export function saveGeneratedTheme(name:string,appearance:AppearanceProfile):SavedTheme {return appendTheme(name,appearance,"agent");}
export function themeVariantColors(profile:AppearanceProfile,mode:"light"|"dark"):AppearanceProfile["colors"] {
  if(profile.palettes)return profile.paletteMode===mode?profile.colors:profile.palettes[mode]??{};
  return (profile.mode==="dark"?"dark":"light")===mode?profile.colors:{};
}
export function themeVariantModes(profile:AppearanceProfile):Array<"light"|"dark"> {
  return profile.palettes?(["light","dark"] as const).filter(mode=>Object.hasOwn(profile.palettes!,mode)):Object.keys(profile.colors).length?[profile.mode==="dark"?"dark":"light"]:[];
}
