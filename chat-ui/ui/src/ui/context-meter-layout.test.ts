import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const compose = readFileSync(new URL("../../../../src/ui/views/chat-compose.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../../../../src/styles/compose.css", import.meta.url), "utf8");
const rail = readFileSync(new URL("../../../../src/ui/components/oc-rail.ts", import.meta.url), "utf8");
const shell = readFileSync(new URL("../../../../src/styles/shell.css", import.meta.url), "utf8");

test("context ring：会话记忆占用改为工具条小圆环，不再占用输入卡顶部", () => {
  const field = compose.indexOf('class="field chat-compose__field"');
  const textarea = compose.indexOf("<textarea", field);
  const toolbar = compose.indexOf("chat-compose__toolbar-divider");
  const ring = compose.indexOf("${renderContextRing(ctx.activeSession");
  assert.ok(field >= 0 && textarea > field, "输入卡结构保持不变");
  assert.ok(ring > toolbar, "圆环必须位于工具条，与额度圆环原位置一致");
  assert.ok(!compose.includes("chat-compose__ctx-meter"), "旧进度条已移除");
  assert.ok(!compose.includes("oc-model-quota"), "额度圆环不再由输入框渲染");
  assert.match(compose, /chat-compose__ctx-ring/);
  assert.match(compose, /role="progressbar"/);
  assert.match(compose, /chat.contextMeterHint/);
});

test("context ring：CSS 用描边圆环表达进度，不引入位移或遮挡", () => {
  const block = css.match(/\.chat-compose__ctx-ring \{[\s\S]*?\}/)?.[0] ?? "";
  assert.ok(block.includes("display: inline-flex"));
  assert.ok(!block.includes("z-index"));
  assert.ok(!block.includes("calc(-1"));
  assert.match(css, /\.chat-compose__ctx-ring-fill/);
  assert.match(css, /\.chat-compose__ctx-ring\[data-tone="warn"\]/);
  assert.match(css, /prefers-reduced-motion/);
});

test("quota ring：额度圆环常驻图标轨，位于打开网页端按钮上方", () => {
  const footer = rail.indexOf('class="oc-rail__footer"');
  const quota = rail.indexOf("<oc-model-quota placement=\"rail\"");
  const web = rail.indexOf("onOpenWebUI()");
  assert.ok(footer >= 0 && quota > footer, "额度圆环必须渲染在图标轨页脚");
  assert.ok(web > quota, "额度圆环位于打开网页端按钮上方");
  assert.match(rail, /quotaClient/);
  assert.match(rail, /quotaProvider/);
});

test("quota ring：余额竖排在圆环上方并使用窄字体", () => {
  const block = shell.match(/\.oc-rail__footer \.chat-quota__trigger\[data-placement="rail"\] \{[\s\S]*?\}/)?.[0] ?? "";
  assert.ok(block.includes("flex-direction: column-reverse"), "余额必须显示在圆环上方");
  const balance = shell.match(/\.oc-rail__footer \.chat-quota__trigger\[data-placement="rail"\] \.chat-quota__balance \{[\s\S]*?\}/)?.[0] ?? "";
  assert.ok(balance.includes("font-stretch"), "余额使用窄字体");
  assert.ok(balance.includes("tabular-nums"));
});
