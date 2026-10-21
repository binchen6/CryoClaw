export const OFFICIAL_UPDATE_BASE="https://github.com/binchen6/CryoClaw/releases/latest/download/";
/** A managed HTTPS mirror may serve the same latest.yml / installer / blockmap triplet. */
export function appUpdateSource(value?:string):string {
  if(!value?.trim())return OFFICIAL_UPDATE_BASE;
  const url=new URL(value.trim());
  if(url.protocol!=="https:" || url.username || url.password || url.search || url.hash)throw Error("软件更新源须为 HTTPS 目录地址 / App update source must be an HTTPS directory");
  return `${url.href.replace(/\/+$/,"")}/`;
}
