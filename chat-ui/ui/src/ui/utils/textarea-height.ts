// Exact content matters: equal-length edits can wrap onto different numbers of lines.
const measurements = new WeakMap<HTMLTextAreaElement, {
  value: string;
  placeholder: string;
  width: number;
}>();

export function adjustTextareaHeight(el: HTMLTextAreaElement, deferred = false): void {
  const apply = () => {
    if (!el.isConnected || el.clientWidth === 0) return;
    const previous = measurements.get(el);
    const next = { value: el.value, placeholder: el.placeholder, width: el.clientWidth };
    if (previous && previous.value === next.value && previous.placeholder === next.placeholder
      && previous.width === next.width) return;
    measurements.set(el, next);
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  if (deferred) requestAnimationFrame(apply);
  else apply();
}
