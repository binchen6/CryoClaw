'use strict';
const {app,BrowserWindow,ipcMain} = require('electron');
const http=require('node:http'), fs=require('node:fs'), path=require('node:path');
const root=path.resolve(__dirname,'../..'), out=path.resolve(process.env.CRYOCLAW_BROWSER_QA_OUT);
app.setPath('userData',path.join(out,'profile'));
app.setAppPath(root);
process.env.OPENCLAW_STATE_DIR=path.join(out,'state');
const token=process.env.CRYOCLAW_BROWSER_QA_TOKEN;
let server;
app.whenReady().then(async()=>{
  const {registerEmbeddedBrowserIpc,controlEmbeddedBrowser}=require('../../dist/embedded-browser');
  const {createGatewayControlRequestHandler}=require('../../dist/gateway-control-server');
  registerEmbeddedBrowserIpc();
  const window=new BrowserWindow({width:840,height:1100,webPreferences:{preload:path.join(__dirname,'browser-ui-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  ipcMain.handle('browser-qa:native-bounds',()=>window.contentView.children.filter(view=>view.webContents && view.webContents!==window.webContents).map(view=>({url:view.webContents.getURL(),bounds:view.getBounds(),visible:view.getVisible?.(),ownerVisible:window.isVisible(),ownerBounds:window.getContentBounds()})));
  const handler=createGatewayControlRequestHandler({getStatus:()=>({running:false,pid:null,port:0,uptimeMs:null}),restart:async()=>{},browserUi:(payload,signal)=>controlEmbeddedBrowser(window,payload,()=>window.webContents.send('embedded-browser:agent-open'),signal)},token);
  server=http.createServer((req,res)=>{
    if(req.url.startsWith('/ui/'))return handler(req,res);
    if(req.url==='/download'){res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':'attachment; filename="qa.txt"'});res.end('qa');return;}
    res.writeHead(200,{'content-type':'text/html;charset=utf-8'});
    res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Browser QA</title><style>body{font:16px system-ui;padding:30px}button,input,select{font:inherit;margin:8px;padding:10px}#target{border:1px solid gray;padding:20px}</style><h1>Shared browser fixture</h1><button onclick="document.body.dataset.clicked='first'">First</button><button onclick="document.body.dataset.clicked='second'">Second</button><input placeholder="Your name"><input type="password" value="do-not-expose"><select><option value="a">A</option><option value="b">B</option></select><div id="target" class="card important" role="button" tabindex="0">Annotate this element</div><a target="_blank" href="/next">Next tab</a><a href="/download">Download</a><button style="display:none">Hidden</button><script>window.changes=[];document.querySelector('input').addEventListener('input',e=>changes.push(e.target.value));</script>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  fs.writeFileSync(path.join(out,'endpoint.json'),JSON.stringify({port}));
  await window.loadFile(path.join(root,'chat-ui/dist/index.html'),{query:{lang:'zh',gatewayUrl:'ws://127.0.0.1:0',qaMarker:process.env.CRYOCLAW_BROWSER_QA_TOKEN}});
});
app.on('window-all-closed',()=>{server?.closeAllConnections();server?.close();app.quit();});
