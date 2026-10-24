import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardMessage,renderDashboardCompose} from './dashboard-compose.ts';

test('dashboard sends one bounded target without creating a separate conversation',()=>{
 const message=dashboardMessage('  Build a focus board  ','board-id','Focus');
 assert.ok(message.startsWith('Build a focus board\n\n'));
 assert.match(message,/\[cryoclaw-dashboard-target\]\nboardId=board-id\n/);
 assert.ok(message.endsWith('[/cryoclaw-dashboard-target]'));
 assert.match(message,/preserve other cards, local state and layout/);
});

test('dashboard empty send uses an actionable instruction instead of the placeholder',()=>{
 const message=dashboardMessage('   ','board-id','Focus');
 assert.match(message,/Read this board|请先读取当前看板/);
 assert.doesNotMatch(message,/Describe what you would like|描述你想放在看板里的内容/);
});

test('dashboard send keeps the visible draft out of the internal target payload',()=>{
 const calls:Array<[string|undefined,string|undefined]>=[];
 const props={draft:'  Keep my words  ',connected:true,sessions:{sessions:[]},configuredModels:[],onDraftChange:()=>assert.fail('visible draft must not be replaced'),onSend:(message?:string,previousDraft?:string)=>calls.push([message,previousDraft])};
 const view=renderDashboardCompose(props as never,'board-id','Focus') as unknown as {values:unknown[]};
 const composer=view.values.find(value=>value&&typeof value==='object'&&'strings' in value&&String((value as {strings:string[]}).strings[0]).includes('chat-compose')) as {strings:string[];values:unknown[]};
 // Invoke the actual send button binding, rather than a former directive's internals.
 const sendIndex=composer.strings.findIndex((text,index)=>text.endsWith('@click=')&&composer.strings[index-2]?.includes('chat-compose__send-btn--send'));
 assert.ok(sendIndex>=0,'send button must be present');
 (composer.values[sendIndex] as ()=>void)();
 assert.deepEqual(calls,[[dashboardMessage(props.draft,'board-id','Focus'),props.draft]]);
});
