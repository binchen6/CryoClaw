type Entry<T>={value?:T;at:number;pending?:Promise<T>};
/** Memory-only snapshots; invalidated in-flight work cannot repopulate the cache. */
export class ResourceCache<T>{
  private entries=new Map<string,Entry<T>>();
  constructor(private ttlMs:number,private limit=30,private now:()=>number=Date.now){}
  peek(key:string):T|undefined{const e=this.entries.get(key);return e && 'value' in e && this.now()-e.at<this.ttlMs?e.value:undefined;}
  read(key:string,load:()=>Promise<T>,force=false):Promise<T>{
    const previous=this.entries.get(key);
    if(!force && previous?.pending)return previous.pending;
    const cached=!force?this.peek(key):undefined;if(cached!==undefined)return Promise.resolve(cached);
    const entry:Entry<T>={at:0};this.entries.set(key,entry);
    const pending=(async()=>load())().then(value=>{
      if(this.entries.get(key)===entry){entry.value=value;entry.at=this.now();entry.pending=undefined;}
      return value;
    },error=>{if(this.entries.get(key)===entry)this.entries.delete(key);throw error;});
    entry.pending=pending;
    while(this.entries.size>this.limit)this.entries.delete(this.entries.keys().next().value!);
    return pending;
  }
  store(key:string,value:T):void{this.entries.set(key,{value,at:this.now()});while(this.entries.size>this.limit)this.entries.delete(this.entries.keys().next().value!);}
  clear(key?:string):void{if(key===undefined)this.entries.clear();else this.entries.delete(key);}
}
