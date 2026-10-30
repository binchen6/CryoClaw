# Card recipes

Copy these patterns, then adapt copy, data and sizes. Every recipe is a complete document; keep
the `<!doctype html>` and inline styles. Read [design-system.md](design-system.md) for tokens and
[layout-and-sizing.md](layout-and-sizing.md) for target sizes.

## 1. Metric row with sparkline

```html
<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;padding:22px 24px;font-family:MiSans,Inter,"Microsoft YaHei UI",system-ui,sans-serif;color:#0f1216;background:#fff}
h2{margin:0 0 10px;font-size:14px;font-weight:650}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.cell{display:flex;flex-direction:column;gap:2px}
.label{font-size:10px;letter-spacing:.08em;color:#8a949c}
.value{font:700 22px/1.1 ui-monospace,monospace;font-variant-numeric:tabular-nums}
.note{font-size:10px;color:#8a949c}.up{color:#12b981}.down{color:#dc2626}
svg{width:100%;height:44px;display:block;margin-top:6px}
@media(max-width:420px){.grid{grid-template-columns:1fr}}
</style></head><body>
<h2>本周概览</h2>
<div class="grid">
  <div class="cell"><span class="label">完成</span><strong class="value">18</strong><span class="note up">+12% 较上周</span></div>
  <div class="cell"><span class="label">进行中</span><strong class="value">4</strong><span class="note">2 项今日到期</span></div>
  <div class="cell"><span class="label">逾期</span><strong class="value">1</strong><span class="note down">需要处理</span>
    <svg viewBox="0 0 120 40" aria-hidden="true"><path d="M2 34 L20 30 L38 20 L56 26 L74 14 L92 18 L118 6" fill="none" stroke="#168aff" stroke-width="2"/></svg>
  </div>
</div>
</body></html>
```

## 2. Notes with local state

```html
<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:22px 24px;font-family:MiSans,Inter,system-ui,sans-serif;color:#0f1216;background:linear-gradient(145deg,#eaf6ff,#fff)}
h2{margin:0;font-size:16px;font-weight:750}p{font-size:11px;color:#69727a;margin:4px 0 10px}
textarea{width:100%;min-height:140px;padding:12px;border:1px solid #d5e9f7;border-radius:12px;background:#fffffff0;font:13px/1.7 inherit;color:#123a4d;resize:vertical;outline:none}
textarea:focus{border-color:#168aff;box-shadow:0 0 0 3px #168aff18}
.status{display:flex;justify-content:space-between;margin-top:8px;font-size:10px;color:#8a949c}
</style></head><body>
<h2>随手记</h2><p>只保存在这张卡片里，不会自动发送。</p>
<textarea id="note" maxlength="4000" placeholder="记录一个想法、链接或下一步…"></textarea>
<div class="status"><span id="count">0 / 4000</span><span id="save" role="status">读取本机状态…</span></div>
<script>
var field=document.getElementById('note'),status=document.getElementById('save'),count=document.getElementById('count'),timer,edited=false,queue=Promise.resolve();
function draw(){count.textContent=field.value.length+' / 4000';}
function persist(){clearTimeout(timer);var value=field.value;status.textContent='保存中…';queue=queue.catch(function(){}).then(function(){return cryoclawDashboard.setState({text:value});}).then(function(){status.textContent=field.value===value?'已保存到本机':'有修改待保存';}).catch(function(){status.textContent='保存失败，失焦时重试';});}
field.addEventListener('input',function(){edited=true;draw();status.textContent='编辑中…';clearTimeout(timer);timer=setTimeout(persist,350);});
field.addEventListener('blur',persist);
cryoclawDashboard.getState().then(function(value){if(!edited&&value&&typeof value.text==='string')field.value=value.text.slice(0,4000);draw();status.textContent='本机自动保存';}).catch(function(){draw();status.textContent='本机状态暂不可用';});
draw();
</script></body></html>
```

## 3. Checklist with progress

```html
<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:22px 24px;font-family:MiSans,Inter,system-ui,sans-serif;color:#0f1216;background:#fff}
h2{margin:0 0 2px;font-size:15px}.meta{display:flex;justify-content:space-between;font-size:10px;color:#8a949c}
.bar{height:6px;border-radius:6px;background:#eef3f7;overflow:hidden;margin:8px 0 12px}.bar i{display:block;height:100%;background:#168aff;border-radius:inherit;transition:width .2s ease}
ul{list-style:none;margin:0;padding:0}li{display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px solid #f2f6f9;font-size:12px}
li:first-child{border-top:0}button{width:18px;height:18px;border-radius:50%;border:1.5px solid #cfe0ea;background:#fff;flex:none}
li.done button{background:#0f1216;border-color:#0f1216}li.done span{color:#9aa7b2;text-decoration:line-through}
</style></head><body>
<h2>今日待办</h2><div class="meta"><span id="done">0 / 3</span><span id="hint">勾选后自动保存</span></div>
<div class="bar"><i id="fill" style="width:0%"></i></div>
<ul id="list"></ul>
<script>
var items=[{id:'a',text:'整理灵感',done:false},{id:'b',text:'回复邮件',done:false},{id:'c',text:'收尾归档',done:false}],list=document.getElementById('list'),done=document.getElementById('done'),fill=document.getElementById('fill'),hint=document.getElementById('hint');
function draw(){list.innerHTML='';items.forEach(function(item){var li=document.createElement('li');li.className=item.done?'done':'';var button=document.createElement('button');button.setAttribute('aria-label',item.text);button.onclick=function(){item.done=!item.done;draw();save();};var span=document.createElement('span');span.textContent=item.text;li.appendChild(button);li.appendChild(span);list.appendChild(li);});var count=items.filter(function(item){return item.done;}).length;done.textContent=count+' / '+items.length;fill.style.width=(count/items.length*100)+'%';}
function save(){hint.textContent='保存中…';cryoclawDashboard.setState({items:items}).then(function(){hint.textContent='已保存到本机';}).catch(function(){hint.textContent='保存失败，请重试';});}
cryoclawDashboard.getState().then(function(value){if(value&&Array.isArray(value.items))items=value.items;draw();}).catch(draw);
</script></body></html>
```

