// Fixtures belong only to the isolated template library, never to a published card.
const sampleDate='2026-01-15';
const quotes={EUR:0.1234,USD:0.1408,JPY:21.55,KRW:196.6};
const priceSeries=[18.2,18.5,18.3,18.9,19.1,18.8,19.4,19.8];
const sampleSystem={preview:true,platform:'Windows · 示例数据',cpuCount:8,cpuModel:'示例 8 核处理器',
 cpuLoad:18,memoryTotal:16*1024**3,memoryFree:9.6*1024**3,diskTotal:512*1024**3,diskFree:286.4*1024**3,
 sampledAt:'2026-01-15T09:30:00.000Z'};

export function previewFixture(id){
 const data={};let state=null;
 if(id==='quick-notes')state={text:'今天的灵感\n\n把常用工具放在眼前，给重要的事留一点空间。\n\n试着编辑这段文字，预览里的修改不会写入正式看板。'};
 if(id==='todo-habits')state={todos:[{text:'整理今天的三个重点',done:true},{text:'留出 25 分钟专注时间',done:false},{text:'散步，给自己一点新想法',done:false}],habits:{}};
 if(id==='fx-rates'){
  data.rates=Object.entries(quotes).map(([quote,rate])=>({date:sampleDate,base:'CNY',quote,rate}));
  data.history=Object.entries(quotes).flatMap(([quote,rate])=>priceSeries.map((value,index)=>({date:`2026-01-${String(8+index).padStart(2,'0')}`,base:'CNY',quote,rate:rate*(1+(value-19)/100)})));
 }
 if(id==='market-watch'){
  data.stocks={data:{diff:[{f12:'600519',f14:'示例 · 贵州茅台',f2:1468.2,f3:1.24,f124:1768469400},
   {f12:'300750',f14:'示例 · 宁德时代',f2:268.4,f3:-0.63,f124:1768469400},
   {f12:'002594',f14:'示例 · 比亚迪',f2:108.65,f3:0.87,f124:1768469400}]}};
  for(const code of ['600519','300750','002594'])data['k'+code]={data:{klines:priceSeries.map((price,index)=>`2026-01-${String(8+index).padStart(2,'0')},${price-.1},${price}`)}};
 }
 if(id==='release-gallery')data.releases=['1.4.0','1.3.2','1.3.0','1.2.1','1.2.0'].map((version,index)=>({
  name:`示例版本 · v${version}`,tag_name:`example-v${version}`,published_at:`2026-01-${String(15-index*2).padStart(2,'0')}T09:30:00Z`,
  body:'示例发布记录，用于预览信息层级与交互效果。',html_url:''}));
 return {state,data,system:sampleSystem};
}

export function systemPreviewDocument(){return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{--paper:#eef6fd;--surface:#ffffff;--ink:#142b3d;--muted:#687883;--accent:#1a6fd0;--line:#d7e7f3;font-family:MiSans,Inter,'Microsoft YaHei UI',sans-serif;color:var(--ink);color-scheme:light}*{box-sizing:border-box}body{margin:0;min-height:100%;padding:clamp(22px,4vw,38px);background:linear-gradient(135deg,var(--paper),var(--surface));display:flex;flex-direction:column;gap:26px}h2,p{margin:0}.heading{display:flex;justify-content:space-between;align-items:center;gap:16px}.heading h2{font-size:clamp(26px,4vw,34px);letter-spacing:-1px}.label{font:11px/1.5 monospace;color:var(--accent);padding:5px 8px;background:var(--paper);border:1px solid var(--line);border-radius:6px}.lead{font-size:13px;line-height:1.7;color:var(--muted);margin-top:7px}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.metric{min-width:0;padding-block:20px;border-top:1px solid var(--line)}.metric>span{font-size:12px;color:var(--muted)}.metric strong{display:block;font:500 clamp(25px,4vw,40px)/1.5 Inter,system-ui,sans-serif;letter-spacing:-1px}.metric small{font-size:11px;font-family:monospace;color:var(--muted)}.track{height:5px;margin-top:15px;border-radius:5px;background:var(--line);overflow:hidden}.track i{display:block;height:100%;background:var(--accent);border-radius:inherit;transition:width .3s}footer{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-top:auto}button{border:0;border-radius:8px;padding:12px 18px;background:var(--ink);color:var(--surface);font:600 13px MiSans,Inter,sans-serif;cursor:pointer;transition:transform .2s,opacity .2s}button:active{transform:scale(.97)}button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}#status{font:11px/1.7 monospace;color:var(--muted);max-width:32em}@media(max-width:480px){.metrics{grid-template-columns:1fr;gap:0}.metric{display:grid;grid-template-columns:1fr auto;gap:4px 16px;padding:15px 0}.metric strong{grid-column:2;grid-row:1/3;font-size:26px}.track{grid-column:1/-1;margin-top:6px}.heading{align-items:flex-start}footer{align-items:stretch;flex-direction:column;gap:14px}body{gap:20px}}@media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head><body data-system-preview><header><div class="heading"><h2>系统状态</h2><span class="label">示例数据</span></div><p class="lead">一眼了解运行状况，需要时再检测。<br>添加到看板后读取这台电脑的真实状态。</p></header><div class="metrics"><div class="metric"><span>CPU</span><strong>18<small>%</small></strong><small>示例 8 核处理器</small><div class="track"><i style="width:18%"></i></div></div><div class="metric"><span>内存占用</span><strong>6.4<small> GB</small></strong><small>16 GB 总内存</small><div class="track"><i style="width:40%"></i></div></div><div class="metric"><span>磁盘可用</span><strong>286<small> GB</small></strong><small>512 GB 总容量</small><div class="track"><i style="width:56%"></i></div></div></div><footer><p id="status" role="status">预览不会访问本机设备或扫描文件。</p><button id="check">演示检测</button></footer><script>document.getElementById('check').onclick=async()=>{await cryoclawDashboard.system();document.getElementById('status').textContent='示例检测完成 · 添加后可检测本机真实状态';document.getElementById('check').textContent='再次演示';};</script></body></html>`;}
