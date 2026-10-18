import test from "node:test";
import assert from "node:assert/strict";
import {normalizeAppearance,exportAppearance,importAppearance,DEFAULT_APPEARANCE,withAppearanceMode,appearanceColors,accentForeground} from "./appearance-profile.ts";
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
