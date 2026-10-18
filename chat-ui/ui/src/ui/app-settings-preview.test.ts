import test from "node:test";
import assert from "node:assert/strict";
import {applySettings} from "./app-settings.ts";
import {parseUiSettings} from "./storage.ts";
import {normalizeAppearance} from "./appearance-profile.ts";
test("session preference updates do not overwrite an unsaved live appearance preview",()=>{
  const previous=globalThis.document;let writes=0;
  try {
    Object.assign(globalThis,{document:{documentElement:{style:{setProperty(){writes++;},removeProperty(){writes++;}}}}});
    const settings=parseUiSettings(null,{host:"",protocol:"file:",search:"",hash:""});
    const host={settings,theme:settings.theme} as unknown as Parameters<typeof applySettings>[0];
    applySettings(host,{...settings,lastActiveSessionKey:"main:updated"});
    assert.equal(writes,0);
    applySettings(host,{...host.settings,appearance:structuredClone(settings.appearance)});
    assert.equal(writes,0,"an equivalent settings snapshot is not a new appearance edit");
  } finally {Object.assign(globalThis,{document:previous});}
});
test("base-theme toggles remain usable after a custom theme package sets its own mode",()=>{
  const settings=parseUiSettings(null,{host:"",protocol:"file:",search:"",hash:""});
  settings.theme="dark";settings.appearance=normalizeAppearance({mode:"dark",colors:{background:"#101012"}});
  const host={settings,theme:"dark"} as unknown as Parameters<typeof applySettings>[0];
  applySettings(host,{...settings,theme:"light"});
  assert.equal(host.settings.theme,"light");assert.equal(host.settings.appearance?.mode,"light");assert.deepEqual(host.settings.appearance?.colors,{});
  applySettings(host,{...host.settings,appearance:normalizeAppearance({mode:"dark",colors:{background:"#15191f"}})});
  assert.equal(host.settings.theme,"dark");assert.equal(host.settings.appearance?.colors.background,"#15191f");
  applySettings(host,{...structuredClone(host.settings),theme:"light"});
  assert.equal(host.settings.appearance?.mode,"light");assert.deepEqual(host.settings.appearance?.colors,{});
});