## 4. Public data with provenance

```html
<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:22px 24px;font-family:MiSans,Inter,system-ui,sans-serif;color:#0f1216;background:#fff}
h2{margin:0;font-size:14px}.value{font:750 30px/1.15 ui-monospace,monospace;margin:6px 0 2px}
.row{display:flex;justify-content:space-between;font-size:10px;color:#8a949c}.stale{color:#d97706}
button{margin-top:10px;padding:7px 12px;border:1px solid #e2e8ee;border-radius:9px;background:#fff;font:inherit;font-size:11px;cursor:pointer}
</style></head><body>
<h2>汇率</h2><div class="value" id="value">—</div>
<div class="row"><span id="source">尚未读取</span><span id="time"></span></div>
<button id="reload" type="button">重新读取</button>
<script>
var value=document.getElementById('value'),source=document.getElementById('source'),time=document.getElementById('time'),button=document.getElementById('reload'),last=null;
function render(){if(!last){value.textContent='—';return;}value.textContent=last.amount;source.textContent=last.source||'公开数据';time.textContent=last.fetchedAt?new Date(last.fetchedAt).toLocaleTimeString():'';}
async function load(){button.disabled=true;try{var snapshot=await cryoclawDashboard.data('rates');var rate=snapshot.value&&snapshot.value.rates&&snapshot.value.rates.CNY;if(typeof rate!=='number')throw Error('返回数据缺少 CNY 汇率');last={amount:rate.toFixed(4),source:snapshot.source,fetchedAt:snapshot.fetchedAt};source.classList.remove('stale');}catch(error){if(last){source.textContent='已过期 · '+(last.source||'上次数据');source.classList.add('stale');}else{value.textContent='—';source.textContent='读取失败：'+error.message;}}finally{button.disabled=false;render();}}
button.onclick=load;load();
</script></body></html>
```

Publish it with a declared source:

```json
{ "dataSources": [{ "id": "rates", "url": "https://api.example.org/rates.json", "format": "json", "refreshSeconds": 300 }] }
```

## 5. Progress ring

```html
<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:20px 22px;font-family:MiSans,Inter,system-ui,sans-serif;display:flex;align-items:center;gap:16px;background:#fff;color:#0f1216}
svg{width:78px;height:78px;flex:none;overflow:visible}
.track,.fill{fill:none;stroke-width:7}.track{stroke:#eef3f7}.fill{stroke:#168aff;stroke-linecap:round;transform:rotate(-90deg);transform-origin:center}
strong{display:block;font:750 24px/1.1 ui-monospace,monospace}span{font-size:10px;color:#8a949c}
</style></head><body>
<svg viewBox="0 0 80 80" role="img" aria-label="完成 67%"><circle class="track" cx="40" cy="40" r="32" pathLength="100"></circle><circle class="fill" cx="40" cy="40" r="32" pathLength="100" stroke-dasharray="67 100"></circle></svg>
<div><strong>67%</strong><span>8 / 12 完成<br>9月27日上线</span></div>
</body></html>
```

## 6. Empty, loading and error states

```html
<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:22px 24px;font-family:MiSans,Inter,system-ui,sans-serif;color:#0f1216;background:#fff}
.state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:160px;text-align:center;border:1px dashed #dfe7ee;border-radius:14px;color:#8a949c;font-size:11px}
.state b{color:#0f1216;font-size:13px}
.skeleton{height:10px;border-radius:6px;background:#eef3f7;animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{50%{opacity:.45}}
</style></head><body>
<div class="state"><b>还没有数据</b><span>关联任务或点击右上角刷新后再试。</span></div>
<!-- loading: <div class="state"><div class="skeleton" style="width:60%"></div><div class="skeleton" style="width:40%"></div></div> -->
<!-- error:   <div class="state"><b>读取失败</b><span>保留上一次数据，09:12 更新。</span></div> -->
</body></html>
```

## Checklist for every card

- One headline, one primary idea, one action at most.
- Numbers in tabular numerals with units and a time window.
- Loading, empty, error and stale states.
- `@media (max-width: 420px)` and a short-height layout.
- No external requests except declared sources/assets; no secrets.
- State saved on edit/blur, never per keystroke or animation frame.
