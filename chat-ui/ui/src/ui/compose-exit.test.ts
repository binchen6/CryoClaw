import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("compose exit：后台挂起也有界收尾且只完成一次", () => {
  const source = readFileSync(new URL("../../../../src/ui/views/chat-compose.ts", import.meta.url), "utf8");
  assert.match(source, /let exitTimer:number\|undefined,finished=false/);
  assert.match(source, /if\(finished\|\|epoch!==plusMenuEpoch\)return;finished=true/);
  assert.match(source, /exitTimer=window\.setTimeout\(finish,POPOVER_EXIT_MS\+50\)/);
  assert.match(source, /if\(exitTimer!==undefined\)clearTimeout\(exitTimer\)/);
});
