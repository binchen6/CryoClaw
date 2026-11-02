import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { browserSnapshot } from "./embedded-browser-page";

test("snapshot bounds page-controlled URLs and terminates with empty content", () => {
  const result = runInNewContext(`(${browserSnapshot.toString()})()`, {
    document: { body: { innerText: "" }, title: "Page", querySelectorAll: () => [] },
    location: { href: `https://example.test/#${"x".repeat(60000)}` }, TextEncoder,
  }, { timeout: 200 });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 55000);
  assert.equal(result.truncated, true);
});
