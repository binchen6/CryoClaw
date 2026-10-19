"use strict";
const https=require("node:https"),http=require("node:http"),crypto=require("node:crypto");

// One deadline covers redirects; idle timeouts also cover a response body that stops arriving.
function consume(url,{headers=()=>({}),timeoutMs=30_000,totalMs=600_000,maxBytes=4*1024*1024,maxRedirects=5,allowHttp=false,onChunk=()=>{}}={}){
  const deadline=Date.now()+totalMs;
  function request(current,remaining){
    return new Promise((resolve,reject)=>{
      const target=new URL(current);
      if(target.protocol!=="https:" && !(allowHttp && target.protocol==="http:"))return reject(Error("Release downloads require HTTPS"));
      const totalLeft=deadline-Date.now();if(totalLeft<=0)return reject(Error("Release download deadline exceeded"));
      let response,settled=false,size=0;
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){response?.destroy();req.destroy();reject(error);}else resolve(value);};
      const req=(target.protocol==="https:"?https:http).get(target,{headers:headers(current)},res=>{
        response=res;
        res.on("error",error=>finish(error));
        if([301,302,303,307,308].includes(res.statusCode)){
          res.resume();
          if(!res.headers.location)return finish(Error("Redirect is missing Location"));
          if(remaining===0)return finish(Error("Too many release download redirects"));
          let next;try{next=new URL(res.headers.location,current).href;}catch(error){return finish(error);}
          clearTimeout(timer);settled=true;req.setTimeout(0);res.destroy();
          request(next,remaining-1).then(resolve,reject);return;
        }
        if(res.statusCode!==200)return finish(Error(`Release download HTTP ${res.statusCode}`));
        if(Number(res.headers["content-length"])>maxBytes)return finish(Error("Release download exceeds byte limit"));
        res.on("data",chunk=>{
          size+=chunk.length;
          if(size>maxBytes)return finish(Error("Release download exceeds byte limit"));
          try{onChunk(chunk);}catch(error){finish(error);}
        });
        res.on("aborted",()=>finish(Error("Release download was truncated")));
        res.on("end",()=>finish(null,{size}));
      });
      const timer=setTimeout(()=>finish(Error("Release download deadline exceeded")),totalLeft);
      req.setTimeout(timeoutMs,()=>finish(Error("Release download idle timeout")));
      req.on("error",error=>finish(error));
    });
  }
  return request(url,maxRedirects);
}
async function fetchBytes(url,options={}){
  const chunks=[];await consume(url,{...options,onChunk:chunk=>chunks.push(chunk)});return Buffer.concat(chunks);
}
async function hashDownload(url,options={}){
  const sha512=crypto.createHash("sha512");
  const result=await consume(url,{...options,onChunk:chunk=>sha512.update(chunk)});
  return {...result,sha512:sha512.digest("base64")};
}
module.exports={fetchBytes,hashDownload};
