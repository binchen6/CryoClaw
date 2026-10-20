import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../../../../../src/ui/components/oc-turn-files.ts", import.meta.url),
  "utf8",
);

test("turn-files popover dismisses on outside pointerdown and Escape", () => {
  assert.match(src, /addEventListener\("pointerdown", this\.onDocumentPointerDown, true\)/);
  assert.match(src, /addEventListener\("keydown", this\.onDocumentKeyDown\)/);
  assert.match(src, /removeEventListener\("pointerdown", this\.onDocumentPointerDown, true\)/);
  assert.match(src, /removeEventListener\("keydown", this\.onDocumentKeyDown\)/);
  assert.match(src, /event\.key !== "Escape"/);
});

test("Escape returns focus to the summary trigger", () => {
  assert.match(src, /details\.querySelector<HTMLElement>\("summary"\)\?\.focus\(\)/);
});
