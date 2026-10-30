"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

// Run the actual component lifecycle with controlled browser scheduling; no gateway or DOM engine.
const source = fs.readFileSync(path.join(__dirname, "../chat-ui/ui/src/ui/components/oc-dashboard.ts"), "utf8");
const compiled = ts.transpileModule(source.replace(/^import .*;\r?$/gm, ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true, useDefineForClassFields: false },
}).outputText;

function fixture() {
  const observers = [], frames = [], animationFrames = new Map(), timers = new Map(), messages = [];
  let sequence = 0;
  const scroller = {};
  class ControlledObserver {
    constructor(callback, options) { this.callback = callback; this.options = options; this.targets = new Set(); observers.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
    emit(target, isIntersecting) { this.callback([{ target, isIntersecting }]); }
  }
  class ElementBase {
    constructor() { this.style = { getPropertyValue: () => "0px", setProperty() {} }; }
    querySelector(selector) { return selector === ".dashboard-workspace__scroll" ? scroller : null; }
    querySelectorAll(selector) { return selector === ".dashboard-card iframe" ? frames : []; }
    connectedCallback() {}
    disconnectedCallback() {}
    addEventListener() {}
    removeEventListener() {}
  }
  const document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const scope = {
    exports: {}, LitElement: ElementBase, customElement: () => value => value,
    document, window: { addEventListener() {}, removeEventListener() {} },
    ResizeObserver: class { observe() {} disconnect() {} }, IntersectionObserver: ControlledObserver,
    getComputedStyle: () => ({ getPropertyValue: () => "blue" }),
    requestAnimationFrame: callback => { animationFrames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: id => animationFrames.delete(id),
    setTimeout: callback => { timers.set(++sequence, callback); return sequence; },
    clearTimeout: id => timers.delete(id), clearInterval() {},
  };
  vm.runInNewContext(compiled, scope);
  const dashboard = new scope.exports.OcDashboard();
  dashboard.selected = "board-a";
  function frame(id) {
    const value = { dataset: { cardId: id }, isConnected: true, getAttribute: () => null,
      contentWindow: { postMessage: message => messages.push({ frame: value, ...message }) } };
    frames.push(value);
    return value;
  }
  function flush(queue) { const callbacks = [...queue.values()]; queue.clear(); for (const callback of callbacks) callback(); }
  return { dashboard, frame, frames, observers, animationFrames, timers, messages, document,
    update: () => dashboard.updated(new Map()),
    flushFrames: () => flush(animationFrames), flushTimers: () => flush(timers),
    visibility: () => messages.filter(message => message.type === "cryoclaw:dashboard:visibility").at(-1)?.active };
}

test("prefetch-range frames mount while motion stays paused until the actual viewport is entered", async () => {
  const f = fixture(), frame = f.frame("nearby");
  const { runtimeScript } = await import("../builtin-plugins/cryoclaw-dashboards/runtime.mjs");
  const sdkWindow = {}, parent = {}, events = new Map();
  vm.runInNewContext(runtimeScript().match(/<script>([\s\S]*?)<\/script>/)[1], {
    window: sdkWindow, parent, URL, Map, Set, Uint32Array, crypto: globalThis.crypto,
    location: { href: "http://127.0.0.1:18789/__cryoclaw__/dashboards/board-a/nearby?ticket=test" },
    document: { get hidden() { return f.document.hidden; }, documentElement: { toggleAttribute() {} } },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener: (name, callback) => events.set(name, callback), removeEventListener() {},
  });
  const record = frame.contentWindow.postMessage;
  frame.contentWindow.postMessage = message => { record(message); events.get("message")({ source: parent, data: message }); };
  f.update();
  const prefetch = f.observers.find(observer => observer.options.rootMargin.includes("900px"));
  const visible = f.observers.find(observer => !observer.options.rootMargin.includes("900px"));
  prefetch.emit(frame, true);
  visible?.emit(frame, false);
  f.flushFrames();
  assert.equal(f.dashboard.frameReady.has("board-a/nearby"), true, "buffer entry schedules the real mount queue");
  assert.equal(f.visibility(), false, "preloading an offscreen frame must not activate motion");
  assert.equal(sdkWindow.cryoclawDashboard.motion.active, false);
  assert.ok(visible, "actual visibility needs its own observer");
  visible.emit(frame, true);
  assert.equal(f.visibility(), true);
  assert.equal(sdkWindow.cryoclawDashboard.motion.active, true);
  visible.emit(frame, false);
  assert.equal(f.visibility(), false);
  assert.equal(sdkWindow.cryoclawDashboard.motion.active, false);
  visible.emit(frame, true);
  f.document.hidden = true;
  f.dashboard.pageVisibility();
  assert.equal(f.visibility(), false, "a hidden document keeps visible frames paused");
  assert.equal(sdkWindow.cryoclawDashboard.motion.active, false);
  f.update();
  assert.equal(f.frames[0], frame, "visibility changes retain the live iframe");
  assert.equal(f.animationFrames.size, 0, "already mounted frames do not remount");
});

test("a prefetch skipped during a gesture retries after the existing gesture update", () => {
  const f = fixture();
  f.frame("distant");
  f.update();
  f.dashboard.gesture = {};
  f.flushTimers();
  assert.equal(f.animationFrames.size, 0, "a gesture postpones background mounts");
  assert.notEqual(f.dashboard.prefetched, "board-a", "postponed work must not be marked complete");
  f.dashboard.gesture = null;
  f.update();
  assert.equal(f.timers.size, 1, "gesture completion schedules one retry without polling");
  f.flushTimers();
  f.flushFrames();
  assert.equal(f.dashboard.frameReady.has("board-a/distant"), true);
  f.update();
  assert.equal(f.timers.size, 0, "completed prefetch does not schedule again");
});

test("board replacement and disconnect retire both observers and pending mount work", () => {
  const f = fixture(), oldFrame = f.frame("old");
  f.update();
  const oldObservers = [...f.observers];
  for (const observer of oldObservers) observer.emit(oldFrame, true);
  f.dashboard.selected = "board-b";
  f.dashboard.willUpdate(new Map([["selected", "board-a"]]));
  oldFrame.isConnected = false;
  f.frames.length = 0;
  const nextFrame = f.frame("next");
  f.update();
  for (const observer of oldObservers) {
    assert.equal(observer.targets.has(oldFrame), false, "removed frames are unobserved");
    observer.emit(oldFrame, true); // Intersection records may have been queued before removal.
  }
  f.flushFrames();
  assert.equal(f.dashboard.frameReady.size, 0, "stale observer records cannot mount into the next board");
  f.dashboard.disconnectedCallback();
  for (const observer of oldObservers) {
    assert.equal(observer.targets.size, 0, "disconnect releases observer targets");
    observer.emit(nextFrame, true);
  }
  f.flushFrames();
  f.flushTimers();
  assert.equal(f.dashboard.frameReady.size, 0);
  assert.equal(f.animationFrames.size, 0);
  assert.equal(f.timers.size, 0);
});
