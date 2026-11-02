// Real Tencent pre-scan only: never supplies test credentials to the user's app.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { arg, waitForPageTarget, connect, sleep } = require('./lib/cdp-harness');
async function main() {
  const port = Number(arg(process.argv, '--attach-port', '9372'));
  const out = path.resolve(arg(process.argv, '--out', 'out/installed-qqbot-qa'));
  fs.mkdirSync(out, { recursive: true });
  const configPath = path.join(process.env.OPENCLAW_STATE_DIR || path.join(process.env.USERPROFILE, '.openclaw'), 'openclaw.json');
  const hash = () => createHash('sha256').update(fs.readFileSync(configPath)).digest('hex');
  const report = { ok: false, authentication: 'pre-scan only', checks: [] };
  const pass = name => { report.checks.push(name); console.log('PASS ' + name); };
  let ws, cdp;
  const until = async (expression, label, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    while (!await cdp.evaluate(expression)) { assert.ok(Date.now() < deadline, label); await sleep(100); }
  };
  try {
    const page = await waitForPageTarget(port); assert.ok(page, 'Installed target');
    ({ ws, cdp } = await connect(page));
    await cdp.send('Page.bringToFront');
    await cdp.evaluate("(()=>{const app=document.querySelector('openclaw-app');window.__qqReleaseView=app.settings.cryoclawView;app.settingsTabHint='channels';app.applySettings({...app.settings,cryoclawView:'settings'});app.requestUpdate();return true})()");
    await until("!!document.querySelector('[data-page-nav=\"settings:channels:qqbot\"]')", 'Channel navigation');
    await cdp.evaluate("document.querySelector('[data-page-nav=\"settings:channels:qqbot\"]').click();true");
    await until("document.querySelector('[data-page-id=\"settings:channels:qqbot\"]')?.dataset.loadState==='ready'", 'Real QQ settings loaded', 45000);
    pass('installed QQ settings loads migrated account configuration');
    const before = hash();
    await cdp.evaluate("(()=>{const select=document.querySelector('#qqbot-setup-mode');if(!select)throw Error('QQ setup selector missing');window.__qqReleaseMode=select.value;select.value='qr';select.dispatchEvent(new Event('change',{bubbles:true}));return true})()");
    await until("!!document.querySelector('[data-page-id=\"settings:channels:qqbot\"] .oc-settings__card .btn.primary')",'QR setup action available');
    await cdp.evaluate("document.querySelector('[data-page-id=\"settings:channels:qqbot\"] .oc-settings__card .btn.primary').click();true");
    await until("(()=>{const image=document.querySelector('.oc-weixin-qr-image');return image?.complete && image.naturalWidth>0 && image.src.startsWith('data:image/svg+xml;base64,')})()", 'Real Tencent QR rendered');
    pass('installed official connector generates a real local SVG QR');
    fs.writeFileSync(path.join(out, 'qqbot-prescan.png'), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: false })).data, 'base64'));
    await cdp.evaluate("(()=>{const root=document.querySelector('[data-page-id=\"settings:channels:qqbot\"]');const cancel=[...root.querySelectorAll('.oc-settings__card .btn-row button')].find(b=>!b.classList.contains('primary'));if(!cancel)throw Error('QR cancel button missing');cancel.click();return true})()");
    await until("!document.querySelector('.oc-weixin-qr-image')", 'QR canceled');
    await sleep(500);
    assert.equal(hash(), before, 'Pre-scan/cancel must not write channel credentials');
    pass('cancel clears QR and leaves user configuration unchanged');
    assert.equal(cdp.exceptions.length, 0); pass('zero renderer exceptions');
    report.ok = true;
  } catch (error) { report.error = String(error.stack || error); throw error; }
  finally {
    if (cdp) await cdp.evaluate("(()=>{const select=document.querySelector('#qqbot-setup-mode');if(select){select.value=window.__qqReleaseMode||'qr';select.dispatchEvent(new Event('change',{bubbles:true}));}const app=document.querySelector('openclaw-app');app.applySettings({...app.settings,cryoclawView:window.__qqReleaseView||'chat'});app.requestUpdate();delete window.__qqReleaseView;delete window.__qqReleaseMode;return true})()").catch(error => { report.cleanupError = error.message; process.exitCode = 1; });
    ws?.close();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log('Report ' + out);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
