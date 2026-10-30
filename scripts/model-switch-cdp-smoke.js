"use strict";

// Attach-only: exercises the rendered session picker without invoking a provider.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { arg, connect, waitForPageTarget, waitForAppReady, sleep } = require("./lib/cdp-harness");

async function main(argv = process.argv) {
  assert.ok(argv.includes("--attach-port"), "Pass --attach-port <existing app CDP port>; this script never launches an app");
  const port = Number(arg(argv, "--attach-port"));
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536, "Invalid attach port");
  const delayMs = Number(arg(argv, "--diagnostic-delay-ms", "0"));
  assert.ok(Number.isInteger(delayMs) && delayMs >= 0 && delayMs <= 5000, "Diagnostic delay must be 0..5000 ms");
  const key = `agent:main:release-smoke-${Date.now()}`;
  const hook = `__modelSwitchQA_${randomUUID().replaceAll("-", "")}`;
  const out = path.resolve(arg(argv, "--out", `out/ui-qa/model-switch-${Date.now()}`));
  fs.mkdirSync(out, { recursive: true });
  const report = {
    startedAt: new Date().toISOString(), port, ok: false, status: "starting",
    ownership: { sessionKey: key, agentId: "main", createAttempted: false, created: false, cleanupVerified: false },
    scope: "Rendered session model selection only; no chat.send, config.patch, provider edits or default-model changes",
    nativeSwitches: [], diagnostic: delayMs ? { simulated: true, delayMs, switches: [] } : { skipped: "No simulated ACK delay requested" },
  };
  const write = () => fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(out, "qa-fixtures.json"), JSON.stringify({ sessionKey: key, agentId: "main", owner: "model-switch-cdp-smoke", deleteTranscript: true }, null, 2));
  write(); // Ownership exists even if the process stops while sessions.create is awaiting its ACK.
  let ws, cdp, originalSession, originalView, originalNavCollapsed, configBefore, fixtureOwned = false, failure;
  const q = JSON.stringify;
  const app = "document.querySelector('openclaw-app')";
  const qa = `window[${q(hook)}]`;
  async function until(expression, label, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await cdp.evaluate(expression)) return;
      await sleep(40);
    }
    throw new Error(`Timed out: ${label}`);
  }
  async function pointer(expression) {
    await cdp.evaluate(`(()=>{const b=${expression};if(!b)throw Error('Missing pointer target');b.scrollIntoView({block:'nearest'});return true;})()`);
    let point;
    const deadline = Date.now() + 3000;
    do {
      point = await cdp.evaluate(`(()=>{const b=${expression};if(!b||b.disabled)return null;const r=b.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return{x,y,hit:b.contains(document.elementFromPoint(x,y)),inside:x>=0&&y>=0&&x<innerWidth&&y<innerHeight};})()`);
      if (point?.hit && point.inside) break;
      await sleep(30);
    } while (Date.now() < deadline);
    assert.ok(point?.hit && point.inside, "Pointer target receives input");
    const { x, y } = point;
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }
  async function openPicker() {
    if (!await cdp.evaluate("!!document.querySelector('oc-model-picker [role=menu]:popover-open')")) {
      await pointer("document.querySelector('oc-model-picker button[aria-haspopup=menu]')");
    }
    await until("!!document.querySelector('oc-model-picker [role=menu]:popover-open')", "picker opens");
  }
  async function openChatPanel() {
    await cdp.evaluate(`(()=>{const a=${app};if(a.settings.navCollapsed)a.applySettings({...a.settings,navCollapsed:false});const rail=document.querySelector('oc-rail');if(!rail)throw Error('Chat rail unavailable');rail.props.onOpenChat();return true;})()`);
    await until("!!document.querySelector('oc-session-panel')", "chat session panel opens");
  }
  async function choose(model, records) {
    await openPicker();
    // Model names must be unique below: the accessible option has no model-key attribute.
    const option = `[...document.querySelectorAll('oc-model-picker [data-page=models] [role=menuitemradio]')].find(b=>b.querySelector('span')?.textContent===${q(model.name)})`;
    await cdp.evaluate(`${qa}.clickStartedAt=performance.now();true`);
    await pointer(option);
    const selection = await cdp.evaluate(`(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const p=document.querySelector('oc-model-picker'),a=${app},observedAt=performance.now();return{key:p?.value,trigger:p?.querySelector('button[aria-haspopup=menu] span')?.textContent,rowModel:a.sessionsResult?.sessions.find(s=>s.key===${q(key)})?.model,observedAt,uiObservedMs:observedAt-${qa}.clickStartedAt,patchCount:${qa}.records.length};})()`);
    records.push({ requested: model.key, ...selection }); write();
    assert.equal(selection.key, model.key, "Rendered picker immediately reflects the chosen model");
    assert.equal(selection.trigger, model.name, "Visible trigger immediately reflects the chosen model");
    assert.equal(selection.rowModel, model.key, "Active session projection immediately reflects the choice");
    await openPicker();
    assert.equal(await cdp.evaluate(`(${option})?.getAttribute('aria-checked')`), "true", "Real picker marks the chosen option checked");
    await cdp.pressEscape();
  }
  async function waitAcknowledged(expectedCount) {
    await until(`${qa}.records.length>=${expectedCount}&&${qa}.records.every(r=>r.settledAt!==undefined)`, "session model patch ACKs", 45000);
    const records = await cdp.evaluate(`${qa}.records`);
    assert.ok(records.every(r => r.ok), "Every model patch is acknowledged successfully");
  }
  async function persisted(model) {
    const row = await cdp.evaluate(`${app}.client.request('sessions.list',{includeGlobal:true,includeUnknown:true}).then(r=>{const s=r.sessions?.find(s=>s.key===${q(key)});return s?{model:s.model,provider:s.modelProvider}:null;})`);
    assert.ok(row, "Owned fixture is returned by backend sessions.list");
    const slash = model.key.indexOf("/");
    assert.ok(row.model === model.key || (row.model === model.key.slice(slash + 1) && row.provider === model.key.slice(0, slash)), `Backend model matches ${model.key}: ${JSON.stringify(row)}`);
    return row;
  }
  try {
    const page = await waitForPageTarget(port, 15000); assert.ok(page, "Existing app CDP page");
    ({ ws, cdp } = await connect(page));
    assert.ok(await waitForAppReady(cdp, { timeoutMs: 60000 }), "App connected and ready");
    originalSession = await cdp.evaluate(`${app}.sessionKey`);
    originalView = await cdp.evaluate(`${app}.settings.cryoclawView??'chat'`);
    originalNavCollapsed = await cdp.evaluate(`${app}.settings.navCollapsed`);
    assert.ok(originalSession, "Original user session captured");
    report.originalSession = originalSession; report.originalView = originalView; write();
    const models = await cdp.evaluate(`${app}.configuredModels.map(m=>({key:m.key,name:m.name}))`);
    const usable = models.filter((m, i) => m.key && m.name && models.findIndex(n => n.key === m.key) === i && models.filter(n => n.name === m.name).length === 1);
    report.configuredModelCount = models.length;
    if (usable.length < 2) {
      report.status = "skipped"; report.skipReason = "Fewer than two configured models with uniquely identifiable picker labels"; write();
    } else {
      report.models = usable.slice(0, 2);
      configBefore = await cdp.evaluate(`${app}.client.request('config.get',{}).then(r=>JSON.stringify({providers:r.config?.models?.providers,agents:r.config?.agents}))`);
      const exists = await cdp.evaluate(`${app}.client.request('sessions.list',{includeGlobal:true,includeUnknown:true}).then(r=>r.sessions?.some(s=>s.key===${q(key)}))`);
      assert.equal(exists, false, "Exact fixture key did not exist before this run");
      fixtureOwned = true; report.ownership.createAttempted = true; write();
      await cdp.evaluate(`${app}.client.request('sessions.create',{key:${q(key)},agentId:'main',displayName:'Model switch verification'},{timeoutMs:45000})`, { timeoutMs: 55000 });
      report.ownership.created = true; write();
      await openChatPanel();
      await cdp.evaluate(`document.querySelector('oc-session-panel').props.onSelectSession(${q(key)});true`);
      await until(`${app}.sessionKey===${q(key)}&&!${app}.chatLoading&&!!document.querySelector('oc-model-picker button[aria-haspopup=menu]')`, "Owned QA session rendered");
      await cdp.evaluate(`(()=>{const a=${app},client=a.client,original=client.request;const state={client,original,records:[],pending:new Set(),delayMs:0};window[${q(hook)}]=state;client.request=function(method,params,...rest){if(method!=='sessions.patch'||params?.key!==${q(key)}||typeof params.model!=='string')return original.call(this,method,params,...rest);const rec={model:params.model,startedAt:performance.now(),simulatedDelayMs:state.delayMs};state.records.push(rec);const promise=(async()=>{try{const result=await original.call(this,method,params,...rest);rec.nativeAckAt=performance.now();rec.nativeAckMs=rec.nativeAckAt-rec.startedAt;if(rec.simulatedDelayMs)await new Promise(r=>setTimeout(r,rec.simulatedDelayMs));rec.ok=true;return result;}catch(e){rec.ok=false;rec.error=String(e);throw e;}finally{rec.settledAt=performance.now();}})();state.pending.add(promise);promise.then(()=>state.pending.delete(promise),()=>state.pending.delete(promise));return promise;};return true;})()`);
      for (const model of [usable[0], usable[1], usable[0]]) {
        await choose(model, report.nativeSwitches);
        await waitAcknowledged(report.nativeSwitches.length);
        report.nativeSwitches.at(-1).backend = await persisted(model); write();
      }
      report.nativePatchTimings = await cdp.evaluate(`${qa}.records`);
      if (delayMs) {
        const offset = report.nativePatchTimings.length;
        await cdp.evaluate(`${qa}.delayMs=${delayMs};true`);
        for (const model of [usable[1], usable[0]]) await choose(model, report.diagnostic.switches);
        await waitAcknowledged(offset + 2);
        report.diagnostic.backend = await persisted(usable[0]);
        report.diagnostic.patchTimings = (await cdp.evaluate(`${qa}.records`)).slice(offset);
        assert.deepEqual(report.diagnostic.patchTimings.map(r => r.model), [usable[1].key, usable[0].key], "Queued own-session patches reach gateway in selection order");
        report.diagnostic.checkedBeforeDelayedAck = report.diagnostic.switches.every((s, i) => s.observedAt < report.diagnostic.patchTimings[i].settledAt);
        assert.ok(report.diagnostic.checkedBeforeDelayedAck, "Diagnostic UI checks completed during simulated ACK delay; rerun with a larger delay if the machine was busy");
      }
      report.rendererExceptions = cdp.exceptions;
      assert.equal(cdp.exceptions.length, 0, "No renderer exceptions during picker QA");
      report.status = "passed"; report.ok = true;
    }
  } catch (error) {
    failure = error; report.status = "failed"; report.error = String(error.stack ?? error);
  } finally {
    if (cdp) {
      try {
        // Drain queued fixture patches before restoring the request method or deleting the fixture.
        await cdp.evaluate(`(async()=>{const s=${qa};if(!s)return true;const deadline=Date.now()+45000;let idle=0;while(Date.now()<deadline){if(s.pending.size){idle=0;await Promise.allSettled([...s.pending]);}else if(++idle>=3)break;await new Promise(r=>setTimeout(r,50));}if(s.pending.size)throw Error('Fixture model patches still pending');return true;})()`, { timeoutMs: 55000 });
      } catch (error) { report.drainError = String(error); report.ok = false; }
      try {
        await cdp.evaluate(`(()=>{const s=${qa};if(s){s.client.request=s.original;delete window[${q(hook)}];}return true;})()`);
        report.requestHookRestored = true;
      } catch (error) { report.hookRestoreError = String(error); report.ok = false; }
      if (fixtureOwned) {
        try {
          await openChatPanel();
          await cdp.evaluate(`(async()=>{const a=${app};document.querySelector('oc-session-panel').props.onSelectSession(${q(originalSession)});await a.updateComplete;if(a.sessionKey!==${q(originalSession)})throw Error('Original session was not restored');return true;})()`);
          report.originalSessionRestored = true;
        } catch (error) { report.restoreError = String(error); report.ok = false; }
        try {
          assert.match(key, /^agent:main:release-smoke-\d+$/);
          await cdp.evaluate(`${app}.client.request('sessions.delete',{key:${q(key)},agentId:'main',deleteTranscript:true})`);
          report.ownership.cleanupVerified = await cdp.evaluate(`${app}.client.request('sessions.list',{includeGlobal:true,includeUnknown:true}).then(r=>!r.sessions?.some(s=>s.key===${q(key)}))`);
          assert.equal(report.ownership.cleanupVerified, true, "Only owned fixture removed from backend");
          await cdp.evaluate(`(()=>{const a=${app};a.sessionsResult={...a.sessionsResult,sessions:(a.sessionsResult?.sessions??[]).filter(s=>s.key!==${q(key)})};a.requestUpdate();return true;})()`);
        } catch (error) { report.cleanupError = String(error); report.ok = false; }
      }
      if (configBefore !== undefined) {
        try {
          const configAfter = await cdp.evaluate(`${app}.client.request('config.get',{}).then(r=>JSON.stringify({providers:r.config?.models?.providers,agents:r.config?.agents}))`);
          report.globalModelsUnchanged = configAfter === configBefore;
          assert.ok(report.globalModelsUnchanged, "Provider configuration and agent defaults unchanged");
        } catch (error) { report.configVerificationError = String(error); report.ok = false; }
      }
      if (fixtureOwned && originalView) {
        await cdp.evaluate(`(()=>{const a=${app};a.applySettings({...a.settings,cryoclawView:${q(originalView)},navCollapsed:${q(originalNavCollapsed)}});return true;})()`).catch(error => { report.viewRestoreError = String(error); report.ok = false; });
      }
    }
    ws?.close(); report.finishedAt = new Date().toISOString();
    if (report.status === "passed" && !report.ok) report.status = "failed";
    write();
  }
  console.log(JSON.stringify({ status: report.status, ok: report.ok, out, sessionKey: key, cleaned: report.ownership.cleanupVerified, skipReason: report.skipReason }));
  if (failure) throw failure;
  if (report.status === "failed") throw new Error("Model picker QA or cleanup failed; inspect report.json");
  return report;
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
