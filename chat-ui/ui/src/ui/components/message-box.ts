/**
 * Status message display (error / success / info).
 *
 * Usage:
 *   <oc-message-box .message=${"Saved!"} .type=${"success"} .visible=${true}></oc-message-box>
 */
import { LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import {showToastGlobal,type ToastKind} from "../app-toast.ts";

@customElement("oc-message-box")
export class MessageBox extends LitElement {
  createRenderRoot() { return this; }

  @property({ type: String }) message = "";
  @property({ type: String }) type: ToastKind = "info";
  @property({ type: Boolean }) visible = false;

  protected updated(changed:Map<PropertyKey,unknown>){if(this.visible && this.message && (changed.has('visible') || changed.has('message') || changed.has('type')))showToastGlobal(this.message,this.type);}
  render() {return nothing;}
}

declare global {
  interface HTMLElementTagNameMap {
    "oc-message-box": MessageBox;
  }
}
