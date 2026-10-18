import test from "node:test";
import assert from "node:assert/strict";
import {importThemeToLibrary,readThemeLibrary,saveThemeToLibrary,saveGeneratedTheme,themeVariantColors,themeVariantModes,MAX_SAVED_THEMES} from "./theme-library.ts";
import {normalizeAppearance,readAppearancePackage,exportAppearance} from "./appearance-profile.ts";

function storageTest(run:(storage:Map<string,string>)=>void){const prior=globalThis.localStorage,store=new Map<string,string>();try{Object.assign(globalThis,{localStorage:{getItem:(key:string)=>store.get(key)??null,setItem:(key:string,value:string)=>store.set(key,value)}});run(store);}finally{Object.assign(globalThis,{localStorage:prior});}}
test("imported themes retain metadata, get unique names, and never overwrite an existing theme",()=>storageTest(()=>{
  const text="\uFEFF"+exportAppearance({mode:"dark",colors:{accent:"#abcdef",background:"#152535"}},"My theme");
  const first=importThemeToLibrary(text),second=importThemeToLibrary(text);
  assert.equal(first.name,"My theme");assert.equal(second.name,"My theme · 2");assert.notEqual(first.id,second.id);
  const themes=readThemeLibrary();assert.equal(themes.length,2);assert.equal(themes[0].source,"imported");
  assert.deepEqual(themeVariantModes(themes[0].appearance),["dark"]);
  assert.equal(themeVariantColors(themes[0].appearance,"dark").background,"#152535");assert.deepEqual(themeVariantColors(themes[0].appearance,"light"),{});
}));
test("legacy packs without a mode show their light colors, and paired-only packs infer the selected variant",()=>{
  const legacy=normalizeAppearance({colors:{accent:"#123456"}});
  assert.equal(themeVariantColors(legacy,"light").accent,"#123456");assert.deepEqual(themeVariantColors(legacy,"dark"),{});
  const paired=normalizeAppearance({mode:"dark",palettes:{light:{background:"#fafafa"},dark:{background:"#121212"}}});
  assert.equal(paired.paletteMode,"dark");assert.equal(paired.colors.background,"#121212");
  assert.equal(themeVariantColors(paired,"light").background,"#fafafa");assert.deepEqual(themeVariantModes(paired),["light","dark"]);
});
test("full theme libraries reject new imports and preserve every existing entry",()=>storageTest(store=>{
  for(let i=0;i<MAX_SAVED_THEMES;i++)saveThemeToLibrary(`Theme ${i}`,{});
  const before=JSON.stringify([...store]);assert.throws(()=>importThemeToLibrary(exportAppearance({})),/full/);assert.equal(JSON.stringify([...store]),before);
  assert.throws(()=>saveThemeToLibrary("One more",{}),/full/);assert.equal(JSON.stringify([...store]),before);
  saveThemeToLibrary("Theme 0",{weight:450});assert.equal(readThemeLibrary().length,MAX_SAVED_THEMES);assert.equal(readThemeLibrary().find(theme=>theme.name==="Theme 0")?.appearance.weight,450);
}));
test("invalid packs and corrupted storage leave the theme library untouched",()=>storageTest(store=>{
  saveThemeToLibrary("Existing",{});const before=JSON.stringify([...store]);
  for(const text of ["not JSON",JSON.stringify({format:"cryoclaw-theme",version:1,appearance:[]}),"x".repeat(65537)])assert.throws(()=>importThemeToLibrary(text));
  assert.equal(JSON.stringify([...store]),before);
  store.set("cryoclaw.theme-library.v1","{broken");assert.deepEqual(readThemeLibrary(),[]);
  assert.throws(()=>importThemeToLibrary(exportAppearance({})),/existing data preserved/);assert.equal(store.get("cryoclaw.theme-library.v1"),"{broken");
}));
test("long multilingual names are bounded without breaking emoji, and unsafe colors are filtered",()=>{
  const theme=readAppearancePackage(JSON.stringify({format:"cryoclaw-theme",version:1,name:"  "+"🌿".repeat(100)+"\n",appearance:{colors:{accent:"url(secret)",secondary:"#218363"}}}));
  assert.equal(Array.from(theme.name).length,80);assert.equal(readAppearancePackage(exportAppearance(theme.appearance,theme.name)).name,theme.name);assert.ok(!theme.name.includes("\ufffd"));assert.deepEqual(theme.appearance.colors,{secondary:"#218363"});
});
test("kept Agent themes retain their source and never overwrite another named theme",()=>storageTest(()=>{
  const first=saveGeneratedTheme("Agent forest",normalizeAppearance({colors:{accent:"#33745c"}}));
  const next=saveGeneratedTheme("Agent forest",normalizeAppearance({colors:{accent:"#1a6fd0"}}));
  assert.notEqual(first.id,next.id);assert.equal(next.name,"Agent forest · 2");
  assert.equal(readThemeLibrary()[0].source,"agent");assert.equal(readThemeLibrary()[0].appearance.colors.accent,"#33745c");
}));
