import test from "node:test";
import assert from "node:assert/strict";
import {normalizeAppearance,exportAppearance,importAppearance,applyAppearance,readAppearancePackage,themeFileName,DEFAULT_APPEARANCE,withAppearanceMode,appearanceColors,accentForeground} from "./appearance-profile.ts";
import {BUILTIN_THEMES} from "./theme-library.ts";

test("expanded semantic theme colors and icon/bubble controls survive export/import with bounds",()=>{
  const profile=normalizeAppearance({colors:{userBubble:'#eeeeff',assistantText:'#123456',composer:'#ffffff',icon:'#218363'},components:{'chat/userBubble/0':{radius:18,gap:8,margin:4},'chat/icon/0':{iconSize:200,strokeWidth:20,borderStyle:'dashed'}}});
  assert.equal(profile.components?.['chat/icon/0'].iconSize,96);assert.equal(profile.components?.['chat/icon/0'].strokeWidth,6);
  assert.equal(profile.colors.userBubble,'#eeeeff');assert.deepEqual(importAppearance(exportAppearance(profile)),profile);
});
test("appearance input clamps numerical controls and rejects arbitrary CSS",()=>{
  const value=normalizeAppearance({font:"remote",size:999,weight:NaN,radius:-10,lineHeight:0,colors:{accent:"url(https://example.test/secret)",background:"#123456",unknown:"#abcdef"}});
  assert.equal(value.size,22);assert.equal(value.weight,400);assert.equal(value.radius,0);assert.equal(value.lineHeight,1.3);
  assert.deepEqual(value.colors,{background:"#123456"});assert.equal(value.font,"studio");
});
test("theme package round-trip excludes unknown settings and credentials",()=>{
  const output=exportAppearance({...DEFAULT_APPEARANCE,token:"private",gatewayUrl:"private"});
  assert.ok(!output.includes("private"));assert.deepEqual(importAppearance(output),DEFAULT_APPEARANCE);
});
test("variable font weight preserves fractional values over the complete 100–900 range",()=>{
  for(const weight of [100,275.25,437.5,899.99,900])assert.equal(normalizeAppearance({weight}).weight,weight);
  assert.equal(normalizeAppearance({weight:50}).weight,100);
  assert.equal(normalizeAppearance({weight:1000}).weight,900);
  assert.equal(importAppearance(exportAppearance({...DEFAULT_APPEARANCE,weight:437.5})).weight,437.5);
});
test("theme import rejects oversized, unsupported or malformed packages",()=>{
  for(const value of ["x".repeat(65537),"{}",'{"format":"cryoclaw-theme","version":2,"appearance":{}}',"not JSON"])assert.throws(()=>importAppearance(value));
});
test("individual component themes admit registered scoped targets and bounded properties only",()=>{
  const value=normalizeAppearance({components:{"settings-appearance/button/3":{x:999,y:-999,radius:80,background:"#123456",color:"url(bad)",script:"bad"},"body *":{x:100},"chat/button/999":{x:1}}});
  assert.deepEqual(value.components,{"settings-appearance/button/3":{x:600,y:-600,radius:80,background:"#123456"}});
  assert.deepEqual(importAppearance(exportAppearance(value)).components,value.components);
});
test("paired theme switching preserves edits and uses defaults for a missing counterpart",()=>{
  const legacy=normalizeAppearance({mode:"dark",colors:{background:"#101012"}});
  const light=withAppearanceMode(legacy,"light");
  assert.deepEqual(light.colors,{});assert.equal(light.palettes?.dark?.background,"#101012");
  light.colors={background:"#fafafa"};
  const dark=withAppearanceMode(light,"dark");assert.equal(dark.colors.background,"#101012");
  assert.equal(withAppearanceMode(dark,"light").colors.background,"#fafafa");
  assert.deepEqual(importAppearance(exportAppearance(dark)),dark);
});
test("system theme resolves the matching palette without leaking the opposite colors",()=>{
  const theme=withAppearanceMode({mode:"light",colors:{background:"#ffffff"},palettes:{dark:{background:"#151515"}}},"system");
  assert.equal(appearanceColors(theme,false).background,"#ffffff");
  assert.equal(appearanceColors(theme,true).background,"#151515");
  const dark=withAppearanceMode(theme,"system",true);dark.colors.accent="#abcdef";
  assert.equal(appearanceColors(dark,true).accent,"#abcdef");
  assert.equal(appearanceColors(dark,false).accent,undefined);
  const legacy=normalizeAppearance({mode:"system",colors:{background:"#ffffff"}});
  assert.equal(appearanceColors(legacy,false).background,"#ffffff");assert.deepEqual(appearanceColors(legacy,true),{});
});
test("paired theme import accepts only known safe color values",()=>{
  const profile=normalizeAppearance({palettes:{dark:{background:"url(secret)",accent:"#123456",html:"bad"},light:{text:"#abcdef"},remote:{accent:"#222222"}},paletteMode:"invalid"});
  assert.deepEqual(profile.palettes,{light:{text:"#abcdef"},dark:{accent:"#123456"}});
  assert.equal(profile.paletteMode,"light");
});
function contrast(a:string,b:string){const luminance=(hex:string)=>{const c=[1,3,5].map(offset=>parseInt(hex.slice(offset,offset+2),16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722;};const values=[luminance(a),luminance(b)].sort((x,y)=>x-y);return (values[1]+.05)/(values[0]+.05);}
test("built-in themes pair distinct readable palettes and accessible primary labels",()=>{
  const backgrounds=new Set<string>();
  for(const theme of BUILTIN_THEMES){
    for(const mode of ["light","dark"] as const){
      const colors=theme.appearance.palettes?.[mode];assert.ok(colors,`${theme.id} has ${mode}`);
      if(!colors.background)continue;
      backgrounds.add(colors.background);
      assert.ok(contrast(colors.text!,colors.background)>=4.5,`${theme.id}/${mode} body contrast`);
      assert.ok(contrast(colors.muted!,colors.background)>=4.5,`${theme.id}/${mode} metadata contrast`);
      assert.ok(contrast(accentForeground(colors.accent!),colors.accent!)>=4.5,`${theme.id}/${mode} primary contrast`);
    }
    assert.deepEqual(importAppearance(exportAppearance(theme.appearance)),theme.appearance);
  }
  assert.equal(backgrounds.size,6,"the three curated themes have independent light/dark surfaces");
  for(const color of ["#777777","#ffffff","#000000","#1a6fd0","#8fc9ff"])assert.ok(contrast(accentForeground(color),color)>=4.5);
});
test("layout-feel fields are optional, bounded, and omitted at their defaults for old themes",()=>{
  const plain=normalizeAppearance({});
  assert.equal(plain.density,undefined);assert.equal(plain.shadow,undefined);assert.equal(plain.borderWidth,undefined);
  assert.deepEqual(normalizeAppearance({density:1,shadow:"default",borderWidth:1}),plain);
  for(const theme of BUILTIN_THEMES)for(const key of ["density","shadow","borderWidth"] as const)assert.equal(theme.appearance[key],undefined,`${theme.id} keeps the current look`);
  const clamped=normalizeAppearance({density:2,shadow:"harsh",borderWidth:99});
  assert.equal(clamped.density,1.1);assert.equal(clamped.shadow,undefined);assert.equal(clamped.borderWidth,2);
  assert.equal(normalizeAppearance({density:.5}).density,.9);
  assert.equal(normalizeAppearance({density:.937}).density,.94);
  assert.equal(normalizeAppearance({borderWidth:-1}).borderWidth,0);
  assert.equal(normalizeAppearance({density:"0.95"}).density,undefined);
  assert.equal(normalizeAppearance({density:NaN}).density,undefined);
  for(const shadow of ["none","soft","default","strong"] as const)assert.equal(normalizeAppearance({shadow}).shadow,shadow==="default"?undefined:shadow);
  const profile=normalizeAppearance({density:.95,shadow:"strong",borderWidth:1.5});
  assert.deepEqual(importAppearance(exportAppearance(profile)),profile);
  assert.deepEqual(importAppearance(exportAppearance({mode:"dark",colors:{background:"#101012"}})),{mode:"dark",font:"studio",size:14,weight:400,italic:false,lineHeight:1.55,radius:12,colors:{background:"#101012"},components:{}});
});
test("theme packages carry an optional bounded description while staying v1-compatible",()=>{
  const text=exportAppearance({colors:{accent:"#1a6fd0"}},"Named","克制而通透的冰蓝主题");
  const packed=readAppearancePackage(text);
  assert.equal(packed.name,"Named");assert.equal(packed.description,"克制而通透的冰蓝主题");
  assert.equal(packed.appearance.colors.accent,"#1a6fd0");
  const parsed=JSON.parse(text);assert.equal(parsed.format,"cryoclaw-theme");assert.equal(parsed.version,1);assert.equal(parsed.description,"克制而通透的冰蓝主题");
  assert.equal(readAppearancePackage(exportAppearance({})).description,undefined);
  const bounded=readAppearancePackage(exportAppearance({},"N","字".repeat(300)));
  assert.equal(Array.from(bounded.description??"").length,120);
  const legacy=readAppearancePackage(JSON.stringify({format:"cryoclaw-theme",version:1,name:"Old",appearance:{radius:12,colors:{accent:"#1a6fd0"},components:{}}}));
  assert.equal(legacy.description,undefined);assert.equal(legacy.appearance.density,undefined);assert.equal(legacy.appearance.shadow,undefined);assert.equal(legacy.appearance.borderWidth,undefined);
  assert.deepEqual(legacy.appearance,normalizeAppearance({radius:12,colors:{accent:"#1a6fd0"}}));
});
test("exported file names are safe on every platform and keep readable names",()=>{
  assert.equal(themeFileName("冰川 · Glacier"),"冰川 · Glacier.json");
  const unsafe=themeFileName('bad<>:"/\\|?* name');
  assert.ok(!/[\\/:*?"<>|]/.test(unsafe));assert.ok(unsafe.endsWith("name.json"));
  assert.equal(themeFileName("   "),"cryoclaw-theme.json");
  assert.equal(themeFileName("."),"cryoclaw-theme.json");
  const traversal=themeFileName("..\\..\\evil");
  assert.ok(!traversal.startsWith("."));assert.ok(!/[\\/:*?"<>|]/.test(traversal));
  assert.equal(themeFileName("CON"),"_CON.json");
  assert.ok(themeFileName("x".repeat(200)).length<=65);
});
test("applyAppearance scales spacers, maps shadow strength and hairline width, and clears overrides at defaults",()=>{
  const observer=globalThis.MutationObserver;
  (globalThis as any).MutationObserver=class{observe(){}disconnect(){}takeRecords(){return [];}};
  const capture=()=>{
    const values=new Map<string,string>();
    const root={dataset:{} as DOMStringMap,style:{setProperty:(name:string,value:string)=>values.set(name,value),removeProperty:(name:string)=>values.delete(name),getPropertyValue:(name:string)=>values.get(name)??""},querySelector:()=>null,querySelectorAll:()=>[]} as unknown as HTMLElement;
    return {root,values};
  };
  try{
    const styled=capture();applyAppearance({density:.95,shadow:"none",borderWidth:2},styled.root);
    assert.equal(styled.values.get("--spacer-8"),"7.6px");
    assert.equal(styled.values.get("--spacer-64"),"60.8px");
    assert.equal(styled.values.get("--shadow-md"),"none");
    assert.equal(styled.values.get("--hairline"),"2px solid var(--border)");
    assert.equal(styled.values.get("--hairline-strong"),"2px solid var(--border-strong)");
    const strong=capture();applyAppearance({shadow:"strong"},strong.root);
    assert.match(strong.values.get("--shadow-lg")??"",/^0 var\(--spacer-16\).*color-mix\(in srgb, var\(--overlay-heavy\) \d+(?:\.\d+)?%, transparent\)$/);
    const soft=capture();applyAppearance({shadow:"soft"},soft.root);
    assert.match(soft.values.get("--shadow-md")??"",/color-mix\(in srgb, var\(--overlay-heavy\) 7%, transparent\)$/);
    assert.notEqual(soft.values.get("--shadow-md"),strong.values.get("--shadow-md"));
    const plain=capture();applyAppearance({},plain.root);
    for(const token of ["--spacer-8","--spacer-16","--shadow-md","--shadow-lg","--hairline","--hairline-strong"])assert.equal(plain.values.has(token),false,`${token} stays on the stylesheet default`);
  } finally {(globalThis as any).MutationObserver=observer;}
});
