import test from "node:test";
import assert from "node:assert/strict";
import {isPluginHostCompatible,selectCompatiblePluginVersion} from "./plugin-update-compat";
test("plugin updates respect host SDK, plugin API and minimum host ranges",()=>{
  assert.equal(isPluginHostCompatible({peerDependencies:{openclaw:">=2026.10.5"}},"2026.10.4"),false);
  assert.equal(isPluginHostCompatible({openclaw:{compat:{pluginApi:">=2026.10.5"}}},"2026.10.4"),false);
  assert.equal(isPluginHostCompatible({openclaw:{install:{minHostVersion:">=2026.6.9"}}},"2026.10.4"),true);
  assert.equal(isPluginHostCompatible({peerDependencies:{openclaw:"invalid range"}},"2026.10.4"),false);
});
test("an incompatible latest version falls back to the newest compatible stable release",()=>{
  const metadata={versions:{"2026.10.3":{},"2026.10.4":{},"2026.10.5":{peerDependencies:{openclaw:">=2026.10.5"}},"2026.10.6-beta.1":{}}};
  assert.equal(selectCompatiblePluginVersion(metadata,"2026.10.4"),"2026.10.4");
  assert.equal(selectCompatiblePluginVersion({versions:{"2026.10.5":metadata.versions["2026.10.5"]}},"2026.10.4"),null);
});
