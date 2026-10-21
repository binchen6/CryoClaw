import test from "node:test";
import assert from "node:assert/strict";
import {appearanceContrastIssues,contrastRatio} from "./appearance-contrast.ts";
import {normalizeAppearance} from "./appearance-profile.ts";
test("contrast feedback covers both variants without flagging unspecified roles",()=>{
  assert.equal(contrastRatio("#ffffff","#000000"),21);
  assert.equal(appearanceContrastIssues(normalizeAppearance({})).length,0);
  const issues=appearanceContrastIssues(normalizeAppearance({colors:{text:"#ffffff",background:"#ffffff"},paletteMode:"light",palettes:{light:{},dark:{text:"#222222",background:"#222222"}}}));
  assert.deepEqual(issues.map(x=>x.mode),["light","dark"]);assert.equal(issues[0].ratio,1);
});
