// These functions run in the untrusted page. Keep them self-contained and free of Node APIs.
export function browserSnapshot() {
  const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
  const selectorFor = (element: Element) => {
    const parts: string[] = [];
    for (let current: Element | null = element; current; current = current.parentElement) {
      if (current.id) {
        const id = `#${CSS.escape(current.id)}`;
        if (document.querySelectorAll(id).length === 1) { parts.unshift(id); break; }
      }
      const siblings: Element[] = current.parentElement ? Array.from(current.parentElement.children).filter(e => e.tagName === current!.tagName) : [current];
      parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`);
    }
    return parts.join(" > ");
  };
  const elements = Array.from(document.querySelectorAll("a,button,input,textarea,select,[role=button],[contenteditable=true]"))
    .filter(visible).slice(0, 80).map(element => {
      const secret = element instanceof HTMLInputElement && element.type === "password";
      const attributes: Record<string, string> = {};
      for (const name of ["id", "name", "type", "href", "placeholder", "aria-label"]) {
        const value = element.getAttribute(name);
        if (value) attributes[name] = value.slice(0, 200);
      }
      return {
        selector: selectorFor(element),
        text: secret ? "" : ((element as HTMLElement).innerText || (element as HTMLInputElement).value || "").trim().slice(0, 160),
        attributes,
        disabled: element.matches(":disabled,[aria-disabled=true]"),
      };
    });
  const result = { url: location.href.slice(0, 8192), title: document.title.slice(0, 500), text: (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 12000), elements, truncated: location.href.length > 8192 };
  while (new TextEncoder().encode(JSON.stringify(result)).length > 55_000) {
    result.truncated = true;
    if (result.elements.length) result.elements.pop();
    else if (result.text.length) result.text = result.text.slice(0, Math.floor(result.text.length / 2));
    else break;
  }
  return result;
}

export function browserInteract(action: string, selector: string, value?: string) {
  const matches = document.querySelectorAll(selector);
  if (matches.length !== 1) throw new Error(matches.length ? "Selector is ambiguous; take a new snapshot" : "Element not found; take a new snapshot");
  const element = matches[0] as HTMLElement;
  if (!element.getClientRects().length || getComputedStyle(element).visibility === "hidden") throw new Error("Element is not visible");
  if (element.matches(":disabled,[aria-disabled=true]")) throw new Error("Element is disabled");
  element.scrollIntoView({ block: "center", behavior: "instant" });
  if (action === "click") {
    element.click();
    return { clicked: true, url: location.href };
  }
  if (element.matches("[readonly]")) throw new Error("Element is read-only");
  element.focus();
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    if (element instanceof HTMLInputElement && ["file", "checkbox", "radio", "button", "submit", "reset", "image", "hidden"].includes(element.type)) throw new Error("Element does not accept text");
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value ?? "");
  } else if (element.isContentEditable) element.textContent = value ?? "";
  else throw new Error("Element does not accept text");
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value ?? "" }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { typed: (value ?? "").length, url: location.href };
}

export const snapshotScript = () => `(${browserSnapshot.toString()})()`;
export const interactionScript = (action: string, selector: string, text?: string) =>
  `(() => { try { return (${browserInteract.toString()})(${JSON.stringify(action)},${JSON.stringify(selector)},${JSON.stringify(text ?? "")}); } catch (error) { return { __cryoclawError: String(error.message || error).slice(0, 500) }; } })()`;

export function browserAnnotate(options: { reducedMotion?: boolean; duration?: number; easing?: string; accent?: string } = {}) {
  return new Promise(resolve => {
    document.dispatchEvent(new Event("cryoclaw-cancel-annotation"));
    document.querySelectorAll("[data-cryoclaw-annotation]").forEach(element => element.remove());
    const cursorStyle = document.createElement("style");
    cursorStyle.textContent = "html, html * { cursor: crosshair !important; }";
    cursorStyle.dataset.cryoclawAnnotation = "cursor";
    document.documentElement.append(cursorStyle);
    const overlay = document.createElement("div");
    overlay.dataset.cryoclawAnnotation = "true";
    const accent = options.accent || "Highlight";
    const reduced = options.reducedMotion ?? matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = Math.max(0, Math.min(300, options.duration ?? 140));
    const easing = options.easing || "cubic-bezier(0.2, 0, 0, 1)";
    const transition = reduced ? "none" : ["left", "top", "width", "height", "opacity"].map(property => `${property} ${duration}ms ${easing}`).join(", ");
    Object.assign(overlay.style, { position: "fixed", pointerEvents: "none", boxSizing: "border-box", border: `2px solid ${accent}`, background: `color-mix(in srgb, ${accent} 10%, transparent)`, zIndex: "2147483647", borderRadius: "4px", opacity: "0" });
    const label = document.createElement("span");
    label.dataset.cryoclawAnnotationLabel = "true";
    Object.assign(label.style, { position: "absolute", right: "-2px", bottom: "calc(100% + 4px)", maxWidth: "240px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: "3px 7px", background: accent, color: "HighlightText", font: "12px/1.4 system-ui", borderRadius: "4px" });
    overlay.append(label);
    document.documentElement.append(overlay);
    let hovered: Element | null = null;
    let frame = 0;
    let painted = false;
    const draw = (element: Element, immediate = false) => {
      const rect = element.getBoundingClientRect();
      overlay.style.transition = immediate || !painted ? "none" : transition;
      Object.assign(overlay.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      overlay.style.opacity = "1";
      label.textContent = `${element.localName}${element.id ? `#${element.id}` : element.classList.length ? `.${element.classList[0]}` : ""}`.slice(0, 160);
      label.style.bottom = rect.top < 24 ? "auto" : "calc(100% + 4px)";
      label.style.top = rect.top < 24 ? "calc(100% + 4px)" : "auto";
      painted = true;
      if (!immediate) requestAnimationFrame(() => { overlay.style.transition = transition; });
    };
    const move = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || overlay.contains(event.target)) return;
      hovered = event.target;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (hovered?.isConnected) draw(hovered); });
    };
    const reposition = () => { if (hovered?.isConnected) draw(hovered); };
    const cleanup = (remove = true) => {
      cancelAnimationFrame(frame); frame = 0; cursorStyle.remove();
      clearTimeout(timer); if (remove) overlay.remove();
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("cryoclaw-cancel-annotation", cancel);
      document.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
    const click = (event: MouseEvent) => {
      event.preventDefault(); event.stopImmediatePropagation();
      const element = event.target as HTMLElement;
      const secret = element instanceof HTMLInputElement && element.type === "password";
      const text = secret ? "" : (window.getSelection()?.toString() || element.innerText || element.getAttribute("aria-label") || element.tagName).trim().slice(0, 4000);
      const rect = element.getBoundingClientRect();
      draw(element, true);
      const badge = document.createElement("span");
      badge.textContent = "1";
      Object.assign(badge.style, { position: "absolute", right: "0", top: "0", padding: "2px 8px", background: "Highlight", color: "HighlightText", font: "bold 14px system-ui", borderRadius: "10px" });
      overlay.append(badge);
      const parts: string[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
        const siblings: Element[] = node.parentElement ? Array.from(node.parentElement.children).filter(item => item.tagName === node!.tagName) : [node];
        parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
      }
      const xpath: string[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        const siblings: Element[] = node.parentElement ? Array.from(node.parentElement.children).filter(item => item.localName === node!.localName) : [node];
        xpath.unshift(`*[local-name()="${node.localName}"][${siblings.indexOf(node) + 1}]`);
      }
      cleanup(false); resolve({ url: location.href.slice(0, 8192), title: document.title.slice(0, 500), text, xpath: "/" + xpath.join("/"),
        selector: parts.join(" > "), id: element.id.slice(0, 500), classes: Array.from(element.classList).slice(0, 20).map(name => name.slice(0, 100)), tag: element.tagName.toLowerCase(),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        role: element.getAttribute("role"), label: element.getAttribute("aria-label")?.slice(0, 500) || "", disabled: element.matches(":disabled,[aria-disabled=true]"),
        href: element.getAttribute("href")?.slice(0, 2000) || "", name: element.getAttribute("name")?.slice(0, 500) || "",
        viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio }, capturedAt: new Date().toISOString(),
      });
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); cleanup(); resolve(null); } };
    const cancel = () => { cleanup(); resolve(null); };
    const timer = setTimeout(() => { cleanup(); resolve(null); }, 30000);
    document.addEventListener("mousemove", move, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("cryoclaw-cancel-annotation", cancel, { once: true });
    document.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
  });
}
