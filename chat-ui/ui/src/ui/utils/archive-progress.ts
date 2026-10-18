import type {ArchiveProgress} from "../data/ipc-bridge.ts";
export function archiveProgressView(progress:ArchiveProgress|null,zh:boolean){
  const labels:Record<string,[string,string]>={snapshot:["正在创建数据快照","Creating a data snapshot"],scan:["正在统计备份文件","Scanning backup files"],write:["正在压缩导出","Writing backup"],verify:["正在校验数据包","Verifying archive"],backup:["正在保留导入前的应急备份","Preserving an emergency backup"],restore:["正在恢复文件","Restoring files"],restart:["正在重启网关并恢复连接","Restarting the gateway"],done:["处理完成","Completed"]};
  const valid=(n:unknown):n is number=>typeof n==="number" && Number.isFinite(n) && n>=0;
  let percent:number|null=progress?.phase==="done"?100:null;
  if(progress && valid(progress.bytesDone) && valid(progress.bytesTotal) && progress.bytesTotal>0)percent=Math.min(100,progress.bytesDone/progress.bytesTotal*100);
  else if(progress && valid(progress.filesDone) && valid(progress.filesTotal) && progress.filesTotal>0)percent=Math.min(100,progress.filesDone/progress.filesTotal*100);
  const details:string[]=[];
  if(progress && valid(progress.filesDone) && valid(progress.filesTotal))details.push(`${progress.filesDone.toLocaleString()} / ${progress.filesTotal.toLocaleString()} ${zh?"项":"entries"}`);
  if(progress && valid(progress.bytesDone) && valid(progress.bytesTotal))details.push(`${(progress.bytesDone/1048576).toFixed(1)} / ${(progress.bytesTotal/1048576).toFixed(1)} MiB`);
  return {label:(labels[progress?.phase??""]??["正在准备，请勿关闭应用","Preparing; keep the app open"])[zh?0:1],percent,detail:details.join(" · ")};
}
