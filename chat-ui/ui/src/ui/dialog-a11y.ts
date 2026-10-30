/**
 * dialog-a11y.ts — 模态对话框的键盘可达性与「原路返回」（R69 + 浮层返回准则 2026.10.30）。
 *
 * 背景：8 处 `role="dialog" aria-modal="true"` 弹窗（确认框、更新、重启网关、
 * WebBridge、发布说明、分享、网关地址确认、高级设置修复）此前只有鼠标可关：
 * 没有 Escape 处理，打开时焦点也留在背后的页面上（读屏用户被"困"在遮罩层）。
 *
 * 实现方式：不侵入各处渲染函数——由 app 层安装一个 document 级 keydown 监听，
 * Escape 时对最上层弹窗的遮罩派发一次点击（遮罩点击语义各处已一致定义为"关闭/
 * 取消"，且各处的守卫——如下载中不可关——写在 click 处理器内部，因此同样生效）；
 * 弹窗出现时若焦点仍在外部，则把焦点移入弹窗（遮罩带 tabindex="-1"）。
 *
 * 「从哪来就从哪去」：焦点第一次被移入弹窗时，把当时焦所在的元素记进 WeakMap；
 * 弹窗经 `closeTopDialog` 关闭后，等退场动画把 DOM 卸掉再把它还回去。找不到原
 * opener（列表重渲染把它删了）就静默放弃，绝不抢其它仍在开的弹窗的焦点。
 */

const DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]';

// 退场动画走 --duration-normal(200ms)（skills.css 的 cc-dialog 契约与
// exit-anim.ts 的 EXIT_MS 同为 200ms）：240ms 时 DOM 已卸载，是回焦的首选时点；
// 400ms 是给更慢的退场（设置页 modal、抽屉）留的第二次机会。
const RESTORE_CHECKPOINTS_MS = [240, 400] as const;

/** 弹窗 → 打开它时焦点所在的元素；元素随列表重渲染消失后自然被回收。 */
const dialogOpeners = new WeakMap<HTMLElement, HTMLElement>();

/**
 * 弹窗 → opener 被记录时的几何位置。仅用于 opener 已被列表重渲染删掉时，
 * 在多个 `[data-dialog-return-focus]` 里挑离原位最近的那个（"回到原来的地方"）。
 */
const openerRects = new WeakMap<HTMLElement, { left: number; top: number; width: number; height: number }>();

/** 当前打开的最上层弹窗（可见、非 display:none），无则 null。 */
export function findOpenDialog(doc: Document = document): HTMLElement | null {
  const nodes = Array.from(doc.querySelectorAll<HTMLElement>(DIALOG_SELECTOR));
  for (let i = nodes.length - 1; i >= 0; i--) {
    const el = nodes[i];
    if (el.getClientRects().length > 0) return el;
  }
  return null;
}

// 能接住焦点的元素：还在文档里、不在 inert 子树内、有布局盒子、没被 display/visibility 藏起来。
// 任一不满足都当"opener 已经没了"，避免把焦点按进一个看不见的节点。
function isFocusableTarget(el: HTMLElement | null | undefined, doc: Document): el is HTMLElement {
  if (!el || typeof el.focus !== "function") return false;
  if (el.isConnected === false) return false;
  if (typeof el.closest === "function" && el.closest("[inert]")) return false;
  if (typeof el.getClientRects === "function" && el.getClientRects().length === 0) return false;
  let style: CSSStyleDeclaration | undefined;
  try {
    style = doc.defaultView?.getComputedStyle?.(el);
  } catch {
    style = undefined;
  }
  if (style && (style.visibility === "hidden" || style.display === "none")) return false;
  return true;
}

/**
 * 现在能不能回焦：`wait` = 关闭的那个弹窗还在台上播退场帧；`abort` = 已经开了
 * 另一个弹窗，焦点归它，我们让位。
 */
function restoreGate(dialog: HTMLElement, doc: Document): "restore" | "wait" | "abort" {
  const open = findOpenDialog(doc);
  if (open === null) return "restore";
  return open === dialog ? "wait" : "abort";
}

function focusQuietly(el: HTMLElement): void {
  try {
    el.focus({ preventScroll: true });
  } catch {
    // 自定义元素可能重写 focus 并抛错；回焦失败不该打断关闭流程
  }
}

