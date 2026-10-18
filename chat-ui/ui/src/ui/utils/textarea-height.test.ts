import test from "node:test";
import assert from "node:assert/strict";
import { adjustTextareaHeight } from "./textarea-height.ts";

test("equal-length content edits recalculate wrapping; unchanged renders skip layout", () => {
  let reads = 0;
  const el = {
    isConnected: true, clientWidth: 200, value: "iiii", placeholder: "Message",
    style: { height: "" },
    get scrollHeight() { reads++; return this.value === "iiii" ? 40 : 64; },
  };
  adjustTextareaHeight(el as unknown as HTMLTextAreaElement);
  assert.equal(el.style.height, "40px");
  adjustTextareaHeight(el as unknown as HTMLTextAreaElement);
  assert.equal(reads, 1);
  el.value = "WWWW";
  adjustTextareaHeight(el as unknown as HTMLTextAreaElement);
  assert.equal(el.style.height, "64px");
  assert.equal(reads, 2);
  el.clientWidth = 100;
  adjustTextareaHeight(el as unknown as HTMLTextAreaElement);
  el.placeholder = "A longer connection hint";
  adjustTextareaHeight(el as unknown as HTMLTextAreaElement);
  assert.equal(reads, 4);
});

test("hidden or detached inputs do not poison the measurement cache", () => {
  let reads = 0;
  const el = {
    isConnected: false, clientWidth: 200, value: "hello", placeholder: "", style: { height: "" },
    get scrollHeight() { reads++; return 40; },
  };
  const measure = () => adjustTextareaHeight(el as unknown as HTMLTextAreaElement);
  measure();
  el.isConnected = true;
  el.clientWidth = 0;
  measure();
  assert.equal(reads, 0);
  el.clientWidth = 200;
  measure();
  assert.equal(reads, 1);
  assert.equal(el.style.height, "40px");
});
