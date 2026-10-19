/**
 * a11y.ts — 键盘可达性小工具（R69）。
 *
 * 项目里多处行/卡片是 `<div @click>` 渲染的可交互元素（会话行、工作区树、git 文件行、
 * worktree 卡等）。它们没有原生按钮语义：Tab 到不了、Enter/Space 也不触发。补齐方式是
 * 加 `role="button" tabindex="0"` + Enter/Space 处理；本模块统一该 keydown 语义，
 * 避免在每个渲染点重复实现（含 e.repeat 防护与 Space 滚动拦截）。
 */

/** 返回一个 keydown 处理器：Enter / Space 时触发 activate（其余按键不拦截）。 */
export function activateOnKeydown(activate: () => void): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    if (e.repeat || e.defaultPrevented || e.isComposing || e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate();
    }
  };
}

/** Keyboard navigation for menus; leave Enter/Space to the native buttons. */
export function menuKeydown(event:KeyboardEvent,onClose:()=>void):void {
  if(event.isComposing || event.defaultPrevented)return;
  if(event.key==="Escape"){
    event.preventDefault();event.stopPropagation();onClose();return;
  }
  if(!["ArrowDown","ArrowUp","Home","End"].includes(event.key))return;
  const menu=event.currentTarget as HTMLElement;
  const items=[...menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled):not([aria-disabled="true"])')];
  if(!items.length)return;
  const current=items.indexOf((event.target as HTMLElement).closest('button[role="menuitem"]') as HTMLButtonElement);
  const next=event.key==="Home"?0:event.key==="End"?items.length-1:event.key==="ArrowDown"?(current+1)%items.length:(current<=0?items.length:current)-1;
  event.preventDefault();event.stopPropagation();items[next].focus();
}

export function tabListKeydown(event:KeyboardEvent):void {
  if(event.isComposing || event.defaultPrevented || !["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
  const current=(event.target as HTMLElement).closest<HTMLButtonElement>('button[role="tab"]');
  if(!current)return;
  const items=[...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button[role="tab"]:not(:disabled)')];
  const index=items.indexOf(current);if(index<0)return;
  const next=event.key==="Home"?0:event.key==="End"?items.length-1:(index+(event.key==="ArrowRight"?1:items.length-1))%items.length;
  event.preventDefault();event.stopPropagation();items[next].focus();items[next].click();
}
