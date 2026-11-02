import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const compose = readFileSync(new URL("../../../../src/ui/views/chat-compose.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../../../../src/styles/compose.css", import.meta.url), "utf8");
const rail = readFileSync(new URL("../../../../src/ui/components/oc-rail.ts", import.meta.url), "utf8");
const shell = readFileSync(new URL("../../../../src/styles/shell.css", import.meta.url), "utf8");

const globals = globalThis as Record<string, unknown>;
globals.customElements ??= { define() {}, get() { return undefined; } };
globals.CSSStyleSheet ??= class { replaceSync() {} };
globals.document = { nodeType: 9, currentScript: null, adoptedStyleSheets: [], createElement: () => ({}), createTreeWalker: () => ({}), querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
globals.window = { document: globals.document, Element: class {}, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) };
const { renderCompose } = await import("./views/chat-compose.ts");

function ringTemplate(percent = 3, dirty = false): any {
  const props: any = { draft: "", sessionKey: "context-ring", connected: true, queue: [], configuredModels: [], dirtyMeterSessions: dirty ? new Set(["context-ring"]) : undefined, onDraftChange() {}, onSend() {} };
  const result = renderCompose(props, { activeSession: { key: "context-ring", totalTokens: percent * 1000, contextTokens: 100000 } as any,
    composePlaceholder: "Write", modelSelectValue: null, isBusy: false, showStop: false });
  const find = (node: any): any => {
    if (Array.isArray(node)) { for (const item of node) { const match = find(item); if (match) return match; } }
    else if (node?.strings && Array.isArray(node.values)) {
      if (node.strings.some((part: string) => part.includes('class="chat-compose__ctx-ring"'))) return node;
      for (const item of node.values) { const match = find(item); if (match) return match; }
    }
    return null;
  };
  return find(result);
}

function text(node: any): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (node?.strings && Array.isArray(node.values)) return node.strings.reduce((out: string, part: string, index: number) => out + part + text(node.values[index]), "");
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}

test("context ring is a quiet numeral-free indicator while real progress and accessible usage remain", () => {
  const rendered = text(ringTemplate());
  const button = rendered.match(/<button[\s\S]*?<\/button>/)?.[0] ?? "";
  assert.doesNotMatch(button, /<text\b|ctx-ring-center/, "the 3% value must not remain painted at the center");
  assert.match(button, /aria-valuenow=3\b/);
  assert.match(button, /aria-valuetext=/);
  assert.match(button, /stroke-dasharray=3\.0 100/);
  assert.match(button, /popovertarget="chat-context-meter-details"/);
  assert.match(rendered, /3,000 \/ 100,000 tokens/);
  assert.match(rendered, /3%|3％/);
  const block = css.match(/\.chat-compose__ctx-ring \{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(block, /width:\s*(?:26|27|28)px/);
  assert.match(block, /height:\s*(?:26|27|28)px/);
  assert.match(block, /border:\s*0\s*;/);
  assert.match(block, /background:\s*transparent\s*;/);
  assert.match(css, /stroke-width:\s*1\.5(?:px)?\s*;/);
  assert.doesNotMatch(css, /\.chat-compose__ctx-ring-center\b/);
});

test("context ring retains real warning/danger tones and hides missing or model-dirty usage", () => {
  assert.match(text(ringTemplate(78)), /data-tone=warn/);
  assert.match(text(ringTemplate(95)), /data-tone=danger/);
  assert.equal(ringTemplate(0), null);
  assert.equal(ringTemplate(3, true), null);
});

test("context usage details stay visible for keyboard focus after the pointer leaves", () => {
  const ring = ringTemplate();
  const eventHandler = (name: string) => ring.values[ring.strings.findIndex((part: string) => part.trimEnd().endsWith(`${name}=`))] as (event: Event) => void;
  let focused = true, open = false, shows = 0;
  const queued: Array<() => void> = [];
  const panel = { matches: (selector: string) => selector.includes(":popover-open") ? open : false, showPopover() { open = true; shows++; }, hidePopover() { open = false; } };
  const wrap = { querySelector: () => panel, matches: (selector: string) => selector.includes(":focus-within") && focused };
  const event = { currentTarget: { closest: () => wrap } } as unknown as Event;
  (globalThis as any).window.setTimeout = (callback: () => void) => { queued.push(callback); return 1; };
  eventHandler("@focusin")(event);
  eventHandler("@pointerenter")(event);
  assert.equal(shows, 1);
  eventHandler("@pointerleave")(event); queued.shift()!();
  assert.equal(open, true, "focus keeps the actual usage details available without hover");
  focused = false;
  eventHandler("@focusout")(event); queued.shift()!();
  assert.equal(open, false);
});

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
  assert.match(css, /data-motion="reduce"/);
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
