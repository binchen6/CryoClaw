import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = (rel: string) =>
  readFileSync(new URL(`../../../../src/ui/${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const css = readFileSync(new URL("../../../../src/styles/settings.css", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");

test("theme preview moves focus into the opened panel and restores it on close", () => {
  const src = ui("theme-live.ts");
  assert.match(src, /previousFocus:document\.activeElement instanceof HTMLElement\?document\.activeElement:null/);
  assert.match(src, /const panel=document\.querySelector<HTMLElement>\(preview\.editorVisible\?"\.theme-editor":"\.theme-preview-banner"\)/);
  assert.match(src, /const focus=preview\.previousFocus;if\(focus\?\.isConnected\)requestAnimationFrame\(\(\)=>focus\.focus\(\)\)/);
  assert.match(src, /<section class="theme-preview-banner" role="region" tabindex="-1"/);
  assert.match(src, /<aside class="theme-editor" tabindex="-1"/);
});

test("programmatic panel focus does not draw a panel-sized ring", () => {
  assert.match(css, /\.theme-editor:focus,\.theme-preview-banner:focus \{ outline: none; \}/);
});
