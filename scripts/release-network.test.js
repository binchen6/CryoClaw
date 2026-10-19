const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto');
const {fetchBytes,hashDownload}=require('./lib/release-network');
async function server(t,handler){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>{s.closeAllConnections();s.close();});return `http://127.0.0.1:${s.address().port}`;}
test('release downloads bound idle time even after response headers arrive',async t=>{
  const url=await server(t,(_q,r)=>{r.writeHead(200);r.write('partial');});
  await assert.rejects(fetchBytes(url,{allowHttp:true,timeoutMs:30}),/idle timeout/);
});
test('release downloads reject redirect loops and missing locations',async t=>{
  const url=await server(t,(q,r)=>{r.writeHead(302,q.url==='/missing'?{}:{Location:'/loop'});r.end();});
  await assert.rejects(fetchBytes(url,{allowHttp:true,maxRedirects:2}),/Too many/);
  await assert.rejects(fetchBytes(url+'/missing',{allowHttp:true}),/missing Location/);
});
test('release downloads reject both announced and streamed oversized bodies',async t=>{
  const url=await server(t,(q,r)=>{if(q.url==='/length')r.setHeader('Content-Length','100');r.end('123456789');});
  for(const suffix of ['/length','/stream'])await assert.rejects(fetchBytes(url+suffix,{allowHttp:true,maxBytes:4}),/byte limit/);
});
test('deep verification hashes chunked data without retaining an installer buffer',async t=>{
  const data=Buffer.alloc(256*1024,123),url=await server(t,(_q,r)=>{r.write(data.subarray(0,100));r.end(data.subarray(100));});
  assert.deepEqual(await hashDownload(url,{allowHttp:true,maxBytes:data.length}),{size:data.length,sha512:crypto.createHash('sha512').update(data).digest('base64')});
});
test('release download deadline bounds a slow but continuously active server',async t=>{
  const url=await server(t,(_q,r)=>{const timer=setInterval(()=>r.write('a'),5);r.on('close',()=>clearInterval(timer));});
  await assert.rejects(fetchBytes(url,{allowHttp:true,totalMs:40,timeoutMs:100}),/deadline/);
});
test('production release downloads refuse insecure transports',async()=>{
  await assert.rejects(fetchBytes('http://example.test'),/HTTPS/);
});

test('truncated release payloads reject rather than validating partial data',async t=>{
  const url=await server(t,(_q,r)=>{r.writeHead(200,{'Content-Length':'100'});r.write('short');setTimeout(()=>r.destroy(),10);});
  await assert.rejects(hashDownload(url,{allowHttp:true}),/truncated|aborted|reset/i);
});
