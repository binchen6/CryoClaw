import test from 'node:test';import assert from 'node:assert/strict';import {dashboardFrameUrl,formatDashboardTimestamp,reorderDashboardCards,type DashboardCard} from './dashboard-model.ts';
import {getLocale,setLocale} from './i18n.ts';
import {arrangeDashboardCards,dashboardSize} from './dashboard-model.ts';
test('continuous card sizing retains fractional widths instead of snapping a column',()=>{assert.equal(dashboardSize(4.2576,2,12),4.258);assert.equal(dashboardSize(99,2,12),12);});
test('arranging fills rows, preserves reading order and full-width section anchors',()=>{
 const cards=[['hero',12,300],['a',4,350],['b',4,400],['c',4,360],['section',12,160],['d',7,450],['e',5,470],['f',4,300],['g',4,330]].map(([id,w,h],order)=>({id,layout:{w,h,order}})) as DashboardCard[];
 const next=arrangeDashboardCards(cards);assert.deepEqual(next.map(c=>c.id),cards.map(c=>c.id));assert.deepEqual(next.map(c=>c.layout.w),[12,4,4,4,12,7,5,6,6]);assert.deepEqual(next.slice(1,4).map(c=>c.layout.h),[400,400,400]);assert.equal(cards[1].layout.h,350);assert.equal(next[4].layout.h,160);
});
test('dashboard frame URLs stay within authenticated gateway card routes',()=>{const gateway='ws://127.0.0.1:18789';assert.equal(dashboardFrameUrl(gateway,'https://evil.org'),null);assert.equal(dashboardFrameUrl(gateway,'//evil.org'),null);assert.equal(dashboardFrameUrl(gateway,'/__cryoclaw__/dashboards/a/b?ticket=x'),'http://127.0.0.1:18789/__cryoclaw__/dashboards/a/b?ticket=x');});
test('card reordering is immutable and retains dimensions',()=>{const cards=['a','b','c'].map((id,order)=>({id,layout:{w:4,h:300,order}})) as DashboardCard[];const next=reorderDashboardCards(cards,'a','c');assert.deepEqual(next.map(c=>c.id),['b','c','a']);assert.equal(cards[0].layout.order,0);assert.equal(next[2].layout.w,4);});

test('dashboard timestamps follow the active locale',()=>{const previous=getLocale();try{setLocale('zh');assert.equal(formatDashboardTimestamp(Date.now()-30_000),'刚刚');assert.match(formatDashboardTimestamp(Date.now()-7_200_000),/小时前/);setLocale('en');assert.equal(formatDashboardTimestamp(Date.now()-30_000),'just now');assert.match(formatDashboardTimestamp(Date.now()-7_200_000),/hours? ago/);}finally{setLocale(previous);}});
