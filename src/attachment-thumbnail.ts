import {ipcMain,nativeImage} from "electron";
import * as fs from "node:fs";
import {assertTrustedIpcSender} from "./ipc-sender-guard";
import {evaluateFileReadTarget} from "./file-read-base64";
import {thumbnailDimensions} from "./image-thumbnail-policy";
export function registerAttachmentThumbnailIpc():void {
  ipcMain.handle("file:thumbnail",async(event,filePath:unknown)=>{
    if(!assertTrustedIpcSender(event,"file:thumbnail"))throw new Error("IPC sender not trusted");
    if(typeof filePath!=="string" || !/\.(png|jpe?g|webp|gif|bmp)$/i.test(filePath) || !evaluateFileReadTarget(filePath,{isFile:true,size:0}).ok)return null;
    try {
      const target=await fs.promises.realpath(filePath),stat=await fs.promises.stat(target);
      if(!evaluateFileReadTarget(target,{isFile:stat.isFile(),size:stat.size}).ok)return null;
      const handle=await fs.promises.open(target,"r");let header:Buffer;
      try{const bytes=Buffer.alloc(65536);const result=await handle.read(bytes,0,bytes.length,0);header=bytes.subarray(0,result.bytesRead);}finally{await handle.close();}
      const dimensions=thumbnailDimensions(header);if(!dimensions)return null;
      const scale=Math.min(1,192/dimensions.width,192/dimensions.height);
      const image=process.platform==="linux"?nativeImage.createFromPath(target).resize({width:Math.max(1,Math.round(dimensions.width*scale)),height:Math.max(1,Math.round(dimensions.height*scale))}):await nativeImage.createThumbnailFromPath(target,{width:192,height:192});
      if(image.isEmpty())return null;return image.toDataURL();
    } catch{return null;}
  });
}
