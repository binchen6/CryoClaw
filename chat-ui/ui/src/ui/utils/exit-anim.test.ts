import test from "node:test";
import assert from "node:assert/strict";
import { runExitAnimation } from "./exit-anim.ts";

test("repeated dismiss waits for the original exit instead of removing the overlay early", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true, value: { matchMedia: () => ({ matches: false }) },
  });
  try {
    const classes = new Set<string>();
    const el = { classList: { contains: (s: string) => classes.has(s), add: (s: string) => classes.add(s) } } as unknown as Element;
    let finalized = 0;
    runExitAnimation(el, () => assert.fail("an obsolete close guard must not run"));
    t.mock.timers.tick(100);
    runExitAnimation(el, () => finalized++);
    assert.equal(finalized, 0);
    t.mock.timers.tick(99);
    assert.equal(finalized, 0);
    t.mock.timers.tick(1);
    assert.equal(finalized, 1);
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("reopening during exit invalidates the old timer and allows a new exit", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true, value: { matchMedia: () => ({ matches: false }) },
  });
  try {
    const classes = new Set<string>();
    const el = { classList: { contains: (s: string) => classes.has(s), add: (s: string) => classes.add(s) } } as unknown as Element;
    runExitAnimation(el, () => assert.fail("reopened element must not be closed by the old timer"));
    t.mock.timers.tick(100);
    classes.delete("cc-leaving");
    let finalized = 0;
    runExitAnimation(el, () => finalized++);
    t.mock.timers.tick(100);
    assert.equal(finalized, 0);
    t.mock.timers.tick(100);
    assert.equal(finalized, 1);
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
