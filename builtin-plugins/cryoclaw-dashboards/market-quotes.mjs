// The shipped watchlist has a second, independent public provider. This adapter
// deliberately does not rewrite arbitrary user sources or accept arbitrary codes.
const codes=['600519','300750','002594'];
const symbols=['sh600519','sz300750','sz002594'];
export const marketFallbackUrl='https://qt.gtimg.cn/q=sh600519,sz300750,sz002594';
export const marketUnavailable='行情源暂不可用，请稍后重试';
export function isBuiltinMarketSource(source){
  if(source?.format==='text')return false;
  try{const url=new URL(source.url);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.hash&&url.hostname==='push2.eastmoney.com'&&url.pathname==='/api/qt/ulist.np/get'&&[...url.searchParams].length===3&&url.searchParams.get('fltt')==='2'&&url.searchParams.get('fields')==='f12,f14,f2,f3,f124'&&url.searchParams.get('secids')==='1.600519,0.300750,0.002594';}catch{return false;}
}
function historySymbol(source){
  if(source?.format==='text')return null;
  try{const url=new URL(source.url),secids=['1.600519','0.300750','0.002594'],index=secids.indexOf(url.searchParams.get('secid'));if(index<0||url.protocol!=='https:'||url.username||url.password||url.port||url.hash||url.hostname!=='push2his.eastmoney.com'||url.pathname!=='/api/qt/stock/kline/get'||[...url.searchParams].length!==7)return null;for(const [key,value]of Object.entries({klt:'101',fqt:'1',lmt:'20',end:'20500101',fields1:'f1',fields2:'f51,f52,f53'}))if(url.searchParams.get(key)!==value)return null;return symbols[index];}catch{return null;}
}
export function isBuiltinMarketDataSource(source){return isBuiltinMarketSource(source)||historySymbol(source)!==null;}
function number(value){if(typeof value==='number')return Number.isFinite(value)?value:null;if(typeof value!=='string'||!/^[-+]?\d+(?:\.\d+)?$/.test(value))return null;const result=Number(value);return Number.isFinite(result)?result:null;}
function timestamp(value){
  if(!/^\d{14}$/.test(value??''))return null;
  const iso=`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(8,10)}:${value.slice(10,12)}:${value.slice(12,14)}+08:00`,time=Date.parse(iso);
  if(!Number.isFinite(time)||new Date(time+8*3600000).toISOString().replace(/[-:T]/g,'').slice(0,14)!==value)return null;
  return time/1000;
}
function primaryQuotes(body){
  const value=JSON.parse(body.toString('utf8')),rows=value?.data?.diff;
  if(!Array.isArray(rows)||rows.length!==codes.length)throw Error('Empty market response');
  const diff=codes.map(code=>{const row=rows.find(row=>row?.f12===code);if(!row||typeof row.f14!=='string'||!row.f14.trim()||row.f14.length>64||number(row.f2)===null||number(row.f2)<=0||number(row.f3)===null||number(row.f124)===null||number(row.f124)<=0)throw Error('Invalid market response');return {...row,f2:number(row.f2),f3:number(row.f3),f124:number(row.f124)};});
  return {...value,data:{...value.data,diff}};
}
export function parseTencentQuotes(body){
  // Tencent's public quote feed is GB18030. Never evaluate its JavaScript envelope.
  const text=new TextDecoder('gb18030',{fatal:true}).decode(body),rows=new Map();
  for(const match of text.matchAll(/(?:^|[\r\n])v_(sh\d{6}|sz\d{6})="([^"\r\n]*)";?/g)){
    if(!symbols.includes(match[1])||rows.has(match[1]))continue;
    const fields=match[2].split('~'),price=number(fields[3]),change=number(fields[32]),stamp=timestamp(fields[30]);
    if(fields[2]!==match[1].slice(2)||!fields[1]?.trim()||fields[1].length>64||price===null||price<=0||change===null||stamp===null)throw Error('Invalid market response');
    rows.set(match[1],{f12:fields[2],f14:fields[1],f2:price,f3:change,f124:stamp});
  }
  if(rows.size!==symbols.length)throw Error('Incomplete market response');
  return {data:{diff:symbols.map(symbol=>rows.get(symbol))}};
}
function historyRows(rows){
  if(!Array.isArray(rows)||rows.length<2||rows.length>20)throw Error('Invalid market history');let previous='';
  return rows.map(row=>{if(!Array.isArray(row)||!/^\d{4}-\d{2}-\d{2}$/.test(row[0]??'')||row[0]<=previous||timestamp(row[0].replaceAll('-','')+'000000')===null||number(row[1])===null||number(row[1])<=0||number(row[2])===null||number(row[2])<=0)throw Error('Invalid market history');previous=row[0];return `${row[0]},${number(row[1])},${number(row[2])}`;});
}
function primaryHistory(body,symbol){const value=JSON.parse(body.toString('utf8'));if(value?.data?.code!==symbol.slice(2))throw Error('Wrong market history');return {...value,data:{...value.data,klines:historyRows(value.data.klines?.map(row=>typeof row==='string'?row.split(','):row))}};}
function secondaryHistory(body,symbol){const value=JSON.parse(new TextDecoder('gb18030',{fatal:true}).decode(body));if(value.code!==0)throw Error('Invalid market history');return {data:{code:symbol.slice(2),klines:historyRows(value.data?.[symbol]?.qfqday)}};}
export async function fetchBuiltinMarketData(source,{fetchBody,expires,now=Date.now,maxBytes=524288}){
  const options={maxBytes,expires,accept:'application/json, text/plain'};
  const symbol=historySymbol(source),fallback=symbol?`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,20,qfq`:marketFallbackUrl;
  try{
    const response=await fetchBody(source.url,{...options,expires:Math.min(expires,now()+6000)});
    return {value:symbol?primaryHistory(response.body,symbol):primaryQuotes(response.body),source:source.url,provider:'东方财富'};
  }catch{
    try{const response=await fetchBody(fallback,options);return {value:symbol?secondaryHistory(response.body,symbol):parseTencentQuotes(response.body),source:fallback,declaredSource:source.url,provider:'腾讯证券',fallback:true};}
    catch(error){throw new Error(marketUnavailable,{cause:error});}
  }
}
