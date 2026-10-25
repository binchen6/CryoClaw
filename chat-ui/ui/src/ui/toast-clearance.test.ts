import test from "node:test";
import assert from "node:assert/strict";
import { setComposeForToast } from "./toast-clearance.ts";

test("toast clearance：跟随输入区高度并在移除后复位", () => {
  const values = new Map<string, string>();
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const observerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  let callback: (() => void) | null = null;
  let disconnected = 0;
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    documentElement: { style: {
      setProperty: (name: string, value: string) => values.set(name, value),
      removeProperty: (name: string) => { values.delete(name); },
    } },
  } });
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class {
    constructor(next: () => void) { callback = next; }
    observe() {}
    disconnect() { disconnected++; }
  } });
  try {
    let height = 120;
    const element = { getBoundingClientRect: () => ({ height }) } as Element;
    setComposeForToast(element);
    assert.equal(values.get("--chat-compose-clearance"), "120px");
    height = 184;
    callback!();
    assert.equal(values.get("--chat-compose-clearance"), "184px");
    setComposeForToast(undefined);
    assert.equal(values.has("--chat-compose-clearance"), false);
    assert.equal(disconnected, 1);
  } finally {
    setComposeForToast(undefined);
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else delete (globalThis as { document?: unknown }).document;
    if (observerDescriptor) Object.defineProperty(globalThis, "ResizeObserver", observerDescriptor);
    else delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  }
});
