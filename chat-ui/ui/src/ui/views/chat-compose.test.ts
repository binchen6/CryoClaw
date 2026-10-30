import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderCompose} from './chat-compose.ts';
import type {ChatProps} from './chat.ts';
type View={strings:readonly string[];values:unknown[]};
function binding(view:View,marker:string,attribute:string):(...args:any[])=>void {
 let start=view.strings.findIndex(text=>text.includes(marker));
 if(start<0){
  const nested=view.values.find(value=>value&&typeof value==='object'&&'strings' in value&&(value as View).strings.some(text=>text.includes(marker))) as View|undefined;
  assert.ok(nested,marker);view=nested;start=view.strings.findIndex(text=>text.includes(marker));
 }
 const index=view.strings.findIndex((text,index)=>index>=start&&text.endsWith(attribute+'='));assert.ok(index>=0,attribute);
 return view.values[index] as (...args:any[])=>void;
}
function composer(overrides:Partial<ChatProps>={}){
 const calls:unknown[][]=[];
 const props={draft:'hello',connected:true,configuredModels:[],onSend:(...args:unknown[])=>{calls.push(args);},...overrides} as ChatProps;
 const view=renderCompose(props,{activeSession:null,composePlaceholder:'Message',modelSelectValue:null,isBusy:false,showStop:true}) as unknown as View;
 return {view,calls};
}
function key(overrides:Record<string,unknown>={}){
 return {key:'Enter',shiftKey:false,ctrlKey:false,metaKey:false,altKey:false,repeat:false,isComposing:false,keyCode:13,defaultPrevented:false,currentTarget:{selectionStart:5,selectionEnd:5},preventDefault(){this.defaultPrevented=true;},...overrides};
}
test('the rendered send button calls onSend without passing its mouse event as the message',()=>{
 const {view,calls}=composer();binding(view,'chat-compose__send-btn--send','@click')({type:'click'});
 assert.deepEqual(calls,[[]]);
});
test('Enter and Shift+Enter leave native textarea line breaks intact',()=>{
 const {view,calls}=composer(),keydown=binding(view,'<textarea','@keydown');
 for(const event of [key(),key({shiftKey:true})]){keydown(event);assert.equal(event.defaultPrevented,false);}
 assert.deepEqual(calls,[]);
});
test('Ctrl or Command+Enter sends once; empty drafts, IME and held keys never submit',()=>{
 const {view,calls}=composer(),keydown=binding(view,'<textarea','@keydown');
 for(const event of [key({ctrlKey:true}),key({metaKey:true})]){keydown(event);assert.equal(event.defaultPrevented,true);}
 assert.equal(calls.length,2);
 for(const event of [key({ctrlKey:true,isComposing:true}),key({metaKey:true,keyCode:229}),key({ctrlKey:true,repeat:true}),key({ctrlKey:true,shiftKey:true})])keydown(event);
 assert.equal(calls.length,2);
 const empty=composer({draft:'  '});binding(empty.view,'<textarea','@keydown')(key({ctrlKey:true}));assert.equal(empty.calls.length,0);
});
test('the stop button isolates its DOM event from the abort action',()=>{
 const calls:unknown[][]=[];const {view}=composer({onAbort:((...args:unknown[])=>calls.push(args)) as ()=>void});
 binding(view,'chat-compose__send-btn--stop','@click')({type:'click'});assert.deepEqual(calls,[[]]);
});
test('Enter does not complete a command; Tab remains the explicit completion key',t=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'requestAnimationFrame');
 Object.defineProperty(globalThis,'requestAnimationFrame',{configurable:true,value:()=>0});
 t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'requestAnimationFrame',descriptor);else delete (globalThis as any).requestAnimationFrame;});
 const changes:string[]=[];
 const {view,calls}=composer({draft:'/hel',commands:[{name:'help',description:'Help',acceptsArgs:false}],onDraftChange:value=>changes.push(value)});
 binding(view,'<textarea','@focus')({target:{selectionStart:4}});
 const event=key({currentTarget:{selectionStart:4,selectionEnd:4}});binding(view,'<textarea','@keydown')(event);
 assert.equal(event.defaultPrevented,false);assert.equal(changes.length,0);assert.deepEqual(calls,[]);
 const tab=key({key:'Tab',currentTarget:{selectionStart:4,selectionEnd:4}});binding(view,'<textarea','@keydown')(tab);assert.equal(tab.defaultPrevented,true);assert.equal(changes[0]?.startsWith('/help'),true);
});
