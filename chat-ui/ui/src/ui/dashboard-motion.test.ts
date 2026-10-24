import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardTransform} from './dashboard-motion.ts';
test('collapse transforms account for a proportionally scaled parent',()=>{
  assert.equal(dashboardTransform({left:30,top:50,width:1600,height:900},{left:130,top:150,width:400,height:225},.5),'translate(-200px, -200px) scale(4, 4)');
  assert.equal(dashboardTransform({left:130,top:150,width:400,height:225},{left:30,top:50,width:1600,height:900}),'translate(100px, 100px) scale(0.25, 0.25)');
  assert.equal(dashboardTransform({left:0,top:0,width:1,height:1},{left:0,top:0,width:0,height:1}),null);
});
