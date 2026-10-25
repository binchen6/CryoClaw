let observer: ResizeObserver | null = null;
let observed: Element | null = null;
let lastHeight = -1;

function removeClearance() {
  document.documentElement.style.removeProperty("--chat-compose-clearance");
}

export function setComposeForToast(element?: Element): void {
  if (observed === element) return;
  observer?.disconnect();
  observer = null;
  observed = element ?? null;
  lastHeight = -1;
  if (!element) {
    removeClearance();
    return;
  }
  const update = () => {
    const height = Math.ceil(element.getBoundingClientRect().height);
    if (height === lastHeight) return;
    lastHeight = height;
    document.documentElement.style.setProperty("--chat-compose-clearance", `${height}px`);
  };
  observer = new ResizeObserver(update);
  observer.observe(element);
  update();
}
