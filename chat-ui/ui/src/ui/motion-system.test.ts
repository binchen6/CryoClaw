import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MOTION_MS, applyMotionPreference, configureMotionPreference, prefersReducedMotion } from "./utils/motion.ts";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

test("motion tokens, JS timers and reduced-motion contract stay aligned", () => {
  const tokens = source("../../../../../../shared/design-tokens.css");
  assert.match(tokens, /--duration-fast: 0\.14s/);
  assert.match(tokens, /--duration-normal: 0\.24s/);
  assert.match(tokens, /--duration-slow: 0\.36s/);
  assert.match(tokens, /--duration-slower: 0\.54s/);
  assert.deepEqual(MOTION_MS, { feedback: 140, panel: 240, enter: 360, scene: 540 });
  assert.match(source("../../../../src/ui/utils/exit-anim.ts"), /const EXIT_MS = MOTION_MS\.panel/);
  assert.match(source("../../../../src/ui/app-toast.ts"), /const TOAST_EXIT_MS = MOTION_MS\.panel/);
});

test("motion.css is the final scroll contract and removes competing workspace scrollers", () => {
  const hub = source("../../../../src/styles.css");
  const motion = source("../../../../src/styles/motion.css");
  assert.ok(hub.trimEnd().endsWith('@import "./styles/motion.css";'));
  assert.match(motion, /\.wk-nav \{ overflow-y: hidden; \}/);
  assert.match(motion, /\.context-dock__body \.wk-main--embedded \{ overflow: hidden; \}/);
  assert.match(motion, /overscroll-behavior-y: contain/);
  assert.match(motion, /scrollbar-gutter: stable/);
  assert.match(motion, /data-motion="reduce"/);
});

test("three motion preferences share one root trigger and support both override directions", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const dataset: Record<string, string> = {};
  let systemMatches = true;
  const listeners: Array<() => void> = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    matchMedia: () => ({ get matches() { return systemMatches; }, addEventListener: (_name: string, fn: () => void) => { listeners.push(fn); } }),
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset } } });
  try {
    configureMotionPreference("full");
    assert.equal(dataset.motion, "full");
    assert.equal(prefersReducedMotion(), false, "full must override OS reduction");
    configureMotionPreference("reduce");
    assert.equal(dataset.motion, "reduce");
    assert.equal(prefersReducedMotion(), true);
    configureMotionPreference("system");
    assert.equal(dataset.motion, "reduce");
    systemMatches = false;
    listeners.forEach(listener => listener());
    assert.equal(dataset.motion, "full", "system changes must update immediately");
    assert.equal(prefersReducedMotion(), false);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
    configureMotionPreference("system");
    applyMotionPreference();
  }
});
