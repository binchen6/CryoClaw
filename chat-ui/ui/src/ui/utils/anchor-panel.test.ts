import test from "node:test";
import assert from "node:assert/strict";
import {fitVerticalPopover} from "./anchor-panel.ts";
import {rectsOverlap} from "./popover-placement.ts";
test("long menus at the viewport centre shrink rather than cover their invoker",()=>{
  for(const width of [390,800,1440])for(const top of [20,275,530]){
    const anchor={left:Math.min(width-60,200),top,width:40,height:32};
    const result=fitVerticalPopover({anchor,panel:{width:168,height:520},viewport:{width,height:600},avoid:[anchor]});
    assert.equal(result.covered,false);
    assert.equal(rectsOverlap({left:result.left,top:result.top,width:168,height:Math.min(520,result.maxHeight)},anchor),false);
    assert.ok(result.top>=12&&result.top+Math.min(520,result.maxHeight)<=588);
  }
});
