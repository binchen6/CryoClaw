import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const compose = readFileSync(new URL("../../../../src/ui/views/chat-compose.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../../../../src/styles/compose.css", import.meta.url), "utf8");

test("context meter：整合在输入卡内部，包含标签、轨道和百分比", () => {
  const field = compose.indexOf('class="field chat-compose__field"');
  const meter = compose.indexOf("${renderContextMeter(ctx.activeSession");
  const textarea = compose.indexOf("<textarea", field);
  assert.ok(field >= 0 && meter > field && textarea > meter, "记忆状态必须位于输入卡内、textarea 前");
  assert.match(compose, /chat-compose__ctx-meter-label/);
  assert.match(compose, /chat.contextMeterLabel/);
  assert.match(compose, /chat-compose__ctx-meter-value/);
  assert.match(compose, /role="progressbar"/);
});

test("context meter：不再依赖负边距或额外层级遮挡", () => {
  const block = css.match(/\.chat-compose__ctx-meter \{[\s\S]*?\}/)?.[0] ?? "";
  assert.ok(block.includes("display: flex"));
  assert.ok(!block.includes("z-index"));
  assert.ok(!block.includes("calc(-1"));
  assert.match(css, /\.chat-compose__ctx-meter-value/);
  assert.match(css, /@media \(max-width: 600px\)/);
});
