import {LitElement,html} from "lit";
import {customElement,property,state} from "lit/decorators.js";
import {clampRange,adjustRange} from "../utils/range.ts";
let sequence=0;
@customElement("oc-range-control")
export class RangeControl extends LitElement {
  createRenderRoot(){return this;}
  @property({type:Number}) value=0;
  @property({type:Number}) min=0;
  @property({type:Number}) max=100;
  @property({type:Number}) precision=3;
  @property({type:Number}) fineStep=.1;
  @property() label="";
  @property() unit="";
  @property({type:Boolean}) disabled=false;
  @state() private draft:string|null=null;
  private frame:number|null=null;
  private pendingValue:number|null=null;
  private readonly controlId=`precise-range-${++sequence}`;
  private clamp(value:number){return clampRange(value,this.min,this.max);}
  private publish(commit=false,value?:number){
    if(value!==undefined)this.pendingValue=value;
    if(this.frame!==null){cancelAnimationFrame(this.frame);this.frame=null;}
    const send=()=>{this.frame=null;const latest=this.pendingValue??this.value;this.pendingValue=null;this.value=latest;this.dispatchEvent(new CustomEvent("value-change",{detail:{value:latest,commit,frame:!commit},bubbles:true,composed:true}));};
    if(commit)send();else this.frame=requestAnimationFrame(send);
  }
  disconnectedCallback(){super.disconnectedCallback();if(this.frame!==null)cancelAnimationFrame(this.frame);this.frame=null;}
  private key(event:KeyboardEvent){
    const direction=event.key==="ArrowRight" || event.key==="ArrowUp"?1:event.key==="ArrowLeft" || event.key==="ArrowDown"?-1:0;
    if(!direction)return;event.preventDefault();
    this.value=adjustRange(this.pendingValue??this.value,direction,this.min,this.max,this.fineStep,event.shiftKey,event.altKey);this.publish(true,this.value);
  }
  render(){const current=this.pendingValue??this.value;return html`<div class="precise-range" style=${`--range-progress:${this.max>this.min?(current-this.min)/(this.max-this.min)*100:0}%`}><label for=${this.controlId}>${this.label}</label><div class="precise-range__value"><input class="precise-range__number" type="number" min=${this.min} max=${this.max} step="any" aria-label=${this.label} .value=${this.draft??String(Number(current.toFixed(this.precision)))} ?disabled=${this.disabled}
    @focus=${()=>{this.draft=String(this.value);}} @input=${(event:Event)=>{this.draft=(event.target as HTMLInputElement).value;}}
    @change=${()=>{const next=Number(this.draft);if(this.draft?.trim() && Number.isFinite(next)){this.value=this.clamp(next);this.publish(true,this.value);}this.draft=null;}}
    @blur=${()=>{this.draft=null;}} @keydown=${(event:KeyboardEvent)=>{if(event.key==="Escape"){this.draft=null;(event.target as HTMLInputElement).blur();event.stopPropagation();}if(event.key==="Enter")(event.target as HTMLInputElement).blur();}} /><span>${this.unit}</span></div>
    <input id=${this.controlId} class="precise-range__slider" type="range" min=${this.min} max=${this.max} step="any" .value=${String(current)} ?disabled=${this.disabled} aria-label=${this.label}
      @input=${(event:Event)=>{this.value=this.clamp(Number((event.target as HTMLInputElement).value));this.publish(false,this.value);}}
      @change=${()=>this.publish(true)} @keydown=${(event:KeyboardEvent)=>this.key(event)} />
  </div>`;}
}
