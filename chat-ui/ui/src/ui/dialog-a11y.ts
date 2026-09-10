/**
 * dialog-a11y.ts — 模态对话框的键盘可达性（R69）。
 *
 * 背景：8 处 `role="dialog" aria-modal="true"` 弹窗（确认框、更新、重启网关、
 * WebBridge、发布说明、分享、网关地址确认、高级设置修复）此前只有鼠标可关：
 * 没有 Escape 处理，打开时焦点也留在背后的页面上（读屏用户被"困"在遮罩层）。
 *
 * 实现方式：不侵入各处渲染函数——由 app 层安装一个 document 级 keydown 监听，
 * Escape 时对最上层弹窗的遮罩派发一次点击（遮罩点击语义各处已一致定义为"关闭/
 * 取消"，且各处的守卫——如下载中不可关——写在 click 处理器内部，因此同样生效）；
 * 弹窗出现时若焦点仍在外部，则把焦点移入弹窗（遮罩带 tabindex="-1"）。
 */

const DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]';

/** 当前打开的最上层弹窗（可见、非 display:none），无则 null。 */
export function findOpenDialog(doc: Document = document): HTMLElement | null {
  const nodes = Array.from(doc.querySelectorAll<HTMLElement>(DIALOG_SELECTOR));
  for (let i = nodes.length - 1; i >= 0; i--) {
    const el = nodes[i];
    if (el.getClientRects().length > 0) return el;
  }
  return null;
}

/**
 * 关闭最上层弹窗：对遮罩派发一次 click（等价于用户点遮罩）。
 * 返回是否真的派发（无弹窗时为 false）。
 */
export function closeTopDialog(doc: Document = document): boolean {
  const dialog = findOpenDialog(doc);
  if (!dialog) return false;
  dialog.click();
  return true;
}

/**
 * 把焦点移入最上层弹窗（仅当焦点还不在弹窗内部时）。
 * 返回是否移动了焦点。
 */
export function focusOpenDialogIfNeeded(doc: Document = document): boolean {
  const dialog = findOpenDialog(doc);
  if (!dialog) return false;
  const active = doc.activeElement;
  if (active && dialog.contains(active)) return false;
  dialog.focus();
  return doc.activeElement === dialog;
}

/** Escape 键判定（含旧式 keyCode 兜底）。 */
export function isEscapeKey(event: { key?: string; keyCode?: number }): boolean {
  return event.key === "Escape" || event.key === "Esc" || event.keyCode === 27;
}