// 记录 opener：同一时刻焦点确实在弹窗之外时，它就是"来的地方"，覆盖旧记录即可
// （同一个 DOM 节点被复用重开时，旧的触发点已经作废）。
function recordDialogOpener(dialog: HTMLElement, doc: Document): boolean {
  const active = doc.activeElement as HTMLElement | null;
  if (!active || active === dialog || dialog.contains(active)) return false;
  if (active === doc.body || active === doc.documentElement) return false;
  if (typeof active.focus !== "function") return false;
  if (dialogOpeners.get(dialog) === active) return false;
  dialogOpeners.set(dialog, active);
  const rect = typeof active.getBoundingClientRect === "function" ? active.getBoundingClientRect() : null;
  if (rect && (rect.width > 0 || rect.height > 0)) {
    openerRects.set(dialog, { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  } else {
    openerRects.delete(dialog);
  }
  return true;
}

// opener 已被列表重渲染删除时的替补：页面上显式标记了"[回来时聚焦我]"的候选节点里，
// 取几何上离opener 原位最近的一个。没有标记就返回 null（调用方静默放弃）。
function findReturnFocusFallback(dialog: HTMLElement, doc: Document): HTMLElement | null {
  if (typeof doc.querySelectorAll !== "function") return null;
  const candidates = Array.from(doc.querySelectorAll<HTMLElement>("[data-dialog-return-focus]"))
    .filter(el => isFocusableTarget(el, doc));
  if (candidates.length === 0) return null;
  const origin = openerRects.get(dialog);
  if (!origin) return candidates[0];
  let best = candidates[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const el of candidates) {
    const rect = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
    if (!rect) continue;
    const dx = rect.left + rect.width / 2 - (origin.left + origin.width / 2);
    const dy = rect.top + rect.height / 2 - (origin.top + origin.height / 2);
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = el;
    }
  }
  return best;
}

/**
 * 把当前焦点记成最上层弹窗的 opener（供调用方在焦点即将移入前显式埋点）。
 * 返回是否新记录了一条。
 */
export function rememberDialogOpener(doc: Document = document): boolean {
  const dialog = findOpenDialog(doc);
  return dialog ? recordDialogOpener(dialog, doc) : false;
}

/**
 * 把焦点还给它来的地方。守卫：opener 仍在文档里、不在 inert 内、可见；
 * 若 opener 已随列表重渲染消失，退回页面上显式标记的 `[data-dialog-return-focus]`，
 * 再找不到就静默清状态（绝不抛错、不抢别处已有的焦点落点）。
 * 返回是否真的把焦点还回去了。
 */
export function restoreDialogOpener(dialog: HTMLElement | null, doc: Document = document): boolean {
  if (!dialog || !doc) return false;
  const opener = dialogOpeners.get(dialog);
  if (!opener) return false;

  // 还有弹窗站在台上：焦点属于它，不能把焦点挪到遮罩后面去。
  // 是同一个弹窗 → 退场还没收尾，保留记录等下一次；是另一个 → 记录作废。
  const open = findOpenDialog(doc);
  if (open !== null) {
    if (open !== dialog) {
      dialogOpeners.delete(dialog);
      openerRects.delete(dialog);
    }
    return false;
  }

  // 一次性状态：无论下面的还原成不成功都先清掉，避免同一个节点再次打开时误回焦到旧位置
  dialogOpeners.delete(dialog);

  const active = doc.activeElement as HTMLElement | null;
  // 关闭后应用已经主动把焦点落到别处（例如把焦点还给输入框）：尊重它，不抢
  if (active && active !== doc.body && active !== doc.documentElement
    && active !== dialog && !dialog.contains(active) && isFocusableTarget(active, doc)) {
    openerRects.delete(dialog);
    return false;
  }

  if (isFocusableTarget(opener, doc)) {
    openerRects.delete(dialog);
    focusQuietly(opener);
    if (doc.activeElement === opener) return true;
  }

  // opener 已经不在文档里（列表重渲染删掉了）：退到最近的 [data-dialog-return-focus]，
  // 找不到就静默放弃——绝不把焦点扔回 body 以外的意外节点。
  const fallback = findReturnFocusFallback(dialog, doc);
  openerRects.delete(dialog);
  if (fallback) {
    focusQuietly(fallback);
    return doc.activeElement === fallback;
  }
  return false;
}

/**
 * 关闭后的回焦时序：关闭是异步的（各弹窗先跑 ~200ms 退场动画再卸载 DOM），
 * 所以从下一帧起连试两帧，再按 240ms / 400ms 两个检查点兜底，谁先看到
 * "弹窗已卸载"谁结算并清掉剩下的定时器——不留下常驻计时器。
 * 期间如果又开了别的弹窗，直接让位：焦点属于新弹窗。
 * 两个检查点都错过（极慢的退场）就放弃：宁可焦点停在原处，也不在动画中途抢。
 */
function scheduleDialogOpenerRestore(dialog: HTMLElement, doc: Document): void {
  const checkpoints = [...RESTORE_CHECKPOINTS_MS];
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let frames = 0;
  // 从关闭时刻起算的累计等待，保证检查点是绝对时点（240ms / 400ms）而不是逐段叠加
  let elapsed = 0;

  const settle = () => {
    done = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  // 返回 true = 收工（已回焦或已让位）
  const attempt = (): boolean => {
    if (done) return true;
    const gate = restoreGate(dialog, doc);
    if (gate === "wait") return false;
    if (gate === "restore") restoreDialogOpener(dialog, doc);
    settle();
    return true;
  };

  const arm = () => {
    const at = checkpoints.shift();
    if (at === undefined) return;
    const delay = Math.max(0, at - elapsed);
    elapsed = at;
    timer = setTimeout(() => {
      timer = null;
      if (done) return;
      if (!attempt()) arm();
    }, delay);
  };
  arm();

  const view = doc.defaultView;
  if (!view?.requestAnimationFrame) return;
  const onFrame = () => {
    if (attempt()) return;
    if (++frames < 2) view.requestAnimationFrame(onFrame);
  };
  view.requestAnimationFrame(onFrame);
}

/**
 * 给"自己写了关闭路径、没走 closeTopDialog"的弹窗用（例如点遮罩/取消按钮关闭）：
 * 传入**还没被移除**的弹窗元素，等退场结束、DOM 卸掉后再把焦点还给 opener。
 */
export function restoreDialogOpenerSoon(dialog: HTMLElement | null, doc: Document = document): void {
  if (!dialog) return;
  scheduleDialogOpenerRestore(dialog, doc);
}

/**
 * 关闭最上层弹窗（Escape 语义）：
 * ① 优先点击弹窗内显式标记的"取消/关闭"按钮（`[data-dialog-dismiss]`）——对
 *    遮罩不响应点击的弹窗（如通用确认框，避免误触外点即取消危险操作的语义）同样有效；
 * ② 否则对遮罩派发一次 click（各处遮罩点击语义已统一为"关闭/取消"）。
 * 关闭动作是异步的，附带一次退场后的焦点归还（见 scheduleDialogOpenerRestore）。
 * 返回是否真的派发了关闭动作（无弹窗时为 false）。
 */
export function closeTopDialog(doc: Document = document): boolean {
  const dialog = findOpenDialog(doc);
  if (!dialog) return false;
  const dismiss = dialog.querySelector<HTMLElement>("[data-dialog-dismiss]");
  (dismiss ?? dialog).click();
  scheduleDialogOpenerRestore(dialog, doc);
  return true;
}

/**
 * 把焦点移入最上层弹窗（仅当焦点还不在弹窗内部时）。
 * 同时记录 opener，供关闭后原路返回。
 * 返回是否移动了焦点。
 */
export function focusOpenDialogIfNeeded(doc: Document = document): boolean {
  const dialog = findOpenDialog(doc);
  if (!dialog) return false;
  const active = doc.activeElement;
  if (active && dialog.contains(active)) return false;
  // 必须在 dialog.focus() 之前记：此刻 activeElement 还是触发弹窗的那个控件
  recordDialogOpener(dialog, doc);
  dialog.focus();
  return doc.activeElement === dialog;
}

/** Keep keyboard navigation inside the top modal, including its exit animation. */
export function trapDialogTab(event: KeyboardEvent, doc: Document = document): boolean {
  if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) return false;
  const dialog = findOpenDialog(doc);
  if (!dialog) return false;
  const controls = Array.from(dialog.querySelectorAll<HTMLElement>(
    'button, a[href], input, select, textarea, [tabindex], [contenteditable="true"]',
  )).filter(el => el.tabIndex >= 0 && !el.matches(":disabled, [aria-disabled='true']")
    && !el.closest("[inert]") && el.getClientRects().length > 0
    && doc.defaultView?.getComputedStyle(el).visibility !== "hidden");
  const first = controls[0];
  const last = controls[controls.length - 1];
  const active = doc.activeElement;
  if (!first || !active || !controls.includes(active as HTMLElement)
    || (event.shiftKey ? active === first : active === last)) {
    event.preventDefault();
    (event.shiftKey ? last ?? dialog : first ?? dialog).focus();
    return true;
  }
  return false;
}

/** Escape 键判定（含旧式 keyCode 兜底）。 */
export function isEscapeKey(event: { key?: string; keyCode?: number }): boolean {
  return event.key === "Escape" || event.key === "Esc" || event.keyCode === 27;
}
