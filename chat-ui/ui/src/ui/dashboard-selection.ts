export type DashboardSelection={cardId:string;cardTitle:string;selector?:string;tagName?:string;text?:string};
export type DashboardComposeTarget={description?:string;selection?:DashboardSelection|null;onClearSelection?:()=>void};

/** Frame content identifies an element; only the host can identify its owning card. */
export function dashboardElementTarget(value:unknown,cardId:string,cardTitle:string):DashboardSelection|null{
 if(!value||typeof value!=='object')return null;
 const data=value as Record<string,unknown>;
 if(typeof data.selector!=='string'||!data.selector.trim()||data.selector.length>768||/[\r\n\0]/.test(data.selector)||typeof data.tagName!=='string'||!/^[a-z][a-z0-9-]{0,49}$/i.test(data.tagName))return null;
 return {cardId,cardTitle,selector:data.selector,tagName:data.tagName.toLowerCase(),text:typeof data.text==='string'?data.text.replace(/\s+/g,' ').trim().slice(0,280):''};
}
export function clampDashboardMenu(x:number,y:number,width:number,height:number){return {x:Math.max(8,Math.min(x,width-228)),y:Math.max(8,Math.min(y,height-100))};}

export function dashboardNodeSelector(element:Element,root:Element):string{
 const parts:string[]=[];let current:Element|null=element;
 while(current&&current!==root){
  const siblings=current.parentElement?[...current.parentElement.children].filter(node=>node.localName===current!.localName):[current];
  parts.unshift(current.localName+(siblings.length>1?`:nth-of-type(${siblings.indexOf(current)+1})`:''));
  const selector=parts.join(' > ');
  if(root.querySelectorAll(selector).length===1)return selector;
  current=current.parentElement;
 }
 return parts.join(' > ');
}
