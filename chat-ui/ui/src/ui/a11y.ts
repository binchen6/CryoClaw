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
    if (e.repeat) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate();
    }
  };
}

/** 可交互行的公共无障碍属性（lit 属性模板用）。 */
export const interactiveRowAttrs = {
  role: "button" as const,
  tabindex: "0" as const,
};
