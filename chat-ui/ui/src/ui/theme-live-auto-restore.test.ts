import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../../../src/ui/theme-live.ts", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");

test("manual theme editing cancels the agent preview auto-restore", () => {
  assert.match(
    src,
    /function pauseAutoRestore\(preview:Preview\):void\{if\(preview\.timer\)\{clearTimeout\(preview\.timer\);preview\.timer=null;\}\}/,
    "helper must clear and forget the auto-restore timer",
  );
  const updateStart = src.indexOf("export function updateActiveThemePreview");
  const updateEnd = src.indexOf("\n}", updateStart);
  assert.ok(
    src.slice(updateStart, updateEnd).includes("pauseAutoRestore(preview)"),
    "settings edits must pause auto-restore",
  );
  assert.ok(
    src.includes("const update=(inFrame=false)=>{pauseAutoRestore(preview);"),
    "live-editor changes must pause auto-restore",
  );
  const pickStart = src.indexOf("const pick=(event:PointerEvent)=>");
  const escapeStart = src.indexOf("const escape=(event:KeyboardEvent)=>");
  assert.ok(
    src.slice(pickStart, escapeStart).includes("pauseAutoRestore(preview)"),
    "picking an element must pause auto-restore",
  );
});
