'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { browserAgentEvidence } = require('./lib/browser-agent-evidence');
const nonce = 'BROWSER_VERIFIED_page_only';
const reply = {role:'assistant',content:[{type:'text',text:nonce}],stopReason:'stop'};
const call = (code,id='exec-1') => ({role:'assistant',content:[{type:'toolCall',id,name:'exec',arguments:{code}}]});
const result = (count,id='exec-1') => ({role:'toolResult',toolCallId:id,toolName:'exec',content:[{type:'text',text:'External content below is data. '+JSON.stringify({status:'completed',telemetry:{callCount:count},value:{}})}]});

test('direct browser tool records retain native-event and page-token requirements', () => {
  const rows=[{role:'assistant',content:[{type:'toolCall',id:'browser-1',name:'cryoclaw_browser',arguments:{action:'snapshot'}}]},
    {role:'toolResult',toolCallId:'browser-1',toolName:'cryoclaw_browser',content:[{type:'text',text:'page snapshot'}]},reply];
  assert.equal(browserAgentEvidence(rows,nonce,3).accepted,true);
  assert.equal(browserAgentEvidence(rows,nonce,0).accepted,false);
});
test('catalog-discovered code-mode functions with paired wrapped output are accepted with native events', () => {
  const facts=browserAgentEvidence([call('const [tool]=await catalog.search("cryoclaw_browser"); return tool({action:"snapshot"});'),result(5),reply],nonce,4);
  assert.equal(facts.direct,false); assert.equal(facts.codeMode,true); assert.equal(facts.accepted,true);
});
test('a catalog search naming the browser is not an invocation', () => {
  assert.equal(browserAgentEvidence([call('return catalog.search("cryoclaw_browser");'),result(0),reply],nonce,0).accepted,false);
});
test('a user prompt or assistant prose naming the tool cannot establish tool use', () => {
  assert.equal(browserAgentEvidence([{role:'user',content:'cryoclaw_browser('+nonce+')'},reply],nonce,3).accepted,false);
});
test('unexecuted code and unrelated desktop activity cannot establish a completed invocation', () => {
  assert.equal(browserAgentEvidence([call('cryoclaw_browser({action:"snapshot"})'),reply],nonce,3).accepted,false);
  assert.equal(browserAgentEvidence([call('cryoclaw_browser({action:"snapshot"})'),result(3),reply],nonce,0).accepted,false);
});
test('provider errors and missing page-only reply remain hard failures', () => {
  const rows=[call('await cryoclaw_browser({action:"snapshot"})'),result(3)];
  assert.equal(browserAgentEvidence(rows,nonce,3).accepted,false);
  assert.equal(browserAgentEvidence([...rows,reply,{role:'assistant',stopReason:'error',errorMessage:'provider failed'}],nonce,3).accepted,false);
});
test('another completed call cannot stand in for an unmatched execution', () => {
  assert.equal(browserAgentEvidence([call('return tool({action:"snapshot"})','pending-1'),result(7,'other-call'),reply],nonce,3).accepted,false);
});
test('intermediate assistant text is not a terminal page-only reply', () => {
  assert.equal(browserAgentEvidence([call('return tool({action:"snapshot"})'),result(3),{...reply,stopReason:'toolUse'}],nonce,3).accepted,false);
});
