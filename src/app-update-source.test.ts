import test from "node:test";
import assert from "node:assert/strict";
import {appUpdateSource,OFFICIAL_UPDATE_BASE} from "./app-update-source";
test("stable manifests use official release assets; explicit mirrors require an HTTPS directory",()=>{
  assert.equal(appUpdateSource(),OFFICIAL_UPDATE_BASE);
  assert.equal(appUpdateSource("https://updates.example.com/cryoclaw"),"https://updates.example.com/cryoclaw/");
  for(const value of ["http://example.com","https://user:secret@example.com","https://example.com/?token=private","file:///tmp"] )assert.throws(()=>appUpdateSource(value));
});
