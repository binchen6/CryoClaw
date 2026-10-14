/**
 * 退场两段式（「一镜到底」原则，参照 app-toast.ts 的 TOAST_EXIT_MS 模式）。
 *
 * Lit 条件渲染本身没有退场概念：状态一清，DOM 立刻消失。退场动画需要
 * 「先给在管元素加 leaving class 播完退场帧，再清状态移除 DOM」两步。
 * leaving class 加在活节点上后，Lit 的增量 patch 不会触碰静态 class 属性，
 * 因此退场期间其它状态变化引起的重渲染不会打断动画。
 *
 * 用法：close 路径改为
 *   runExitAnimation(closeButtonElOrNull, ".cc-dialog-overlay", () => { state.x = null; });
 * finalize 负责清状态 + 触发重渲染（与原来立即关闭时相同）。
 *
 * 幂等：元素已在退场（含 cc-leaving）或找不到元素时立即 finalize，不叠定时器。
 * reduced-motion 下跳过动画直接 finalize（全局 0.01ms 收敛下等待无意义）。
 */

// 与 --duration-normal 对齐：退场曲线用 ease-in-out，时长 normal 档。
const EXIT_MS = 200;

export function runExitAnimation(
  els: Element | null | Array<Element | null | undefined>,
  finalize: () => void,
): void {
  const list = (Array.isArray(els) ? els : [els]).filter(
    (el): el is Element => el != null,
  );
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (list.length === 0 || reduced || list[0].classList.contains("cc-leaving")) {
    finalize();
    return;
  }
  for (const el of list) el.classList.add("cc-leaving");
  setTimeout(finalize, EXIT_MS);
}

/** 从事件目标出发找最近的带退场动画的浮层宿主（overlay/drawer/panel）。 */
export function exitHostFromEvent(e: Event, selector: string): Element | null {
  const target = e.target as Element | null;
  return target?.closest?.(selector) ?? document.querySelector(selector);
}
