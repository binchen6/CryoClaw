import type {ChatAttachment} from "../ui-types.ts";
let queue=Promise.resolve();
export function hydrateAttachmentThumbnails(attachments:ChatAttachment[],update:(mutator:(previous:ChatAttachment[])=>ChatAttachment[])=>void):void {
  for(const attachment of attachments){
    const path=attachment.filePath;if(!path || !/\.(png|jpe?g|webp|gif|bmp)$/i.test(path))continue;
    queue=queue.then(async()=>{
      try {
        let exists=false;update(previous=>{exists=previous.some(item=>item.id===attachment.id);return previous;});if(!exists)return;
        const thumbnailUrl=await (window as any).cryoclaw?.fileThumbnail?.(path);
        if(thumbnailUrl?.startsWith("data:image/") && thumbnailUrl.length<524288)update(previous=>previous.map(item=>item.id===attachment.id?{...item,thumbnailUrl}:item));
      }catch{/* An unsupported preview still has a usable file card. */}
    });
  }
}
