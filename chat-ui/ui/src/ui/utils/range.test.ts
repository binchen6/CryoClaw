import test from "node:test";
import assert from "node:assert/strict";
import {adjustRange,clampRange} from "./range.ts";
test("precise sliders support fractional keyboard steps and modifiers without numerical drift",()=>{
  assert.equal(adjustRange(437.5,1,100,900,.1),437.6);
  assert.equal(adjustRange(437.5,1,100,900,.1,true),437.51);
  assert.equal(adjustRange(437.5,-1,100,900,.1,false,true),436.5);
  let value=0;for(let i=0;i<100;i++)value=adjustRange(value,1,0,100,.1);
  assert.equal(value,10);assert.equal(clampRange(NaN,0,1),0);assert.equal(adjustRange(900,1,100,900,.1),900);
});
