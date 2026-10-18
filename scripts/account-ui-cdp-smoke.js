"use strict";
// Run only against an isolated state directory with a user-authorized account.
// Never logs identity, credentials, browser URLs or raw RPC responses.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const {arg,launch,waitForPageTarget,connect,waitForAppReady,waitForSettle,setViewport} = require("./lib/cdp-harness.js");

(async()=>{
  if (!process.env.OPENCLAW_STATE_DIR || process.env.CRYOCLAW_MULTI_INSTANCE !== "1") throw new Error("An isolated test state is required");
  const exe=arg(process.argv,"--exe",path.resolve("out/win32-x64/win-unpacked/CryoClaw.exe"));
  const port=Number(arg(process.argv,"--port","9240"));
  const {cleanup}=launch(exe,port);
  let ws;
  try {
    const page=await waitForPageTarget(port,90000);assert.ok(page,"test window opened");
    const connection=await connect(page);ws=connection.ws;const cdp=connection.cdp;
    assert.ok(await waitForAppReady(cdp,{timeoutMs:150000}),"gateway connected");await setViewport(cdp,1200);
    await cdp.evaluate(`[...document.querySelectorAll('.oc-rail__footer > button.oc-rail__item')].pop()?.click()`);
    await waitForSettle(cdp,500);
    await cdp.evaluate(`[...document.querySelectorAll('.oc-settings-nav-item')].find(e=>/模型|models/i.test(e.textContent))?.click()`);
    await cdp.evaluate(`document.querySelector('details.oc-subscription-account')?.setAttribute('open','')`);
    for(let attempt=0;attempt<80;attempt++) {
      if(await cdp.evaluate(`document.querySelector('.oc-subscription-models select')?.options.length>1 && document.querySelectorAll('.oc-subscription-account progress').length>0`))break;
      if(attempt===35 || attempt===65)await cdp.evaluate(`document.querySelector('.oc-subscription-account .oc-provider-header > button:not(:disabled)')?.click()`);
      await waitForSettle(cdp,1000);
    }
    const status=await cdp.evaluate(`(() => {
      const account=document.querySelector('.oc-subscription-account');
      return {connected:/已连接|Connected/.test(account?.querySelector('.oc-subscription-account__overview')?.textContent??''),
        quota:account?.querySelectorAll('progress').length??0,proxyCollapsed:account?.querySelector('.oc-openai-proxy-details')?.open===false,
        loginCollapsed:account?.querySelector('.oc-subscription-account__signin')?.open===false,
        modelOptions:account?.querySelector('.oc-subscription-models select')?.options.length??0};
    })()`);
    console.log(JSON.stringify(status));
    assert.ok(status.connected,"signed-in account state is visible");
    assert.ok(status.quota>0,"native subscription limits are visible");
    assert.ok(status.proxyCollapsed,"proxy is collapsed by default");
    assert.ok(status.loginCollapsed,"sign-in controls collapse after connection");
    assert.ok(status.modelOptions>1,"model choices are available");
    await cdp.evaluate(`(() => {const details=document.querySelector('.oc-subscription-models');details.open=true;const select=details.querySelector('select');select.value=([...select.options].find(o=>/已配置|Configured/.test(o.textContent)) || [...select.options].find(o=>o.value))?.value;select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitForSettle(cdp,500);
    assert.ok(await cdp.evaluate(`!!document.querySelector('.oc-subscription-models__editor input')`),"model editor is usable");
    if(process.argv.includes("--save-existing")) {
      assert.ok(await cdp.evaluate(`Boolean(document.querySelector('.oc-subscription-models select')?.selectedOptions[0]?.textContent.match(/已配置|Configured/))`),"only save an already configured model");
      await cdp.evaluate(`document.querySelector('.oc-subscription-models__editor button.primary').click()`);
      for(let attempt=0;attempt<30;attempt++) {
        if(await cdp.evaluate(`document.querySelector('.oc-subscription-models')?.open===false`))break;
        await waitForSettle(cdp,1000);
      }
      assert.ok(await cdp.evaluate(`document.querySelector('.oc-subscription-models')?.open===false`),"model settings collapse after saving");
    }
    await cdp.evaluate(`document.querySelector('.oc-subscription-models').open=false`);
    await waitForSettle(cdp,500);
    const collapsed=await cdp.evaluate(`(() => {const el=document.querySelector('.oc-subscription-models'),style=getComputedStyle(el);return {height:el.getBoundingClientRect().height,summary:el.querySelector('summary').getBoundingClientRect().height,padding:parseFloat(style.paddingTop)+parseFloat(style.paddingBottom)+parseFloat(style.borderTopWidth)+parseFloat(style.borderBottomWidth)};})()`);
    assert.ok(collapsed.height<=collapsed.summary+collapsed.padding+2,"collapsed model settings only occupy the summary row");
    const output=path.resolve("out/ui-qa/account-management");fs.mkdirSync(output,{recursive:true});
    const screenshot=await cdp.send("Page.captureScreenshot",{format:"png"});
    fs.writeFileSync(path.join(output,"account.png"),Buffer.from(screenshot.data,"base64"));
    for(const width of [1200,800]) {
      await setViewport(cdp,width);await waitForSettle(cdp,300);
      assert.ok(await cdp.evaluate(`document.documentElement.scrollWidth<=window.innerWidth`),`no horizontal overflow at ${width}px`);
    }
    await cdp.evaluate(`document.querySelector('.oc-rail__nav .oc-rail__item')?.click()`);
    await waitForSettle(cdp,5000);
    assert.ok(await cdp.evaluate(`!!document.querySelector('.chat-quota__trigger')`),"composer quota ring is present");
    await cdp.evaluate(`document.querySelector('.chat-quota__trigger').click()`);
    await waitForSettle(cdp,300);
    assert.ok(await cdp.evaluate(`document.querySelector('.chat-quota__details')?.matches(':popover-open')`),"quota details open");
    await cdp.pressEscape();await waitForSettle(cdp,300);
    assert.ok(await cdp.evaluate(`!document.querySelector('.chat-quota__details')?.matches(':popover-open')`),"quota details close with Escape");
    assert.equal(cdp.exceptions.length,0,"no renderer exceptions");
    console.log(JSON.stringify({...status,rendererExceptions:cdp.exceptions.length,modelCollapse:true,widths:[1200,800]}));
  } finally {ws?.close();cleanup();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
