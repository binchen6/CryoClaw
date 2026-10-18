export type ArchiveProgress={phase:"snapshot"|"scan"|"write"|"verify"|"backup"|"restore"|"restart"|"done";filesDone?:number;filesTotal?:number;bytesDone?:number;bytesTotal?:number};
export type ArchiveProgressCallback=(progress:ArchiveProgress)=>void;
export function reportArchiveProgress(callback:ArchiveProgressCallback|undefined,progress:ArchiveProgress):void {
  try{callback?.(progress);}catch{/* UI observation must never interrupt a backup or restore. */}
}
