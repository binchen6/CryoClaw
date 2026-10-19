"use strict";
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
async function verifyLocalAssets(assets,directory,names,sha512ByName={}){
  for(const name of names){
    if(path.basename(name)!==name)throw Error("Invalid local asset name");
    const asset=assets.find(a=>a.name===name);
    if(!asset || asset.state!=="uploaded" || !/^sha256:[a-f0-9]{64}$/.test(asset.digest??""))throw Error(`Missing uploaded server digest: ${name}`);
    const file=path.resolve(directory,name),hash=crypto.createHash("sha256"),sha512=crypto.createHash("sha512");
    let size=0;
    for await(const chunk of fs.createReadStream(file)){size+=chunk.length;hash.update(chunk);sha512.update(chunk);}
    if(asset.size!==size || asset.digest!==`sha256:${hash.digest("hex")}`)throw Error(`Local/server asset mismatch: ${name}`);
    if(sha512ByName[name] && sha512.digest("base64")!==sha512ByName[name])throw Error(`Local manifest SHA-512 mismatch: ${name}`);
  }
}
module.exports={verifyLocalAssets};
