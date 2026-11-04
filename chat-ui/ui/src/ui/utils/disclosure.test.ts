import test from "node:test";
import assert from "node:assert/strict";
import { html, nothing } from "lit";
import { PartType } from "lit/directive.js";
import { DisclosureDirective } from "./disclosure.ts";
import { MOTION_MS } from "./motion.ts";

class Probe extends DisclosureDirective {
  removed: unknown[] = [];
  setValue(value: unknown) { this.removed.push(value); }
  detach() { this.disconnected(); }
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test("closing stays bounded despite repeated stream renders; hidden content remains lazy", async () => {
  const probe = new Probe({type: PartType.CHILD}); let renders = 0;
  const body = () => { renders++; return html`<p>content</p>`; };
  assert.equal(probe.render(false, body), nothing);
  assert.equal(renders, 0);
  probe.render(true, body); probe.render(false, body);
  await pause(MOTION_MS.panel / 2); probe.render(false, body);
  await pause(MOTION_MS.panel / 2 + 30);
  assert.deepEqual(probe.removed, [nothing]); assert.equal(renders, 1);
});
test("rapid reversal and disconnect cancel pending subtree removal", async () => {
  const probe = new Probe({type: PartType.CHILD}), body = () => html`<p>content</p>`;
  probe.render(true, body); probe.render(false, body); probe.render(true, body);
  await pause(MOTION_MS.panel + 25); assert.equal(probe.removed.length, 0);
  probe.render(false, body); probe.detach();
  await pause(MOTION_MS.panel + 25); assert.equal(probe.removed.length, 0);
});
