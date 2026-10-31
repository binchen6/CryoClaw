import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../../../../../src/ui/components/oc-dashboard.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../../../../../src/styles/dashboard.css", import.meta.url), "utf8");

// Exercise the real component methods without pretending Node has a renderer.
// Strip only imports/decorator; Lit lifecycle and all templates stay untouched.
function dashboardHarness() {
  const exports: Record<string, new () => Record<string, any>> = {};
  const frames: Array<() => void> = [];
  let styleReads = 0;
  const compiled = ts.transpileModule(source.replace(/^import .*$/gm, "").replace(/^@customElement.*$/gm, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, useDefineForClassFields: false },
  });
  runInNewContext(compiled.outputText, {
    exports, LitElement: class {}, document: { hidden: false }, navigator: {},
    requestAnimationFrame: (callback: () => void) => { frames.push(callback); return frames.length; },
    getComputedStyle: () => { styleReads++; return { getPropertyValue: () => "blue" }; },
  });
  return { dashboard: new exports.OcDashboard!(), frames, styleReads: () => styleReads };
}

test("visibility traffic never runs the inspector; frame reload still initializes it", () => {
  const { dashboard, styleReads } = dashboardHarness();
  const messages: Array<{ type: string }> = [];
  const frame = { isConnected: true, dataset: { visible: "true", cardId: "card-1" }, contentWindow: { postMessage: (message: { type: string }) => messages.push(message) } };
  dashboard.observedFrames.add(frame);
  for (let i = 0; i < 100; i++) dashboard.postFrameVisibility(frame);
  assert.equal(messages.length, 100);
  assert.ok(messages.every(message => message.type.endsWith(":visibility")));
  assert.equal(styleReads(), 0);
  dashboard.frameLoaded({ target: frame });
  assert.equal(messages.at(-1)?.type, "cryoclaw:dashboard:inspect");
  assert.equal(styleReads(), 0, "inactive inspector does not need theme lookup");
  dashboard.editing = true;
  dashboard.frameLoaded({ target: frame });
  assert.equal(styleReads(), 1);
});

test("iframe wheel bursts coalesce in one frame and reject unobserved sources", async () => {
  const { dashboard, frames } = dashboardHarness();
  const contentWindow = {};
  const frame = { contentWindow, isConnected: true, dataset: { cardId: "one" } };
  dashboard.observedFrames.add(frame);
  dashboard.frameSources.set(contentWindow, frame);
  const scroller = { scrollHeight: 2000, clientHeight: 500, scrollTop: 100 };
  dashboard.querySelectorAll = () => { throw new Error("message hot path must not scan DOM"); };
  dashboard.querySelector = () => scroller;
  const wheel = { source: contentWindow, data: { type: "cryoclaw:dashboard", action: "wheel", value: { dy: 20 } } };
  for (let i = 0; i < 12; i++) await dashboard.frameMessage(wheel);
  assert.equal(frames.length, 1);
  frames.shift()!();
  assert.equal(scroller.scrollTop, 340);
  await dashboard.frameMessage({ ...wheel, source: {} });
  frame.isConnected = false;
  await dashboard.frameMessage(wheel);
  frame.isConnected = true;
  dashboard.observedFrames.delete(frame);
  await dashboard.frameMessage(wheel);
  assert.equal(frames.length, 0);
});

test("viewport visibility does not read styles or resend element inspector state", () => {
  const visibility = source.slice(source.indexOf("private postFrameVisibility="), source.indexOf("private postInspector="));
  assert.doesNotMatch(visibility, /postInspector|getComputedStyle/);
  assert.match(source, /private frameLoaded=/, "reload must still initialize inspector and visibility");
});

test("iframe wheel messages use the observed source index, not a DOM scan", () => {
  const handler = source.slice(source.indexOf("private frameMessage="), source.indexOf("private async measure"));
  assert.doesNotMatch(handler, /querySelectorAll/);
  assert.match(handler, /frameSources\.get\(event\.source\)/);
  assert.match(handler, /observedFrames\.has\(frame\)/, "detached or previous-board sources must be rejected");
  assert.match(handler, /frame\.isConnected/);
});

test("scrolling dashboard chrome does not sample a blurred backdrop", () => {
  const tabs = css.match(/\.dashboard-tabs\{[^}]+\}/)?.[0] ?? "";
  assert.doesNotMatch(tabs, /backdrop-filter/);
  assert.match(tabs, /background:var\(--bg\)/);
  assert.match(css, /scroll-behavior:auto/);
  assert.doesNotMatch(css, /scroll-behavior:smooth/);
});
